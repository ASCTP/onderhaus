/**
 * The completion flow itself, independent of HTTP. Everything the transport layer needs to
 * do is authenticate the caller and serialize a request into CompleteRequest; every
 * decision about whether to spend lives here so it can be tested without a server.
 *
 * The service is bidirectional. Each direction is a "leg" paid for by a different funded
 * account, XLM on the Stellar side and native USDC on the Arc side, so each leg reads its
 * own balance monitor and reaches for its own signer. Everything else, the validation, the
 * spend cap, the ledger, and the failure classification, is shared.
 *
 * The guard order matters and is deliberate. Validation, spend cap, and the balance halt
 * are all checked before the recipient preflight, because those are free, and the
 * preflight costs a Soroban RPC round trip. The preflight in turn runs before the ledger
 * row is written, so a request rejected for an unready recipient leaves no trace in the
 * metering table and cannot block a later legitimate retry of the same burn.
 */

import { completeMint, checkStellarRecipientReady, SubmissionTimeoutError } from "@asctp/parabola";
import type { ChainId, CompleteMintResult, Signer, StellarRecipientStatus } from "@asctp/parabola";
import { StrKey } from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import type { ApiKeyRecord } from "./db.js";
import { Store } from "./db.js";
import type { BalanceSource } from "./balance-monitor.js";
import type { Logger } from "./logger.js";
import type { ServiceSigner } from "./stellar.js";
import type { ArcServiceSigner } from "./arc.js";
import {
  AttestationPendingError,
  DirectionUnavailableError,
  MintInProgressError,
  NetworkMismatchError,
  RateLimitedError,
  RecipientNotReadyError,
  SpendCapExceededError,
  BalanceHaltError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

/** The two legs this service can complete, named by the direction funds travel. */
export type Direction = "arc->stellar" | "stellar->arc";

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
  /**
   * Both are absent when the service is not configured for the reverse direction, which is
   * what an operator running Arc to Stellar only gets. The pair travels together because
   * a leg cannot be paid for without an account to sign from and an account to watch.
   */
  readonly arcServiceSigner?: ArcServiceSigner | undefined;
  readonly arcBalanceMonitor?: BalanceSource | undefined;
  readonly logger: Logger;
  readonly completeMintImpl?: typeof completeMint;
  readonly checkRecipientReadyImpl?: typeof checkStellarRecipientReady;
}

/** Everything the flow needs to know about the leg it is serving. */
interface Leg {
  readonly direction: Direction;
  readonly from: ChainId;
  readonly to: ChainId;
  /** The account that pays for this leg, and the halt that guards it. */
  readonly balanceMonitor: BalanceSource;
  readonly unit: "XLM" | "USDC";
  readonly signer: Signer;
  /**
   * True only for legs that settle on Stellar, where the recipient needs an on-ledger
   * account with a USDC trustline. An Arc recipient needs no setup, so there is nothing
   * to preflight on the reverse leg and nothing to skip spending over.
   */
  readonly preflightsRecipient: boolean;
}

export interface ValidatedRequest {
  readonly direction: Direction;
  readonly burnTxHash: string;
  readonly recipient: string;
}

