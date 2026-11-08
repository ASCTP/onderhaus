import type {
  OperatorStatus,
  ProtocolStats,
  RelayerStat,
  TransferEvent,
  TransferPage,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // fall through to the status text
  }
  return `${response.status} ${response.statusText}`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

export interface TransferRequest {
  limit?: number;
  offset?: number;
  direction?: string;
  status?: string;
}

export const api = {
  stats: (): Promise<ProtocolStats> => getJson<ProtocolStats>("/v1/public/stats"),

  transfers: (params: TransferRequest = {}): Promise<TransferPage> => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const suffix = search.toString();
    return getJson<TransferPage>(`/v1/public/transfers${suffix === "" ? "" : `?${suffix}`}`);
  },

  transfer: (burnTxHash: string): Promise<TransferEvent> =>
    getJson<TransferEvent>(`/v1/public/transfers/${encodeURIComponent(burnTxHash)}`),

  relayers: (): Promise<{ relayers: RelayerStat[] }> =>
    getJson<{ relayers: RelayerStat[] }>("/v1/public/relayers"),

  operatorStatus: async (key: string): Promise<OperatorStatus> => {
    const response = await fetch(`${BASE}/v1/status`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return (await response.json()) as OperatorStatus;
  },
};
