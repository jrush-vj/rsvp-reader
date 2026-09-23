import { useCallback, useEffect, useState } from "react";

/**
 * Storage keys.
 * ---------------------------------------------------------------------------
 * Centralised because two of them are read from more than one page — the pace
 * is set in the reader and used for the home page's time estimate, and a
 * mismatch would show up as the two screens disagreeing, not as an error.
 */

/**
 * Reading pace. Deliberately the **same key the original single-file reader
 * used**, so a pace chosen before the rewrite is still in force afterwards.
 */
export const WPM_KEY = "rsvp_wpm";

/** Whether the sidebar is collapsed to icons. */
export const RAIL_KEY = "booktube.rail.collapsed";

/**
 * Read a value from localStorage, tolerating a browser that refuses access.
 *
 * Privacy modes and third-party-cookie blockers make `localStorage` **throw**
 * on read rather than return null, which would otherwise take the whole app
 * down on first paint. Every access goes through here for that reason.
 */
export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a value, ignoring a storage failure. Returns false if it did not stick. */
export function writeStore(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStore(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/**
 * A piece of state mirrored into localStorage.
 *
 * Hydration is lazy (a function) so the value is read once on mount and the
 * setter can take either a value or an updater, exactly like `useState`.
 */
export function useStored<T>(
  key: string,
  fallback: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStore(key, fallback));

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeStore(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

/**
 * `matchMedia` as reactive state.
 *
 * Used for the pointer type (the chapter rail is hover-driven and pointless on
 * touch) and for reduced motion.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * True when the primary pointer can hover.
 *
 * The reader uses this to decide whether to offer hover-opened chrome at all;
 * on a touch device the rail has to be a tap target instead.
 */
export function useCanHover(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

/** True when the viewport is narrow enough that the sidebar should overlay. */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 900px)");
}
