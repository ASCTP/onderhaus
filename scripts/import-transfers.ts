/**
 * Imports settlement events into the public read model.
 *
 * The service ledger only knows what the paymaster itself did. A transfer completed by
 * another relayer, or before the read model existed, reaches the dashboard through this
 * command until the chain indexer replaces it. Input is either a JSON array or one JSON
 * object per line. Re-importing the same burn hash updates the existing row.
 *
 * Usage: pnpm transfer:import -- --file transfers.json [--network testnet] [--db path]
 */

import { readFileSync } from "node:fs";
import { applyEnvFile } from "../src/env-file.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import type { TransferDirection, TransferImport, TransferStatus } from "../src/analytics.js";
import { TRANSFER_DIRECTIONS, TRANSFER_STATUSES } from "../src/analytics.js";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function parseEntries(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("The input file is empty.");
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("The input file must be a JSON array or newline-delimited objects.");
    return parsed;
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Line ${index + 1} is not valid JSON: ${message}`);
      }
    });
}

function requireString(entry: Record<string, unknown>, field: string, index: number): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Entry ${index + 1} is missing a non-empty "${field}".`);
  }
  return value.trim();
}

function optionalString(entry: Record<string, unknown>, field: string, index: number): string | null {
  const value = entry[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Entry ${index + 1} has a non-string "${field}".`);
  return value;
}

function toImport(entry: unknown, index: number, defaultNetwork: string): TransferImport {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Entry ${index + 1} is not an object.`);
  }
  const record = entry as Record<string, unknown>;

  const direction = requireString(record, "direction", index);
  if (!TRANSFER_DIRECTIONS.includes(direction as TransferDirection)) {
    throw new Error(`Entry ${index + 1} has an unknown direction "${direction}".`);
  }

  const status = requireString(record, "status", index);
  if (!TRANSFER_STATUSES.includes(status as TransferStatus)) {
    throw new Error(`Entry ${index + 1} has an unknown status "${status}".`);
  }

  const submittedAt = requireString(record, "submittedAt", index);
  if (Number.isNaN(Date.parse(submittedAt))) {
    throw new Error(`Entry ${index + 1} has an unparseable submittedAt "${submittedAt}".`);
  }

  const settledAt = optionalString(record, "settledAt", index);
  if (settledAt !== null && Number.isNaN(Date.parse(settledAt))) {
    throw new Error(`Entry ${index + 1} has an unparseable settledAt "${settledAt}".`);
  }

  return {
    burnTxHash: requireString(record, "burnTxHash", index),
    network: optionalString(record, "network", index) ?? defaultNetwork,
    direction: direction as TransferDirection,
    recipient: requireString(record, "recipient", index),
    amount: optionalString(record, "amount", index),
    amountUnit: optionalString(record, "amountUnit", index) ?? "USDC",
    fee: optionalString(record, "fee", index),
    feeUnit: optionalString(record, "feeUnit", index),
    relayer: optionalString(record, "relayer", index),
    status: status as TransferStatus,
    mintTxHash: optionalString(record, "mintTxHash", index),
    attestationHash: optionalString(record, "attestationHash", index),
    error: optionalString(record, "error", index),
    submittedAt,
    settledAt,
    origin: optionalString(record, "origin", index) ?? "import",
  };
}

function main(): void {
  const file = readFlag("file");
  if (!file) {
    throw new Error(
      "Provide an input file, for example: pnpm transfer:import -- --file transfers.json",
    );
  }

  applyEnvFile();
  const config = loadConfig();
  const network = readFlag("network") ?? config.network;
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error('--network must be "mainnet" or "testnet".');
  }

  const store = new Store(readFlag("db") ?? config.databasePath);
  try {
    const entries = parseEntries(readFileSync(file, "utf8"));
    let imported = 0;
    for (const [index, entry] of entries.entries()) {
      const event = store.importTransferEvent(toImport(entry, index, network));
      imported += 1;
      process.stdout.write(`  ${event.burnTxHash.slice(0, 12)}...  ${event.direction}  ${event.status}\n`);
    }
    process.stdout.write(`\nImported ${imported} transfer${imported === 1 ? "" : "s"} on ${network}.\n`);
  } finally {
    store.close();
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
