import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/ui/Button";
import { Chip } from "../components/ui/Surface";
import { Notice, Slider, Spinner } from "../components/ui/Feedback";
import { getBook, getStream, patchSection } from "../lib/api";
import { clock, fmtMinutes, fmtWords, minsFor, sectionAtIn } from "../lib/format";
import { shortName } from "../lib/names";
import { WPM_DEFAULT, WPM_MAX, WPM_MIN, WPM_STEP } from "../lib/speed";
import { useCanHover, useIsCompact, useStored, WPM_KEY } from "../lib/storage";
import type { BookSummary, Boundary, StreamEntry } from "../lib/types";
import { toWord } from "../lib/words";
import type { Word } from "../lib/words";
import { ChapterBar } from "../reader/ChapterBar";
import { ChapterRail } from "../reader/ChapterRail";
import { EbookReader } from "../reader/EbookReader";
import { ReaderWord } from "../reader/ReaderWord";
import { TitleCardOverlay } from "../reader/TitleCard";
import { useReader } from "../reader/useReader";
import { useLibrary } from "../store/library";
import { useToast } from "../store/toast";

/**
 * The reader.
 * ---------------------------------------------------------------------------
 * Takes the whole viewport: no sidebar, no page chrome. It is reached from a
 * book, never from the menu, because it is always *about* one specific thing.
 *
 * Two ways in, and the difference is a **prop**, not the URL:
 *   <ReaderPage paste />    — text held in sessionStorage, saved nowhere
 *   /read/:bookId           — a stored book, saved against on the server
 *
 * `paste` is passed in rather than derived from `useParams` because the paste
 * route is static and therefore has no params: `bookId` is `undefined` there,
 * so a string comparison against "paste" can never match, and the reader would
 * silently fall through to the stored-book path with an id of `undefined`.
 *
 * The transport bar auto-hides while playing and returns on mouse movement or
 * a keypress, so nothing competes with the word. The one exception is the
 * chapter rail: it floats *above* everything (see `--z-drawer`) rather than
 * insetting the controls, because reflowing the stage while the eye is resting
 * on the pivot letter is the single most disruptive thing the UI could do.
 */

const CHROME_HIDE_MS = 2600;

