/**
 * Environment configuration for the paymaster. Parsed once at startup by loadConfig()
 * and passed down explicitly, so no module reads process.env on its own.
 *
 * The secret key is validated for shape here but never logged. Only its derived public
 * key is ever written to logs, which lets an operator confirm the service loaded the
 * account they expect without exposing the key itself.
 */

import { AmountFormatError, parseFixed } from "./amounts.js";
import { arcNativeDecimals } from "./arc.js";

export type Network = "mainnet" | "testnet";

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly network: Network;
  readonly stellarSecretKey: string;
  readonly stellarRpcUrl: string | undefined;
  /**
   * Absent when the service is not configured for the reverse direction. Its presence is
   * what turns Phase 2 on, so an operator running Arc to Stellar only is never forced to
   * hold a second hot key.
   */
  readonly arcSecretKey: string | undefined;
  readonly arcRpcUrl: string | undefined;
  readonly databasePath: string;
  readonly xlmLowBalanceFloorStroops: bigint;
  readonly xlmBalancePollMs: number;
  readonly usdcLowBalanceFloorWei: bigint;
  readonly usdcBalancePollMs: number;
  readonly defaultRateLimitPerMinute: number;
  readonly ipRateLimitPerMinute: number;
  readonly attestationPollIntervalMs: number;
  readonly attestationPollTimeoutMs: number;
  readonly logLevel: string;
  readonly trustProxy: boolean;
}

const STROOPS_DECIMALS = 7;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: NodeJS.ProcessEnv, name: string, hint?: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required but not set.${hint ? ` ${hint}` : ""}`);
  }
  return value.trim();
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new ConfigError(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * Converts a human XLM amount such as "5" or "2.5" into stroops. Integer math only, so
 * a floor comparison against an on-chain balance never depends on float rounding.
 */
export function xlmToStroops(amount: string): bigint {
  return asConfigError(() => parseFixed(amount, STROOPS_DECIMALS, "XLM amount"));
}

/**
 * Converts a human USDC amount into wei, which is the scale Arc reports its native gas
 * token at. That balance and the 6-decimal ERC-20 USDC that CCTP moves are the same asset at
 * two precisions, so the floor is expressed in the native scale the service actually spends
 * from. See src/arc.ts for how that was established.
 */
export function usdcToWei(amount: string, network: Network): bigint {
  return asConfigError(() => parseFixed(amount, arcNativeDecimals(network), "USDC amount"));
}

/**
 * The amount helpers report their own error type, since they also render figures read back
 * from a chain. Only here, where the value came from the environment, is a malformed
 * number a configuration problem.
 */
function asConfigError(convert: () => bigint): bigint {
  try {
    return convert();
  } catch (err) {
    if (err instanceof AmountFormatError) throw new ConfigError(err.message);
    throw err;
  }
}

function optionalEvmPrivateKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigError(`${name} must be a 0x-prefixed 32 byte private key`);
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawNetwork = env.NETWORK?.trim() || "testnet";
  if (rawNetwork !== "mainnet" && rawNetwork !== "testnet") {
    throw new ConfigError(`NETWORK must be mainnet or testnet, got ${JSON.stringify(rawNetwork)}`);
  }

  const stellarSecretKey = required(
    env,
    "STELLAR_SECRET_KEY",
    "Copy .env.example to .env and fill it in, or export it in the environment.",
  );
  if (!stellarSecretKey.startsWith("S") || stellarSecretKey.length !== 56) {
    throw new ConfigError("STELLAR_SECRET_KEY must be a Stellar secret key beginning with S");
  }

  const floor = env.XLM_LOW_BALANCE_FLOOR?.trim() || "5";
  const usdcFloor = env.USDC_LOW_BALANCE_FLOOR?.trim() || "1";
  const arcSecretKey = optionalEvmPrivateKey(env, "ARC_SECRET_KEY");

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env, "PORT", 3000),
    network: rawNetwork,
    stellarSecretKey,
    stellarRpcUrl: env.STELLAR_RPC_URL?.trim() || undefined,
    arcSecretKey,
    arcRpcUrl: env.ARC_RPC_URL?.trim() || undefined,
    databasePath: env.DATABASE_PATH?.trim() || "onderhaus.db",
    xlmLowBalanceFloorStroops: xlmToStroops(floor),
    xlmBalancePollMs: integer(env, "XLM_BALANCE_POLL_MS", 60_000),
    usdcLowBalanceFloorWei: usdcToWei(usdcFloor, rawNetwork),
    usdcBalancePollMs: integer(env, "USDC_BALANCE_POLL_MS", 60_000),
    defaultRateLimitPerMinute: integer(env, "DEFAULT_RATE_LIMIT_PER_MINUTE", 60),
    ipRateLimitPerMinute: integer(env, "IP_RATE_LIMIT_PER_MINUTE", 600),
    attestationPollIntervalMs: integer(env, "ATTESTATION_POLL_INTERVAL_MS", 3_000),
    attestationPollTimeoutMs: integer(env, "ATTESTATION_POLL_TIMEOUT_MS", 30_000),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    trustProxy: boolean(env, "TRUST_PROXY", false),
  };
}
