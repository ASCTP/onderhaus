import type { DailyPoint } from "../types";
import { formatUsdc } from "../format";

export function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const max = Math.max(1, ...daily.map((point) => point.transfers));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Last 14 days</h2>
        <span className="muted">Transfers per UTC day</span>
      </div>
      <div className="chart" role="img" aria-label="Transfers per day over the last 14 days">
        {daily.map((point) => {
          const height = (point.transfers / max) * 100;
          const succeededShare = point.transfers === 0 ? 0 : (point.succeeded / point.transfers) * 100;
          const failedShare = point.transfers === 0 ? 0 : (point.failed / point.transfers) * 100;
          return (
            <div
              className="chart-col"
              key={point.date}
              title={`${point.date}: ${point.transfers} transfers, ${formatUsdc(point.volumeUsdc)}`}
            >
              <div className="chart-stack" style={{ height: `${height}%` }}>
                <div className="bar bar-ok" style={{ height: `${succeededShare}%` }} />
                <div className="bar bar-failed" style={{ height: `${failedShare}%` }} />
              </div>
              <span className="chart-label">{point.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
