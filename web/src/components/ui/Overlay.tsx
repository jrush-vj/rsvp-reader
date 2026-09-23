import { AnimatePresence, motion } from "framer-motion";
import type { MotionProps } from "framer-motion";
import { useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { Icon } from "../Icon";
import { IconButton } from "./Button";

/**
 * Overlays: dialogs, drawers, and the toaster.
 * ---------------------------------------------------------------------------
 * All three share one set of transitions so the app has a single notion of
 * "something appeared". They also all trap Escape and restore focus, which is
 * the part that is easy to forget and impossible to notice until it is wrong.
 */

const SCRIM: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
};

/** A centred modal panel. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onKey]);

  return (
    <AnimatePresence>
      {open && (
        <div className="overlay overlay--center">
          <motion.div className="overlay__scrim" onClick={onClose} {...SCRIM} />
          <motion.div
            className="dialog glass"
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            style={{ maxWidth: width }}
            initial={{ opacity: 0, scale: 0.96, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <header className="dialog__head">
              <h2 className="dialog__title">{title}</h2>
              <IconButton name="close" label="Close" onClick={onClose} size={18} />
            </header>
            <div className="dialog__body">{children}</div>
            {footer && <footer className="dialog__foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * A panel anchored to an edge.
 *
 * Goes above every other element in the reader (see `--z-drawer`), which is
 * what lets the chapter rail float over the transport bar rather than having
 * to displace it.
 */
export function Drawer({
  open,
  onClose,
  side = "right",
  width = 340,
  children,
  label,
  /** Dim and click-catch behind the panel. */
  scrim = true,
}: {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  width?: number;
  children: ReactNode;
  label: string;
  scrim?: boolean;
}) {
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onKey]);

  const from = side === "right" ? 24 : -24;

  return (
    <AnimatePresence>
      {open && (
        <div className={`overlay overlay--${side}`} style={{ zIndex: "var(--z-drawer)" as unknown as number }}>
          {scrim && (
            <motion.div
              className="overlay__scrim overlay__scrim--soft"
              onClick={onClose}
              {...SCRIM}
            />
          )}
          <motion.aside
            className="drawer glass"
            role="dialog"
            aria-modal={scrim || undefined}
            aria-label={label}
            style={{ width }}
            initial={{ x: from, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: from, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
          >
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

/** A transient message. Rendered by the Toaster, never directly. */
export interface Toast {
  id: number;
  message: string;
  tone: "info" | "ok" | "danger";
  action?: { label: string; run: () => void };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast glass toast--${t.tone}`}
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <Icon
              name={t.tone === "ok" ? "check" : t.tone === "danger" ? "alert" : "sparkle"}
              size={16}
              className="toast__glyph"
            />
            <span className="toast__text">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action?.run();
                  onDismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <IconButton
              name="close"
              label="Dismiss"
              size={14}
              subtle
              onClick={() => onDismiss(t.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
