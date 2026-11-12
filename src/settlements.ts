import { scValToNative, xdr } from "@stellar/stellar-sdk";

export class SettlementIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementIndexError";
  }
}

export interface ParsedSettlement {
  readonly sourceDomain: number;
  readonly nonce: string;
  readonly recipient: string;
  readonly relayer: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly relayerFee: bigint;
  readonly treasuryFee: bigint;
}

export interface SettlementRecord {
  readonly id: number;
  readonly network: string;
  readonly contractId: string;
  readonly sourceDomain: number;
  readonly nonce: string;
  readonly txHash: string;
  readonly ledger: number;
  readonly ledgerClosedAt: string;
  readonly recipient: string;
  readonly relayer: string;
  readonly amount: string;
  readonly fee: string;
  readonly relayerFee: string;
  readonly treasuryFee: string;
  readonly indexedAt: string;
}

export interface SettlementInsert {
  readonly network: string;
  readonly contractId: string;
  readonly sourceDomain: number;
  readonly nonce: string;
  readonly txHash: string;
  readonly ledger: number;
  readonly ledgerClosedAt: string;
  readonly recipient: string;
  readonly relayer: string;
  readonly amount: string;
  readonly fee: string;
  readonly relayerFee: string;
  readonly treasuryFee: string;
}

export interface SettlementQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly relayer?: string;
  readonly recipient?: string;
  readonly sourceDomain?: number;
}

export interface SettlementPage {
  readonly settlements: readonly SettlementRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SettlementDailyPoint {
  readonly date: string;
  readonly settlements: number;
  readonly volumeUsdc: string;
  readonly feesUsdc: string;
  readonly relayerFeesUsdc: string;
  readonly treasuryFeesUsdc: string;
}

export interface SettlementStats {
  readonly network: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly settlements: number;
    readonly relayers: number;
    readonly recipients: number;
  };
  readonly volumeUsdc: string;
  readonly feesUsdc: string;
  readonly relayerFeesUsdc: string;
  readonly treasuryFeesUsdc: string;
  readonly last24h: {
    readonly settlements: number;
    readonly volumeUsdc: string;
    readonly feesUsdc: string;
  };
  readonly daily: readonly SettlementDailyPoint[];
}

export interface SettlementRelayerStat {
  readonly relayer: string;
  readonly settlements: number;
  readonly volumeUsdc: string;
  readonly feesUsdc: string;
  readonly relayerFeesUsdc: string;
  readonly treasuryFeesUsdc: string;
  readonly lastSeenAt: string;
}

export function messageId(sourceDomain: number, nonce: string): string {
  return `${sourceDomain}:${nonce}`;
}

export function parseSettlementEvent(
  topics: readonly xdr.ScVal[],
  value: xdr.ScVal,
): ParsedSettlement {
  if (topics.length !== 3) {
    throw new SettlementIndexError(`Expected 3 event topics, got ${topics.length}`);
  }
  const [nameTopic, recipientTopic, relayerTopic] = topics;
  if (!nameTopic || !recipientTopic || !relayerTopic) {
    throw new SettlementIndexError("The settlement event is missing a topic");
  }
  const name = scValToNative(nameTopic);
  if (name !== "settled") {
    throw new SettlementIndexError(`Expected a settled event, got ${String(name)}`);
  }

  const recipient = addressFromTopic(recipientTopic, "recipient");
  const relayer = addressFromTopic(relayerTopic, "relayer");
  const data = scValToNative(value);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new SettlementIndexError("The settlement event value is not a map");
  }
  const fields = data as Record<string, unknown>;

  const sourceDomain = positiveInteger(fields.source_domain, "source_domain");
  const nonce = nonceHex(fields.nonce);
  const amount = positiveBigInt(fields.amount, "amount");
  const fee = nonNegativeBigInt(fields.fee, "fee");
  const relayerFee = nonNegativeBigInt(fields.relayer_fee, "relayer_fee");
  const treasuryFee = nonNegativeBigInt(fields.treasury_fee, "treasury_fee");

  if (fee > amount) throw new SettlementIndexError("The settlement fee is larger than the amount");
  if (relayerFee + treasuryFee !== fee) {
    throw new SettlementIndexError("The relayer and treasury fees do not add up to the total fee");
  }

  return { sourceDomain, nonce, recipient, relayer, amount, fee, relayerFee, treasuryFee };
}

function addressFromTopic(topic: xdr.ScVal, field: string): string {
  const value = scValToNative(topic);
  if (typeof value !== "string" || value === "") {
    throw new SettlementIndexError(`The settlement ${field} is not an address string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SettlementIndexError(`The settlement ${field} is not a non-negative integer`);
  }
  return value;
}

function nonceHex(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new SettlementIndexError("The settlement nonce is not 32 bytes");
  }
  return Buffer.from(value).toString("hex");
}

function positiveBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new SettlementIndexError(`The settlement ${field} is not a positive integer`);
  }
  return value;
}

function nonNegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new SettlementIndexError(`The settlement ${field} is not a non-negative integer`);
  }
  return value;
}
