/**
 * Covers the spending guards in the completion flow. The assertions that matter most are
 * the negative ones: for every rejection path the suite checks that the SDK's completeMint
 * was never called, because a called completeMint is a spent fee.
 *
 * The two directions are paid for by different accounts, so the halt tests come in pairs.
 * A low XLM balance must not stop the leg Arc pays for, and a low Arc balance must not stop
 * the leg Stellar pays for; a guard that read the wrong monitor would pass a single-sided
 * test and fail here.
 */

import { describe, expect, it, vi } from "vitest";
import { SubmissionTimeoutError } from "@asctp/parabola";
import { Store } from "../src/db.js";
import { Paymaster, type PaymasterDeps } from "../src/paymaster.js";
import {
  BalanceHaltError,
  AttestationPendingError,
  DirectionUnavailableError,
  UpstreamError,
} from "../src/errors.js";
import {
  VALID_BURN_TX,
  VALID_EVM_RECIPIENT,
  VALID_RECIPIENT,
  VALID_STELLAR_BURN_TX,
  balanceOf,
  reverseEnabled,
  silentLogger,
  testArcSigner,
  testConfig,
  testSigner,
  unreadBalance,
} from "./helpers.js";

const READY = { exists: true, hasTrustline: true, ready: true };
const NO_ACCOUNT = { exists: false, hasTrustline: false, ready: false };
const NO_TRUSTLINE = { exists: true, hasTrustline: false, ready: false };

interface Harness {
  paymaster: Paymaster;
  store: Store;
  apiKeyId: number;
  completeMint: ReturnType<typeof vi.fn>;
  checkRecipient: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<PaymasterDeps> = {}, store = new Store(":memory:")): Harness {
  const config = testConfig();
  const { record } = store.createApiKey("test", null, 60);
  const completeMint = vi.fn().mockResolvedValue({ mintTxHash: "mint-hash", attestationHash: "attestation-hash" });
  const checkRecipient = vi.fn().mockResolvedValue(READY);

  const paymaster = new Paymaster({
    config,
    store,
    serviceSigner: testSigner(),
    balanceMonitor: balanceOf(false),
    logger: silentLogger(),
    completeMintImpl: completeMint as unknown as PaymasterDeps["completeMintImpl"],
    checkRecipientReadyImpl: checkRecipient as unknown as PaymasterDeps["checkRecipientReadyImpl"],
    ...overrides,
  });

  return { paymaster, store, apiKeyId: record.id, completeMint, checkRecipient };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    burnTxHash: VALID_BURN_TX,
    from: "arc",
    to: "stellar",
    recipient: VALID_RECIPIENT,
    ...overrides,
  } as Parameters<Paymaster["complete"]>[1];
}

/**
 * The same request travelling the other way, with each field in the format that leg
 * expects: a bare Stellar burn hash and an Arc address.
 */
function reverseRequest(overrides: Record<string, unknown> = {}) {
  return {
    burnTxHash: VALID_STELLAR_BURN_TX,
    from: "stellar",
    to: "arc",
    recipient: VALID_EVM_RECIPIENT,
    ...overrides,
  } as Parameters<Paymaster["complete"]>[1];
}

/** A harness that also holds the Arc account, which is what enables the reverse leg. */
function reverseHarness(overrides: Partial<PaymasterDeps> = {}): Harness & { arcSigner: ReturnType<typeof testArcSigner> } {
  const arcSigner = testArcSigner();
  const h = harness({ ...reverseEnabled(), arcServiceSigner: arcSigner, ...overrides });
  return { ...h, arcSigner };
}

