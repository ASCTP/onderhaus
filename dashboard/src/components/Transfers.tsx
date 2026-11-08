import type { TransferEvent, TransferPage } from "../types";
import {
  explorerUrl,
  formatAmount,
  formatLatency,
  formatRelative,
  shortHash,
  trimDecimal,
} from "../format";
import { CopyButton, DirectionBadge, EmptyState, StatusPill } from "./Bits";

export interface Filters {
  direction: string;
  status: string;
}

export function TransferFilters({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="filters">
      <label>
        <span>Direction</span>
        <select value={filters.direction} onChange={(event) => onChange({ ...filters, direction: event.target.value })}>
          <option value="">All</option>
          <option value="arc->stellar">arc to stellar</option>
          <option value="stellar->arc">stellar to arc</option>
        </select>
      </label>
      <label>
        <span>Status</span>
        <select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}>
          <option value="">All</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="in_progress">In progress</option>
        </select>
      </label>
    </div>
  );
}

export function TransfersTable({ page, onSelect }: { page: TransferPage | null; onSelect: (burnTxHash: string) => void }) {
  if (!page) {
    return (
      <div className="table-wrap">
        <div className="table-loading">Loading transfers</div>
      </div>
    );
  }
  if (page.transfers.length === 0) {
    return (
      <EmptyState title="No transfers yet">
        The dashboard reads the service ledger and imported settlement events for this network.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Direction</th>
            <th>Amount</th>
            <th>Recipient</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Relayer</th>
          </tr>
        </thead>
        <tbody>
          {page.transfers.map((transfer) => (
            <tr
              key={transfer.id}
              tabIndex={0}
              onClick={() => onSelect(transfer.burnTxHash)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(transfer.burnTxHash);
                }
              }}
            >
              <td title={new Date(transfer.submittedAt).toLocaleString()}>{formatRelative(transfer.submittedAt)}</td>
              <td>
                <DirectionBadge direction={transfer.direction} />
              </td>
              <td>{formatAmount(transfer.amount, transfer.amountUnit)}</td>
              <td className="mono" title={transfer.recipient}>
                {shortHash(transfer.recipient, 6, 4)}
              </td>
              <td>
                <StatusPill status={transfer.status} />
              </td>
              <td>{formatLatency(transfer.latencyMs)}</td>
              <td className="mono">
                {transfer.relayer ? shortHash(transfer.relayer, 6, 4) : <span className="muted">n/a</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, onPage }: { page: TransferPage | null; onPage: (offset: number) => void }) {
  if (!page) return null;
  const start = page.total === 0 ? 0 : page.offset + 1;
  const end = Math.min(page.total, page.offset + page.transfers.length);
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

export function TransferDetail({ transfer, onClose }: { transfer: TransferEvent; onClose: () => void }) {
  const burnLink = explorerUrl(transfer.sourceChain, transfer.network, transfer.burnTxHash);
  const mintLink = transfer.mintTxHash
    ? explorerUrl(transfer.destinationChain, transfer.network, transfer.mintTxHash)
    : null;

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label="Transfer detail">
        <div className="drawer-head">
          <div>
            <span className="muted">Transfer</span>
            <h2>
              <DirectionBadge direction={transfer.direction} />
              <StatusPill status={transfer.status} />
            </h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close detail">
            Close
          </button>
        </div>

        <dl className="field-grid">
          <Field label="Amount" value={formatAmount(transfer.amount, transfer.amountUnit)} />
          <Field
            label="Fee"
            value={transfer.fee === null ? "not captured" : `${trimDecimal(transfer.fee)} ${transfer.feeUnit ?? ""}`.trim()}
          />
          <Field label="Relayer" value={transfer.relayer ?? "not recorded"} mono={transfer.relayer !== null} />
          <Field label="Origin" value={transfer.origin} />
          <Field label="Submitted" value={new Date(transfer.submittedAt).toLocaleString()} />
          <Field label="Settled" value={transfer.settledAt ? new Date(transfer.settledAt).toLocaleString() : "not settled"} />
          <Field label="Latency" value={formatLatency(transfer.latencyMs)} />
          <Field label="Recipient" value={transfer.recipient} mono />
        </dl>

        <HashField label="Burn hash" value={transfer.burnTxHash} link={burnLink} />
        <HashField label="Mint hash" value={transfer.mintTxHash ?? "not recorded"} link={mintLink} />
        <HashField label="Attestation hash" value={transfer.attestationHash ?? "not recorded"} />

        {transfer.error ? (
          <div className="error-note">
            <span>Error</span>
            <p>{transfer.error}</p>
          </div>
        ) : null}
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
  const present = value !== "not recorded";
  return (
    <div className="hash-field">
      <div className="hash-head">
        <span>{label}</span>
        {present ? <CopyButton value={value} /> : null}
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
