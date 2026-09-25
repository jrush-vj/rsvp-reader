import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { putState } from "../lib/api";
import { sectionAtIn } from "../lib/format";
import type { Word } from "../lib/words";
import type { Boundary } from "../lib/types";

/**
 * The RSVP engine.
 * ---------------------------------------------------------------------------
 * Ported from the original inline reader script, with the same timing rules,
 * because they are what the reading actually feels like:
 *
 *   delay = 60000 / wpm * word.pause
 *
 * The *delay* is still decided after each word is shown, but the timer that
 * waits it out runs in `tempo.worker.ts`. A `setTimeout` on this thread is
 * clamped to about once a second once the tab is hidden, which stalled the
 * reader to roughly 56 wpm at a 775 wpm setting — see that file for the
 * measurements. A worker's timers are not clamped, and neither is delivery of
 * its messages, so moving the schedule off this thread is the whole fix.
 *
 * Only the clock moved. The words and the rendering deliberately stay here:
 * posting 59,619 word objects to a worker costs 542 ms of structured clone
 * against 144 ms to fetch and parse them in the page, and playback already
 * holds 60 fps with no long tasks, so there was nothing else worth moving.
 *
 * All mutable playback state lives in refs and is mirrored into React state
 * only for rendering. A state machine driven by React effects cannot express
 * this correctly: the tick is recursive and must not be restarted by a
 * re-render, or playback stutters and doubles up under StrictMode.
 */

/**
 * Reading speed bounds live in `lib/speed.ts`.
 *
 * They are re-exported here for the reader's own use, but nothing outside the
 * reader should import them from this module — see the note in that file for
 * why importing three numbers from the engine was expensive.
 */
export { WPM_DEFAULT, WPM_MAX, WPM_MIN, WPM_STEP } from "../lib/speed";

/** The chapter title card, resolved into what the overlay needs to draw. */
export interface TitleCard {
  sectionId: string;
  /** "Chapter" / "Section". */
  kind: string;
  /** The leading label from `full_title` — usually a chapter number. */
  lead: string;
  title: string;
  /** A real subtitle, only when the book's label carries one. */
  sub: string;
  /** Milliseconds the card should hold before dismissing itself. */
  dwell: number;
}

export interface ReaderSource {
  /** Null for pasted text, which has no server-side identity to save against. */
  bookId: string | null;
  filename: string;
  words: Word[];
  boundaries: Boundary[];
  /** Where to land. Clamped to the stream, so a stale position is harmless. */
  startIndex: number;
}

interface Options {
  /** Reading speed, in words per minute. */
  wpm: number;
  /** Whether boundary title cards are shown at all. */
  titleCards: boolean;
  /** Called when the last word has been passed. */
  onFinish?: () => void;
  /** Called whenever the rendered word changes, for progress persistence. */
  onIndexChange?: (index: number) => void;
}

/** Split a boundary's labels into the three parts the card shows. */
export function resolveTitleParts(b: Boundary): Pick<TitleCard, "kind" | "lead" | "title" | "sub"> {
  const full = (b.full_title || b.title || "").trim();
  const title = (b.title || full).trim();
  const isSub = (b.level ?? 1) > 1 || b.entry_type === "sub";

  // `full_title` is the book's own label and may carry more than the printed
  // heading: "1 The Surprising Power of Amazing Habits" prefixes a chapter
  // number, other entries append a real subtitle. Splitting on the printed
  // heading tells the two apart, so a number is never rendered as if it were a
  // subtitle hanging under the title.
  let lead = "";
  let sub = "";
  const at = title ? full.indexOf(title) : -1;
  // Any run of separators: whitespace, an em/en dash, a colon, a middot, a
  // hyphen. Books punctuate their running heads inconsistently, so all six are
  // stripped from whichever side of the heading they land on.
  const LEAD_SEP = /^[\s\u2014\u2013:\u00b7-]+/;
  const TRAIL_SEP = /[\s\u2014\u2013:\u00b7-]+$/;

  if (at > 0) {
    lead = full.slice(0, at).replace(TRAIL_SEP, "").trim();
    sub = full.slice(at + title.length).replace(LEAD_SEP, "").trim();
  } else if (at === -1 && full !== title) {
    sub = full;
  }

  return { kind: isSub ? "Section" : "Chapter", lead, title, sub };
}

