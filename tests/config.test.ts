/**
 * Covers configuration parsing and the stroop conversions. The amounts here are the ones
 * that decide whether the service halts, so the rounding behaviour is asserted directly
 * rather than assumed.
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError, loadConfig, xlmToStroops } from "../src/config.js";
import { decimalToStroops, stroopsToXlm } from "../src/stellar.js";

const SECRET = Keypair.random().secret();

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { STELLAR_SECRET_KEY: SECRET, ...overrides } as NodeJS.ProcessEnv;
}

describe("xlmToStroops", () => {
  it("converts whole and fractional amounts", () => {
    expect(xlmToStroops("5")).toBe(50_000_000n);
    expect(xlmToStroops("2.5")).toBe(25_000_000n);
    expect(xlmToStroops("0.0000001")).toBe(1n);
  });

  it("rejects amounts with more precision than a stroop", () => {
    expect(() => xlmToStroops("0.00000001")).toThrow(ConfigError);
    expect(() => xlmToStroops("abc")).toThrow(ConfigError);
    expect(() => xlmToStroops("-1")).toThrow(ConfigError);
  });
});

describe("stroop conversion round trip", () => {
  it("parses Horizon decimals", () => {
    expect(decimalToStroops("12.3456789")).toBe(123_456_789n);
    expect(decimalToStroops("0.0000000")).toBe(0n);
  });

  it("formats stroops back to a decimal", () => {
    expect(stroopsToXlm(50_000_000n)).toBe("5.0000000");
    expect(stroopsToXlm(1n)).toBe("0.0000001");
  });

  it("survives a round trip", () => {
    expect(decimalToStroops(stroopsToXlm(123_456_789n))).toBe(123_456_789n);
  });
});

describe("loadConfig", () => {
  it("defaults to testnet", () => {
    expect(loadConfig(env()).network).toBe("testnet");
  });

  it("accepts mainnet when asked for explicitly", () => {
    expect(loadConfig(env({ NETWORK: "mainnet" })).network).toBe("mainnet");
  });

  it("rejects an unknown network", () => {
    expect(() => loadConfig(env({ NETWORK: "devnet" }))).toThrow(ConfigError);
  });

  it("requires a secret key", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/STELLAR_SECRET_KEY is required/);
  });

  it("rejects a secret key of the wrong shape", () => {
    expect(() => loadConfig(env({ STELLAR_SECRET_KEY: "not-a-key" }))).toThrow(ConfigError);
  });

  it("defaults the attestation poll well below the SDK's five minutes", () => {
    expect(loadConfig(env()).attestationPollTimeoutMs).toBe(30_000);
  });

  it("refuses a non-numeric port", () => {
    expect(() => loadConfig(env({ PORT: "http" }))).toThrow(ConfigError);
  });

  it("leaves the Stellar RPC override unset unless provided", () => {
    expect(loadConfig(env()).stellarRpcUrl).toBeUndefined();
    expect(loadConfig(env({ STELLAR_RPC_URL: "https://example.test" })).stellarRpcUrl).toBe("https://example.test");
  });
});
