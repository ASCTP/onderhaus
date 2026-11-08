/**
 * The read model behind the public dashboard.
 *
 * It is deliberately separate from the operational `mints` ledger. The ledger is an
 * idempotency guard keyed on an API key, while a settlement event on chain has no API key
 * at all, so one table cannot serve both. The service keeps this read model in step with
 * the ledger today, and a chain indexer can write into it later without touching the
 * spending path.
 */

export type TransferDirection = "arc->stellar" | "stellar->arc";
export type TransferStatus = "in_progress" | "succeeded" | "failed";

export interface TransferEvent {
  readonly id: number;
  readonly burnTxHash: string;
  readonly network: string;
  readonly direction: TransferDirection;
  readonly recipient: string;
  readonly amount: string | null;
  readonly amountUnit: string;
  readonly fee: string | null;
  readonly feeUnit: string | null;
  readonly relayer: string | null;
  readonly status: TransferStatus;
  readonly mintTxHash: string | null;
  readonly attestationHash: string | null;
  readonly error: string | null;
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly submittedAt: string;
  readonly settledAt: string | null;
  readonly latencyMs: number | null;
  readonly origin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly direction?: TransferDirection;
  readonly status?: TransferStatus;
}

export interface TransferPage {
  readonly transfers: readonly TransferEvent[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface DailyPoint {
  readonly date: string;
  readonly transfers: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly volumeUsdc: string;
}

export interface FeeTotal {
  readonly unit: string;
  readonly amount: string;
}

export interface ProtocolStats {
  readonly network: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly transfers: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly inProgress: number;
  };
  readonly successRate: number | null;
  readonly volumeUsdc: string;
  readonly fees: readonly FeeTotal[];
  readonly latency: { readonly p50Ms: number | null; readonly p95Ms: number | null };
  readonly relayers: { readonly active: number };
  readonly last24h: { readonly transfers: number; readonly volumeUsdc: string };
  readonly daily: readonly DailyPoint[];
}

export interface RelayerStat {
  readonly relayer: string;
  readonly completed: number;
  readonly volumeUsdc: string;
  readonly lastSeenAt: string;
}

/** A row written by an importer or, later, by a chain indexer. */
export interface TransferImport {
  readonly burnTxHash: string;
  readonly network: string;
  readonly direction: TransferDirection;
  readonly recipient: string;
  readonly amount?: string | null;
  readonly amountUnit?: string;
  readonly fee?: string | null;
  readonly feeUnit?: string | null;
  readonly relayer?: string | null;
  readonly status: TransferStatus;
  readonly mintTxHash?: string | null;
  readonly attestationHash?: string | null;
  readonly error?: string | null;
  readonly submittedAt: string;
  readonly settledAt?: string | null;
  readonly origin?: string;
}

/** The read side the HTTP layer depends on, so a test can supply a fake. */
export interface TransferSource {
  listTransfers(network: string, query?: TransferQuery): TransferPage;
  getTransfer(burnTxHash: string, network: string): TransferEvent | undefined;
  transferStats(network: string): ProtocolStats;
  relayerStats(network: string): readonly RelayerStat[];
}

export function chainsFor(direction: TransferDirection): { source: string; destination: string } {
  return direction === "arc->stellar"
    ? { source: "arc", destination: "stellar" }
    : { source: "stellar", destination: "arc" };
}

export const TRANSFER_DIRECTIONS: readonly TransferDirection[] = ["arc->stellar", "stellar->arc"];
export const TRANSFER_STATUSES: readonly TransferStatus[] = ["in_progress", "succeeded", "failed"];
