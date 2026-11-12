import type { SettlementDailyPoint } from "../types";
import { formatUsdc } from "../format";

export function DailyChart({ daily }: { daily: SettlementDailyPoint[] }) {
  const max = Math.max(1, ...daily.map((point) => point.settlements));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Last 14 days</h2>
        <span className="muted">Settlements per UTC day</span>
      </div>
      <div className="chart" role="img" aria-label="Settlements per day over the last 14 days">
        {daily.map((point) => {
          const height = (point.settlements / max) * 100;
          return (
            <div
              className="chart-col"
              key={point.date}
              title={`${point.date}: ${point.settlements} settlements, ${formatUsdc(point.volumeUsdc)} volume, ${formatUsdc(point.feesUsdc)} fees`}
            >
              <div className="chart-stack" style={{ height: `${height}%` }}>
                <div className="bar bar-ok" style={{ height: "100%" }} />
              </div>
              <span className="chart-label">{point.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
