/**
 * Shared fixtures. Every test builds its own store against an in-memory database and
 * injects fakes for the two SDK calls that would otherwise touch the network, so the
 * suite never reaches Arc, Stellar, or Iris.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig, type Config } from "../src/config.js";
import type { BalanceSnapshot, BalanceSource } from "../src/balance-monitor.js";
import type { Logger } from "../src/logger.js";
import type { ServiceSigner } from "../src/stellar.js";

/** A valid Stellar account address, taken from the SDK's own README example. */
export const VALID_RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

export const VALID_BURN_TX = `0x${"ab".repeat(32)}`;

export const OTHER_BURN_TX = `0x${"cd".repeat(32)}`;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    STELLAR_SECRET_KEY: Keypair.random().secret(),
    NETWORK: "testnet",
    DATABASE_PATH: ":memory:",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

export function testSigner(): ServiceSigner {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  return { signer: { publicKey, keypair }, publicKey };
}

export function balanceOf(halted: boolean, stroops = 10_0000000n): BalanceSource {
  const snapshot: BalanceSnapshot = {
    stroops,
    floorStroops: 5_0000000n,
    halted,
    lastCheckedAt: "2026-10-06T00:00:00.000Z",
    lastError: null,
  };
  return { snapshot: () => snapshot };
}
