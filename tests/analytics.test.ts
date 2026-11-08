/**
 * Covers the dashboard read model: what an importer writes, what the ledger projects into
 * it, and the aggregates the public API serves. None of this touches the spending path, so
 * these tests assert only that the numbers a visitor sees match the rows behind them.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import { sumDecimals } from "../src/amounts.js";
import type { TransferImport } from "../src/analytics.js";
import { VALID_RECIPIENT } from "./helpers.js";

const BURN_A = "aa".repeat(32);
const BURN_B = "bb".repeat(32);
const BURN_C = "cc".repeat(32);

function store(): Store {
  return new Store(":memory:");
}

function transfer(overrides: Partial<TransferImport> = {}): TransferImport {
  return {
    burnTxHash: BURN_A,
    network: "testnet",
    direction: "arc->stellar",
    recipient: VALID_RECIPIENT,
    amount: "25.5",
    status: "succeeded",
    submittedAt: "2026-10-01T10:00:00.000Z",
    settledAt: "2026-10-01T10:00:09.230Z",
    ...overrides,
  };
}

describe("importing transfers", () => {
  it("stores the full event and derives the chains and latency", () => {
    const s = store();
    const event = s.importTransferEvent(transfer({ relayer: "relayer-a", fee: "0.1", feeUnit: "USDC" }));

    expect(event).toMatchObject({
      burnTxHash: BURN_A,
      network: "testnet",
      direction: "arc->stellar",
      sourceChain: "arc",
      destinationChain: "stellar",
      recipient: VALID_RECIPIENT,
      amount: "25.5",
      amountUnit: "USDC",
      fee: "0.1",
      feeUnit: "USDC",
      relayer: "relayer-a",
      status: "succeeded",
      latencyMs: 9230,
      origin: "import",
    });
  });

  it("defaults a succeeded transfer to settled now when no settle time is given", () => {
    const s = store();
    const event = s.importTransferEvent(transfer({ settledAt: null }));
    expect(event.settledAt).not.toBeNull();
    expect(event.latencyMs).not.toBeNull();
  });

  it("updates the same row when a burn is re-imported", () => {
    const s = store();
    s.importTransferEvent(transfer({ status: "in_progress", settledAt: null, amount: null }));
    const updated = s.importTransferEvent(transfer({ status: "succeeded", amount: "40" }));

    expect(s.listTransfers("testnet").total).toBe(1);
    expect(updated.id).toBe(1);
    expect(updated.status).toBe("succeeded");
    expect(updated.amount).toBe("40");
  });

  it("keeps the same burn hash on two networks apart", () => {
    const s = store();
    s.importTransferEvent(transfer({ network: "testnet" }));
    s.importTransferEvent(transfer({ network: "mainnet" }));

    expect(s.listTransfers("testnet").total).toBe(1);
    expect(s.listTransfers("mainnet").total).toBe(1);
  });
});

describe("querying transfers", () => {
  function seeded(): Store {
    const s = store();
    s.importTransferEvent(
      transfer({ burnTxHash: BURN_A, status: "succeeded", submittedAt: "2026-10-01T10:00:00.000Z" }),
    );
    s.importTransferEvent(
      transfer({
        burnTxHash: BURN_B,
        status: "failed",
        direction: "stellar->arc",
        submittedAt: "2026-10-02T10:00:00.000Z",
        settledAt: "2026-10-02T10:00:01.000Z",
      }),
    );
    s.importTransferEvent(
      transfer({
        burnTxHash: BURN_C,
        status: "succeeded",
        direction: "stellar->arc",
        submittedAt: "2026-10-03T10:00:00.000Z",
      }),
    );
    return s;
  }

  it("newest first, and paged with a stable total", () => {
    const s = seeded();
    const first = s.listTransfers("testnet", { limit: 2 });
    expect(first.total).toBe(3);
    expect(first.limit).toBe(2);
    expect(first.offset).toBe(0);
    expect(first.transfers.map((event) => event.burnTxHash)).toEqual([BURN_C, BURN_B]);

    const second = s.listTransfers("testnet", { limit: 2, offset: 2 });
    expect(second.transfers.map((event) => event.burnTxHash)).toEqual([BURN_A]);
  });

  it("filters by direction and status", () => {
    const s = seeded();
    expect(s.listTransfers("testnet", { direction: "stellar->arc" }).total).toBe(2);
    expect(s.listTransfers("testnet", { direction: "arc->stellar" }).total).toBe(1);
    expect(s.listTransfers("testnet", { status: "failed" }).total).toBe(1);
    expect(s.listTransfers("testnet", { direction: "stellar->arc", status: "succeeded" }).total).toBe(1);
  });

  it("caps an oversized page at one hundred rows", () => {
    const s = seeded();
    expect(s.listTransfers("testnet", { limit: 5_000 }).limit).toBe(100);
  });

  it("looks up a burn hash regardless of case and only on its network", () => {
    const s = store();
    s.importTransferEvent(transfer({ burnTxHash: `0x${"AB".repeat(32)}` }));

    expect(s.getTransfer(`0x${"ab".repeat(32)}`, "testnet")?.burnTxHash).toBe(`0x${"AB".repeat(32)}`);
    expect(s.getTransfer(`0x${"ab".repeat(32)}`, "mainnet")).toBeUndefined();
    expect(s.getTransfer("does-not-exist", "testnet")).toBeUndefined();
  });
});

describe("protocol statistics", () => {
  it("reports an empty network without dividing by zero", () => {
    const s = store();
    const stats = s.transferStats("testnet");

    expect(stats.totals).toEqual({ transfers: 0, succeeded: 0, failed: 0, inProgress: 0 });
    expect(stats.successRate).toBeNull();
    expect(stats.volumeUsdc).toBe("0");
    expect(stats.fees).toEqual([]);
    expect(stats.latency).toEqual({ p50Ms: null, p95Ms: null });
    expect(stats.relayers.active).toBe(0);
    expect(stats.daily).toHaveLength(14);
  });

  it("aggregates volume, success rate, fees, latency, and relayers", () => {
    const s = store();
    s.importTransferEvent(
      transfer({
        burnTxHash: BURN_A,
        amount: "10.5",
        fee: "0.05",
        feeUnit: "USDC",
        relayer: "relayer-a",
        submittedAt: "2026-10-01T10:00:00.000Z",
        settledAt: "2026-10-01T10:00:02.000Z",
      }),
    );
    s.importTransferEvent(
      transfer({
        burnTxHash: BURN_B,
        amount: "20.25",
        fee: "0.05",
        feeUnit: "USDC",
        relayer: "relayer-a",
        submittedAt: "2026-10-01T11:00:00.000Z",
        settledAt: "2026-10-01T11:00:06.000Z",
      }),
    );
    s.importTransferEvent(
      transfer({
        burnTxHash: BURN_C,
        status: "failed",
        amount: null,
        error: "mint reverted",
        submittedAt: "2026-10-01T12:00:00.000Z",
        settledAt: null,
      }),
    );

    const stats = s.transferStats("testnet");
    expect(stats.totals).toEqual({ transfers: 3, succeeded: 2, failed: 1, inProgress: 0 });
    expect(stats.successRate).toBeCloseTo(2 / 3, 10);
    expect(stats.volumeUsdc).toBe("30.75");
    expect(stats.fees).toEqual([{ unit: "USDC", amount: "0.10" }]);
    expect(stats.latency).toEqual({ p50Ms: 2000, p95Ms: 6000 });
    expect(stats.relayers.active).toBe(1);
  });

  it("groups relayers and sorts them by completions", () => {
    const s = store();
    s.importTransferEvent(transfer({ burnTxHash: BURN_A, relayer: "relayer-a", amount: "10" }));
    s.importTransferEvent(
      transfer({ burnTxHash: BURN_B, relayer: "relayer-b", amount: "5", submittedAt: "2026-10-02T10:00:00.000Z" }),
    );
    s.importTransferEvent(
      transfer({ burnTxHash: BURN_C, relayer: "relayer-b", amount: "7", submittedAt: "2026-10-03T10:00:00.000Z" }),
    );

    const relayers = s.relayerStats("testnet");
    expect(relayers).toHaveLength(2);
    expect(relayers[0]).toMatchObject({ relayer: "relayer-b", completed: 2, volumeUsdc: "12" });
    expect(relayers[1]).toMatchObject({ relayer: "relayer-a", completed: 1, volumeUsdc: "10" });
  });
});

describe("ledger projection", () => {
  it("moves a transfer from in progress to succeeded with its amount intact", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    const begun = s.beginMint({
      apiKeyId: record.id,
      burnTxHash: BURN_A,
      network: "testnet",
      direction: "arc->stellar",
      recipient: VALID_RECIPIENT,
      amount: "12.5",
    });
    if (begun.kind !== "created") throw new Error("expected a new row");

    expect(s.getTransfer(BURN_A, "testnet")).toMatchObject({ status: "in_progress", origin: "ledger" });

    s.markMintSucceeded(begun.record.id, "mint-hash", "attestation-hash");

    const event = s.getTransfer(BURN_A, "testnet");
    expect(event).toMatchObject({
      status: "succeeded",
      mintTxHash: "mint-hash",
      attestationHash: "attestation-hash",
      amount: "12.5",
      origin: "ledger",
    });
    expect(event?.latencyMs).not.toBeNull();
  });

  it("marks a failed transfer without inventing a settle time", () => {
    const s = store();
    const { record } = s.createApiKey("acme", null, 60);
    const begun = s.beginMint({
      apiKeyId: record.id,
      burnTxHash: BURN_B,
      network: "testnet",
      direction: "arc->stellar",
      recipient: VALID_RECIPIENT,
    });
    if (begun.kind !== "created") throw new Error("expected a new row");

    s.markMintFailed(begun.record.id, "attestation not ready");

    expect(s.getTransfer(BURN_B, "testnet")).toMatchObject({
      status: "failed",
      error: "attestation not ready",
      settledAt: null,
      latencyMs: null,
    });
  });

  it("preserves imported detail when the ledger later reports the same burn", () => {
    const s = store();
    s.importTransferEvent(transfer({ relayer: "relayer-a", fee: "0.1", feeUnit: "USDC", amount: "25.5" }));

    const { record } = s.createApiKey("acme", null, 60);
    s.beginMint({
      apiKeyId: record.id,
      burnTxHash: BURN_A,
      network: "testnet",
      direction: "arc->stellar",
      recipient: VALID_RECIPIENT,
    });

    expect(s.getTransfer(BURN_A, "testnet")).toMatchObject({
      amount: "25.5",
      fee: "0.1",
      feeUnit: "USDC",
      relayer: "relayer-a",
    });
  });
});

describe("sumDecimals", () => {
  it("adds at the widest scale without floating point", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["1", "2.5"])).toBe("3.5");
    expect(sumDecimals([])).toBe("0");
    expect(sumDecimals(["not-a-number", "2"])).toBe("2");
  });
});
