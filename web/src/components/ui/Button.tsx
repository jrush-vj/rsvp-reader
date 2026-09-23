import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "../Icon";

/**
 * Buttons.
 * ---------------------------------------------------------------------------
 * `variant` picks the material, `size` the scale. The primary button is a
 * gradient with an inner highlight and a coloured glow — the single most
 * "raised" thing in the UI, so it stays unambiguous which action is the main
 * one on a page.
 */

export type Variant = "primary" | "glass" | "ghost" | "danger" | "soft";
export type Size = "sm" | "md" | "lg";

interface Base {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
  /** Stretch to the full width of the parent. */
  block?: boolean;
  className?: string;
}

type ButtonProps = Base & ButtonHTMLAttributes<HTMLButtonElement>;

function classes({ variant = "glass", size = "md", block, className }: Base) {
  return [
    "btn",
    `btn--${variant}`,
    `btn--${size}`,
    block ? "btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconRight, children, block, className, ...rest },
  ref,
) {
  const glyph = size === "sm" ? 15 : size === "lg" ? 20 : 17;
  return (
    <button
      ref={ref}
      type="button"
      className={classes({ variant, size, block, className })}
      {...rest}
    >
      {icon && <Icon name={icon} size={glyph} />}
      {children && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={glyph} />}
    </button>
  );
});

/** A button that navigates. Renders an anchor so it keeps link semantics. */
export function LinkButton({
  to,
  variant,
  size,
  icon,
  iconRight,
  children,
  block,
  className,
  ...rest
}: Base & { to: string } & Omit<
    React.ComponentProps<typeof Link>,
    "to" | "className" | "children"
  >) {
  const glyph = size === "sm" ? 15 : size === "lg" ? 20 : 17;
  return (
    <Link
      to={to}
      className={classes({ variant, size, block, className })}
      {...rest}
    >
      {icon && <Icon name={icon} size={glyph} />}
      {children && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={glyph} />}
    </Link>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: IconName;
  /** Required: an icon-only control has no text for a screen reader. */
  label: string;
  size?: number;
  variant?: Variant;
  /** Renders the pressed/lit state, for a toggle. */
  active?: boolean;
  /** Renders a compact, lower-contrast treatment for dense rows. */
  subtle?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { name, label, size = 19, variant = "ghost", active, subtle, className, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={active === undefined ? undefined : active}
        className={[
          "iconbtn",
          `iconbtn--${variant}`,
          active ? "is-active" : "",
          subtle ? "iconbtn--subtle" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        <Icon name={name} size={size} />
      </button>
    );
  },
);

/** A horizontal row of related actions, with consistent gaps. */
export function ButtonRow({
  children,
  align = "start",
}: {
  children: ReactNode;
  align?: "start" | "end" | "between";
}) {
  return <div className={`btnrow btnrow--${align}`}>{children}</div>;
}
