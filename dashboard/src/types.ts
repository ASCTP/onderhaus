export type TransferDirection = "arc->stellar" | "stellar->arc";
export type TransferStatus = "in_progress" | "succeeded" | "failed";

export interface TransferEvent {
  id: number;
  burnTxHash: string;
  network: string;
  direction: TransferDirection;
  recipient: string;
  amount: string | null;
  amountUnit: string;
  fee: string | null;
  feeUnit: string | null;
  relayer: string | null;
  status: TransferStatus;
  mintTxHash: string | null;
  attestationHash: string | null;
  error: string | null;
  sourceChain: string;
  destinationChain: string;
  submittedAt: string;
  settledAt: string | null;
  latencyMs: number | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransferPage {
  transfers: TransferEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface DailyPoint {
  date: string;
  transfers: number;
  succeeded: number;
  failed: number;
  volumeUsdc: string;
}

export interface FeeTotal {
  unit: string;
  amount: string;
}

export interface ProtocolStats {
  network: string;
  generatedAt: string;
  totals: {
    transfers: number;
    succeeded: number;
    failed: number;
    inProgress: number;
  };
  successRate: number | null;
  volumeUsdc: string;
  fees: FeeTotal[];
  latency: { p50Ms: number | null; p95Ms: number | null };
  relayers: { active: number };
  last24h: { transfers: number; volumeUsdc: string };
  daily: DailyPoint[];
}

export interface RelayerStat {
  relayer: string;
  completed: number;
  volumeUsdc: string;
  lastSeenAt: string;
}

export interface OperatorLeg {
  direction: string;
  unit: string;
  account: string;
  balance: string | null;
  floor: string;
  halted: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface OperatorStatus {
  network: string;
  legs: OperatorLeg[];
  usage: {
    mintsToday: number;
    dailyMintCap: number | null;
    rateLimitPerMinute: number;
  };
  mints: Record<string, number>;
}

export interface Settlement {
  id: number;
  network: string;
  contractId: string;
  sourceDomain: number;
  nonce: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  recipient: string;
  relayer: string;
  amount: string;
  fee: string;
  relayerFee: string;
  treasuryFee: string;
  indexedAt: string;
}

export interface SettlementPage {
  settlements: Settlement[];
  total: number;
  limit: number;
  offset: number;
}

export interface SettlementDailyPoint {
  date: string;
  settlements: number;
  volumeUsdc: string;
  feesUsdc: string;
  relayerFeesUsdc: string;
  treasuryFeesUsdc: string;
}

export interface SettlementStats {
  network: string;
  generatedAt: string;
  totals: {
    settlements: number;
    relayers: number;
    recipients: number;
  };
  volumeUsdc: string;
  feesUsdc: string;
  relayerFeesUsdc: string;
  treasuryFeesUsdc: string;
  last24h: {
    settlements: number;
    volumeUsdc: string;
    feesUsdc: string;
  };
  daily: SettlementDailyPoint[];
}

export interface SettlementRelayerStat {
  relayer: string;
  settlements: number;
  volumeUsdc: string;
  feesUsdc: string;
  relayerFeesUsdc: string;
  treasuryFeesUsdc: string;
  lastSeenAt: string;
}
