import { useState, type ReactNode } from "react";
import type { TransferDirection, TransferStatus } from "../types";

export function StatusPill({ status }: { status: TransferStatus }) {
  return <span className={`pill pill-${status}`}>{status.replace("_", " ")}</span>;
}

export function DirectionBadge({ direction }: { direction: TransferDirection }) {
  return <span className="direction">{direction}</span>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}
