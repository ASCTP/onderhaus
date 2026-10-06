/**
 * Loads a .env file into process.env for local development.
 *
 * Two deliberate properties. Variables already present in the environment are never
 * overwritten, so a real environment variable always beats a value in the file, which is
 * what makes this safe to leave in a service that also runs in a container where
 * configuration arrives as actual environment variables. And a missing file is not an
 * error, so a deployment that supplies its configuration entirely through the environment
 * does not have to create an empty file to satisfy the loader.
 *
 * Only the process entry points call this. loadConfig() stays a pure function of the
 * environment it is handed, so tests cannot be influenced by a stray .env on disk.
 */

import { config as parseEnvFile } from "dotenv";

export function applyEnvFile(path = ".env"): string | undefined {
  const result = parseEnvFile({ path, quiet: true });
  return result.error ? undefined : path;
}
