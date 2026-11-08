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
import { sumDecimals } from "./amounts.js";
import {
  chainsFor,
  type DailyPoint,
  type ProtocolStats,
  type RelayerStat,
  type TransferDirection,
  type TransferEvent,
  type TransferImport,
  type TransferPage,
  type TransferQuery,
  type TransferStatus,
} from "./analytics.js";

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
  readonly direction: string;
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
  direction: string;
  recipient: string;
  status: string;
  attempts: number;
  mint_tx_hash: string | null;
  attestation_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface TransferRow {
  id: number;
  burn_tx_hash: string;
  network: string;
  direction: string;
  recipient: string;
  amount: string | null;
  amount_unit: string;
  fee: string | null;
  fee_unit: string | null;
  relayer: string | null;
  status: string;
  mint_tx_hash: string | null;
  attestation_hash: string | null;
  error: string | null;
  source_chain: string;
  destination_chain: string;
  submitted_at: string;
  settled_at: string | null;
  latency_ms: number | null;
  origin: string;
  created_at: string;
  updated_at: string;
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
    direction: row.direction,
    recipient: row.recipient,
    status: row.status as MintStatus,
    attempts: row.attempts,
    mintTxHash: row.mint_tx_hash,
    attestationHash: row.attestation_hash,
    error: row.error,
  };
}

