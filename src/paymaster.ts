/**
 * The completion flow itself, independent of HTTP. Everything the transport layer needs to
 * do is authenticate the caller and serialize a request into CompleteRequest; every
 * decision about whether to spend XLM lives here so it can be tested without a server.
 *
 * The guard order matters and is deliberate. Validation, spend cap, and the balance halt
 * are all checked before the recipient preflight, because those are free, and the
 * preflight costs a Soroban RPC round trip. The preflight in turn runs before the ledger
 * row is written, so a request rejected for an unready recipient leaves no trace in the
 * metering table and cannot block a later legitimate retry of the same burn.
 */

import { completeMint, checkStellarRecipientReady, SubmissionTimeoutError } from "@asctp/parabola";
import type { CompleteMintResult, StellarRecipientStatus } from "@asctp/parabola";
import { StrKey } from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import type { ApiKeyRecord } from "./db.js";
import { Store } from "./db.js";
import type { BalanceSource } from "./balance-monitor.js";
import type { Logger } from "./logger.js";
import type { ServiceSigner } from "./stellar.js";
import {
  AttestationPendingError,
  MintInProgressError,
  NetworkMismatchError,
  RateLimitedError,
  RecipientNotReadyError,
  SpendCapExceededError,
  BalanceHaltError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

export interface CompleteRequest {
  readonly burnTxHash: string;
  readonly from: string;
  readonly to: string;
  readonly recipient: string;
  readonly network?: string;
}

export interface CompleteSuccess {
  readonly mintTxHash: string;
  readonly attestationHash: string;
  readonly replayed: boolean;
}

export interface PaymasterDeps {
  readonly config: Config;
  readonly store: Store;
  readonly serviceSigner: ServiceSigner;
  readonly balanceMonitor: BalanceSource;
  readonly logger: Logger;
  readonly completeMintImpl?: typeof completeMint;
  readonly checkRecipientReadyImpl?: typeof checkStellarRecipientReady;
}

const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Classification for "Circle has not signed this burn yet". The retryable outcome arrives
 * as a plain Error whose message contains the word attestation, so the predicate matches
 * on that text and is confined to this one constant, which keeps the rest of the service
 * free of any dependency on message wording.
 */
const ATTESTATION_MESSAGE = /attestation/i;

export class Paymaster {
  private readonly deps: PaymasterDeps;

  constructor(deps: PaymasterDeps) {
    this.deps = deps;
  }

  async complete(apiKey: ApiKeyRecord, request: CompleteRequest): Promise<CompleteSuccess> {
    const { burnTxHash, recipient } = this.validate(request);
    const { config, store, logger, balanceMonitor } = this.deps;

    this.assertWithinSpendCap(apiKey);

    const balance = balanceMonitor.snapshot();
    if (balance.halted) {
      throw new BalanceHaltError(
        "The service is not completing transfers because its XLM balance is below the configured floor or has not been confirmed yet.",
      );
    }

    const status = await this.checkRecipient(recipient);

    const begun = store.beginMint({
      apiKeyId: apiKey.id,
      burnTxHash,
      network: config.network,
      recipient,
    });

    if (begun.kind === "succeeded") {
      logger.info({ burnTxHash, apiKeyId: apiKey.id }, "burn was already completed, returning the recorded result");
      return {
        mintTxHash: begun.record.mintTxHash ?? "",
        attestationHash: begun.record.attestationHash ?? "",
        replayed: true,
      };
    }
    if (begun.kind === "in_progress") {
      throw new MintInProgressError(
        `A completion for burn ${burnTxHash} is already in flight. Retry shortly to read its result.`,
      );
    }

    const startedAt = Date.now();
    try {
      const result = await this.submit(burnTxHash);
      store.markMintSucceeded(begun.record.id, result.mintTxHash, result.attestationHash);

      logger.info(
        {
          burnTxHash,
          mintTxHash: result.mintTxHash,
          apiKeyId: apiKey.id,
          durationMs: Date.now() - startedAt,
          recipientReady: status.ready,
        },
        "completed a Stellar mint and paid the XLM fee",
      );

      return { mintTxHash: result.mintTxHash, attestationHash: result.attestationHash, replayed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markMintFailed(begun.record.id, message);
      logger.warn({ burnTxHash, apiKeyId: apiKey.id, err: message }, "could not complete the Stellar mint");

      // A submission timeout is not a failure. The transaction reached the network and
      // may still land, so the caller is told the outcome is uncertain rather than being
      // told it failed and retrying against a mint that already succeeded.
      if (err instanceof SubmissionTimeoutError) {
        throw new UpstreamError(
          `The mint transaction was broadcast as ${err.hash} but confirmation did not arrive in time. It may still land; check that hash before retrying.`,
        );
      }
      if (err instanceof Error && ATTESTATION_MESSAGE.test(err.message)) {
        throw new AttestationPendingError(
          `Circle has not attested burn ${burnTxHash} yet. Retry the same request in a few seconds.`,
        );
      }
      throw new UpstreamError(`Completing burn ${burnTxHash} failed upstream: ${message}`);
    }
  }

  /** Enforces the per-key rate limit. Called by the transport before any work is done. */
  assertWithinRateLimit(apiKey: ApiKeyRecord): void {
    const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
    const allowed = this.deps.store.consumeRateLimit(apiKey.id, windowStart, apiKey.rateLimitPerMinute);
    if (!allowed) {
      throw new RateLimitedError(
        `Rate limit of ${apiKey.rateLimitPerMinute} requests per minute exceeded for this API key.`,
      );
    }
  }

  private validate(request: CompleteRequest): { burnTxHash: string; recipient: string } {
    if (request.from !== "arc" || request.to !== "stellar") {
      throw new ValidationError(
        `This service completes Arc to Stellar transfers only. Received from=${JSON.stringify(request.from)} to=${JSON.stringify(request.to)}. The reverse direction is Phase 2 and is not implemented.`,
      );
    }

    const burnTxHash = request.burnTxHash?.trim();
    if (!burnTxHash || !EVM_TX_HASH.test(burnTxHash)) {
      throw new ValidationError("burnTxHash must be a 0x-prefixed 32 byte transaction hash");
    }

    const recipient = request.recipient?.trim();
    if (!recipient || !StrKey.isValidEd25519PublicKey(recipient)) {
      throw new ValidationError(
        "recipient must be a valid Stellar account address. Note that this service pays the fee for whichever recipient the burn message names; the value here is used only to confirm readiness before spending.",
      );
    }

    if (request.network !== undefined && request.network !== this.deps.config.network) {
      throw new NetworkMismatchError(
        `This service is configured for ${this.deps.config.network} and will not transact on ${String(request.network)}.`,
      );
    }

    return { burnTxHash, recipient };
  }

  private assertWithinSpendCap(apiKey: ApiKeyRecord): void {
    if (apiKey.dailyMintCap === null) return;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const used = this.deps.store.countBillableMintsSince(apiKey.id, startOfDay.toISOString());
    if (used >= apiKey.dailyMintCap) {
      throw new SpendCapExceededError(
        `Daily cap of ${apiKey.dailyMintCap} completions reached for this API key. It resets at 00:00 UTC.`,
      );
    }
  }

  /**
   * Confirms the recipient can actually receive USDC before any XLM is spent. completeMint
   * performs no such check, unlike transfer, which does it automatically, so a service
   * that skips this pays to submit a mint that cannot land and leaves the USDC with the
   * CctpForwarder.
   */
  private async checkRecipient(recipient: string): Promise<StellarRecipientStatus> {
    const check = this.deps.checkRecipientReadyImpl ?? checkStellarRecipientReady;
    let status: StellarRecipientStatus;
    try {
      status = await check(recipient, this.deps.config.network, this.deps.config.stellarRpcUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UpstreamError(`Could not verify the Stellar recipient's readiness: ${message}`);
    }

    if (!status.exists) {
      throw new RecipientNotReadyError(
        `Stellar recipient ${recipient} does not exist on-ledger. It must be funded with at least the minimum XLM reserve before it can receive USDC.`,
      );
    }
    if (!status.hasTrustline) {
      throw new RecipientNotReadyError(
        `Stellar recipient ${recipient} exists but holds no USDC trustline. It must add one before it can receive USDC.`,
      );
    }
    return status;
  }

  private async submit(burnTxHash: string): Promise<CompleteMintResult> {
    const { config, serviceSigner } = this.deps;
    const complete = this.deps.completeMintImpl ?? completeMint;

    return complete({
      from: "arc",
      to: "stellar",
      burnTxHash,
      signer: serviceSigner.signer,
      network: config.network,
      stellarRpcUrl: config.stellarRpcUrl,
      pollInterval: config.attestationPollIntervalMs,
      pollTimeout: config.attestationPollTimeoutMs,
    });
  }
}
