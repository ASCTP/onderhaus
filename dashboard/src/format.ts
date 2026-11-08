export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatUsdc(value: string): string {
  return `${trimDecimal(value)} USDC`;
}

export function formatAmount(value: string | null, unit: string): string {
  return value === null ? "not captured" : `${trimDecimal(value)} ${unit}`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatRelative(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return iso;
  const seconds = Math.max(0, Math.round(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function shortHash(hash: string, head = 8, tail = 6): string {
  if (hash.length <= head + tail + 3) return hash;
  return `${hash.slice(0, head)}...${hash.slice(-tail)}`;
}

/**
 * Only Stellar explorer links are generated, because the Stellar URL is stable across
 * networks. An Arc explorer base is not guessed here; the hash stays copyable instead.
 */
export function explorerUrl(chain: string, network: string, hash: string): string | null {
  if (chain !== "stellar") return null;
  const path = network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${path}/tx/${hash}`;
}
