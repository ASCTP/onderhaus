/**
 * Indexes settlement events from the Soroban contract into the public read model.
 *
 * The cursor is stored next to the settlements, so a restart resumes from the last processed
 * event instead of rescanning the retention window. Run with --once for a single pass, or
 * without it to poll continuously.
 *
 * Usage: pnpm settlement:index -- --contract C... [--once] [--network testnet] [--db path]
 */

import { rpc } from "@stellar/stellar-sdk";
import { Store } from "../src/db.js";
import { applyEnvFile } from "../src/env-file.js";
import { SettlementIndexer } from "../src/indexer.js";

const RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  applyEnvFile(readFlag("env-file") ?? ".env.testnet");

  const network = readFlag("network") ?? process.env.NETWORK?.trim() ?? "testnet";
  const rpcUrl = RPC_URLS[network];
  if (!rpcUrl) throw new Error(`NETWORK must be testnet or mainnet, got ${network}`);

  const contractId = readFlag("contract") ?? process.env.SETTLEMENT_CONTRACT_ID?.trim();
  if (!contractId) throw new Error("SETTLEMENT_CONTRACT_ID is not set and --contract was not provided");

  const databasePath = readFlag("db") ?? process.env.DATABASE_PATH?.trim() ?? "onderhaus.db";
  const startLedger = positiveInteger(
    "SETTLEMENT_START_LEDGER",
    readFlag("start-ledger") ?? process.env.SETTLEMENT_START_LEDGER,
  );
  const pollIntervalMs = positiveInteger(
    "SETTLEMENT_POLL_INTERVAL_MS",
    process.env.SETTLEMENT_POLL_INTERVAL_MS,
  );
  const once = process.argv.includes("--once");

  const store = new Store(databasePath);
  const server = new rpc.Server(process.env.STELLAR_RPC_URL?.trim() || rpcUrl);
  const indexer = new SettlementIndexer({
    server,
    store,
    network,
    contractId,
    startLedger,
    pollIntervalMs,
    logger: (line) => process.stdout.write(`${line}\n`),
  });

  process.once("SIGINT", () => {
    indexer.stop();
    store.close();
    process.exit(0);
  });

  if (once) {
    const inserted = await indexer.runOnce();
    process.stdout.write(`Indexed ${inserted} new settlement${inserted === 1 ? "" : "s"}.\n`);
    store.close();
    return;
  }

  process.stdout.write(`Indexing ${contractId} on ${network} into ${databasePath}.\n`);
  await indexer.start();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${message}\n`);
  process.exitCode = 1;
});
