import type { ProtocolStats } from "../types";
import { formatLatency, formatUsdc } from "../format";

export function StatsGrid({ stats }: { stats: ProtocolStats | null }) {
  if (!stats) {
    return (
      <section className="stat-grid" aria-label="Protocol statistics loading">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="stat skeleton" key={index} />
        ))}
      </section>
    );
  }

  const { totals, successRate, volumeUsdc, fees, latency, relayers, last24h } = stats;

  return (
    <section className="stat-grid" aria-label="Protocol statistics">
      <Stat label="Transfers" value={String(totals.transfers)} sub={`${totals.inProgress} in progress`} />
      <Stat
        label="Success rate"
        value={successRate === null ? "n/a" : `${(successRate * 100).toFixed(1)}%`}
        sub={`${totals.failed} failed`}
      />
      <Stat label="Volume" value={formatUsdc(volumeUsdc)} sub={`${formatUsdc(last24h.volumeUsdc)} in 24h`} />
      <Stat
        label="Fees collected"
        value={fees.length === 0 ? "not captured" : fees.map((fee) => `${fee.amount} ${fee.unit}`).join(" + ")}
        sub="protocol revenue"
      />
      <Stat label="Median latency" value={formatLatency(latency.p50Ms)} sub={`p95 ${formatLatency(latency.p95Ms)}`} />
      <Stat label="Relayers" value={String(relayers.active)} sub={`${last24h.transfers} transfers in 24h`} />
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
