/**
 * Lists issued API keys by label, id, cap, and rate limit, plus today's usage.
 *
 * Raw keys are not recoverable, so this prints the label and id rather than anything that
 * identifies the credential itself.
 */

import { applyEnvFile } from "../src/env-file.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";

function main(): void {
  applyEnvFile();
  const config = loadConfig();
  const store = new Store(config.databasePath);
  try {
    const keys = store.listApiKeys();
    if (keys.length === 0) {
      process.stdout.write("No API keys have been created yet.\n");
      return;
    }

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();

    process.stdout.write(`\nKeys on ${config.network} (${config.databasePath})\n\n`);
    for (const key of keys) {
      const used = store.countBillableMintsSince(key.id, since);
      const cap = key.dailyMintCap ?? "unlimited";
      const state = key.disabled ? "disabled" : "active";
      process.stdout.write(
        `  #${key.id}  ${key.label}  [${state}]  used ${used}/${cap} today  ${key.rateLimitPerMinute} rpm\n`,
      );
    }
    process.stdout.write("\n");
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