function toTransferEvent(row: TransferRow): TransferEvent {
  return {
    id: row.id,
    burnTxHash: row.burn_tx_hash,
    network: row.network,
    direction: row.direction as TransferDirection,
    recipient: row.recipient,
    amount: row.amount,
    amountUnit: row.amount_unit,
    fee: row.fee,
    feeUnit: row.fee_unit,
    relayer: row.relayer,
    status: row.status as TransferStatus,
    mintTxHash: row.mint_tx_hash,
    attestationHash: row.attestation_hash,
    error: row.error,
    sourceChain: row.source_chain,
    destinationChain: row.destination_chain,
    submittedAt: row.submitted_at,
    settledAt: row.settled_at,
    latencyMs: row.latency_ms,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        direction TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS transfer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        burn_tx_hash TEXT NOT NULL,
        network TEXT NOT NULL,
        direction TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount TEXT,
        amount_unit TEXT NOT NULL DEFAULT 'USDC',
        fee TEXT,
        fee_unit TEXT,
        relayer TEXT,
        status TEXT NOT NULL,
        mint_tx_hash TEXT,
        attestation_hash TEXT,
        error TEXT,
        source_chain TEXT NOT NULL,
        destination_chain TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        settled_at TEXT,
        latency_ms INTEGER,
        origin TEXT NOT NULL DEFAULT 'ledger',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_events_burn
        ON transfer_events (burn_tx_hash, network);
      CREATE INDEX IF NOT EXISTS idx_transfer_events_created
        ON transfer_events (network, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transfer_events_relayer
        ON transfer_events (network, relayer);
    `);

    // A database created before the reverse direction existed has no such column, and
    // every row in it can only have been Arc to Stellar, so that is the backfill. SQLite
    // requires a default to add a NOT NULL column to a populated table.
    const columns = this.db.prepare(`PRAGMA table_info(mints)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === "direction")) {
      this.db.exec(`ALTER TABLE mints ADD COLUMN direction TEXT NOT NULL DEFAULT 'arc->stellar'`);
    }

    // The read model is derived, so an existing ledger backfills it on boot. Rows that
    // already carry importer or indexer detail keep their amount, fee, and relayer.
    this.syncLedgerToEvents();
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
    direction: string;
    recipient: string;
    amount?: string | null;
  }): BeginMintOutcome {
    const now = new Date().toISOString();
    return this.db.transaction((): BeginMintOutcome => {
      const existing = this.db
        .prepare(`SELECT * FROM mints WHERE api_key_id = ? AND burn_tx_hash = ? AND network = ?`)
        .get(args.apiKeyId, args.burnTxHash, args.network) as MintRow | undefined;

      if (existing) {
        const record = toMintRecord(existing);
        if (record.status === "succeeded") {
          this.upsertTransferEvent(existing);
          return { kind: "succeeded", record };
        }
        if (record.status === "in_progress") return { kind: "in_progress", record };

        this.db
          .prepare(
            `UPDATE mints SET status = 'in_progress', attempts = attempts + 1, recipient = ?,
             error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(args.recipient, now, record.id);
        const revived = this.db.prepare(`SELECT * FROM mints WHERE id = ?`).get(record.id) as MintRow;
        this.upsertTransferEvent(revived, args.amount ?? null);
        return { kind: "created", record: toMintRecord(revived) };
      }

      const info = this.db
        .prepare(
          `INSERT INTO mints (api_key_id, burn_tx_hash, network, direction, recipient, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'in_progress', 1, ?, ?)`,
        )
        .run(args.apiKeyId, args.burnTxHash, args.network, args.direction, args.recipient, now, now);
      const inserted = this.db.prepare(`SELECT * FROM mints WHERE id = ?`).get(Number(info.lastInsertRowid)) as MintRow;
      this.upsertTransferEvent(inserted, args.amount ?? null);
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
    this.refreshTransferEvent(id);
  }

  markMintFailed(id: number, error: string): void {
    this.db
      .prepare(`UPDATE mints SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(error, new Date().toISOString(), id);
    this.refreshTransferEvent(id);
  }

  private refreshTransferEvent(id: number): void {
    const row = this.db.prepare(`SELECT * FROM mints WHERE id = ?`).get(id) as MintRow | undefined;
    if (row) this.upsertTransferEvent(row);
  }

  /**
   * Projects one ledger row into the read model. The upsert preserves any amount, fee, or
   * relayer detail an importer or indexer already attached, because those fields cannot be
   * derived from the operational ledger and should not be wiped by a status change.
   */
  private upsertTransferEvent(mint: MintRow, amount?: string | null): void {
    const chains = chainsFor(mint.direction as TransferDirection);
    const succeeded = mint.status === "succeeded";
    const latencyMs = succeeded
      ? Math.max(0, Date.parse(mint.updated_at) - Date.parse(mint.created_at))
      : null;
    this.db
      .prepare(
        `INSERT INTO transfer_events (
           burn_tx_hash, network, direction, recipient, amount, amount_unit, status,
           mint_tx_hash, attestation_hash, error, source_chain, destination_chain,
           submitted_at, settled_at, latency_ms, origin, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ledger', ?, ?)
         ON CONFLICT (burn_tx_hash, network) DO UPDATE SET
           direction = excluded.direction,
           recipient = excluded.recipient,
           amount = COALESCE(excluded.amount, transfer_events.amount),
           status = excluded.status,
           mint_tx_hash = excluded.mint_tx_hash,
           attestation_hash = excluded.attestation_hash,
           error = excluded.error,
           source_chain = excluded.source_chain,
           destination_chain = excluded.destination_chain,
           settled_at = excluded.settled_at,
           latency_ms = excluded.latency_ms,
           updated_at = excluded.updated_at`,
      )
      .run(
        mint.burn_tx_hash,
        mint.network,
        mint.direction,
        mint.recipient,
        amount ?? null,
        mint.status,
        mint.mint_tx_hash,
        mint.attestation_hash,
        mint.error,
        chains.source,
        chains.destination,
        mint.created_at,
        succeeded ? mint.updated_at : null,
        latencyMs,
        mint.created_at,
        mint.updated_at,
      );
  }

  /** Backfills the read model from the operational ledger, which is safe to run on boot. */
  syncLedgerToEvents(): void {
    const rows = this.db.prepare(`SELECT * FROM mints`).all() as MintRow[];
    for (const row of rows) this.upsertTransferEvent(row);
  }

  /**
   * Writes a transfer from an importer or a chain indexer. Unlike the ledger projection,
   * this carries the full detail, including the amounts and relayer a settlement exposes.
   */
  importTransferEvent(input: TransferImport): TransferEvent {
    const chains = chainsFor(input.direction);
    const settledAt = input.settledAt ?? (input.status === "succeeded" ? new Date().toISOString() : null);
    const latencyMs =
      settledAt === null ? null : Math.max(0, Date.parse(settledAt) - Date.parse(input.submittedAt));
    const updatedAt = settledAt ?? input.submittedAt;
    this.db
      .prepare(
        `INSERT INTO transfer_events (
           burn_tx_hash, network, direction, recipient, amount, amount_unit, fee, fee_unit,
           relayer, status, mint_tx_hash, attestation_hash, error, source_chain,
           destination_chain, submitted_at, settled_at, latency_ms, origin, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (burn_tx_hash, network) DO UPDATE SET
           direction = excluded.direction,
           recipient = excluded.recipient,
           amount = excluded.amount,
           amount_unit = excluded.amount_unit,
           fee = excluded.fee,
           fee_unit = excluded.fee_unit,
           relayer = excluded.relayer,
           status = excluded.status,
           mint_tx_hash = excluded.mint_tx_hash,
           attestation_hash = excluded.attestation_hash,
           error = excluded.error,
           source_chain = excluded.source_chain,
           destination_chain = excluded.destination_chain,
           submitted_at = excluded.submitted_at,
           settled_at = excluded.settled_at,
           latency_ms = excluded.latency_ms,
           origin = excluded.origin,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.burnTxHash,
        input.network,
        input.direction,
        input.recipient,
        input.amount ?? null,
        input.amountUnit ?? "USDC",
        input.fee ?? null,
        input.feeUnit ?? null,
        input.relayer ?? null,
        input.status,
        input.mintTxHash ?? null,
        input.attestationHash ?? null,
        input.error ?? null,
        chains.source,
        chains.destination,
        input.submittedAt,
        settledAt,
        latencyMs,
        input.origin ?? "import",
        input.submittedAt,
        updatedAt,
      );
    const event = this.getTransfer(input.burnTxHash, input.network);
    if (!event) throw new Error("imported transfer could not be read back");
    return event;
  }

  listTransfers(network: string, query: TransferQuery = {}): TransferPage {
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const offset = Math.max(0, query.offset ?? 0);
    const filters: string[] = ["network = ?"];
    const params: (string | number)[] = [network];
    if (query.direction !== undefined) {
      filters.push("direction = ?");
      params.push(query.direction);
    }
    if (query.status !== undefined) {
      filters.push("status = ?");
      params.push(query.status);
    }
    const where = filters.join(" AND ");
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM transfer_events WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM transfer_events WHERE ${where}
         ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TransferRow[];
    return { transfers: rows.map(toTransferEvent), total, limit, offset };
  }

  getTransfer(burnTxHash: string, network: string): TransferEvent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM transfer_events WHERE burn_tx_hash = ? COLLATE NOCASE AND network = ?`)
      .get(burnTxHash, network) as TransferRow | undefined;
    return row ? toTransferEvent(row) : undefined;
  }

  transferStats(network: string): ProtocolStats {
    const rows = this.db
      .prepare(`SELECT * FROM transfer_events WHERE network = ? ORDER BY submitted_at ASC`)
      .all(network) as TransferRow[];
    const events = rows.map(toTransferEvent);
    const succeeded = events.filter((event) => event.status === "succeeded");
    const failed = events.filter((event) => event.status === "failed");
    const inProgress = events.filter((event) => event.status === "in_progress");
    const completed = succeeded.length + failed.length;

    const feeGroups = new Map<string, string[]>();
    for (const event of succeeded) {
      if (event.fee === null || event.feeUnit === null) continue;
      const values = feeGroups.get(event.feeUnit) ?? [];
      values.push(event.fee);
      feeGroups.set(event.feeUnit, values);
    }
    const fees = [...feeGroups.entries()]
      .map(([unit, values]) => ({ unit, amount: sumDecimals(values) }))
      .sort((a, b) => a.unit.localeCompare(b.unit));

    const latencies = succeeded
      .map((event) => event.latencyMs)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);

    const relayers = new Set(events.map((event) => event.relayer).filter((value): value is string => value !== null));
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const last24h = events.filter((event) => Date.parse(event.submittedAt) >= now - dayMs);
    const last24hSucceeded = last24h.filter((event) => event.status === "succeeded");

    return {
      network,
      generatedAt: new Date(now).toISOString(),
      totals: {
        transfers: events.length,
        succeeded: succeeded.length,
        failed: failed.length,
        inProgress: inProgress.length,
      },
      successRate: completed === 0 ? null : succeeded.length / completed,
      volumeUsdc: sumDecimals(
        succeeded.map((event) => event.amount).filter((value): value is string => value !== null),
      ),
      fees,
      latency: { p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) },
      relayers: { active: relayers.size },
      last24h: {
        transfers: last24h.length,
        volumeUsdc: sumDecimals(
          last24hSucceeded.map((event) => event.amount).filter((value): value is string => value !== null),
        ),
      },
      daily: buildDaily(events, now, 14),
    };
  }

  relayerStats(network: string): RelayerStat[] {
    const rows = this.db
      .prepare(
        `SELECT relayer, amount, updated_at FROM transfer_events
         WHERE network = ? AND status = 'succeeded' AND relayer IS NOT NULL`,
      )
      .all(network) as { relayer: string; amount: string | null; updated_at: string }[];
    const groups = new Map<string, { completed: number; amounts: string[]; lastSeenAt: string }>();
    for (const row of rows) {
      const group = groups.get(row.relayer) ?? { completed: 0, amounts: [], lastSeenAt: row.updated_at };
      group.completed += 1;
      if (row.amount !== null) group.amounts.push(row.amount);
      if (row.updated_at > group.lastSeenAt) group.lastSeenAt = row.updated_at;
      groups.set(row.relayer, group);
    }
    return [...groups.entries()]
      .map(([relayer, group]) => ({
        relayer,
        completed: group.completed,
        volumeUsdc: sumDecimals(group.amounts),
        lastSeenAt: group.lastSeenAt,
      }))
      .sort((a, b) => b.completed - a.completed);
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

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Fourteen UTC days ending today, so the chart always has a stable width. */
function buildDaily(events: readonly TransferEvent[], now: number, days: number): DailyPoint[] {
  const buckets = new Map<string, { transfers: number; succeeded: number; failed: number; amounts: string[] }>();
  const today = new Date(now);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    buckets.set(day.toISOString().slice(0, 10), { transfers: 0, succeeded: 0, failed: 0, amounts: [] });
  }

  for (const event of events) {
    const key = new Date(event.submittedAt).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.transfers += 1;
    if (event.status === "succeeded") {
      bucket.succeeded += 1;
      if (event.amount !== null) bucket.amounts.push(event.amount);
    }
    if (event.status === "failed") bucket.failed += 1;
  }

  return [...buckets.entries()].map(([date, bucket]) => ({
    date,
    transfers: bucket.transfers,
    succeeded: bucket.succeeded,
    failed: bucket.failed,
    volumeUsdc: sumDecimals(bucket.amounts),
  }));
}
