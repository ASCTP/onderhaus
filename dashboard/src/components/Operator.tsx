import { useState } from "react";
import { api } from "../api";
import type { OperatorStatus } from "../types";
import { ErrorBanner } from "./Bits";

const STORAGE_KEY = "onderhaus.operator.key";

export function OperatorPanel() {
  const [key, setKey] = useState(() => sessionStorage.getItem(STORAGE_KEY) ?? "");
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const trimmed = key.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.operatorStatus(trimmed);
      sessionStorage.setItem(STORAGE_KEY, trimmed);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="operator">
      <section className="panel">
        <div className="panel-head">
          <h2>Operator access</h2>
          <span className="muted">Authenticated</span>
        </div>
        <p className="muted">
          Reads service balances and usage. The key can spend funds, so it stays in this tab only and is cleared when
          the tab closes.
        </p>
        <form
          className="key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            placeholder="ohk_..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Loading" : "Load status"}
          </button>
        </form>
        {error ? <ErrorBanner message={error} /> : null}
      </section>

      {status ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Legs</h2>
              <span className="muted">{status.network}</span>
            </div>
            <div className="leg-grid">
              {status.legs.map((leg) => (
                <div className="leg" key={leg.direction}>
                  <div className="leg-head">
                    <strong>{leg.direction}</strong>
                    <span className={leg.halted ? "pill pill-failed" : "pill pill-succeeded"}>
                      {leg.halted ? "halted" : "ready"}
                    </span>
                  </div>
                  <dl className="leg-fields">
                    <div>
                      <dt>Balance</dt>
                      <dd>{leg.balance === null ? "unconfirmed" : `${leg.balance} ${leg.unit}`}</dd>
                    </div>
                    <div>
                      <dt>Floor</dt>
                      <dd>
                        {leg.floor} {leg.unit}
                      </dd>
                    </div>
                    <div>
                      <dt>Account</dt>
                      <dd className="mono">{leg.account}</dd>
                    </div>
                    <div>
                      <dt>Last checked</dt>
                      <dd>{leg.lastCheckedAt ? new Date(leg.lastCheckedAt).toLocaleString() : "never"}</dd>
                    </div>
                  </dl>
                  {leg.lastError ? <p className="error-note">{leg.lastError}</p> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Usage</h2>
              <span className="muted">This key</span>
            </div>
            <div className="usage-grid">
              <div>
                <span className="stat-label">Today</span>
                <strong>{status.usage.mintsToday}</strong>
              </div>
              <div>
                <span className="stat-label">Daily cap</span>
                <strong>{status.usage.dailyMintCap ?? "none"}</strong>
              </div>
              <div>
                <span className="stat-label">Rate limit</span>
                <strong>{status.usage.rateLimitPerMinute}/min</strong>
              </div>
              <div>
                <span className="stat-label">Succeeded</span>
                <strong>{status.mints.succeeded ?? 0}</strong>
              </div>
              <div>
                <span className="stat-label">Failed</span>
                <strong>{status.mints.failed ?? 0}</strong>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
