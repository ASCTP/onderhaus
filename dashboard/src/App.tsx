import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Settlement, SettlementPage, SettlementRelayerStat, SettlementStats } from "./types";
import { DailyChart } from "./components/DailyChart";
import { SettlementStatsGrid } from "./components/SettlementStats";
import {
  SettlementDetail,
  SettlementFilters,
  SettlementPager,
  SettlementsTable,
  type Filters,
} from "./components/Settlements";
import { SettlementRelayersTable } from "./components/SettlementRelayers";
import { OperatorPanel } from "./components/Operator";
import { EmptyState, ErrorBanner } from "./components/Bits";

type Tab = "overview" | "settlements" | "relayers" | "operator";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "settlements", label: "Settlements" },
  { id: "relayers", label: "Relayers" },
  { id: "operator", label: "Operator" },
];

const PAGE_SIZE = 25;

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<SettlementStats | null>(null);
  const [relayers, setRelayers] = useState<SettlementRelayerStat[]>([]);
  const [page, setPage] = useState<SettlementPage | null>(null);
  const [filters, setFilters] = useState<Filters>({ relayer: "", sourceDomain: "" });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStats, nextRelayers, nextPage] = await Promise.all([
        api.settlementStats(),
        api.settlementRelayers(),
        api.settlements({
          limit: PAGE_SIZE,
          offset,
          relayer: filters.relayer || undefined,
          sourceDomain: filters.sourceDomain === "" ? undefined : Number(filters.sourceDomain),
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
            <span className="dot" /> on chain
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
          <SettlementStatsGrid stats={stats} />
          {stats ? <DailyChart daily={stats.daily} /> : null}
          <section className="panel">
            <div className="panel-head">
              <h2>Recent settlements</h2>
              <button type="button" className="link-button" onClick={() => setTab("settlements")}>
                View all
              </button>
            </div>
            {page && page.settlements.length > 0 ? (
              <SettlementsTable
                page={{ ...page, settlements: page.settlements.slice(0, 8) }}
                onSelect={(settlement) => setSelected(settlement)}
              />
            ) : (
              <EmptyState title="No settlements indexed yet">
                Run the settlement indexer to read settlement events from the contract.
              </EmptyState>
            )}
          </section>
        </>
      ) : null}

      {tab === "settlements" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Settlements</h2>
            <SettlementFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                setOffset(0);
              }}
            />
          </div>
          <SettlementsTable page={page} onSelect={(settlement) => setSelected(settlement)} />
          <SettlementPager page={page} onPage={setOffset} />
        </section>
      ) : null}

      {tab === "relayers" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Relayers</h2>
            <span className="muted">Permissionless settlement</span>
          </div>
          <SettlementRelayersTable relayers={relayers} />
        </section>
      ) : null}

      {tab === "operator" ? <OperatorPanel /> : null}

      <footer className="footer">
        <span>Onderhaus public dashboard</span>
        <span>{network} settlement events, refreshed every 15 seconds</span>
      </footer>

      {selected ? <SettlementDetail settlement={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
