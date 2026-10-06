/**
 * Arc-side plumbing the service needs on top of the SDK: building the service signer from
 * a private key, and reading that account's balance so the service can halt the reverse
 * direction before it runs dry.
 *
 * Arc pays gas in USDC rather than in a separate native token, so the account the service
 * spends from is the same account it monitors, which is the role the Stellar account plays
 * for XLM. The balance read here is the chain's native balance. It is deliberately not the
 * ERC-20 USDC contract that CCTP mints and burns: that is a separate 6-decimal token, and
 * the service pays gas without ever holding it.
 *
 * The signer wraps a viem WalletClient, which is what the SDK's ArcSigner type requires.
 * viem is therefore a direct dependency of this service, declared in package.json like
 * every other one it uses, rather than reached for through the SDK's transitive tree.
 */

import type { Chain, PublicClient } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ArcSigner } from "@asctp/parabola";
import { ARC_MAINNET, ARC_TESTNET, arcMainnetChain, arcTestnetChain } from "@asctp/parabola";
import { formatFixed } from "./amounts.js";
import type { Network } from "./config.js";
import { UpstreamError } from "./errors.js";

export interface ArcServiceSigner {
  readonly signer: ArcSigner;
  readonly address: string;
}

const RPC_TIMEOUT_MS = 10_000;

export function arcChainFor(network: Network): Chain {
  return network === "mainnet" ? arcMainnetChain : arcTestnetChain;
}

export function arcRpcUrlFor(network: Network, override?: string): string {
  if (override) return override;
  return network === "mainnet" ? ARC_MAINNET.rpcUrl : ARC_TESTNET.rpcUrl;
}

/**
 * The scale Arc reports its native gas token at. Read from the chain definition rather
 * than hardcoded, because it is the number the configured floor is parsed against and a
 * wrong scale would put the halt at the wrong balance.
 */
export function arcNativeDecimals(network: Network): number {
  return arcChainFor(network).nativeCurrency.decimals;
}

export function buildArcServiceSigner(privateKey: string, network: Network, rpcUrl: string): ArcServiceSigner {
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(privateKey as `0x${string}`);
  } catch {
    // The parser message can echo part of the key, so it is deliberately not propagated
    // into an error that may reach a log.
    throw new Error("ARC_SECRET_KEY could not be parsed as an EVM private key");
  }

  const walletClient = createWalletClient({
    account,
    chain: arcChainFor(network),
    transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS }),
  });

  return { signer: { walletClient }, address: account.address };
}

/**
 * Returns the account's native balance in wei, which on Arc is the USDC that pays gas.
 * An account that does not exist reads as zero rather than erroring, which is the correct
 * reading for an EVM chain: the halt below the floor covers it either way.
 */
export async function fetchArcUsdcBalanceWei(
  address: string,
  network: Network,
  rpcUrl: string,
  client?: PublicClient,
): Promise<bigint> {
  const reader =
    client ?? createPublicClient({ chain: arcChainFor(network), transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS }) });
  try {
    return await reader.getBalance({ address: address as `0x${string}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`Could not read the service USDC balance from Arc: ${message}`);
  }
}

/** Renders wei as a human USDC string, for status responses and log lines. */
export function weiToUsdc(wei: bigint, network: Network): string {
  return formatFixed(wei, arcNativeDecimals(network));
}
