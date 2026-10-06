/**
 * Covers the spending guards in the completion flow. The assertions that matter most are
 * the negative ones: for every rejection path the suite checks that the SDK's completeMint
 * was never called, because a called completeMint is a spent XLM fee.
 */

import { describe, expect, it, vi } from "vitest";
import { SubmissionTimeoutError } from "@asctp/parabola";
import { Store } from "../src/db.js";
import type { BalanceSource } from "../src/balance-monitor.js";
import { Paymaster, type PaymasterDeps } from "../src/paymaster.js";
import { BalanceHaltError, AttestationPendingError, UpstreamError } from "../src/errors.js";
import { VALID_BURN_TX, VALID_RECIPIENT, balanceOf, silentLogger, testConfig, testSigner } from "./helpers.js";

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

  it("rejects the reverse direction rather than attempting it", async () => {
    const h = harness();
    const key = h.store.findApiKeyById(h.apiKeyId)!;

    await expect(
      h.paymaster.complete(key, request({ from: "stellar", to: "arc" })),
    ).rejects.toMatchObject({ code: "validation_error" });
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
    const unknown: BalanceSource = {
      snapshot: () => ({
        stroops: null,
        floorStroops: 5_0000000n,
        halted: true,
        lastCheckedAt: null,
        lastError: "Horizon unreachable",
      }),
    };
    const h = harness({ balanceMonitor: unknown });
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
