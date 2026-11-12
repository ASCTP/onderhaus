import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import { SettlementIndexer, type SettlementRpc } from "../src/indexer.js";
import {
  SettlementIndexError,
  messageId,
  parseSettlementEvent,
  type SettlementInsert,
} from "../src/settlements.js";

const G = "GAUVTGIX55JJ5PX27CYDJ2T6E4KOGEZSDXW4A7UHPJ3GDOMLWDKY2USH";
const C = "CARSIIMF4ERN5V2TTTQT4ACFFKJKKDZAD4RLV64B6D2I5S4UDFHPQN2R";
const NONCE = "67fb3b8ddde0153e8fc048c0958712e07fd0b0e27b5cff0e0e8264a30f5f785c";

function addressValue(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

function settlementValue(overrides: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    amount: nativeToScVal(5_000_000n, { type: "i128" }),
    fee: nativeToScVal(100_000n, { type: "i128" }),
    nonce: nativeToScVal(Buffer.from(NONCE, "hex"), { type: "bytes" }),
    relayer_fee: nativeToScVal(70_000n, { type: "i128" }),
    source_domain: nativeToScVal(26, { type: "u32" }),
    treasury_fee: nativeToScVal(30_000n, { type: "i128" }),
    ...overrides,
  };
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

function topics(name = "settled", recipient = G, relayer = G): xdr.ScVal[] {
  return [xdr.ScVal.scvSymbol(name), addressValue(recipient), addressValue(relayer)];
}

function settlement(overrides: Partial<SettlementInsert> = {}): SettlementInsert {
  return {
    network: "testnet",
    contractId: C,
    sourceDomain: 26,
    nonce: NONCE,
    txHash: "331186775467866eba440eeaf403b15c6488b684b15896bf221785d59752e067",
    ledger: 5_698_081,
    ledgerClosedAt: "2026-11-12T20:07:29Z",
    recipient: G,
    relayer: G,
    amount: "0.5000000",
    fee: "0.0100000",
    relayerFee: "0.0070000",
    treasuryFee: "0.0030000",
    ...overrides,
  };
}

describe("parseSettlementEvent", () => {
  it("reads the source domain, nonce, addresses, and split from a settled event", () => {
    expect(parseSettlementEvent(topics(), settlementValue())).toEqual({
      sourceDomain: 26,
      nonce: NONCE,
      recipient: G,
      relayer: G,
      amount: 5_000_000n,
      fee: 100_000n,
      relayerFee: 70_000n,
      treasuryFee: 30_000n,
    });
  });

  it("rejects a different event name", () => {
    expect(() => parseSettlementEvent(topics("other"), settlementValue())).toThrow(
      "Expected a settled event",
    );
  });

  it("rejects a split that does not add up", () => {
    expect(() =>
      parseSettlementEvent(
        topics(),
        settlementValue({ treasury_fee: nativeToScVal(1n, { type: "i128" }) }),
      ),
    ).toThrow(SettlementIndexError);
  });

  it("rejects a fee above the amount", () => {
    expect(() =>
      parseSettlementEvent(
        topics(),
        settlementValue({ fee: nativeToScVal(6_000_000n, { type: "i128" }) }),
      ),
    ).toThrow("larger than the amount");
  });

  it("rejects a nonce that is not 32 bytes", () => {
    expect(() =>
      parseSettlementEvent(
        topics(),
        settlementValue({ nonce: nativeToScVal(Buffer.alloc(16), { type: "bytes" }) }),
      ),
    ).toThrow("not 32 bytes");
  });

  it("formats a message id from the source domain and nonce", () => {
    expect(messageId(26, NONCE)).toBe(`26:${NONCE}`);
  });
});

describe("settlement read model", () => {
  it("records a settlement once and lists it", () => {
    const store = new Store(":memory:");
    expect(store.recordSettlement(settlement())).toBe(true);
    expect(store.recordSettlement(settlement())).toBe(false);

    const page = store.listSettlements("testnet");
    expect(page.total).toBe(1);
    expect(page.settlements[0]).toMatchObject({
      nonce: NONCE,
      amount: "0.5000000",
      relayerFee: "0.0070000",
    });
    expect(store.getSettlement("testnet", 26, NONCE.toUpperCase())?.txHash).toBe(settlement().txHash);
    store.close();
  });

  it("computes totals and daily buckets from indexed amounts", () => {
    const store = new Store(":memory:");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    store.recordSettlement(settlement({ txHash: "tx-1", relayer: "relayer-a", ledgerClosedAt: today.toISOString() }));
    store.recordSettlement(
      settlement({
        txHash: "tx-2",
        nonce: "aa".repeat(32),
        sourceDomain: 27,
        relayer: "relayer-b",
        amount: "1.5000000",
        fee: "0.0300000",
        relayerFee: "0.0210000",
        treasuryFee: "0.0090000",
        ledgerClosedAt: yesterday.toISOString(),
      }),
    );

    const stats = store.settlementStats("testnet");
    expect(stats.totals).toEqual({ settlements: 2, relayers: 2, recipients: 1 });
    expect(stats.volumeUsdc).toBe("2.0000000");
    expect(stats.feesUsdc).toBe("0.0400000");
    expect(stats.relayerFeesUsdc).toBe("0.0280000");
    expect(stats.treasuryFeesUsdc).toBe("0.0120000");
    expect(stats.daily.at(-1)?.settlements).toBe(1);

    const relayers = store.settlementRelayerStats("testnet");
    expect(relayers).toHaveLength(2);
    expect(relayers[0]).toMatchObject({ relayer: "relayer-a", settlements: 1, volumeUsdc: "0.5000000" });
    store.close();
  });

  it("stores and returns the indexer cursor", () => {
    const store = new Store(":memory:");
    expect(store.getIndexerCursor("testnet:C")).toBeUndefined();
    store.setIndexerCursor("testnet:C", "cursor-1", 100);
    expect(store.getIndexerCursor("testnet:C")).toEqual({ cursor: "cursor-1", lastLedger: 100 });
    store.close();
  });
});

describe("SettlementIndexer", () => {
  function event(overrides: Record<string, unknown> = {}) {
    return {
      id: "1",
      type: "contract" as const,
      ledger: 5_698_081,
      ledgerClosedAt: "2026-11-12T20:07:29Z",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      txHash: settlement().txHash,
      topic: topics(),
      value: settlementValue(),
      ...overrides,
    };
  }

  it("stores a page and resumes from the cursor", async () => {
    const store = new Store(":memory:");
    const requests: unknown[] = [];
    let calls = 0;
    const server: SettlementRpc = {
      getHealth: async () => ({ latestLedger: 5_698_081, oldestLedger: 5_600_000 }),
      getEvents: async (request) => {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return {
            events: [event() as never],
            cursor: "cursor-1",
            latestLedger: 5_698_081,
            oldestLedger: 5_600_000,
            latestLedgerCloseTime: "",
            oldestLedgerCloseTime: "",
          };
        }
        return {
          events: [],
          cursor: "cursor-1",
          latestLedger: 5_698_081,
          oldestLedger: 5_600_000,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        };
      },
    };
    const indexer = new SettlementIndexer({ server, store, network: "testnet", contractId: C, startLedger: 5_698_081 });

    expect(await indexer.runOnce()).toBe(1);
    expect(store.listSettlements("testnet").total).toBe(1);
    expect(store.getIndexerCursor(`testnet:${C}`)).toEqual({ cursor: "cursor-1", lastLedger: 5_698_081 });
    expect(requests[0]).toMatchObject({ startLedger: 5_698_081 });

    expect(await indexer.runOnce()).toBe(0);
    expect(requests[1]).toMatchObject({ cursor: "cursor-1" });
    store.close();
  });

  it("ignores failed and unrelated events", async () => {
    const store = new Store(":memory:");
    const server: SettlementRpc = {
      getHealth: async () => ({ latestLedger: 5_698_081, oldestLedger: 5_600_000 }),
      getEvents: async () => ({
        events: [
          event({ inSuccessfulContractCall: false }) as never,
          event({ topic: topics("other") }) as never,
        ],
        cursor: "cursor-2",
        latestLedger: 5_698_081,
        oldestLedger: 5_600_000,
        latestLedgerCloseTime: "",
        oldestLedgerCloseTime: "",
      }),
    };
    const indexer = new SettlementIndexer({ server, store, network: "testnet", contractId: C, startLedger: 1 });
    expect(await indexer.runOnce()).toBe(0);
    expect(store.listSettlements("testnet").total).toBe(0);
    store.close();
  });
});
