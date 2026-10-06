/**
 * Covers the HTTP contract: that every spending endpoint requires a key, and that each
 * error class reaches the caller with the right status and a machine-readable code.
 */

import { describe, expect, it, vi } from "vitest";
import { createApp, registerRoutes } from "../src/server.js";
import { Store } from "../src/db.js";
import { Paymaster, type PaymasterDeps } from "../src/paymaster.js";
import { VALID_BURN_TX, VALID_RECIPIENT, balanceOf, silentLogger, testConfig, testSigner } from "./helpers.js";

const READY = { exists: true, hasTrustline: true, ready: true };
const NO_TRUSTLINE = { exists: true, hasTrustline: false, ready: false };

async function buildApp(
  options: {
    recipientStatus?: typeof READY;
    completeMint?: unknown;
    keyRateLimit?: number;
    ipRateLimit?: number;
    halted?: boolean;
  } = {},
) {
  const config = testConfig({
    LOG_LEVEL: "silent",
    IP_RATE_LIMIT_PER_MINUTE: String(options.ipRateLimit ?? 600),
  });
  const store = new Store(":memory:");
  const { rawKey } = store.createApiKey("test", null, options.keyRateLimit ?? 60);
  const balanceMonitor = balanceOf(options.halted ?? false);

  const completeMint = vi
    .fn()
    .mockResolvedValue({ mintTxHash: "mint-hash", attestationHash: "attestation-hash" });
  const checkRecipient = vi.fn().mockResolvedValue(options.recipientStatus ?? READY);

  const paymaster = new Paymaster({
    config,
    store,
    serviceSigner: testSigner(),
    balanceMonitor,
    logger: silentLogger(),
    completeMintImpl: (options.completeMint ?? completeMint) as unknown as PaymasterDeps["completeMintImpl"],
    checkRecipientReadyImpl: checkRecipient as unknown as PaymasterDeps["checkRecipientReadyImpl"],
  });

  const app = createApp(config);
  registerRoutes(app, {
    config,
    store,
    paymaster,
    balanceMonitor,
    serviceSigner: testSigner(),
  });
  await app.ready();
  return { app, rawKey, store, completeMint };
}

const validBody = {
  burnTxHash: VALID_BURN_TX,
  from: "arc",
  to: "stellar",
  recipient: VALID_RECIPIENT,
};

describe("GET /healthz", () => {
  it("answers without a key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("keeps answering while the balance halt is on, because the process is alive", async () => {
    const { app } = await buildApp({ halted: true });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /readyz", () => {
  it("answers ready without a key while the service can complete transfers", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("refuses traffic with 503 once the balance halt is on", async () => {
    const { app } = await buildApp({ halted: true });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("halted");
    await app.close();
  });

  it("does not disclose the balance figure to an unauthenticated caller", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.body).not.toContain("stroops");
    expect(JSON.stringify(response.json())).not.toContain("balanceStroops");
    await app.close();
  });
});

describe("POST /v1/complete", () => {
  it("refuses a request with no key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/v1/complete", payload: validBody });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    await app.close();
  });

  it("refuses an unrecognised key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validBody,
      headers: { authorization: "Bearer ohk_not-a-real-key" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("completes a transfer for an authenticated caller", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validBody,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mintTxHash: "mint-hash",
      attestationHash: "attestation-hash",
      replayed: false,
    });
    await app.close();
  });

  it("accepts the key in the x-api-key header as well", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validBody,
      headers: { "x-api-key": rawKey },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a body that is missing required fields", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: { burnTxHash: VALID_BURN_TX },
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    await app.close();
  });

  it("passes a recipient readiness failure through as 422", async () => {
    const { app, rawKey } = await buildApp({ recipientStatus: NO_TRUSTLINE });
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validBody,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("recipient_not_ready");
    await app.close();
  });

  it("reports a pending attestation as a retryable 409", async () => {
    const failing = vi.fn().mockRejectedValue(new Error(`Timed out after 30000ms waiting for Iris attestation`));
    const { app, rawKey } = await buildApp({ completeMint: failing });
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validBody,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "attestation_pending", retryable: true });
    await app.close();
  });

  it("rejects an unknown field rather than silently ignoring it", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: { ...validBody, sneaky: true },
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    await app.close();
  });
});

describe("rate limiting", () => {
  const malformed = { from: "arc" };

  it("charges a request the schema rejects against the key's limit", async () => {
    const { app, rawKey } = await buildApp({ keyRateLimit: 2 });
    const headers = { authorization: `Bearer ${rawKey}` };

    // These never reach the handler, because Fastify rejects them before it runs.
    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: malformed, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: malformed, headers })).statusCode).toBe(400);

    const third = await app.inject({ method: "POST", url: "/v1/complete", payload: malformed, headers });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
    await app.close();
  });

  it("bounds traffic that presents no key at all", async () => {
    const { app } = await buildApp({ ipRateLimit: 2 });

    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: validBody })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: validBody })).statusCode).toBe(401);

    const third = await app.inject({ method: "POST", url: "/v1/complete", payload: validBody });
    expect(third.statusCode).toBe(429);
    await app.close();
  });

  it("bounds a caller presenting an unrecognised key", async () => {
    const { app } = await buildApp({ ipRateLimit: 1 });
    const headers = { authorization: "Bearer ohk_not-a-real-key" };

    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: validBody, headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/complete", payload: validBody, headers })).statusCode).toBe(429);
    await app.close();
  });

  it("leaves the health probes out of the address limit", async () => {
    const { app } = await buildApp({ ipRateLimit: 1 });

    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("GET /v1/status", () => {
  it("requires a key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/status" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("reports balance, usage, and ledger counts", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.network).toBe("testnet");
    expect(body.balance.halted).toBe(false);
    expect(body.usage.mintsToday).toBe(0);
    await app.close();
  });
});

describe("unknown routes", () => {
  it("answers 404 with the standard error shape", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});
