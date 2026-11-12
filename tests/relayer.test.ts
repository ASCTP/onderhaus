import { describe, expect, it } from "vitest";
import {
  RelayerError,
  decodeMessageHex,
  parseSettlementMessage,
  pollAttestation,
  relayerShare,
} from "../src/relayer.js";

const G = "GAUVTGIX55JJ5PX27CYDJ2T6E4KOGEZSDXW4A7UHPJ3GDOMLWDKY2USH";
const C = "CANA7BI2BBCYBBKPLB4ZA4PGL4ELBWI6RR3SYGU5W2L6O2HQAJSQXUWX";
const BODY_AMOUNT_OFFSET = 148 + 68;

function writeU256(target: Buffer, offset: number, value: bigint): void {
  for (let index = 0; index < 32; index += 1) {
    target[offset + 31 - index] = Number((value >> BigInt(8 * index)) & 0xffn);
  }
}

function buildHook(recipient: string, fee?: bigint, version = 0): Buffer {
  const strkey = Buffer.from(recipient, "utf8");
  const hook = Buffer.alloc(32 + strkey.length + (fee === undefined ? 0 : 16));
  hook.writeUInt32BE(version, 24);
  hook.writeUInt32BE(strkey.length, 28);
  strkey.copy(hook, 32);
  if (fee !== undefined) {
    let value = fee;
    for (let index = 15; index >= 0; index -= 1) {
      hook[32 + strkey.length + index] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return hook;
}

function buildMessage(hook: Buffer, amount = 5_000_000n): Buffer {
  const message = Buffer.alloc(376 + hook.length);
  writeU256(message, BODY_AMOUNT_OFFSET, amount);
  hook.copy(message, 376);
  return message;
}

describe("parseSettlementMessage", () => {
  it("reads the amount, fee, and contract recipient from a settlement message", () => {
    const parsed = parseSettlementMessage(buildMessage(buildHook(C, 100_000n)));

    expect(parsed.amount).toBe(5_000_000n);
    expect(parsed.fee).toBe(100_000n);
    expect(parsed.recipient).toBe(C);
  });

  it("reads an account recipient and a zero fee when there is no fee payload", () => {
    const parsed = parseSettlementMessage(buildMessage(buildHook(G)));

    expect(parsed.fee).toBe(0n);
    expect(parsed.recipient).toBe(G);
  });

  it("rejects a negative fee", () => {
    expect(() => parseSettlementMessage(buildMessage(buildHook(C, -1n)))).toThrow(RelayerError);
  });

  it("rejects an unsupported hook version", () => {
    expect(() => parseSettlementMessage(buildMessage(buildHook(C, 1n, 1)))).toThrow(
      "Unsupported hook version 1",
    );
  });

  it("rejects a message shorter than the burn body", () => {
    expect(() => parseSettlementMessage(Buffer.alloc(375))).toThrow("shorter than a full burn body");
  });

  it("rejects an invalid recipient", () => {
    expect(() => parseSettlementMessage(buildMessage(buildHook("not-a-strkey", 1n)))).toThrow(
      "not a valid Stellar address",
    );
  });

  it("rejects a trailing payload that is not a fee", () => {
    const message = buildMessage(Buffer.concat([buildHook(C, 1n), Buffer.from([0])]));
    expect(() => parseSettlementMessage(message)).toThrow("trailing bytes");
  });
});

describe("relayerShare", () => {
  it("takes the configured basis-point share of the fee", () => {
    expect(relayerShare(100_000n, 7_000)).toBe(70_000n);
    expect(relayerShare(100_000n, 0)).toBe(0n);
    expect(relayerShare(100_000n, 10_000)).toBe(100_000n);
  });

  it("rounds down", () => {
    expect(relayerShare(1n, 7_000)).toBe(0n);
    expect(relayerShare(3n, 7_000)).toBe(2n);
  });

  it("rejects a share outside the basis-point range", () => {
    expect(() => relayerShare(1n, 10_001)).toThrow(RelayerError);
    expect(() => relayerShare(1n, -1)).toThrow(RelayerError);
  });
});

describe("decodeMessageHex", () => {
  it("decodes a 0x-prefixed hex message", () => {
    expect(decodeMessageHex("0xdeadbeef").toString("hex")).toBe("deadbeef");
  });

  it("rejects malformed hex", () => {
    expect(() => decodeMessageHex("deadbeef")).toThrow(RelayerError);
    expect(() => decodeMessageHex("0xabc")).toThrow(RelayerError);
  });
});

describe("pollAttestation", () => {
  it("returns the message and attestation once Iris completes", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [{ status: "complete", message: "0xdead", attestation: "0xbeef" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      pollAttestation({
        burnTxHash: "0xabc",
        sourceDomain: 26,
        fetchImpl,
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ message: "0xdead", attestation: "0xbeef" });
  });

  it("times out when Iris never completes", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: [{ status: "pending" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      pollAttestation({
        burnTxHash: "0xabc",
        sourceDomain: 26,
        fetchImpl,
        pollIntervalMs: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("Timed out waiting for an Iris attestation");
  });
});
