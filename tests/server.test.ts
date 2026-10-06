/**
 * Covers the HTTP contract: that every spending endpoint requires a key, and that each
 * error class reaches the caller with the right status and a machine-readable code.
 *
 * The reverse direction is opt-in here the same way it is in production, by whether an Arc
 * account was configured at all, so both shapes of the deployment get exercised: a service
 * offering one direction and a service offering two.
 */

import { describe, expect, it, vi } from "vitest";
import { createApp, registerRoutes, type RouteLeg } from "../src/server.js";
import { Store } from "../src/db.js";
import { Paymaster, type PaymasterDeps } from "../src/paymaster.js";
import { stroopsToXlm } from "../src/stellar.js";
import { weiToUsdc } from "../src/arc.js";
import {
  VALID_BURN_TX,
  VALID_EVM_RECIPIENT,
  VALID_RECIPIENT,
  VALID_STELLAR_BURN_TX,
  balanceOf,
  silentLogger,
  testArcSigner,
  testConfig,
  testSigner,
} from "./helpers.js";

const READY = { exists: true, hasTrustline: true, ready: true };
const NO_TRUSTLINE = { exists: true, hasTrustline: false, ready: false };

async function buildApp(
  options: {
    recipientStatus?: typeof READY;
    completeMint?: unknown;
    keyRateLimit?: number;
    ipRateLimit?: number;
    halted?: boolean;
    arc?: boolean;
    arcHalted?: boolean;
  } = {},
) {
  const config = testConfig({
    LOG_LEVEL: "silent",
    IP_RATE_LIMIT_PER_MINUTE: String(options.ipRateLimit ?? 600),
  });
  const store = new Store(":memory:");
  const { rawKey } = store.createApiKey("test", null, options.keyRateLimit ?? 60);
  const balanceMonitor = balanceOf(options.halted ?? false);
  const stellarSigner = testSigner();

  const legs: RouteLeg[] = [
    {
      direction: "arc->stellar",
      unit: "XLM",
      account: stellarSigner.publicKey,
      monitor: balanceMonitor,
      format: stroopsToXlm,
    },
  ];

  const arcServiceSigner = options.arc ? testArcSigner() : undefined;
  // Native USDC on Arc is an 18-decimal figure, unlike the 6-decimal ERC-20 that CCTP
  // moves, so the fixture is scaled to match what the chain actually reports.
  const arcBalanceMonitor = options.arc
    ? balanceOf(options.arcHalted ?? false, 20n * 10n ** 18n, 10n ** 18n)
    : undefined;
  if (arcServiceSigner && arcBalanceMonitor) {
    legs.push({
      direction: "stellar->arc",
      unit: "USDC",
      account: arcServiceSigner.address,
      monitor: arcBalanceMonitor,
      format: (wei) => weiToUsdc(wei, config.network),
    });
  }

  const completeMint = vi
    .fn()
    .mockResolvedValue({ mintTxHash: "mint-hash", attestationHash: "attestation-hash" });
  const checkRecipient = vi.fn().mockResolvedValue(options.recipientStatus ?? READY);

  const paymaster = new Paymaster({
    config,
    store,
    serviceSigner: stellarSigner,
    balanceMonitor,
    arcServiceSigner,
    arcBalanceMonitor,
    logger: silentLogger(),
    completeMintImpl: (options.completeMint ?? completeMint) as unknown as PaymasterDeps["completeMintImpl"],
    checkRecipientReadyImpl: checkRecipient as unknown as PaymasterDeps["checkRecipientReadyImpl"],
  });

  const app = createApp(config);
  registerRoutes(app, { config, store, paymaster, legs });
  await app.ready();
  return { app, rawKey, store, completeMint };
}

const validBody = {
  burnTxHash: VALID_BURN_TX,
  from: "arc",
  to: "stellar",
  recipient: VALID_RECIPIENT,
};

const validReverseBody = {
  burnTxHash: VALID_STELLAR_BURN_TX,
  from: "stellar",
  to: "arc",
  recipient: VALID_EVM_RECIPIENT,
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
    expect(response.json()).toEqual({ status: "ready", directions: { "arc->stellar": "ready" } });
    await app.close();
  });

  it("refuses traffic with 503 once the balance halt is on", async () => {
    const { app } = await buildApp({ halted: true });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("halted");
    await app.close();
  });

  it("reports degraded rather than unready when only one leg is down", async () => {
    const { app } = await buildApp({ arc: true, halted: true });
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      directions: { "arc->stellar": "halted", "stellar->arc": "ready" },
    });
    await app.close();
  });

  it("refuses traffic only once every leg is down", async () => {
    const { app } = await buildApp({ arc: true, halted: true, arcHalted: true });
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json().directions).toEqual({ "arc->stellar": "halted", "stellar->arc": "halted" });
    await app.close();
  });

  it("does not disclose the balance figure to an unauthenticated caller", async () => {
    const { app } = await buildApp({ arc: true });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.body).not.toContain("balance");
    expect(response.body).not.toContain("10.0000000");
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

  it("reports a direction this deployment cannot serve as 501", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validReverseBody,
      headers: { authorization: `Bearer ${rawKey}` },
    });

    // Not a validation error: the request is well formed and a deployment holding an Arc
    // key would have served it, so the caller is told the capability is absent.
    expect(response.statusCode).toBe(501);
    expect(response.json().error).toMatchObject({ code: "direction_unavailable", retryable: false });
    await app.close();
  });

  it("completes a Stellar to Arc transfer when the Arc account is configured", async () => {
    const { app, rawKey } = await buildApp({ arc: true });
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: validReverseBody,
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().replayed).toBe(false);
    await app.close();
  });

  it("rejects a 64 character hash, which only a Stellar burn can be", async () => {
    const { app, rawKey } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/complete",
      payload: { ...validBody, burnTxHash: VALID_STELLAR_BURN_TX },
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(400);
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
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0]).toMatchObject({ direction: "arc->stellar", unit: "XLM", halted: false });
    expect(body.usage.mintsToday).toBe(0);
    await app.close();
  });

  it("reports both legs when the reverse direction is configured", async () => {
    const { app, rawKey } = await buildApp({ arc: true });
    const response = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    const body = response.json();

    expect(body.legs.map((leg: { direction: string }) => leg.direction)).toEqual(["arc->stellar", "stellar->arc"]);
    // Each leg renders its own chain's amount at that chain's scale, which is the reason
    // the leg carries a formatter rather than the server knowing about either asset.
    expect(body.legs[0].balance).toBe("10.0000000");
    expect(body.legs[1]).toMatchObject({
      unit: "USDC",
      balance: "20.000000000000000000",
      floor: "1.000000000000000000",
    });
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
