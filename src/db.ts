/**
 * Durable state for the paymaster: API keys, per-key rate limit windows, and the mint
 * ledger. Backed by SQLite through better-sqlite3, whose calls are synchronous. That
 * blocks the event loop for the duration of each query, which is acceptable here because
 * every statement is a single-row indexed read or write against a local file, and it buys
 * atomic counters without a connection pool or an external service.
 *
 * The mint ledger does double duty: it is the metering record for off-band billing, and
 * its unique index on (api key, burn hash, network) is what makes completion idempotent,
 * so a caller retrying the same burn after a network blip gets the original result rather
 * than a second submission.
 */

import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";

export type MintStatus = "in_progress" | "succeeded" | "failed";

export interface ApiKeyRecord {
  readonly id: number;
  readonly label: string;
  readonly dailyMintCap: number | null;
  readonly rateLimitPerMinute: number;
  readonly disabled: boolean;
}

export interface MintRecord {
  readonly id: number;
  readonly apiKeyId: number;
  readonly burnTxHash: string;
  readonly network: string;
  readonly recipient: string;
  readonly status: MintStatus;
  readonly attempts: number;
  readonly mintTxHash: string | null;
  readonly attestationHash: string | null;
  readonly error: string | null;
}

export type BeginMintOutcome =
  | { readonly kind: "created"; readonly record: MintRecord }
  | { readonly kind: "in_progress"; readonly record: MintRecord }
  | { readonly kind: "succeeded"; readonly record: MintRecord };

interface ApiKeyRow {
  id: number;
  label: string;
  daily_mint_cap: number | null;
  rate_limit_per_minute: number;
  disabled: number;
}

interface MintRow {
  id: number;
  api_key_id: number;
  burn_tx_hash: string;
  network: string;
  recipient: string;
  status: string;
  attempts: number;
  mint_tx_hash: string | null;
  attestation_hash: string | null;
  error: string | null;
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): string {
  return `ohk_${randomBytes(32).toString("base64url")}`;
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    dailyMintCap: row.daily_mint_cap,
    rateLimitPerMinute: row.rate_limit_per_minute,
    disabled: row.disabled === 1,
  };
}

