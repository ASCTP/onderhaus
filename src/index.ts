/**
 * Process entrypoint. Loads configuration, wires the store, signer, balance monitor, and
 * paymaster together, and starts listening. Configuration is validated before anything
 * else so a missing or malformed environment fails at boot rather than on the first
 * request that would spend money.
 *
 * The network default here is testnet. For a library a mainnet default is a reasonable
 * convenience; for a service that custodies a funded key, defaulting to the network where
 * mistakes cost real USDC and real XLM is the wrong failure mode. Mainnet is opt-in and
 * announced at startup.
 */

import { applyEnvFile } from "./env-file.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { buildServiceSigner, stroopsToXlm } from "./stellar.js";
import { BalanceMonitor } from "./balance-monitor.js";
import { Paymaster } from "./paymaster.js";
import { createApp, registerRoutes } from "./server.js";

async function main(): Promise<void> {
  const envFile = applyEnvFile();
  const config = loadConfig();
  const serviceSigner = buildServiceSigner(config.stellarSecretKey);
  const store = new Store(config.databasePath);
  const app = createApp(config);

  const balanceMonitor = new BalanceMonitor({
    publicKey: serviceSigner.publicKey,
    network: config.network,
    floorStroops: config.xlmLowBalanceFloorStroops,
    pollMs: config.xlmBalancePollMs,
    logger: app.log,
  });

  const paymaster = new Paymaster({
    config,
    store,
    serviceSigner,
    balanceMonitor,
    logger: app.log,
  });

  registerRoutes(app, { config, store, paymaster, balanceMonitor, serviceSigner });
  balanceMonitor.start();

  app.log.info(
    {
      network: config.network,
      serviceSigner: serviceSigner.publicKey,
      databasePath: config.databasePath,
      envFile: envFile ?? null,
      xlmLowBalanceFloor: stroopsToXlm(config.xlmLowBalanceFloorStroops),
      attestationPollTimeoutMs: config.attestationPollTimeoutMs,
    },
    "starting onderhaus paymaster",
  );

  if (config.network === "mainnet") {
    app.log.warn(
      "running on mainnet. Transfers move real USDC and every completed mint spends real XLM from the service account.",
    );
  }

  await app.listen({ host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    balanceMonitor.stop();
    await app.close();
    store.close();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Deliberately stderr and not the logger, since the logger may not exist yet and the
  // failure is almost always a configuration problem the operator needs to read.
  process.stderr.write(`onderhaus failed to start: ${message}\n`);
  process.exit(1);
});