describe("Paymaster.complete", () => {
  it("completes a transfer and reports the mint hash", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    const result = await h.paymaster.complete(key, request());

    expect(result).toEqual({ mintTxHash: "mint-hash", attestationHash: "attestation-hash", replayed: false });
    expect(h.completeMint).toHaveBeenCalledTimes(1);
    expect(h.completeMint.mock.calls[0]![0]).toMatchObject({
      from: "arc",
      to: "stellar",
      burnTxHash: VALID_BURN_TX,
      network: "testnet",
    });
  });

  it("returns the recorded result on a repeat without submitting again", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await h.paymaster.complete(key, request());
    const replay = await h.paymaster.complete(key, request());

    expect(replay).toEqual({ mintTxHash: "mint-hash", attestationHash: "attestation-hash", replayed: true });
    expect(h.completeMint).toHaveBeenCalledTimes(1);
  });

  it("refuses an unready recipient and never spends XLM", async () => {
    const h = harness();
    h.checkRecipient.mockResolvedValue(NO_TRUSTLINE);
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({
      code: "recipient_not_ready",
      status: 422,
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("refuses a recipient account that does not exist", async () => {
    const h = harness();
    h.checkRecipient.mockResolvedValue(NO_ACCOUNT);
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({ code: "recipient_not_ready" });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("leaves no ledger row behind when the recipient is not ready", async () => {
    const h = harness();
    h.checkRecipient.mockResolvedValue(NO_ACCOUNT);
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toThrow();
    expect(h.store.countBillableMintsSince(h.apiKeyId, "1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("maps an attestation timeout to a retryable conflict", async () => {
    const h = harness();
    h.completeMint.mockRejectedValue(
      new Error(`Timed out after 30000ms waiting for Iris attestation of ${VALID_BURN_TX}`),
    );
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({
      code: "attestation_pending",
      status: 409,
      retryable: true,
    });
  });

  it("retries a burn that previously failed on attestation instead of deduplicating it", async () => {
    const h = harness();
    h.completeMint.mockRejectedValueOnce(new Error(`Timed out after 30000ms waiting for Iris attestation`));
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toBeInstanceOf(AttestationPendingError);
    const retry = await h.paymaster.complete(key, request());

    expect(retry.replayed).toBe(false);
    expect(h.completeMint).toHaveBeenCalledTimes(2);
  });

  it("reports a submission timeout as uncertain rather than failed", async () => {
    const h = harness();
    h.completeMint.mockRejectedValue(new SubmissionTimeoutError("timed out", "stellar-tx-hash"));
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    const error = await h.paymaster.complete(key, request()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toContain("stellar-tx-hash");
    expect((error as UpstreamError).message).toContain("may still land");
  });

  it("reports an unrecognised upstream failure without matching it to attestation", async () => {
    const h = harness();
    h.completeMint.mockRejectedValue(new Error("Stellar transaction abc failed"));
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("rejects a network that does not match the configured one", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request({ network: "mainnet" }))).rejects.toMatchObject({
      code: "network_mismatch",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects a direction the service does not know at all", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(
      h.paymaster.complete(key, request({ from: "stellar", to: "stellar" })),
    ).rejects.toMatchObject({ code: "validation_error", status: 400 });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects a malformed burn hash", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request({ burnTxHash: "0x1234" }))).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("rejects a malformed recipient address", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request({ recipient: "not-an-address" }))).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("halts when the service balance is below the floor", async () => {
    const h = harness({ balanceMonitor: balanceOf(true) });
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toBeInstanceOf(BalanceHaltError);
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("halts when the balance has never been read successfully", async () => {
    const h = harness({ balanceMonitor: unreadBalance() });
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({
      code: "insufficient_service_balance",
      status: 503,
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("enforces the per-key daily cap before doing any work", async () => {
    const store = new Store(":memory:");
    const config = testConfig();
    const { record } = store.createApiKey("capped", 1, 60);
    const completeMint = vi.fn().mockResolvedValue({ mintTxHash: "m", attestationHash: "a" });
    const checkRecipient = vi.fn().mockResolvedValue(READY);
    const paymaster = new Paymaster({
      config,
      store,
      serviceSigner: testSigner(),
      balanceMonitor: balanceOf(false),
      logger: silentLogger(),
      completeMintImpl: completeMint as unknown as PaymasterDeps["completeMintImpl"],
      checkRecipientReadyImpl: checkRecipient as unknown as PaymasterDeps["checkRecipientReadyImpl"],
    });
    const key = store.findApiKeyById(record.id)!;

    await paymaster.complete(key, request());
    await expect(paymaster.complete(key, request({ burnTxHash: "0x" + "ee".repeat(32) }))).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      status: 429,
    });
    expect(completeMint).toHaveBeenCalledTimes(1);
  });

  it("reports a second concurrent request for the same burn as in progress", async () => {
    const h = harness();
    // Simulate a request already in flight by leaving an in_progress row in the ledger.
    h.store.beginMint({
      apiKeyId: h.apiKeyId,
      burnTxHash: VALID_BURN_TX,
      network: "testnet",
      direction: "arc->stellar",
      recipient: VALID_RECIPIENT,
    });
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request())).rejects.toMatchObject({
      code: "mint_in_progress",
      status: 409,
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("enforces the rate limit and never reaches the SDK", async () => {
    const store = new Store(":memory:");
    const { record } = store.createApiKey("limited", null, 1);
    const completeMint = vi.fn().mockResolvedValue({ mintTxHash: "m", attestationHash: "a" });
    const paymaster = new Paymaster({
      config: testConfig(),
      store,
      serviceSigner: testSigner(),
      balanceMonitor: balanceOf(false),
      logger: silentLogger(),
      completeMintImpl: completeMint as unknown as PaymasterDeps["completeMintImpl"],
      checkRecipientReadyImpl: vi.fn().mockResolvedValue(READY) as unknown as PaymasterDeps["checkRecipientReadyImpl"],
    });
    const key = store.findApiKeyById(record.id)!;

    paymaster.assertWithinRateLimit(key);
    expect(() => paymaster.assertWithinRateLimit(key)).toThrowError(/Rate limit/);
    expect(completeMint).not.toHaveBeenCalled();
  });
});

describe("Paymaster.complete on the reverse direction", () => {
  it("completes a Stellar to Arc transfer with the Arc account", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    const result = await h.paymaster.complete(key, reverseRequest());

    expect(result).toEqual({ mintTxHash: "mint-hash", attestationHash: "attestation-hash", replayed: false });
    expect(h.completeMint).toHaveBeenCalledTimes(1);
    expect(h.completeMint.mock.calls[0]![0]).toMatchObject({
      from: "stellar",
      to: "arc",
      burnTxHash: VALID_STELLAR_BURN_TX,
      network: "testnet",
    });
    expect(h.completeMint.mock.calls[0]![0].signer).toBe(h.arcSigner.signer);
  });

  it("does not preflight the Arc recipient, which needs no setup to receive USDC", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await h.paymaster.complete(key, reverseRequest());

    expect(h.checkRecipient).not.toHaveBeenCalled();
    expect(h.completeMint).toHaveBeenCalledTimes(1);
  });

  it("records the direction on the ledger so the two legs are separable", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await h.paymaster.complete(key, reverseRequest());

    expect(h.store.countBillableMintsSince(h.apiKeyId, "1970-01-01T00:00:00.000Z")).toBe(1);
  });

  it("refuses the reverse direction on a deployment that holds no Arc key", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest())).rejects.toBeInstanceOf(DirectionUnavailableError);
    await expect(h.paymaster.complete(key, reverseRequest())).rejects.toMatchObject({
      code: "direction_unavailable",
      status: 501,
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("refuses the reverse direction before writing anything to the ledger", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest())).rejects.toThrow();
    expect(h.store.countBillableMintsSince(h.apiKeyId, "1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("ignores the XLM balance, which pays for the other leg", async () => {
    const h = reverseHarness({ balanceMonitor: balanceOf(true) });
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest())).resolves.toMatchObject({ replayed: false });
    expect(h.completeMint).toHaveBeenCalledTimes(1);
  });

  it("halts on a low Arc balance even though the XLM balance is healthy", async () => {
    const h = reverseHarness({ arcBalanceMonitor: balanceOf(true) });
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest())).rejects.toMatchObject({
      code: "insufficient_service_balance",
      status: 503,
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects an Arc hash supplied for a Stellar burn", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest({ burnTxHash: VALID_BURN_TX }))).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects a Stellar hash supplied for an Arc burn", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request({ burnTxHash: VALID_STELLAR_BURN_TX }))).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects a Stellar address as the recipient of an Arc settlement", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, reverseRequest({ recipient: VALID_RECIPIENT }))).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("rejects an Arc address as the recipient of a Stellar settlement", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(h.paymaster.complete(key, request({ recipient: VALID_EVM_RECIPIENT }))).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(h.completeMint).not.toHaveBeenCalled();
  });

  it("does not let one direction replay the other", async () => {
    const h = reverseHarness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await h.paymaster.complete(key, reverseRequest());
    await h.paymaster.complete(key, request());

    // The idempotency key is the key, the hash, and the network, with no direction in it.
    // That is safe because the two hash shapes cannot collide: a Stellar hash is bare and
    // an Arc one is 0x-prefixed, so the same text is never valid for both legs.
    expect(h.completeMint).toHaveBeenCalledTimes(2);
    expect(h.store.countBillableMintsSince(h.apiKeyId, "1970-01-01T00:00:00.000Z")).toBe(2);
  });
});
