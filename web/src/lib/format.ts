/** Small formatting helpers shared across pages. */

/**
 * A word count as a compact string: `1,240`, `59.6k`, `1.2M`.
 *
 * `full` opts out of abbreviation — used where the exact number matters (the
 * library total, a chapter's own count) rather than where it is glanced at.
 */
export function fmtWords(n: number, full = false): string {
  const v = Math.max(0, Math.round(n || 0));
  if (full || v < 10000) return v.toLocaleString("en-US");
  if (v < 1_000_000) {
    const k = v / 1000;
    return (k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k).toString()) + "k";
  }
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/**
 * A duration in minutes as `12 min`, `1h 40m`.
 *
 * The unit is always visible: an unqualified "1:40" is ambiguous between a
 * clock time and a duration, and this is only ever a duration.
 */
export function fmtMinutes(mins: number): string {
  const m = Math.max(0, Math.round(mins || 0));
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** Reading time for a word count at a given speed. */
export function minsFor(words: number, wpm: number): number {
  return wpm > 0 ? words / wpm : 0;
}

/**
 * A clock in the form a player uses: `m:ss` under an hour, `h:mm:ss` past it.
 * Both ends of the seek bar are read off the same word count, so they can
 * never disagree.
 */
export function clock(secs: number): string {
  const total = Math.max(0, Math.round(secs || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

/** An ISO-ish local timestamp as a short, human date. */
export function fmtDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  const day = 86_400_000;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A byte count for the upload size limit and file rows. */
export function fmtBytes(bytes: number): string {
  const b = Math.max(0, bytes || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** `1 chapter` / `3 chapters`, with an explicit plural. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * How far into a section a word index sits, as 0–1.
 *
 * Returns 0 for anything at or before the section start, which includes every
 * section ahead of the pointer — callers must therefore decide "current
 * section" by *position* and use this only for the fill proportion. A progress
 * test alone lights every future section at once.
 */
export function sectionProgress(start: number, count: number, pointer: number): number {
  if (count <= 0) return 0;
  if (pointer <= start) return 0;
  return Math.max(0, Math.min(1, (pointer - start) / count));
}

/**
 * The section containing a word index.
 *
 * Walks backwards from the end so the *last* boundary at or before `pointer`
 * wins, which is the correct answer when two sections share a start index.
 */
export function sectionAtIn<T extends { start_index: number }>(
  boundaries: T[],
  i: number,
): T | null {
  if (!boundaries.length) return null;
  for (let j = boundaries.length - 1; j >= 0; j--) {
    if (boundaries[j].start_index <= i) return boundaries[j];
  }
  return boundaries[0];
}
