/**
 * Process entrypoint. Loads configuration, wires the store, signers, balance monitors, and
 * paymaster together, and starts listening. Configuration is validated before anything else
 * so a missing or malformed environment fails at boot rather than on the first request that
 * would spend money.
 *
 * The reverse direction is built here and only here. ARC_SECRET_KEY is what turns it on, so
 * a deployment that holds one funded key serves one direction and never polls an account it
 * cannot sign for. Both legs are composed into the same list the probes and the status
 * endpoint read, which is also what the shutdown path walks to stop the timers.
 *
 * The network default here is testnet. For a library a mainnet default is a reasonable
 * convenience; for a service that custodies a funded key, defaulting to the network where
 * mistakes cost real USDC and real XLM is the wrong failure mode. Mainnet is opt-in and
 * announced at startup.
 */

import { applyEnvFile } from "./env-file.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { buildServiceSigner, fetchXlmBalanceStroops, stroopsToXlm } from "./stellar.js";
import { arcRpcUrlFor, buildArcServiceSigner, fetchArcUsdcBalanceWei, weiToUsdc } from "./arc.js";
import { BalanceMonitor } from "./balance-monitor.js";
import { Paymaster } from "./paymaster.js";
import { createApp, registerRoutes } from "./server.js";
import type { RouteLeg } from "./server.js";

async function main(): Promise<void> {
  const envFile = applyEnvFile();
  const config = loadConfig();
  const serviceSigner = buildServiceSigner(config.stellarSecretKey);
  const store = new Store(config.databasePath);
  const app = createApp(config);

  const balanceMonitor = new BalanceMonitor({
    account: serviceSigner.publicKey,
    unit: "XLM",
    floor: config.xlmLowBalanceFloorStroops,
    pollMs: config.xlmBalancePollMs,
    logger: app.log,
    read: () => fetchXlmBalanceStroops(serviceSigner.publicKey, config.network),
  });

  const legs: RouteLeg[] = [
    {
      direction: "arc->stellar",
      unit: "XLM",
      account: serviceSigner.publicKey,
      monitor: balanceMonitor,
      format: stroopsToXlm,
    },
  ];

  const arcRpcUrl = arcRpcUrlFor(config.network, config.arcRpcUrl);
  const arcServiceSigner = config.arcSecretKey
    ? buildArcServiceSigner(config.arcSecretKey, config.network, arcRpcUrl)
    : undefined;

  let arcBalanceMonitor: BalanceMonitor | undefined;
  if (arcServiceSigner) {
    const { address } = arcServiceSigner;
    arcBalanceMonitor = new BalanceMonitor({
      account: address,
      unit: "USDC",
      floor: config.usdcLowBalanceFloorWei,
      pollMs: config.usdcBalancePollMs,
      logger: app.log,
      read: () => fetchArcUsdcBalanceWei(address, config.network, arcRpcUrl),
    });
    legs.push({
      direction: "stellar->arc",
      unit: "USDC",
      account: address,
      monitor: arcBalanceMonitor,
      format: (wei) => weiToUsdc(wei, config.network),
    });
  }

  const paymaster = new Paymaster({
    config,
    store,
    serviceSigner,
    balanceMonitor,
    arcServiceSigner,
    arcBalanceMonitor,
    logger: app.log,
  });

  registerRoutes(app, { config, store, paymaster, legs });
  balanceMonitor.start();
  arcBalanceMonitor?.start();

  app.log.info(
    {
      network: config.network,
      stellarSigner: serviceSigner.publicKey,
      arcSigner: arcServiceSigner?.address ?? null,
      directions: legs.map((leg) => leg.direction),
      databasePath: config.databasePath,
      envFile: envFile ?? null,
      xlmLowBalanceFloor: stroopsToXlm(config.xlmLowBalanceFloorStroops),
      usdcLowBalanceFloor: weiToUsdc(config.usdcLowBalanceFloorWei, config.network),
      attestationPollTimeoutMs: config.attestationPollTimeoutMs,
    },
    "starting onderhaus paymaster",
  );

  if (!arcServiceSigner) {
    app.log.info(
      "ARC_SECRET_KEY is not set, so stellar to arc is not offered and no Arc balance is polled. Set it to a funded Arc account to enable the reverse direction.",
    );
  }

  if (config.network === "mainnet") {
    app.log.warn(
      "running on mainnet. Transfers move real USDC and every completed transfer spends from a real funded account.",
    );
  }

  await app.listen({ host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    balanceMonitor.stop();
    arcBalanceMonitor?.stop();
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
