import type { ReactNode } from "react";

/**
 * Surfaces.
 * ---------------------------------------------------------------------------
 * Two materials, used for two different jobs:
 *
 * `GlassPanel` is frosted and translucent — it sits *over* the ambient
 * gradient, so colour drifts behind it. Used for chrome: the topbar, the
 * chapter rail, dialogs.
 *
 * `Card` is opaque and neumorphic — it is part of the page's own material, lit
 * from the top-left. Used for content: book rows, stat tiles, sections.
 *
 * Mixing them freely is what makes the interface look like assorted boxes; the
 * rule is chrome floats, content sits.
 */

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Adds the raised neumorphic treatment (dark below, light above). */
  raised?: boolean;
  /** Adds a soft accent glow. Reserved for the one focal element on a page. */
  glow?: boolean;
  as?: "div" | "section" | "aside" | "article" | "header" | "footer";
}

export function GlassPanel({
  children,
  className = "",
  raised,
  glow,
  as: Tag = "div",
}: PanelProps) {
  return (
    <Tag
      className={[
        "glass",
        "panel",
        raised ? "panel--raised" : "",
        glow ? "panel--glow" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Tag>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "div",
  ...rest
}: PanelProps & { onClick?: () => void; role?: string; tabIndex?: number }) {
  return (
    <Tag className={["card", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

/** A titled block inside a card or page. */
export function Section({
  title,
  hint,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={["block", className].filter(Boolean).join(" ")}>
      {(title || actions) && (
        <header className="block__head">
          <div className="block__titles">
            {title && <h2 className="block__title">{title}</h2>}
            {hint && <p className="block__hint">{hint}</p>}
          </div>
          {actions && <div className="block__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A small uppercase label. Used above values and inside chrome. */
export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`kicker ${className}`.trim()}>{children}</span>;
}

/** An inline tag. `tone` shifts the hue without leaving the muted range. */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn";
  className?: string;
}) {
  return <span className={`chip chip--${tone} ${className}`.trim()}>{children}</span>;
}
