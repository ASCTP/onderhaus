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
import { buildArcServiceSigner, type ArcServiceSigner } from "../src/arc.js";
import type { PaymasterDeps } from "../src/paymaster.js";

/** A valid Stellar account address, taken from the SDK's own README example. */
export const VALID_RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

export const VALID_BURN_TX = `0x${"ab".repeat(32)}`;

export const OTHER_BURN_TX = `0x${"cd".repeat(32)}`;

/** A Stellar burn hash is the same 32 bytes with no prefix, since the burn is on Stellar. */
export const VALID_STELLAR_BURN_TX = "ab".repeat(32);

export const VALID_EVM_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

/**
 * A well-formed but unfunded Arc account. Constructing the signer builds a viem wallet
 * client around a URL nothing listens on, which costs nothing because viem's transport
 * does not connect until a request is actually sent, and every test that gets this far
 * has already replaced completeMint with a fake.
 */
export const TEST_ARC_PRIVATE_KEY = `0x${"11".repeat(32)}`;

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

export function testArcSigner(): ArcServiceSigner {
  return buildArcServiceSigner(TEST_ARC_PRIVATE_KEY, "testnet", "http://127.0.0.1:1");
}

/**
 * The configuration that turns the reverse direction on. PaymasterDeps carries both halves
 * of the reverse leg, so a test opts in by spreading this into the overrides.
 */
export function reverseEnabled(monitor: BalanceSource = balanceOf(false)): Partial<PaymasterDeps> {
  return { arcServiceSigner: testArcSigner(), arcBalanceMonitor: monitor };
}

export function balanceOf(halted: boolean, amount = 10_0000000n, floor = 5_0000000n): BalanceSource {
  return fixedBalance({ amount, floor, halted, lastCheckedAt: "2026-10-06T00:00:00.000Z", lastError: null });
}

/** A monitor that has never completed a read, which is the state the service boots in. */
export function unreadBalance(): BalanceSource {
  return fixedBalance({
    amount: null,
    floor: 5_0000000n,
    halted: true,
    lastCheckedAt: null,
    lastError: "Horizon unreachable",
  });
}

function fixedBalance(snapshot: BalanceSnapshot): BalanceSource {
  return { snapshot: () => snapshot };
}
