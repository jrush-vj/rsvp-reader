import { useId } from "react";
import type { ReactNode } from "react";
import { Icon } from "../Icon";

/**
 * Feedback primitives: progress, emptiness, loading, status.
 * ---------------------------------------------------------------------------
 * All of them are deliberately quiet. This is a reading app, so the states
 * between sessions should recede rather than announce themselves.
 */

/** A slim progress bar. The fill carries a subtle accent gradient. */
export function Progress({
  value,
  className = "",
  tone = "accent",
  label,
}: {
  /** 0–1. */
  value: number;
  className?: string;
  tone?: "accent" | "muted" | "danger";
  /** Accessible name. Omit only when an adjacent label already names it. */
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <div
      className={`progress progress--${tone} ${className}`.trim()}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <span className="progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A labelled statistic. Used on book cards and the Home summary. */
export function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="stat">
      {icon && <span className="stat__icon">{icon}</span>}
      <span className="stat__value tnum">{value}</span>
      <span className="stat__label">{label}</span>
      {sub && <span className="stat__sub">{sub}</span>}
    </div>
  );
}

/** The "nothing here yet" state. Always offers the way out of itself. */
export function EmptyState({
  icon = "books",
  title,
  body,
  action,
}: {
  icon?: Parameters<typeof Icon>[0]["name"];
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__glyph">
        <Icon name={icon} size={26} />
      </span>
      <h3 className="empty__title">{title}</h3>
      {body && <p className="empty__body">{body}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/** A spinner with an optional label. */
export function Spinner({ label, size = 22 }: { label?: string; size?: number }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <Icon name="spinner" size={size} className="spinner__glyph" />
      {label && <span className="spinner__label">{label}</span>}
    </span>
  );
}

/** A skeleton block, for content whose shape is already known. */
export function Skeleton({
  width = "100%",
  height = 14,
  radius,
}: {
  width?: string | number;
  height?: number;
  radius?: number;
}) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: `${height}px`,
        borderRadius: radius !== undefined ? `${radius}px` : undefined,
      }}
    />
  );
}

/**
 * An inline notice.
 *
 * `danger` is a desaturated brick and never the pivot red — that colour is
 * reserved for the RSVP letter, and spending it on an error box would blunt
 * the one signal the reader actually needs.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const glyph = tone === "ok" ? "check" : tone === "info" ? "sparkle" : "alert";
  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon name={glyph} size={17} className="notice__glyph" />
      <div className="notice__body">
        {title && <strong className="notice__title">{title}</strong>}
        {children && <div className="notice__text">{children}</div>}
      </div>
      {action && <div className="notice__action">{action}</div>}
    </div>
  );
}

/** A labelled control row, for the reader's inline settings. */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && <p className="field__hint">{hint}</p>}
    </div>
  );
}

/**
 * A range input with the app's own track and thumb.
 *
 * `accent` tints the filled portion. The reader's speed slider uses it; the
 * seek bar passes nothing so it stays neutral, because a coloured seek bar
 * would compete with the pivot letter for attention.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  accent = false,
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /** Accessible name. */
  label: string;
  accent?: boolean;
  className?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={["slider", accent ? "slider--accent" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ ["--pct" as string]: `${pct}%` }}
      value={value}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
    />
  );
}
