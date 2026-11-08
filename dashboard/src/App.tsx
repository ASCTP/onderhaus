import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { ProtocolStats, RelayerStat, TransferEvent, TransferPage } from "./types";
import { DailyChart } from "./components/DailyChart";
import { StatsGrid } from "./components/Stats";
import { Pager, TransferDetail, TransferFilters, TransfersTable, type Filters } from "./components/Transfers";
import { RelayersTable } from "./components/Relayers";
import { OperatorPanel } from "./components/Operator";
import { EmptyState, ErrorBanner } from "./components/Bits";

type Tab = "overview" | "transfers" | "relayers" | "operator";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "transfers", label: "Transfers" },
  { id: "relayers", label: "Relayers" },
  { id: "operator", label: "Operator" },
];

const PAGE_SIZE = 25;

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [relayers, setRelayers] = useState<RelayerStat[]>([]);
  const [page, setPage] = useState<TransferPage | null>(null);
  const [filters, setFilters] = useState<Filters>({ direction: "", status: "" });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<TransferEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStats, nextRelayers, nextPage] = await Promise.all([
        api.stats(),
        api.relayers(),
        api.transfers({
          limit: PAGE_SIZE,
          offset,
          direction: filters.direction || undefined,
          status: filters.status || undefined,
        }),
      ]);
      setStats(nextStats);
      setRelayers(nextRelayers.relayers);
      setPage(nextPage);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filters, offset]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function openTransfer(burnTxHash: string) {
    try {
      setSelected(await api.transfer(burnTxHash));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const network = stats?.network ?? "testnet";

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <div className="brand">Onderhaus</div>
          <p className="tagline">Trustless CCTP settlement on Stellar</p>
        </div>
        <div className="masthead-right">
          <span className={`badge ${network === "mainnet" ? "badge-danger" : "badge-info"}`}>{network}</span>
          <span className="live">
            <span className="dot" /> live
          </span>
          <span className="updated">
            {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString()}` : "connecting"}
          </span>
        </div>
      </header>

      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? "tab active" : "tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error ? <ErrorBanner message={error} /> : null}

      {tab === "overview" ? (
        <>
          <StatsGrid stats={stats} />
          {stats ? <DailyChart daily={stats.daily} /> : null}
          <section className="panel">
            <div className="panel-head">
              <h2>Recent transfers</h2>
              <button type="button" className="link-button" onClick={() => setTab("transfers")}>
                View all
              </button>
            </div>
            {page && page.transfers.length > 0 ? (
              <TransfersTable
                page={{ ...page, transfers: page.transfers.slice(0, 8) }}
                onSelect={(hash) => void openTransfer(hash)}
              />
            ) : (
              <EmptyState title="No transfers recorded yet">
                The dashboard reads the service ledger and imported settlement events for this network.
              </EmptyState>
            )}
          </section>
        </>
      ) : null}

      {tab === "transfers" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Transfers</h2>
            <TransferFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                setOffset(0);
              }}
            />
          </div>
          <TransfersTable page={page} onSelect={(hash) => void openTransfer(hash)} />
          <Pager page={page} onPage={setOffset} />
        </section>
      ) : null}

      {tab === "relayers" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Relayers</h2>
            <span className="muted">Permissionless settlement</span>
          </div>
          <RelayersTable relayers={relayers} />
        </section>
      ) : null}

      {tab === "operator" ? <OperatorPanel /> : null}

      <footer className="footer">
        <span>Onderhaus public dashboard</span>
        <span>{network} data, refreshed every 15 seconds</span>
      </footer>

      {selected ? <TransferDetail transfer={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