function toMintRecord(row: MintRow): MintRecord {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    burnTxHash: row.burn_tx_hash,
    network: row.network,
    recipient: row.recipient,
    status: row.status as MintStatus,
    attempts: row.attempts,
    mintTxHash: row.mint_tx_hash,
    attestationHash: row.attestation_hash,
    error: row.error,
  };
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        daily_mint_cap INTEGER,
        rate_limit_per_minute INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (api_key_id, window_start)
      );

      CREATE TABLE IF NOT EXISTS ip_rate_limit_windows (
        scope TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (scope, window_start)
      );

      CREATE TABLE IF NOT EXISTS mints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
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

      CREATE UNIQUE INDEX IF NOT EXISTS idx_mints_idempotency
        ON mints (api_key_id, burn_tx_hash, network);
      CREATE INDEX IF NOT EXISTS idx_mints_key_created
        ON mints (api_key_id, created_at);
    `);
  }

  createApiKey(label: string, dailyMintCap: number | null, rateLimitPerMinute: number): { rawKey: string; record: ApiKeyRecord } {
    const rawKey = generateApiKey();
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO api_keys (key_hash, label, daily_mint_cap, rate_limit_per_minute, disabled, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(hashApiKey(rawKey), label, dailyMintCap, rateLimitPerMinute, now);
    const record = this.findApiKeyById(Number(info.lastInsertRowid));
    if (!record) throw new Error("api key insert succeeded but the row could not be read back");
    return { rawKey, record };
  }

  findApiKeyByHash(keyHash: string): ApiKeyRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).get(keyHash) as ApiKeyRow | undefined;
    return row ? toApiKeyRecord(row) : undefined;
  }

  findApiKeyById(id: number): ApiKeyRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as ApiKeyRow | undefined;
    return row ? toApiKeyRecord(row) : undefined;
  }

  listApiKeys(): readonly ApiKeyRecord[] {
    const rows = this.db.prepare(`SELECT * FROM api_keys ORDER BY id`).all() as ApiKeyRow[];
    return rows.map(toApiKeyRecord);
  }

  /**
   * Increments the fixed-window counter for the given minute and reports whether the call
   * is within the limit. Rejected calls are still counted, so a caller hammering the
   * endpoint cannot push the window's count down by being rejected.
   */
  consumeRateLimit(apiKeyId: number, windowStartSeconds: number, limit: number): boolean {
    const row = this.db
      .prepare(
        `INSERT INTO rate_limit_windows (api_key_id, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (api_key_id, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .get(apiKeyId, windowStartSeconds) as { count: number };
    if (row.count === 1) this.pruneWindows("rate_limit_windows", windowStartSeconds);
    return row.count <= limit;
  }

  /**
   * The same counter keyed by an arbitrary scope rather than an API key, so that traffic
   * which never presents a usable key can still be bounded. This is what covers requests
   * that fail authentication, and requests rejected by schema validation before a key is
   * ever examined.
   */
  consumeIpRateLimit(scope: string, windowStartSeconds: number, limit: number): boolean {
    const row = this.db
      .prepare(
        `INSERT INTO ip_rate_limit_windows (scope, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (scope, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .get(scope, windowStartSeconds) as { count: number };
    if (row.count === 1) this.pruneWindows("ip_rate_limit_windows", windowStartSeconds);
    return row.count <= limit;
  }

  /**
   * Drops windows that no caller can still be measured against. Called only when a counter
   * row is first created, which happens at most once per scope per minute, so the sweep
   * costs one indexed delete per new window rather than one per request. Only the window
   * currently in progress can accept a request, so anything older is dead weight.
   */
  private pruneWindows(table: "rate_limit_windows" | "ip_rate_limit_windows", windowStartSeconds: number): void {
    this.db.prepare(`DELETE FROM ${table} WHERE window_start < ?`).run(windowStartSeconds - 60);
  }

  /** Limiter window row counts. Exposed so the sweep above can be confirmed rather than assumed. */
  limiterWindowCounts(): { perKey: number; perAddress: number } {
    const perKey = this.db.prepare(`SELECT COUNT(*) AS n FROM rate_limit_windows`).get() as { n: number };
    const perAddress = this.db.prepare(`SELECT COUNT(*) AS n FROM ip_rate_limit_windows`).get() as { n: number };
    return { perKey: perKey.n, perAddress: perAddress.n };
  }

  /** Mints that could have spent service XLM since the given instant, used for spend caps. */
  countBillableMintsSince(apiKeyId: number, sinceIso: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mints WHERE api_key_id = ? AND created_at >= ?`)
      .get(apiKeyId, sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Records the intent to complete a burn, or reports why it should not proceed. The
   * unique index on (api key, burn hash, network) is the idempotency guard, so two
   * concurrent requests for the same burn cannot both submit. A previous failure is
   * revived rather than deduplicated, because attestation delay is a normal condition a
   * caller is expected to retry through.
   */
  beginMint(args: {
    apiKeyId: number;
    burnTxHash: string;
    network: string;
    recipient: string;
  }): BeginMintOutcome {
    const now = new Date().toISOString();
    return this.db.transaction((): BeginMintOutcome => {
      const existing = this.db
        .prepare(`SELECT * FROM mints WHERE api_key_id = ? AND burn_tx_hash = ? AND network = ?`)
        .get(args.apiKeyId, args.burnTxHash, args.network) as MintRow | undefined;

      if (existing) {
        const record = toMintRecord(existing);
        if (record.status === "succeeded") return { kind: "succeeded", record };
        if (record.status === "in_progress") return { kind: "in_progress", record };

        this.db
          .prepare(
            `UPDATE mints SET status = 'in_progress', attempts = attempts + 1, recipient = ?,
             error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(args.recipient, now, record.id);
        const revived = this.db.prepare(`SELECT * FROM mints WHERE id = ?`).get(record.id) as MintRow;
        return { kind: "created", record: toMintRecord(revived) };
      }

      const info = this.db
        .prepare(
          `INSERT INTO mints (api_key_id, burn_tx_hash, network, recipient, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'in_progress', 1, ?, ?)`,
        )
        .run(args.apiKeyId, args.burnTxHash, args.network, args.recipient, now, now);
      const inserted = this.db.prepare(`SELECT * FROM mints WHERE id = ?`).get(Number(info.lastInsertRowid)) as MintRow;
      return { kind: "created", record: toMintRecord(inserted) };
    })();
  }

  markMintSucceeded(id: number, mintTxHash: string, attestationHash: string): void {
    this.db
      .prepare(
        `UPDATE mints SET status = 'succeeded', mint_tx_hash = ?, attestation_hash = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(mintTxHash, attestationHash, new Date().toISOString(), id);
  }

  markMintFailed(id: number, error: string): void {
    this.db
      .prepare(`UPDATE mints SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(error, new Date().toISOString(), id);
  }

  countMintsByStatus(): Record<string, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM mints GROUP BY status`).all() as {
      status: string;
      n: number;
    }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}
