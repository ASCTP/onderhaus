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
