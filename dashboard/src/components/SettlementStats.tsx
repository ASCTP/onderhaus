import type { SettlementStats } from "../types";
import { formatUsdc } from "../format";

export function SettlementStatsGrid({ stats }: { stats: SettlementStats | null }) {
  if (!stats) {
    return (
      <section className="stat-grid" aria-label="Settlement statistics loading">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="stat skeleton" key={index} />
        ))}
      </section>
    );
  }

  return (
    <section className="stat-grid" aria-label="Settlement statistics">
      <Stat
        label="Settlements"
        value={String(stats.totals.settlements)}
        sub={`${stats.last24h.settlements} in the last 24h`}
      />
      <Stat label="Volume" value={formatUsdc(stats.volumeUsdc)} sub={`${formatUsdc(stats.last24h.volumeUsdc)} in 24h`} />
      <Stat label="Fees" value={formatUsdc(stats.feesUsdc)} sub={`${formatUsdc(stats.last24h.feesUsdc)} in 24h`} />
      <Stat label="Relayer share" value={formatUsdc(stats.relayerFeesUsdc)} sub="paid to submitters" />
      <Stat label="Treasury share" value={formatUsdc(stats.treasuryFeesUsdc)} sub="retained by the contract" />
      <Stat label="Relayers" value={String(stats.totals.relayers)} sub={`${stats.totals.recipients} recipients`} />
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}
