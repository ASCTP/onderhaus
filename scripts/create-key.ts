/**
 * Creates an API key and prints it once. Only the SHA-256 hash is stored, so a key that is
 * lost cannot be recovered from the database and must be rotated by creating a new one.
 *
 * This is the provisioning step for the off-band billing model: keys are issued out of
 * band, and usage is metered per key in the ledger so it can be invoiced separately.
 *
 * Usage: pnpm key:create -- --label "acme" --daily-cap 500 --rate-limit 120
 */

import { applyEnvFile } from "../src/env-file.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function main(): void {
  const label = readFlag("label");
  if (!label) {
    throw new Error('Provide a label, for example: pnpm key:create -- --label "acme"');
  }

  const dailyCapRaw = readFlag("daily-cap");
  const dailyCap = dailyCapRaw === undefined || dailyCapRaw === "none" ? null : Number(dailyCapRaw);
  if (dailyCap !== null && (!Number.isInteger(dailyCap) || dailyCap <= 0)) {
    throw new Error("--daily-cap must be a positive integer, or none for unlimited");
  }

  const rateLimitRaw = readFlag("rate-limit");
  const rateLimit = rateLimitRaw === undefined ? 60 : Number(rateLimitRaw);
  if (!Number.isInteger(rateLimit) || rateLimit <= 0) {
    throw new Error("--rate-limit must be a positive integer");
  }

  applyEnvFile();
  const config = loadConfig();
  const store = new Store(config.databasePath);
  try {
    const { rawKey, record } = store.createApiKey(label, dailyCap, rateLimit);
    process.stdout.write(
      [
        "",
        "API key created. This is the only time it will be shown.",
        "",
        `  key:           ${rawKey}`,
        `  id:            ${record.id}`,
        `  label:         ${record.label}`,
        `  daily cap:     ${record.dailyMintCap ?? "unlimited"} completions`,
        `  rate limit:    ${record.rateLimitPerMinute} requests per minute`,
        `  network:       ${config.network}`,
        "",
      ].join("\n"),
    );
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
