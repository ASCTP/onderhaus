import type { Settlement, SettlementPage } from "../types";
import { explorerUrl, formatRelative, formatUsdc, shortHash } from "../format";
import { CopyButton, EmptyState } from "./Bits";

export interface Filters {
  relayer: string;
  sourceDomain: string;
}

export function SettlementFilters({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="filters">
      <label>
        <span>Relayer</span>
        <input
          value={filters.relayer}
          placeholder="G..."
          onChange={(event) => onChange({ ...filters, relayer: event.target.value.trim() })}
        />
      </label>
      <label>
        <span>Source</span>
        <select
          value={filters.sourceDomain}
          onChange={(event) => onChange({ ...filters, sourceDomain: event.target.value })}
        >
          <option value="">All</option>
          <option value="26">Arc</option>
        </select>
      </label>
    </div>
  );
}

export function SettlementsTable({
  page,
  onSelect,
}: {
  page: SettlementPage | null;
  onSelect: (settlement: Settlement) => void;
}) {
  if (!page) {
    return (
      <div className="table-wrap">
        <div className="table-loading">Loading settlements</div>
      </div>
    );
  }
  if (page.settlements.length === 0) {
    return (
      <EmptyState title="No settlements indexed yet">
        Run the settlement indexer to read settlement events from the contract.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Message</th>
            <th>Amount</th>
            <th>Fee</th>
            <th>Recipient</th>
            <th>Relayer fee</th>
            <th>Treasury fee</th>
            <th>Relayer</th>
          </tr>
        </thead>
        <tbody>
          {page.settlements.map((settlement) => (
            <tr
              key={settlement.id}
              tabIndex={0}
              onClick={() => onSelect(settlement)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(settlement);
                }
              }}
            >
              <td title={new Date(settlement.ledgerClosedAt).toLocaleString()}>
                {formatRelative(settlement.ledgerClosedAt)}
              </td>
              <td className="mono" title={`${settlement.sourceDomain}:${settlement.nonce}`}>
                {settlement.sourceDomain}:{shortHash(settlement.nonce, 8, 6)}
              </td>
              <td>{formatUsdc(settlement.amount)}</td>
              <td>{formatUsdc(settlement.fee)}</td>
              <td className="mono" title={settlement.recipient}>
                {shortHash(settlement.recipient, 6, 4)}
              </td>
              <td>{formatUsdc(settlement.relayerFee)}</td>
              <td>{formatUsdc(settlement.treasuryFee)}</td>
              <td className="mono" title={settlement.relayer}>
                {shortHash(settlement.relayer, 6, 4)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettlementPager({ page, onPage }: { page: SettlementPage | null; onPage: (offset: number) => void }) {
  if (!page) return null;
  const start = page.total === 0 ? 0 : page.offset + 1;
  const end = Math.min(page.total, page.offset + page.settlements.length);
  return (
    <div className="pager">
      <span className="muted">
        {start}-{end} of {page.total}
      </span>
      <div className="pager-buttons">
        <button type="button" disabled={page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>
          Previous
        </button>
        <button
          type="button"
          disabled={page.offset + page.limit >= page.total}
          onClick={() => onPage(page.offset + page.limit)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function SettlementDetail({ settlement, onClose }: { settlement: Settlement; onClose: () => void }) {
  const txLink = explorerUrl("stellar", settlement.network, settlement.txHash);

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label="Settlement detail">
        <div className="drawer-head">
          <div>
            <span className="muted">Settlement</span>
            <h2 className="mono">
              {settlement.sourceDomain}:{shortHash(settlement.nonce, 12, 8)}
            </h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close detail">
            Close
          </button>
        </div>

        <dl className="field-grid">
          <Field label="Amount" value={formatUsdc(settlement.amount)} />
          <Field label="Fee" value={formatUsdc(settlement.fee)} />
          <Field label="Relayer fee" value={formatUsdc(settlement.relayerFee)} />
          <Field label="Treasury fee" value={formatUsdc(settlement.treasuryFee)} />
          <Field label="Recipient" value={settlement.recipient} mono />
          <Field label="Relayer" value={settlement.relayer} mono />
          <Field label="Ledger" value={String(settlement.ledger)} />
          <Field label="Settled" value={new Date(settlement.ledgerClosedAt).toLocaleString()} />
        </dl>

        <HashField label="Stellar transaction" value={settlement.txHash} link={txLink} />
        <HashField label="CCTP nonce" value={settlement.nonce} />
        <HashField label="Settlement contract" value={settlement.contractId} />
      </aside>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

function HashField({ label, value, link }: { label: string; value: string; link?: string | null }) {
  return (
    <div className="hash-field">
      <div className="hash-head">
        <span>{label}</span>
        <CopyButton value={value} />
      </div>
      {link ? (
        <a className="mono hash-value" href={link} target="_blank" rel="noreferrer">
          {value}
        </a>
      ) : (
        <span className="mono hash-value">{value}</span>
      )}
    </div>
  );
}
