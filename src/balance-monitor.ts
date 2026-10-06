/**
 * Watches one of the service's funded accounts and raises a halt when its balance falls
 * below the configured floor.
 *
 * The monitor knows nothing about which chain it is watching. It is handed a reader and a
 * floor, and the two instances the service runs differ only in those: XLM from Horizon on
 * one side, native USDC from Arc's RPC on the other. Keeping the chain out of here is what
 * lets the same halt logic, including the fail-closed start, cover both.
 *
 * The halt fails closed. Until the first successful balance read the service reports
 * itself halted, so a misconfigured or unreachable endpoint cannot produce a service that
 * happily spends from an account it has never confirmed holds anything. Once a read has
 * succeeded, a later transient read failure keeps the previous verdict rather than
 * flipping the service to halted on a single blip, and the failure is recorded in the
 * snapshot so an operator can see the reading is stale.
 */

import type { Logger } from "./logger.js";

export interface BalanceSnapshot {
  readonly amount: bigint | null;
  readonly floor: bigint;
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
  /** The account being watched, used in log lines so an operator knows which one is low. */
  readonly account: string;
  /** The asset this account spends, "XLM" or "USDC". Used in log lines only. */
  readonly unit: string;
  readonly floor: bigint;
  readonly pollMs: number;
  readonly logger: Logger;
  readonly read: () => Promise<bigint>;
}

export class BalanceMonitor implements BalanceSource {
  private readonly options: BalanceMonitorOptions;
  private timer: NodeJS.Timeout | undefined;
  private amount: bigint | null = null;
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
      {
        account: this.options.account,
        unit: this.options.unit,
        floor: this.options.floor.toString(),
      },
      `the service starts halted for ${this.options.unit} and refuses to complete transfers until the first balance read succeeds`,
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
      amount: this.amount,
      floor: this.options.floor,
      halted: this.halted,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /** Reads the balance once and folds the result into the halt state. Exposed for tests. */
  async poll(): Promise<void> {
    const { account, unit, floor, logger, read } = this.options;
    try {
      const balance = await read();
      const wasHalted = this.halted;
      const isFirstRead = !this.hasReadOnce;
      this.amount = balance;
      this.halted = balance < floor;
      this.lastCheckedAt = new Date().toISOString();
      this.lastError = null;
      this.hasReadOnce = true;

      const fields = { account, unit, balance: balance.toString(), floor: floor.toString() };
      // Logging normally waits for a transition, but the first read always reports its
      // verdict. A service that boots below its floor begins halted and never transitions
      // into that state, so without this the anomalous case is the quiet one.
      if (this.halted) {
        if (isFirstRead || !wasHalted) {
          logger.error(fields, `service ${unit} balance is below the floor, completing transfers is halted`);
        }
      } else if (isFirstRead || wasHalted) {
        logger.info(fields, `service ${unit} balance is above the floor, completing transfers are enabled`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      logger.warn({ account, unit, err: message }, `could not read the service ${unit} balance`);
    }
  }
}
