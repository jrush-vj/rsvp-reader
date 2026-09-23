import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ToastStack, type Toast } from "../components/ui/Overlay";

/**
 * Toasts.
 * ---------------------------------------------------------------------------
 * A small context rather than a library. The rules that matter here are:
 *
 * - a message is dismissed on a timer, but the timer is *not* extended by a new
 *   message arriving, so a burst of three does not leave the first one stuck;
 * - an action button always dismisses on click, so a "Undo" can never be fired
 *   twice from a toast that is already gone;
 * - `danger` never auto-dismisses. An error the reader did not see is worse
 *   than one they have to close.
 */

interface ToastValue {
  push: (
    message: string,
    opts?: { tone?: Toast["tone"]; action?: Toast["action"]; duration?: number },
  ) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastValue["push"]>(
    (message, opts = {}) => {
      const id = nextId.current++;
      const tone = opts.tone ?? "info";
      setToasts((prev) => {
        const next = [...prev, { id, message, tone, action: opts.action }];
        // Never stack more than four: beyond that they cover the page.
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      const duration = opts.duration ?? (tone === "danger" ? 0 : 4200);
      if (duration > 0) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>.");
  return value;
}