export function ReaderPage({ paste = false }: { paste?: boolean }) {
  const { bookId } = useParams<{ bookId: string }>();
  const isPaste = paste;
  const navigate = useNavigate();
  const toast = useToast();
  const compact = useIsCompact();
  const canHover = useCanHover();

  const [words, setWords] = useState<Word[]>([]);
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [stream, setStream] = useState<StreamEntry[]>([]);
  const [book, setBook] = useState<BookSummary | null>(null);
  const [filename, setFilename] = useState("");
  const [startIndex, setStartIndex] = useState(0);
  const [loading, setLoading] = useState(!isPaste);
  const [error, setError] = useState<string | null>(null);
  const [pendingSections, setPendingSections] = useState<Set<string>>(new Set());
  /**
   * The reader's own include/exclude choices, from `state.json`.
   *
   * Needed because nothing else reports them: the words endpoint returns only
   * the sections that are *in*, and `meta.stream` carries `default_checked` —
   * the original default, not the current choice. Without this map the panel
   * would show a section as included on the strength of a default the reader
   * had already overridden.
   */
  const [selections, setSelections] = useState<Record<string, boolean>>({});

  const [wpm, setWpm] = useStored<number>(WPM_KEY, WPM_DEFAULT);
  const [titleCards, setTitleCards] = useStored("booktube.titlecards", true);

  const [railOpen, setRailOpen] = useState(false);
  const [railPinned, setRailPinned] = useStored("booktube.rail.pinned", false);
  const [chromeShown, setChromeShown] = useState(true);
  const [ebookMode, setEbookMode] = useState(false);

  const { upsertLocal } = useLibrary();

  // --- load ------------------------------------------------------------------

  /** Fetch the stream and the saved position for a stored book. */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!bookId || isPaste) return;
      // One request per resource, in parallel — the detail endpoint already
      // carries the summary, the meta and the state, so nothing is fetched
      // twice.
      const [{ book: b, meta, state }, payload] = await Promise.all([
        getBook(bookId, signal),
        getStream(bookId, signal),
      ]);
      if (signal?.aborted) return;
      setBook(b);
      setFilename(payload.filename || meta.filename);
      setStream(meta.stream ?? []);
      setBoundaries(payload.boundaries ?? []);
      // The server already tags every word with its pivot and pause, so the
      // payload is used as-is — `toWord` is only for text with no round trip
      // (the paste box).
      setWords(payload.words);
      setStartIndex(state?.word_index ?? 0);
      setSelections(state?.selections ?? {});
    },
    [bookId, isPaste],
  );

  useEffect(() => {
    if (isPaste) {
      // Pasted text is read once from sessionStorage and then held in memory.
      try {
        const raw = window.sessionStorage.getItem("booktube.paste");
        const parsed = raw ? (JSON.parse(raw) as { filename: string; text: string }) : null;
        if (!parsed?.text) {
          setError("The pasted text is gone. Paste it again to read it.");
        } else {
          setFilename(parsed.filename || "Pasted text");
          setWords(parsed.text.split(/\s+/).filter(Boolean).map(toWord));
          setBoundaries([]);
        }
      } catch {
        setError("The pasted text could not be read.");
      }
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    load(controller.signal)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not open that book.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // `load` is stable per book id; re-running on every render would refetch.
  }, [load, isPaste]);

  const source = useMemo(
    () => ({ bookId: isPaste ? null : (bookId ?? null), filename, words, boundaries, startIndex }),
    [isPaste, bookId, filename, words, boundaries, startIndex],
  );

  const engine = useReader(source, {
    wpm,
    titleCards,
    onFinish: () => {
      toast.push("You've reached the end.", { tone: "ok" });
      if (book && !isPaste) {
        // Refresh the summary so the library reflects the finished state
        // without the reader having to navigate and come back.
        void getBook(book.book_id)
          .then((r) => upsertLocal(r.book))
          .catch(() => {});
      }
    },
  });

  const {
    idx,
    playing,
    titleCard,
    toggle,
    seek,
    seekToBoundary,
    jumpSeconds,
    stepChapter,
    restart,
    dismissTitle,
    flushSave,
  } = engine;

  const current = useMemo(() => sectionAtIn(boundaries, idx), [boundaries, idx]);
  const lastIndex = Math.max(0, words.length - 1);

  // --- chrome auto-hide ------------------------------------------------------

  const hideTimer = useRef<number | null>(null);

  const revealChrome = useCallback(() => {
    setChromeShown(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setChromeShown(false);
    }, CHROME_HIDE_MS);
  }, []);

  // While playing, the chrome fades; it stays visible while the rail is open.
  useEffect(() => {
    if (!playing || railOpen || titleCard) {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      setChromeShown(true);
      return;
    }
    revealChrome();
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [playing, railOpen, titleCard, revealChrome]);

  // --- keyboard --------------------------------------------------------------
  //
  // Bound on the window so a keypress works without the stage being focusable.
  // Every binding from the original is preserved: the reading keys are muscle
  // memory, and losing one would be a regression the reader would feel
  // immediately.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      revealChrome();

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (titleCard) dismissTitle();
          else toggle();
          return;
        case "ArrowUp":
          e.preventDefault();
          setWpm((v) => Math.min(WPM_MAX, v + WPM_STEP * 2));
          return;
        case "ArrowDown":
          e.preventDefault();
          setWpm((v) => Math.max(WPM_MIN, v - WPM_STEP * 2));
          return;
        case "ArrowLeft":
          e.preventDefault();
          jumpSeconds(-10);
          return;
        case "ArrowRight":
          e.preventDefault();
          jumpSeconds(10);
          return;
        case "PageUp":
          e.preventDefault();
          stepChapter(-1);
          return;
        case "PageDown":
          e.preventDefault();
          stepChapter(1);
          return;
        case "r":
        case "R":
          restart();
          return;
        case "c":
        case "C":
          if (!isPaste) setRailOpen((v) => !v);
          return;
        case "f":
        case "F":
          void toggleFullScreen();
          return;
        case "\\":
          navigate("/library");
          return;
        case "Escape":
          if (railOpen) {
            setRailOpen(false);
            setRailPinned(false);
          } else {
            setChromeShown((v) => !v);
          }
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    toggle,
    dismissTitle,
    titleCard,
    jumpSeconds,
    stepChapter,
    restart,
    setWpm,
    navigate,
    railOpen,
    isPaste,
    setRailPinned,
    revealChrome,
  ]);

  // --- leaving --------------------------------------------------------------

  // Flush the position immediately rather than waiting for the debounce, so
  // closing the tab or navigating away never loses the last few seconds.
  useEffect(() => {
    const onLeave = () => {
      void flushSave();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [flushSave]);

  useEffect(() => {
    if (!isTauri()) return;
    let allowClose = false;
    let disposed = false;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (allowClose) return;
      event.preventDefault();
      await flushSave();
      if (disposed) return;
      allowClose = true;
      await getCurrentWindow().close();
    });
    return () => {
      disposed = true;
      void unlisten.then((stopListening) => stopListening());
    };
  }, [flushSave]);

  // --- section include / exclude -------------------------------------------

  const toggleSection = useCallback(
    async (sectionId: string, checked: boolean) => {
      if (!bookId || isPaste) return;
      setPendingSections((prev) => new Set(prev).add(sectionId));
      try {
        await patchSection(bookId, sectionId, checked);
        // The server rebuilds the word stream from the selections, so both the
        // stream and the saved index have to be re-read — the old index may not
        // even exist in the new list.
        await load();
        const state = await getBook(bookId).then((r) => r.state);
        setStartIndex(state?.word_index ?? 0);
        toast.push(checked ? "Section added to the reading." : "Section removed.", {
          tone: "ok",
        });
      } catch (err) {
        toast.push(err instanceof Error ? err.message : "Could not change that section.", {
          tone: "danger",
        });
      } finally {
        setPendingSections((prev) => {
          const next = new Set(prev);
          next.delete(sectionId);
          return next;
        });
      }
    },
    [bookId, isPaste, load, toast],
  );

  // --- derived readouts ------------------------------------------------------

  const totalSecs = words.length > 0 ? (words.length / wpm) * 60 : 0;
  const doneSecs = (idx / wpm) * 60;
  const leftWords = Math.max(0, lastIndex - idx);

  const heading = current?.title || current?.full_title || (filename ? shortName(filename) : "");

  const backTo = isPaste ? "/add" : `/library?focus=${bookId}`;

  // --- render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="reader reader--loading">
        <Spinner label="Opening your book…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="reader reader--error">
        <Notice
          tone="danger"
          title="This book could not be opened"
          action={
            <Link to={backTo} className="btn btn--glass btn--sm">
              Back
            </Link>
          }
        >
          {error}
        </Notice>
      </div>
    );
  }

  if (!words.length) {
    return (
      <div className="reader reader--error">
        <Notice
          tone="warn"
          title="There is nothing to read"
          action={
            <Link to={backTo} className="btn btn--glass btn--sm">
              Back
            </Link>
          }
        >
          Every section of this book is currently excluded. Open the contents panel
          and include at least one chapter.
        </Notice>
      </div>
    );
  }

  const atEnd = idx >= lastIndex && !playing;

  return (
    <div
      className={[
        "reader",
        playing ? "is-playing" : "",
        chromeShown ? "chrome-on" : "chrome-off",
        railOpen ? "is-railed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseMove={revealChrome}
      onClick={(e) => {
        // Clicking the stage resumes; clicking a control must not.
        if ((e.target as HTMLElement).closest("button, a, input, [role='button'], [role='dialog'], [data-ebook-content]")) return;
        if (titleCard) dismissTitle();
        else toggle();
      }}
    >
      <div className="ambient" aria-hidden="true">
        <span className="ambient__blob" />
      </div>

      {/* ---- top bar ---- */}
      <motion.header
        className="reader__top"
        animate={{ opacity: chromeShown || railOpen ? 1 : 0, y: chromeShown || railOpen ? 0 : -10 }}
        transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="reader__top-left">
          <Link
            to={backTo}
            className="reader__back"
            aria-label={isPaste ? "Back to Add a book" : "Back to the library"}
          >
            <Icon name="chevronLeft" size={18} />
            <span className="reader__back-label">{isPaste ? "Back" : "Library"}</span>
          </Link>
        </div>

        <div className="reader__top-centre">
          <span className="reader__filename" title={filename}>
            {shortName(filename) || "Untitled"}
          </span>
          {/* Pasted text has no chapters, so the heading falls back to the
              filename — and printing the same string twice reads as a bug. */}
          {heading && heading !== shortName(filename) && (
            <span className="reader__chapter">{heading}</span>
          )}
        </div>

        <div className="reader__top-right">
          <Chip tone="accent">{fmtWords(words.length, true)} words</Chip>
          {!isPaste && (
            <IconButton
              name="list"
              label="Contents"
              size={18}
              active={railOpen}
              onClick={() => setRailOpen((v) => !v)}
            />
          )}
          <IconButton
            name="books"
            label={ebookMode ? "Switch to RSVP reader" : "Switch to ebook reader with reading progress"}
            size={18}
            active={ebookMode}
            onClick={() => setEbookMode((value) => !value)}
          />
        </div>
      </motion.header>

      {/* ---- the stage ---- */}
      {ebookMode ? (
        <EbookReader
          words={words}
          boundaries={boundaries}
          index={idx}
          onSeek={seek}
        />
      ) : (
        <ReaderWord
          word={words[idx]}
          scale={compact ? 0.82 : 1}
          wpm={wpm}
        />
      )}

      {/* ---- bottom ---- */}
      <motion.div
        className="reader__bottom"
        animate={{ opacity: chromeShown || railOpen || !playing ? 1 : 0.0, y: chromeShown ? 0 : 14 }}
        transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
        style={{ pointerEvents: chromeShown || railOpen || !playing ? "auto" : "none" }}
      >
        {boundaries.length > 1 && !isPaste && (
          <ChapterBar
            boundaries={boundaries}
            index={idx}
            onSeekTo={seekToBoundary}
          />
        )}

        <div className="transport">
          <div className="transport__seek">
            <span className="transport__time tnum">{clock(doneSecs)}</span>
            <Slider
              value={idx}
              min={0}
              max={lastIndex}
              onChange={seek}
              label="Reading position"
            />
            <span className="transport__time tnum">−{clock(totalSecs - doneSecs)}</span>
          </div>

          <div className="transport__main">
            <div className="transport__group">
              <IconButton
                name="prevChapter"
                label="Previous chapter (Page Up)"
                size={20}
                disabled={isPaste || boundaries.length === 0}
                onClick={() => stepChapter(-1)}
              />
              <IconButton
                name="back10"
                label="Back 10 seconds (Left arrow)"
                size={20}
                onClick={() => jumpSeconds(-10)}
              />
            </div>

            <button
              type="button"
              className="playbtn"
              onClick={titleCard ? dismissTitle : toggle}
              aria-label={playing ? "Pause" : "Play"}
            >
              <motion.span
                key={playing || titleCard ? "pause" : "play"}
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 520, damping: 26 }}
                className="playbtn__glyph"
              >
                <Icon
                  name={atEnd ? "restart" : playing || titleCard ? "pause" : "play"}
                  size={22}
                />
              </motion.span>
            </button>

            <div className="transport__group">
              <IconButton
                name="fwd10"
                label="Forward 10 seconds (Right arrow)"
                size={20}
                onClick={() => jumpSeconds(10)}
              />
              <IconButton
                name="nextChapter"
                label="Next chapter (Page Down)"
                size={20}
                disabled={isPaste || boundaries.length === 0}
                onClick={() => stepChapter(1)}
              />
            </div>
          </div>

          <div className="transport__side">
            <div className="speed">
              <span className="speed__value tnum">{wpm}</span>
              <span className="speed__unit">wpm</span>
            </div>
            <div className="speed__controls">
              <IconButton
                name="chevronLeft"
                label="Slower (Down arrow)"
                size={15}
                subtle
                disabled={wpm <= WPM_MIN}
                onClick={() => setWpm((v) => Math.max(WPM_MIN, v - WPM_STEP))}
              />
              <Slider
                value={wpm}
                min={WPM_MIN}
                max={WPM_MAX}
                step={WPM_STEP}
                onChange={(v) => setWpm(v)}
                label="Reading speed"
                accent
                className="speed__slider"
              />
              <IconButton
                name="chevronRight"
                label="Faster (Up arrow)"
                size={15}
                subtle
                disabled={wpm >= WPM_MAX}
                onClick={() => setWpm((v) => Math.min(WPM_MAX, v + WPM_STEP))}
              />
            </div>
          </div>
        </div>

        <div className="reader__footline">
          <span className="dim">
            {fmtWords(idx, true)} of {fmtWords(words.length, true)} words ·{" "}
            {fmtMinutes(minsFor(leftWords, wpm))} left
          </span>
          <div className="reader__footline-tools">
            <IconButton
              name="text"
              label={`Title cards ${titleCards ? "on" : "off"}`}
              size={16}
              subtle
              active={titleCards}
              onClick={() => setTitleCards((v) => !v)}
            />
            <IconButton
              name="restart"
              label="Restart from the beginning (R)"
              size={16}
              subtle
              onClick={restart}
            />
          </div>
        </div>
      </motion.div>

      {/* ---- overlays ---- */}

      <TitleCardOverlay card={titleCard} onDismiss={dismissTitle} />

      {/*
       * Mounted for the reader's whole life, not just while open.
       *
       * It looks like dead weight when closed, but the panel and its row list
       * both sit inside an `open &&` branch inside the component, so a closed
       * rail renders nothing past its own two hooks. Keeping the component
       * mounted is what lets its internal `AnimatePresence` play the slide-out
       * when it closes — moving the mount inside `railOpen` would make the
       * panel vanish instead of leaving.
       */}
      {!isPaste && (
        <ChapterRail
          open={railOpen}
          onClose={() => setRailOpen(false)}
          boundaries={boundaries}
          stream={stream}
          selections={selections}
          index={idx}
          onSeekTo={(i) => {
            seekToBoundary(i);
            // A peek closes behind you; a pinned rail stays.
            if (!railPinned) setRailOpen(false);
          }}
          canHover={canHover}
          onToggleSection={(id, checked) => void toggleSection(id, checked)}
          pending={pendingSections}
          pinned={railPinned}
          onTogglePin={() => setRailPinned((v) => !v)}
        />
      )}
    </div>
  );
}

/* Default export for the route table's `lazy()`; the name is kept for direct use. */
export default ReaderPage;

/** Toggle full-screen, tolerating the browsers that refuse without a gesture. */
async function toggleFullScreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* Refused: the browser needs a user gesture, or the API is unavailable. */
  }
}