const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A Stellar transaction hash is the same 32 bytes without the 0x prefix. */
const STELLAR_TX_HASH = /^[0-9a-fA-F]{64}$/;

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
    const { direction, burnTxHash, recipient } = this.validate(request);
    const leg = this.resolveLeg(direction);
    const { store, logger } = this.deps;

    this.assertWithinSpendCap(apiKey);

    const balance = leg.balanceMonitor.snapshot();
    if (balance.halted) {
      throw new BalanceHaltError(
        `The service is not completing ${direction} transfers because its ${leg.unit} balance is below the configured floor or has not been confirmed yet.`,
      );
    }

    const status = leg.preflightsRecipient ? await this.checkRecipient(recipient) : null;

    const begun = store.beginMint({
      apiKeyId: apiKey.id,
      burnTxHash,
      network: this.deps.config.network,
      direction,
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
      const result = await this.submit(leg, burnTxHash);
      store.markMintSucceeded(begun.record.id, result.mintTxHash, result.attestationHash);

      logger.info(
        {
          burnTxHash,
          mintTxHash: result.mintTxHash,
          direction,
          apiKeyId: apiKey.id,
          durationMs: Date.now() - startedAt,
          recipientReady: status?.ready ?? null,
        },
        `completed the ${direction} transfer and paid the ${leg.unit} fee`,
      );

      return { mintTxHash: result.mintTxHash, attestationHash: result.attestationHash, replayed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markMintFailed(begun.record.id, message);
      logger.warn(
        { burnTxHash, direction, apiKeyId: apiKey.id, err: message },
        "could not complete the transfer",
      );

      // A submission timeout is not a failure. The transaction reached the network and
      // may still land, so the caller is told the outcome is uncertain rather than being
      // told it failed and retrying against a mint that already succeeded.
      if (err instanceof SubmissionTimeoutError) {
        throw new UpstreamError(
          `The completion transaction was broadcast as ${err.hash} but confirmation did not arrive in time. It may still land; check that hash before retrying.`,
          err.hash,
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

  validate(request: CompleteRequest): ValidatedRequest {
    const direction = directionOf(request.from, request.to);
    if (!direction) {
      throw new ValidationError(
        `Unsupported direction from=${JSON.stringify(request.from)} to=${JSON.stringify(request.to)}. This service completes arc to stellar and stellar to arc transfers.`,
      );
    }

    const burnTxHash = request.burnTxHash?.trim();
    if (!burnTxHash || !BURN_HASH_PATTERN[direction].test(burnTxHash)) {
      throw new ValidationError(
        direction === "arc->stellar"
          ? "burnTxHash must be a 0x-prefixed 32 byte Arc transaction hash"
          : "burnTxHash must be a 32 byte Stellar transaction hash, without a 0x prefix",
      );
    }

    const recipient = request.recipient?.trim();
    if (!recipient) {
      throw new ValidationError("recipient is required");
    }
    if (direction === "arc->stellar") {
      if (!StrKey.isValidEd25519PublicKey(recipient)) {
        throw new ValidationError(
          "recipient must be a valid Stellar account address. Note that this service pays the fee for whichever recipient the burn message names; the value here is used only to confirm readiness before spending.",
        );
      }
    } else if (!EVM_ADDRESS.test(recipient)) {
      throw new ValidationError(
        "recipient must be a valid Arc (EVM) address. Note that this service pays the gas for whichever recipient the burn message names; the value here is recorded on the ledger but does not gate spending, because an Arc address needs no setup to receive USDC.",
      );
    }

    if (request.network !== undefined && request.network !== this.deps.config.network) {
      throw new NetworkMismatchError(
        `This service is configured for ${this.deps.config.network} and will not transact on ${String(request.network)}.`,
      );
    }

    return { direction, burnTxHash, recipient };
  }

  /**
   * Binds a direction to the account that pays for it. Resolved after validation and
   * before the ledger is touched, so an unconfigured direction is refused without
   * consuming anything.
   */
  private resolveLeg(direction: Direction): Leg {
    const { serviceSigner, balanceMonitor, arcServiceSigner, arcBalanceMonitor } = this.deps;

    if (direction === "arc->stellar") {
      return {
        direction,
        from: "arc",
        to: "stellar",
        balanceMonitor,
        unit: "XLM",
        signer: serviceSigner.signer,
        preflightsRecipient: true,
      };
    }

    if (!arcServiceSigner || !arcBalanceMonitor) {
      throw new DirectionUnavailableError(
        "This deployment is configured for arc to stellar only. Set ARC_SECRET_KEY to enable stellar to arc, which needs a USDC-funded Arc account to pay that chain's gas.",
      );
    }

    return {
      direction,
      from: "stellar",
      to: "arc",
      balanceMonitor: arcBalanceMonitor,
      unit: "USDC",
      signer: arcServiceSigner.signer,
      preflightsRecipient: false,
    };
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
   *
   * Only the Stellar-settling leg has this problem. An Arc address can receive USDC with
   * no prior setup, so there is nothing to preflight on the reverse leg.
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

  private async submit(leg: Leg, burnTxHash: string): Promise<CompleteMintResult> {
    const { config } = this.deps;
    const complete = this.deps.completeMintImpl ?? completeMint;

    return complete({
      from: leg.from,
      to: leg.to,
      burnTxHash,
      signer: leg.signer,
      network: config.network,
      // Only the leg that settles on Stellar reads from it, and the SDK ignores it
      // otherwise, so the reverse leg is unaffected by this being set.
      stellarRpcUrl: config.stellarRpcUrl,
      pollInterval: config.attestationPollIntervalMs,
      pollTimeout: config.attestationPollTimeoutMs,
    });
  }
}

function directionOf(from: string, to: string): Direction | undefined {
  if (from === "arc" && to === "stellar") return "arc->stellar";
  if (from === "stellar" && to === "arc") return "stellar->arc";
  return undefined;
}

/** The burn happens on the source chain, so the hash format follows the source. */
const BURN_HASH_PATTERN: Record<Direction, RegExp> = {
  "arc->stellar": EVM_TX_HASH,
  "stellar->arc": STELLAR_TX_HASH,
};
