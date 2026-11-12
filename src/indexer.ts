import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";
import { formatFixed } from "./amounts.js";
import type { Store } from "./db.js";
import { parseSettlementEvent } from "./settlements.js";

const USDC_DECIMALS = 7;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const BACKFILL_LEDGERS = 10_000;

export interface SettlementRpc {
  getHealth(): Promise<{ latestLedger: number; oldestLedger: number }>;
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

export interface SettlementIndexerOptions {
  readonly server: SettlementRpc;
  readonly store: Store;
  readonly network: string;
  readonly contractId: string;
  readonly startLedger?: number;
  readonly pageSize?: number;
  readonly pollIntervalMs?: number;
  readonly logger?: (message: string) => void;
}

export class SettlementIndexer {
  private readonly server: SettlementRpc;
  private readonly store: Store;
  private readonly network: string;
  private readonly contractId: string;
  private readonly startLedger: number | undefined;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly logger: (message: string) => void;
  private stopped = false;

  constructor(options: SettlementIndexerOptions) {
    this.server = options.server;
    this.store = options.store;
    this.network = options.network;
    this.contractId = options.contractId;
    this.startLedger = options.startLedger;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger ?? (() => undefined);
  }

  private get cursorKey(): string {
    return `${this.network}:${this.contractId}`;
  }

  async runOnce(): Promise<number> {
    const saved = this.store.getIndexerCursor(this.cursorKey);
    const startLedger = saved
      ? undefined
      : (this.startLedger ?? (await this.defaultStartLedger()));
    let cursor = saved?.cursor;
    let lastLedger = saved?.lastLedger ?? 0;
    let inserted = 0;

    for (;;) {
      const request: rpc.Api.GetEventsRequest = cursor
        ? {
            filters: [{ type: "contract", contractIds: [this.contractId] }],
            cursor,
            limit: this.pageSize,
          }
        : {
            filters: [{ type: "contract", contractIds: [this.contractId] }],
            startLedger: startLedger as number,
            limit: this.pageSize,
          };
      const response = await this.server.getEvents(request);
      let pageInserted = 0;

      for (const event of response.events) {
        if (event.inSuccessfulContractCall === false) continue;
        const name = event.topic[0];
        if (name === undefined) continue;
        let parsedName: unknown;
        try {
          parsedName = parseEventName(name);
        } catch {
          continue;
        }
        if (parsedName !== "settled") continue;

        const parsed = parseSettlementEvent(event.topic, event.value);
        const created = this.store.recordSettlement({
          network: this.network,
          contractId: this.contractId,
          sourceDomain: parsed.sourceDomain,
          nonce: parsed.nonce,
          txHash: event.txHash,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          recipient: parsed.recipient,
          relayer: parsed.relayer,
          amount: formatFixed(parsed.amount, USDC_DECIMALS),
          fee: formatFixed(parsed.fee, USDC_DECIMALS),
          relayerFee: formatFixed(parsed.relayerFee, USDC_DECIMALS),
          treasuryFee: formatFixed(parsed.treasuryFee, USDC_DECIMALS),
        });
        if (created) {
          pageInserted += 1;
          this.logger(
            `indexed ${parsed.sourceDomain}:${parsed.nonce} ledger=${event.ledger} tx=${event.txHash}`,
          );
        }
      }

      inserted += pageInserted;
      if (response.cursor === "") break;
      cursor = response.cursor;
      if (response.events.length > 0) lastLedger = response.events[response.events.length - 1]!.ledger;
      this.store.setIndexerCursor(this.cursorKey, cursor, lastLedger);
      if (response.events.length < this.pageSize) break;
    }

    return inserted;
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger(`indexer error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped) return;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async defaultStartLedger(): Promise<number> {
    const health = await this.server.getHealth();
    return Math.max(health.oldestLedger, health.latestLedger - BACKFILL_LEDGERS);
  }
}

function parseEventName(topic: xdr.ScVal): unknown {
  return scValToNative(topic);
}