/**
 * How long a title card should hold.
 *
 * Scaled to the text on it — a long chapter title with a subtitle needs longer
 * than "Prologue" — but floored so a two-word title is still readable and
 * capped so a pathological one cannot stall the session.
 */
export function dwellFor(text: string): number {
  return Math.max(1200, Math.min(320 + 55 * (text || "").length, 4500));
}

export function useReader(source: ReaderSource, opts: Options) {
  const { wpm, titleCards, onFinish, onIndexChange } = opts;

  const words = source.words;
  const boundaries = source.boundaries;
  const lastIndex = Math.max(0, words.length - 1);

  // --- playback state: refs are the source of truth -------------------------
  const idxRef = useRef(0);
  const playingRef = useRef(false);
  /**
   * The playback clock, created on first play.
   *
   * Lazily, so merely opening a book does not spawn a thread, and never
   * terminated on re-render — only on unmount. Re-creating it mid-session would
   * lose the armed tick and stall playback.
   */
  const clockRef = useRef<Worker | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  /** Index into `boundaries` of the next title not yet announced. */
  const nextBoundaryRef = useRef(0);
  /** Guards the finish callback so a stray tick cannot fire it twice. */
  const finishedRef = useRef(false);

  // --- mirrored for render --------------------------------------------------
  const [idx, setIdxState] = useState(0);
  const [playing, setPlayingState] = useState(false);
  const [titleCard, setTitleCard] = useState<TitleCard | null>(null);
  const [finished, setFinished] = useState(false);

  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;
  const titleCardsRef = useRef(titleCards);
  titleCardsRef.current = titleCards;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;

  const bookIdRef = useRef(source.bookId);
  bookIdRef.current = source.bookId;

  /** Write the index into state and notify the host. */
  const commitIndex = useCallback((next: number) => {
    idxRef.current = next;
    setIdxState(next);
    onIndexChangeRef.current?.(next);
  }, []);

  /**
   * Re-point the title cursor at the first boundary at or after `i`.
   *
   * A seek moves the index discontinuously, and the walk inside `tick` only
   * ever steps one boundary per word — so without this, every chapter skipped
   * over would never be announced.
   */
  const syncBoundaryPointer = useCallback((i: number) => {
    const at = boundaries.findIndex((b) => b.start_index >= i);
    nextBoundaryRef.current = at === -1 ? boundaries.length : at;
  }, [boundaries]);

  /**
   * Silence the clock.
   *
   * The worker is told to stop rather than merely ignored, so a `pause` that
   * lands mid-word cannot be followed by one more advance. `playingRef` is
   * still checked on the way in, because a tick already in flight when this is
   * called is delivered asynchronously and must be dropped.
   */
  const stopClock = useCallback(() => {
    clockRef.current?.postMessage({ type: "stop" });
  }, []);

  const flushSave = useCallback(async () => {
    const id = bookIdRef.current;
    if (!id) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const here = sectionAtIn(boundaries, idxRef.current);
    try {
      // Deliberately only these two fields: the server merges, so omitting
      // `selections` must not be read as "clear them".
      await putState(id, {
        word_index: idxRef.current,
        section_id: here ? here.section_id : null,
      });
    } catch {
      // A failed save is not worth interrupting reading for; the next one
      // carries the same position anyway.
    }
  }, [boundaries]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlayingState(false);
    stopClock();
    void flushSave();
  }, [flushSave, stopClock]);

  /** Debounced position save — playback would otherwise write every few seconds. */
  const scheduleSave = useCallback(() => {
    if (!bookIdRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 2500);
  }, [flushSave]);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    pause();
    setFinished(true);
    void flushSave();
    onFinishRef.current?.();
  }, [pause, flushSave]);

  /**
   * The tick.
   *
   * Defined with a ref so it can call itself without a circular dependency —
   * the chain is the scheduler.
   */
  const tickRef = useRef<() => void>(() => {});

  const tick = useCallback(() => {
    if (!playingRef.current) return;

    const i = idxRef.current;
    if (i >= words.length - 1) {
      finish();
      return;
    }

    // A title is due at this index: stop, show it, then carry on from the same
    // word so the section's first word is what the reader sees next. With cards
    // switched off the cursor still advances, so turning them back on later
    // does not replay every boundary already passed.
    const due = boundaries[nextBoundaryRef.current];
    if (due && due.start_index === i) {
      // Advance the cursor either way, so a session that ran with cards off
      // does not replay every boundary when they are switched back on.
      nextBoundaryRef.current++;
      if (titleCardsRef.current) {
        const parts = resolveTitleParts(due);
        pause();
        setTitleCard({
          sectionId: due.section_id,
          ...parts,
          // Dwell on everything that will be on screen, so a long title with a
          // subtitle is not dismissed before it can be read.
          dwell: dwellFor(`${parts.title} ${parts.sub}`),
        });
        return;
      }
    } else if (due && due.start_index < i) {
      nextBoundaryRef.current++;
    }

    const w = words[i];
    if (!w) {
      finish();
      return;
    }
    // The unchanged rule. It is handed to the worker broken into its two parts
    // rather than as one millisecond figure, so a speed change can re-time the
    // word already on screen without having to remember its punctuation.
    const base = 60_000 / wpmRef.current;
    const pauseFactor = w.pause || 1;

    clockRef.current?.postMessage({ type: "arm", base, pause: pauseFactor });
  }, [words, boundaries, commitIndex, scheduleSave, pause, finish]);

  tickRef.current = tick;

  /**
   * Start the clock.
   *
   * Created on first play and kept for the life of the reader. The handler is
   * attached once, here, so it never needs `tick` in its identity — a handler
   * re-created on every render would be a second clock doing double duty.
   * `tickRef` is read through at delivery time, so it always resolves to the
   * current tick without this effect depending on it.
   */
  useEffect(() => {
    if (clockRef.current) return;
    // The Vite idiom: `new URL(..., import.meta.url)` is what lets the bundler
    // see the worker as an entry point and emit it. A bare string path would
    // resolve at runtime against the page URL and 404 in production.
    const clock = new Worker(new URL("./tempo.worker.ts", import.meta.url), {
      type: "module",
      name: "tempo",
    });
    clock.onmessage = (e: MessageEvent<{ type: string }>) => {
      // A tick already in flight when playback stopped is dropped here, and the
      // `playingRef` guard in `tick` covers the rest. This is the only place a
      // beat enters the main thread.
      if (e.data?.type !== "tick" || !playingRef.current) return;
      commitIndex(idxRef.current + 1);
      scheduleSave();
      tickRef.current();
    };
    clockRef.current = clock;
    return () => {
      clockRef.current = null;
      clock.terminate();
    };
  }, [commitIndex, scheduleSave]);

  const play = useCallback(() => {
    if (!words.length || finishedRef.current) return;
    playingRef.current = true;
    setPlayingState(true);
    tick();
  }, [words.length, tick]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  /** Dismiss the title card and resume from the word it was covering. */
  const dismissTitle = useCallback(() => {
    setTitleCard(null);
    if (finishedRef.current) return;
    playingRef.current = true;
    setPlayingState(true);
    tick();
  }, [tick]);

  /** Jump to an arbitrary word index, keeping the title cursor in step. */
  const seek = useCallback(
    (to: number) => {
      if (!words.length) return;
      const clamped = Math.max(0, Math.min(lastIndex, Math.round(to)));
      finishedRef.current = false;
      setFinished(false);
      commitIndex(clamped);
      syncBoundaryPointer(clamped);
      scheduleSave();
      // A seek while playing restarts the delay from the new word rather than
      // letting the in-flight timer land on the old one.
      if (playingRef.current) {
        stopClock();
        tick();
      }
    },
    [words.length, lastIndex, commitIndex, syncBoundaryPointer, scheduleSave, stopClock, tick],
  );

  /**
   * Move by a number of *seconds*, not words.
   *
   * "10 seconds forward" has to mean ten seconds of reading time at the
   * current speed, or the control gets less useful the faster you read.
   */
  const jumpSeconds = useCallback(
    (seconds: number) => {
      const delta = Math.max(1, Math.round((Math.abs(seconds) * wpmRef.current) / 60));
      seek(idxRef.current + (seconds < 0 ? -delta : delta));
    },
    [seek],
  );

  const jumpWords = useCallback((delta: number) => seek(idxRef.current + delta), [seek]);

  /** Jump to a boundary's first word. */
  const seekToBoundary = useCallback(
    (i: number) => {
      const b = boundaries[i];
      if (b) seek(b.start_index);
    },
    [boundaries, seek],
  );

  /**
   * Step a chapter.
   *
   * Backwards means "restart this section, and only go to the previous one if
   * already at its start" — which is what makes it usable as a re-read key
   * rather than a skip.
   */
  const stepChapter = useCallback(
    (dir: number) => {
      if (!boundaries.length) return;
      const here = sectionAtIn(boundaries, idxRef.current);
      const at = here ? boundaries.indexOf(here) : -1;
      let next: number;
      if (dir < 0) {
        next = here && idxRef.current > here.start_index ? at : at - 1;
      } else {
        next = at + 1;
      }
      next = Math.max(0, Math.min(boundaries.length - 1, next));
      seekToBoundary(next);
    },
    [boundaries, seekToBoundary],
  );

  const restart = useCallback(() => seek(0), [seek]);

  // --- lifecycle ------------------------------------------------------------

  /**
   * Adopt a new source.
   *
   * Runs whenever the book or the word list changes, which includes a
   * re-fetch after a selection change. Playback always lands paused so the
   * reader chooses when to start.
   */
  useEffect(() => {
    stopClock();
    playingRef.current = false;
    setPlayingState(false);
    setTitleCard(null);
    setFinished(false);
    finishedRef.current = false;

    const clamped = Math.max(0, Math.min(Math.max(0, words.length - 1), source.startIndex));
    idxRef.current = clamped;
    setIdxState(clamped);
    syncBoundaryPointer(clamped);
    // Intentionally keyed on the source identity, not on every prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.bookId, words, boundaries, stopClock, syncBoundaryPointer]);

  // A speed change applies from the next word: re-arm rather than waiting out a
  // delay computed at the old speed. The clock is only stopped, never rebuilt,
  // because it holds no state worth losing — the next `tick` re-arms it.
  useEffect(() => {
    if (!playingRef.current) return;
    stopClock();
    tick();
  }, [wpm, stopClock, tick]);

  // Stop the clock on unmount, and flush the position so navigating away never
  // loses the last few seconds of reading. The worker itself is terminated by
  // the effect that created it.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      playingRef.current = false;
      void flushSave();
    };
  }, [flushSave]);

  const currentSection = useMemo(
    () => sectionAtIn(boundaries, idx),
    [boundaries, idx],
  );

  return {
    // state
    idx,
    playing,
    finished,
    titleCard,
    words,
    boundaries,
    total: words.length,
    lastIndex,
    currentSection,
    // actions
    play,
    pause,
    toggle,
    seek,
    seekToBoundary,
    stepChapter,
    jumpSeconds,
    jumpWords,
    restart,
    dismissTitle,
    flushSave,
  };
}
