/**
 * Stellar-side plumbing the service needs on top of the SDK: building the service signer
 * from a secret key, and reading that account's XLM balance so the service can halt before
 * it runs dry.
 *
 * The signer wraps a Keypair, and the SDK takes the Keypair rather than a secret, so the
 * service imports @stellar/stellar-sdk directly to construct one. That dependency is
 * declared in package.json alongside every other one the service uses.
 *
 * Balance is read from Horizon rather than the Soroban RPC. Horizon is a separate service
 * with separate rate limits, so a balance poll cannot compete with the same quota the
 * mint submissions depend on.
 */

import { Keypair } from "@stellar/stellar-sdk";
import type { StellarSigner } from "@asctp/parabola";
import { STELLAR_MAINNET, STELLAR_TESTNET } from "@asctp/parabola";
import type { Network } from "./config.js";
import { UpstreamError } from "./errors.js";

export interface ServiceSigner {
  readonly signer: StellarSigner;
  readonly publicKey: string;
}

export function buildServiceSigner(secretKey: string): ServiceSigner {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch {
    // The underlying parser message can echo part of the secret, so it is deliberately
    // not propagated into an error that may reach a log.
    throw new Error("STELLAR_SECRET_KEY could not be parsed as a Stellar secret key");
  }
  const publicKey = keypair.publicKey();
  return { signer: { publicKey, keypair }, publicKey };
}

export function horizonUrlFor(network: Network): string {
  return network === "mainnet" ? STELLAR_MAINNET.horizonUrl : STELLAR_TESTNET.horizonUrl;
}

/**
 * Returns the account's native XLM balance in stroops. A 404 means the account does not
 * exist on-ledger, which for the service's own funding account is a hard misconfiguration
 * rather than a zero balance, so it is reported as an upstream error with that distinction
 * spelled out.
 */
export async function fetchXlmBalanceStroops(
  publicKey: string,
  network: Network,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint> {
  const url = `${horizonUrlFor(network)}/accounts/${publicKey}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`Could not reach Horizon to read the service XLM balance: ${message}`);
  }

  if (response.status === 404) {
    throw new UpstreamError(
      `The service signing account ${publicKey} does not exist on ${network}. Fund it before serving traffic.`,
    );
  }
  if (!response.ok) {
    throw new UpstreamError(`Horizon returned ${response.status} reading the service XLM balance`);
  }

  const body = (await response.json()) as { balances?: { asset_type?: string; balance?: string }[] };
  const native = body.balances?.find((entry) => entry.asset_type === "native");
  if (!native?.balance) {
    throw new UpstreamError(`Horizon returned no native balance for ${publicKey}`);
  }
  return decimalToStroops(native.balance);
}

/** Horizon reports XLM as a decimal string with 7 places. Parsed with integer math only. */
export function decimalToStroops(amount: string): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) {
    throw new UpstreamError(`Horizon returned a balance that could not be parsed: ${JSON.stringify(amount)}`);
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").slice(0, 7).padEnd(7, "0");
  return BigInt(whole) * 10_000_000n + BigInt(fraction);
}

/** Renders stroops as a human XLM string, for status responses and log lines. */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / 10_000_000n;
  const fraction = (absolute % 10_000_000n).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
