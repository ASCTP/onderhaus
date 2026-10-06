/**
 * Watches the service's own XLM balance and raises a halt when it falls below the
 * configured floor.
 *
 * The halt fails closed. Until the first successful balance read the service reports
 * itself halted, so a misconfigured or unreachable Horizon cannot produce a service that
 * happily spends from an account it has never confirmed holds anything. Once a read has
 * succeeded, a later transient read failure keeps the previous verdict rather than
 * flipping the service to halted on a single blip, and the failure is recorded in the
 * snapshot so an operator can see the reading is stale.
 */

import type { Network } from "./config.js";
import type { Logger } from "./logger.js";
import { fetchXlmBalanceStroops } from "./stellar.js";

export interface BalanceSnapshot {
  readonly stroops: bigint | null;
  readonly floorStroops: bigint;
  readonly halted: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
}

/**
 * The read side of the monitor. The Paymaster depends on this rather than on the concrete
 * class so a test can supply a fixed balance without a timer or a network call.
 */
export interface BalanceSource {
  snapshot(): BalanceSnapshot;
}

export interface BalanceMonitorOptions {
  readonly publicKey: string;
  readonly network: Network;
  readonly floorStroops: bigint;
  readonly pollMs: number;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

const FETCH_TIMEOUT_MS = 10_000;

export class BalanceMonitor implements BalanceSource {
  private readonly options: BalanceMonitorOptions;
  private timer: NodeJS.Timeout | undefined;
  private stroops: bigint | null = null;
  private halted = true;
  private hasReadOnce = false;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: BalanceMonitorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    // Said out loud because it is the state the service is in until the first read lands,
    // and an operator reading the log should not have to infer it from the absence of a
    // resumption message.
    this.options.logger.info(
      { publicKey: this.options.publicKey, floorStroops: this.options.floorStroops.toString() },
      "the service starts halted and refuses to complete transfers until the first XLM balance read succeeds",
    );
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs);
    // A balance poll must never be the reason the process stays alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  snapshot(): BalanceSnapshot {
    return {
      stroops: this.stroops,
      floorStroops: this.options.floorStroops,
      halted: this.halted,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /** Reads the balance once and folds the result into the halt state. Exposed for tests. */
  async poll(): Promise<void> {
    const { publicKey, network, floorStroops, logger, fetchImpl } = this.options;
    try {
      const balance = await fetchXlmBalanceStroops(publicKey, network, fetchImpl ?? fetchWithTimeout);
      const wasHalted = this.halted;
      const isFirstRead = !this.hasReadOnce;
      this.stroops = balance;
      this.halted = balance < floorStroops;
      this.lastCheckedAt = new Date().toISOString();
      this.lastError = null;
      this.hasReadOnce = true;

      const fields = { balanceStroops: balance.toString(), floorStroops: floorStroops.toString() };
      // Logging normally waits for a transition, but the first read always reports its
      // verdict. A service that boots below its floor begins halted and never transitions
      // into that state, so without this the anomalous case is the quiet one.
      if (this.halted) {
        if (isFirstRead || !wasHalted) {
          logger.error(fields, "service XLM balance is below the floor, completing transfers is halted");
        }
      } else if (isFirstRead || wasHalted) {
        logger.info(fields, "service XLM balance is above the floor, completing transfers are enabled");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      logger.warn({ err: message }, "could not read the service XLM balance");
    }
  }
}

async function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
