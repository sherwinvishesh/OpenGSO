import type { ReactNode } from 'react';

/** The handful of primitives every view shares. Nothing here knows what OpenGEO is. */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <header className="card-head">
      <div>
        <h2>{title}</h2>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {right}
    </header>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export type BannerTone = 'ok' | 'warn' | 'fail' | 'info';

export function Banner({ tone, title, children, action }: { tone: BannerTone; title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'fail' ? 'alert' : undefined}>
      <div className="banner-body">
        {title ? <h3>{title}</h3> : null}
        <p>{children}</p>
      </div>
      {action}
    </div>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'fail' | 'warn' | 'mute'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  busy,
  small,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`btn ${primary ? 'btn-primary' : ''} ${small ? 'btn-sm' : ''}`}
      onClick={onClick}
      disabled={disabled || busy}
    >
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" /> <span style={{ marginLeft: 6 }}>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** Relative time, in the tense the reader is actually thinking in. */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}
