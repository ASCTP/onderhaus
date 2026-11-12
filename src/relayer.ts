import { StrKey } from "@stellar/stellar-sdk";

export class RelayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerError";
  }
}

export interface SettlementMessage {
  amount: bigint;
  fee: bigint;
  recipient: string;
  handler: Buffer;
  mintRecipient: Buffer;
  destinationCaller: Buffer;
}

export interface Attestation {
  message: string;
  attestation: string;
}

export interface AttestationOptions {
  burnTxHash: string;
  sourceDomain: number;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const BODY_START = 148;
const HEADER_RECIPIENT_OFFSET = 76;
const HEADER_DESTINATION_CALLER_OFFSET = 108;
const BODY_AMOUNT_OFFSET = BODY_START + 68;
const BODY_MINT_RECIPIENT_OFFSET = BODY_START + 36;
const BODY_HOOK_OFFSET = BODY_START + 228;
const HOOK_VERSION_OFFSET = 24;
const HOOK_LENGTH_OFFSET = 28;
const HOOK_RECIPIENT_OFFSET = 32;
const HOOK_HEADER_LEN = 32;
const FEE_PAYLOAD_LEN = 16;
const BPS_DENOMINATOR = 10_000n;
const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com/v2";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 600_000;

export function parseSettlementMessage(message: Buffer): SettlementMessage {
  if (message.length < BODY_HOOK_OFFSET) {
    throw new RelayerError("The CCTP message is shorter than a full burn body with hook data");
  }

  const hook = message.subarray(BODY_HOOK_OFFSET);
  if (hook.length < HOOK_HEADER_LEN) {
    throw new RelayerError("The CCTP message has no complete hook header");
  }

  const version = hook.readUInt32BE(HOOK_VERSION_OFFSET);
  if (version !== 0) {
    throw new RelayerError(`Unsupported hook version ${version}`);
  }

  const recipientLength = hook.readUInt32BE(HOOK_LENGTH_OFFSET);
  const recipientEnd = HOOK_RECIPIENT_OFFSET + recipientLength;
  if (hook.length < recipientEnd) {
    throw new RelayerError("The hook recipient is shorter than its declared length");
  }

  const recipient = hook.subarray(HOOK_RECIPIENT_OFFSET, recipientEnd).toString("utf8");
  if (
    !StrKey.isValidEd25519PublicKey(recipient) &&
    !StrKey.isValidContract(recipient) &&
    !StrKey.isValidMed25519PublicKey(recipient)
  ) {
    throw new RelayerError(`The hook recipient is not a valid Stellar address: ${recipient}`);
  }

  const trailing = hook.length - recipientEnd;
  let fee = 0n;
  if (trailing === FEE_PAYLOAD_LEN) {
    fee = readI128(hook.subarray(recipientEnd, recipientEnd + FEE_PAYLOAD_LEN));
    if (fee < 0n) throw new RelayerError("The hook fee is negative");
  } else if (trailing !== 0) {
    throw new RelayerError(`The hook has ${trailing} trailing bytes, expected 0 or 16`);
  }

  const amount = readU256(message.subarray(BODY_AMOUNT_OFFSET, BODY_AMOUNT_OFFSET + 32));
  return {
    amount,
    fee,
    recipient,
    handler: readBytes32(message, HEADER_RECIPIENT_OFFSET),
    mintRecipient: readBytes32(message, BODY_MINT_RECIPIENT_OFFSET),
    destinationCaller: readBytes32(message, HEADER_DESTINATION_CALLER_OFFSET),
  };
}

export function isZeroBytes32(value: Buffer): boolean {
  return value.length === 32 && value.every((byte) => byte === 0);
}

export function addressBytes32(address: string): Buffer {
  if (!StrKey.isValidContract(address)) {
    throw new RelayerError(`Expected a Stellar contract address, got ${address}`);
  }
  return Buffer.from(StrKey.decodeContract(address));
}

export function relayerShare(fee: bigint, relayerBps: number): bigint {
  if (!Number.isInteger(relayerBps) || relayerBps < 0 || relayerBps > 10_000) {
    throw new RelayerError(`Relayer basis points must be an integer from 0 to 10000, got ${relayerBps}`);
  }
  if (fee < 0n) throw new RelayerError("The fee is negative");
  return (fee * BigInt(relayerBps)) / BPS_DENOMINATOR;
}

export function decodeMessageHex(message: string): Buffer {
  if (!/^0x[0-9a-fA-F]*$/.test(message) || message.length % 2 !== 0) {
    throw new RelayerError("The CCTP message is not a 0x-prefixed hex string");
  }
  return Buffer.from(message.slice(2), "hex");
}

export async function pollAttestation(options: AttestationOptions): Promise<Attestation> {
  const baseUrl = options.baseUrl ?? IRIS_SANDBOX;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl}/messages/${options.sourceDomain}?transactionHash=${options.burnTxHash}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetchImpl(url);
    if (response.ok) {
      const body = (await response.json()) as {
        messages?: { status?: string; message?: string; attestation?: string }[];
      };
      const complete = body.messages?.find(
        (entry) => entry.status === "complete" && entry.message && entry.attestation,
      );
      if (complete?.message && complete.attestation) {
        return { message: complete.message, attestation: complete.attestation };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new RelayerError(`Timed out waiting for an Iris attestation of ${options.burnTxHash}`);
}

function readU256(bytes: Buffer): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function readI128(bytes: Buffer): bigint {
  return BigInt.asIntN(128, readU256(bytes));
}

function readBytes32(message: Buffer, offset: number): Buffer {
  return Buffer.from(message.subarray(offset, offset + 32));
}
