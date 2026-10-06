/**
 * Covers the ledger's two jobs: metering, and the idempotency that stops a retried burn
 * from being submitted twice.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, generateApiKey, hashApiKey } from "../src/db.js";
import { VALID_BURN_TX, VALID_RECIPIENT } from "./helpers.js";

function store(): Store {
  return new Store(":memory:");
}

describe("api keys", () => {
  it("stores only a hash and resolves the key by presenting it", () => {
    const s = store();
    const { rawKey, record } = s.createApiKey("acme", 10, 60);

    expect(rawKey.startsWith("ohk_")).toBe(true);
    expect(s.findApiKeyByHash(hashApiKey(rawKey))?.id).toBe(record.id);
    expect(s.findApiKeyByHash(rawKey)).toBeUndefined();
  });

  it("does not recognise a key that was never issued", () => {
    const s = store();
    s.createApiKey("acme", 10, 60);
    expect(s.findApiKeyByHash(hashApiKey(generateApiKey()))).toBeUndefined();
  });

  it("round-trips the cap and rate limit", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 120);
    expect(record.dailyMintCap).toBeNull();
    expect(record.rateLimitPerMinute).toBe(120);
    expect(record.disabled).toBe(false);
  });
});

describe("rate limit windows", () => {
  it("allows calls up to the limit and refuses beyond it", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 3);
    const window = 1_000_000;

    expect(s.consumeRateLimit(record.id, window, 3)).toBe(true);
    expect(s.consumeRateLimit(record.id, window, 3)).toBe(true);
    expect(s.consumeRateLimit(record.id, window, 3)).toBe(true);
    expect(s.consumeRateLimit(record.id, window, 3)).toBe(false);
  });

  it("resets in the next window", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 1);

    expect(s.consumeRateLimit(record.id, 1_000_000, 1)).toBe(true);
    expect(s.consumeRateLimit(record.id, 1_000_000, 1)).toBe(false);
    expect(s.consumeRateLimit(record.id, 1_000_060, 1)).toBe(true);
  });

  it("sweeps windows that can no longer be measured against", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 10);
    s.consumeRateLimit(record.id, 1_000_000, 10);
    s.consumeRateLimit(record.id, 1_000_060, 10);
    expect(s.limiterWindowCounts().perKey).toBe(2);

    // Crossing into a new window drops every window older than the one now in progress.
    s.consumeRateLimit(record.id, 1_000_180, 10);
    expect(s.limiterWindowCounts().perKey).toBe(1);
  });
});

describe("address rate limit windows", () => {
  it("counts per scope, so one address cannot spend another's budget", () => {
    const s = store();

    expect(s.consumeIpRateLimit("1.2.3.4", 1_000_000, 2)).toBe(true);
    expect(s.consumeIpRateLimit("1.2.3.4", 1_000_000, 2)).toBe(true);
    expect(s.consumeIpRateLimit("1.2.3.4", 1_000_000, 2)).toBe(false);
    expect(s.consumeIpRateLimit("5.6.7.8", 1_000_000, 2)).toBe(true);
  });

  it("sweeps stale scopes the same way", () => {
    const s = store();
    s.consumeIpRateLimit("1.2.3.4", 1_000_000, 10);
    s.consumeIpRateLimit("5.6.7.8", 1_000_000, 10);
    expect(s.limiterWindowCounts().perAddress).toBe(2);

    s.consumeIpRateLimit("1.2.3.4", 1_000_180, 10);
    expect(s.limiterWindowCounts().perAddress).toBe(1);
  });
});

describe("mint ledger", () => {
  const args = (apiKeyId: number, burnTxHash = VALID_BURN_TX) => ({
    apiKeyId,
    burnTxHash,
    network: "testnet",
    direction: "arc->stellar",
    recipient: VALID_RECIPIENT,
  });

  it("creates a row on first sight and reports it as in flight", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);

    expect(s.beginMint(args(record.id)).kind).toBe("created");
    expect(s.beginMint(args(record.id)).kind).toBe("in_progress");
  });

  it("returns the stored result once the mint has succeeded", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    const begun = s.beginMint(args(record.id));
    if (begun.kind !== "created") throw new Error("expected a new row");

    s.markMintSucceeded(begun.record.id, "mint-hash", "attestation-hash");
    const again = s.beginMint(args(record.id));

    expect(again.kind).toBe("succeeded");
    expect(again.record.mintTxHash).toBe("mint-hash");
  });

  it("revives a failed row so a retry can proceed", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    const begun = s.beginMint(args(record.id));
    if (begun.kind !== "created") throw new Error("expected a new row");
    s.markMintFailed(begun.record.id, "attestation not ready");

    const retry = s.beginMint(args(record.id));

    expect(retry.kind).toBe("created");
    expect(retry.record.attempts).toBe(2);
    expect(retry.record.error).toBeNull();
  });

  it("tracks a burn per key and per network", () => {
    const s = store();
    const first = s.createApiKey("first", null, 60);
    const second = s.createApiKey("second", null, 60);

    expect(s.beginMint(args(first.record.id)).kind).toBe("created");
    expect(s.beginMint(args(second.record.id)).kind).toBe("created");
    expect(s.beginMint({ ...args(first.record.id), network: "mainnet" }).kind).toBe("created");
  });

  it("counts mints since an instant for spend caps", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    s.beginMint(args(record.id));

    expect(s.countBillableMintsSince(record.id, "1970-01-01T00:00:00.000Z")).toBe(1);
    expect(s.countBillableMintsSince(record.id, "2999-01-01T00:00:00.000Z")).toBe(0);
  });

  it("reports counts by status", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    s.beginMint(args(record.id));

    expect(s.countMintsByStatus()).toEqual({ in_progress: 1 });
  });

  it("records which direction the row was for", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);

    const begun = s.beginMint({ ...args(record.id), direction: "stellar->arc" });

    expect(begun.kind).toBe("created");
    expect(begun.record.direction).toBe("stellar->arc");
  });

  it("backfills the direction on a database created before the reverse existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "onderhaus-legacy-"));
    const path = join(dir, "legacy.db");
    try {
      // The schema exactly as an Arc-to-Stellar-only deployment left it, with one row in
      // it, so the migration has to add a NOT NULL column to a populated table.
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE mints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_key_id INTEGER NOT NULL,
          burn_tx_hash TEXT NOT NULL,
          network TEXT NOT NULL,
          recipient TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          mint_tx_hash TEXT,
          attestation_hash TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO mints (api_key_id, burn_tx_hash, network, recipient, status, created_at, updated_at)
        VALUES (1, '${VALID_BURN_TX}', 'testnet', '${VALID_RECIPIENT}', 'succeeded',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      legacy.close();

      const s = new Store(path);
      const existing = s.beginMint(args(1));

      expect(existing.kind).toBe("succeeded");
      expect(existing.record.direction).toBe("arc->stellar");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
