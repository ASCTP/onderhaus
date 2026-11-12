import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, checkStellarRecipientReady } from "@asctp/parabola";
import { formatFixed, parseFixed } from "../src/amounts.js";
import { applyEnvFile } from "../src/env-file.js";
import {
  RelayerError,
  addressBytes32,
  decodeMessageHex,
  isZeroBytes32,
  parseSettlementMessage,
  pollAttestation,
  relayerShare,
} from "../src/relayer.js";
import { fetchXlmBalanceStroops, stroopsToXlm } from "../src/stellar.js";

const ARC_DOMAIN = 26;
const STELLAR_FEE = "1000000";
const USDC_DECIMALS = 7;
const DEFAULT_MIN_PAYOUT = "0.005";

interface SettlementConfig {
  usdc: string;
  treasury: string;
  token_messenger_minter: string;
  relayer_bps: number;
}

interface SettlementReceipt {
  recipient: string;
  relayer: string;
  amount: bigint;
  fee: bigint;
  relayer_fee: bigint;
  treasury_fee: bigint;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RelayerError(`--${name} requires a value`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RelayerError(`${name} is not set in the loaded env file`);
  return value;
}

function networkPassphrase(): string {
  return STELLAR_TESTNET.networkPassphrase;
}

async function signedSubmit(
  server: rpc.Server,
  keypair: Keypair,
  operation: xdr.Operation,
): Promise<{ hash: string; response: rpc.Api.GetTransactionResponse }> {
  const account = await server.getAccount(keypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: STELLAR_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") {
    throw new RelayerError(`Stellar submission failed: ${JSON.stringify(sent)}`);
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await server.getTransaction(sent.hash);
    if (response.status === "SUCCESS") return { hash: sent.hash, response };
    if (response.status === "FAILED") throw new RelayerError(`Stellar transaction ${sent.hash} failed`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new RelayerError(`Timed out waiting for Stellar transaction ${sent.hash}`);
}

async function readConfig(
  server: rpc.Server,
  source: Keypair,
  contractId: string,
): Promise<SettlementConfig> {
  const account = await server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: STELLAR_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(new Contract(contractId).call("get_config"))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new RelayerError(`Could not read the settlement configuration: ${JSON.stringify(simulation)}`);
  }
  return scValToNative(simulation.result.retval) as SettlementConfig;
}

async function main(): Promise<void> {
  const envFile = readFlag("env-file") ?? ".env.testnet";
  if (!applyEnvFile(envFile)) throw new RelayerError(`Could not read ${envFile}`);

  const network = process.env.NETWORK?.trim() ?? "testnet";
  if (network !== "testnet") throw new RelayerError(`The relayer runs on testnet only, got ${network}`);

  const contractId = readFlag("contract");
  const burnTxHash = readFlag("burn");
  if (!contractId) throw new RelayerError("--contract is required");
  if (!burnTxHash) throw new RelayerError("--burn is required");

  const keyEnv = readFlag("relayer-key-env") ?? "STELLAR_BURNER_SECRET_KEY";
  const relayer = Keypair.fromSecret(requiredEnv(keyEnv));
  const minPayout = parseFixed(readFlag("min-payout") ?? DEFAULT_MIN_PAYOUT, USDC_DECIMALS, "Minimum payout");

  const server = new rpc.Server(STELLAR_TESTNET.sorobanRpcUrl);
  const config = await readConfig(server, relayer, contractId);

  const readiness = await checkStellarRecipientReady(relayer.publicKey(), "testnet");
  if (!readiness.exists) throw new RelayerError(`The relayer account ${relayer.publicKey()} does not exist`);
  if (!readiness.hasTrustline) {
    throw new RelayerError(`The relayer account ${relayer.publicKey()} has no USDC trustline`);
  }

  const attestation = await pollAttestation({ burnTxHash, sourceDomain: ARC_DOMAIN });
  const message = parseSettlementMessage(decodeMessageHex(attestation.message));
  const contractBytes = addressBytes32(contractId);
  if (!message.mintRecipient.equals(contractBytes)) {
    throw new RelayerError("The burn mints to a different contract");
  }
  if (!message.handler.equals(addressBytes32(config.token_messenger_minter))) {
    throw new RelayerError("The burn targets a different Stellar token messenger");
  }
  if (!isZeroBytes32(message.destinationCaller) && !message.destinationCaller.equals(contractBytes)) {
    throw new RelayerError("The burn restricts completion to a different caller");
  }
  const payout = relayerShare(message.fee, config.relayer_bps);
  const treasuryFee = message.fee - payout;

  let xlmBalance = "unreadable";
  try {
    xlmBalance = `${stroopsToXlm(await fetchXlmBalanceStroops(relayer.publicKey(), network))} XLM`;
  } catch {
    xlmBalance = "unreadable";
  }

  process.stdout.write(
    [
      "",
      `Contract:       ${contractId}`,
      `Burn:           ${burnTxHash}`,
      `Recipient:      ${message.recipient}`,
      `Fee:            ${formatFixed(message.fee, USDC_DECIMALS)} USDC`,
      `Relayer share:  ${formatFixed(payout, USDC_DECIMALS)} USDC (${config.relayer_bps} bps)`,
      `Treasury share: ${formatFixed(treasuryFee, USDC_DECIMALS)} USDC`,
      `Minimum payout: ${formatFixed(minPayout, USDC_DECIMALS)} USDC`,
      `Relayer XLM:    ${xlmBalance}`,
      "",
    ].join("\n"),
  );

  if (payout < minPayout) {
    throw new RelayerError(
      `Refusing to relay: the payout ${formatFixed(payout, USDC_DECIMALS)} USDC is below the ${formatFixed(minPayout, USDC_DECIMALS)} USDC minimum`,
    );
  }

  const result = await signedSubmit(
    server,
    relayer,
    new Contract(contractId).call(
      "settle",
      Address.fromString(relayer.publicKey()).toScVal(),
      nativeToScVal(Buffer.from(attestation.message.slice(2), "hex"), { type: "bytes" }),
      nativeToScVal(Buffer.from(attestation.attestation.slice(2), "hex"), { type: "bytes" }),
    ),
  );
  if (result.response.status !== "SUCCESS" || !result.response.returnValue) {
    throw new RelayerError(`Settlement ${result.hash} did not return a receipt`);
  }

  const receipt = scValToNative(result.response.returnValue) as SettlementReceipt;
  process.stdout.write(
    [
      `Settle tx:      ${result.hash}`,
      `Forwarded to:   ${receipt.recipient}`,
      `Minted:         ${formatFixed(receipt.amount, USDC_DECIMALS)} USDC`,
      `Relayer paid:   ${formatFixed(receipt.relayer_fee, USDC_DECIMALS)} USDC`,
      `Treasury paid:  ${formatFixed(receipt.treasury_fee, USDC_DECIMALS)} USDC`,
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${message}\n`);
  process.exitCode = 1;
});
