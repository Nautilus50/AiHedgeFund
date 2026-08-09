import type { ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return <section className="card">{children}</section>;
}

export function CardHead({ title, hint, actions }: { title: ReactNode; hint?: string; actions?: ReactNode }) {
  return (
    <header className="card-head">
      <div>
        <div className="card-title">
          <h2>{title}</h2>
        </div>
        {hint && <p className="card-hint">{hint}</p>}
      </div>
      {actions}
    </header>
  );
}

export function CardBody({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <div className={flush ? "card-body card-body-flush" : "card-body"}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

export type AlertTone = "error" | "ok" | "warn" | "info";

const ALERT_GLYPH: Record<AlertTone, string> = { error: "✕", ok: "✓", warn: "▲", info: "i" };

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="alert-glyph" aria-hidden="true">
        {ALERT_GLYPH[tone]}
      </span>
      <div>{children}</div>
    </div>
  );
}

/**
 * Timestamps render in UTC with the local rendering available on hover
 * (spec 15.17). Research evidence is compared across machines and
 * timezones, so a bare local time is ambiguous.
 */
export function Timestamp({ value, dateOnly = false }: { value: string | Date; dateOnly?: boolean }) {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) {
    return <span className="unset">unknown</span>;
  }

  const iso = d.toISOString();
  const utc = dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

  return (
    <time className="mono" dateTime={iso} title={`${iso}\nLocal: ${d.toLocaleString()}`}>
      {utc}
      {!dateOnly && <span className="visually-hidden"> UTC</span>}
    </time>
  );
}

/** A content hash, truncated for scanning but complete on hover and copy. */
export function Hash({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="unset">not set</span>;
  return (
    <span className="mono" title={value}>
      {value.slice(0, 16)}…
    </span>
  );
}
