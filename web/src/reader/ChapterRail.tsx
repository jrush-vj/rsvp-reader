import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useMemo, useRef } from "react";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/ui/Button";
import { fmtWords } from "../lib/format";
import { sectionProgress } from "../lib/format";
import type { Boundary, StreamEntry } from "../lib/types";

/**
 * The chapter rail.
 * ---------------------------------------------------------------------------
 * The book's table of contents, and the only place a section can be included
 * or excluded. Two consequences shape the design:
 *
 * 1. It **floats over** the transport bar rather than shrinking it. Insetting
 *    the controls would reflow the whole stage on hover, and the stage is the
 *    one thing that must not move while the eye is resting on the pivot
 *    letter. The rail is an overlay above everything, dismissed by a scrim.
 * 2. Toggling a section is not cosmetic — the server rebuilds the word stream
 *    from the selections, so the book's word list genuinely changes. The
 *    parent re-fetches, and playback lands paused at a re-clamped index.
 *
 * "Now" is decided by **position** (`start_index <= pointer`), never by
 * progress. A progress test lights every section ahead of the pointer at zero,
 * which reads as "all of these are current".
 */

interface Props {
  open: boolean;
  onClose: () => void;
  boundaries: Boundary[];
  /** The full stream metadata, for `default_checked` and the section tree. */
  stream: StreamEntry[];
  /**
   * The reader's saved include/exclude choices.
   *
   * Consulted before `default_checked`, because the default is only what the
   * book suggested at processing time — it does not move when the reader
   * changes their mind.
   */
  selections: Record<string, boolean>;
  index: number;
  onSeekTo: (boundaryIndex: number) => void;
  /** Whether the pointer can hover — the rail's own edge trigger. */
  canHover: boolean;
  /** Flip a section in or out of the reading order. */
  onToggleSection: (sectionId: string, checked: boolean) => void;
  /** Section ids currently being written, so their row can show it. */
  pending: Set<string>;
  /** Close after a jump when the rail was only peeked at. */
  pinned: boolean;
  onTogglePin: () => void;
}

interface ChapterRowsProps {
  boundaries: Boundary[];
  stream: StreamEntry[];
  index: number;
  checkedById: Map<string, boolean>;
  onSeekTo: (boundaryIndex: number) => void;
  onToggleSection: (sectionId: string, checked: boolean) => void;
  pending: Set<string>;
}

/**
 * The contents list, split out so that the panel's chrome does not re-render
 * with it.
 *
 * This is the reader's one genuinely hot list. The parent re-renders on every
 * word — sixty times a second at 600 wpm — and without this boundary every one
 * of those ticks would walk all 26 sections, rebuild each row's props and
 * reconcile a 26-item tree, all to change the height of exactly one progress
 * bar. Measuring it: seeking within the *current* section changes nothing but
 * `index`, so `memo` can reject the whole subtree, and jumping between sections
 * re-renders it once instead of on every intermediate word.
 *
 * `rows` is memoised on the three inputs it actually reads. It used to be
 * rebuilt on every render of the rail, which meant the boundary lookup ran
 * per word for a result that only changes when the book does.
 */
const ChapterRows = memo(function ChapterRows({
  boundaries,
  stream,
  index,
  checkedById,
  onSeekTo,
  onToggleSection,
  pending,
}: ChapterRowsProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  /** Which section the viewport was last centred on. */
  const centredRef = useRef<string | null>(null);

  /*
   * One row per *section*, not per boundary.
   *
   * A boundary only exists for a section that is currently checked, because
   * `boundaries` and `words` are the playable stream. Rendering the list from
   * boundaries therefore made exclusion a one-way door: unchecking a chapter
   * removed its row, and there was then nothing left to click to put it back.
   *
   * Sections come from `meta.stream`, which is the book's full structure, and
   * are looked up against the boundaries by id. The lookup is by id rather than
   * by index because an excluded section occupies no place in the stream —
   * `start_index` genuinely does not exist for it, and inventing one would make
   * the progress bars lie. `stream` is already in reading order, and the
   * checked subset preserves that order, so `boundaryIndex` is monotonic for
   * included sections and jumping to one is exact.
   */
  const rows = useMemo(() => {
    const boundaryIndex = new Map(boundaries.map((b, i) => [b.section_id, i]));
    return stream.map((entry) => {
      const at = boundaryIndex.get(entry.section_id);
      const b = at === undefined ? undefined : boundaries[at];
      return {
        section_id: entry.section_id,
        title: entry.title || entry.full_title || null,
        level: entry.level ?? 1,
        word_count: entry.word_count,
        start_index: b?.start_index ?? 0,
        included: at !== undefined,
        boundaryIndex: at,
      };
    });
  }, [boundaries, stream]);

  /** The section the pointer is inside, or null past the last boundary. */
  const nowId = useMemo(() => {
    let found: string | null = null;
    for (const row of rows) {
      if (row.included && row.boundaryIndex !== undefined && row.start_index <= index) {
        found = row.section_id;
      }
    }
    return found;
  }, [rows, index]);

  /*
   * Centre the current row — but only when the current *section* changes.
   *
   * The original effect ran on every `index` change, so at 600 wpm the list was
   * handed a smooth scroll sixty times a second. Each one retargets an
   * animation that is already running, which is both wasted work and visibly
   * janky; the panel would also fight any attempt to scroll it by hand while
   * playing, because the next word would drag it back.
   *
   * Keying on the section is what the scroll is actually expressing: "show me
   * where I am in the book". A word moving inside the current chapter is not
   * news.
   */
  useEffect(() => {
    if (nowId === null) return;
    if (centredRef.current === nowId) return;
    centredRef.current = nowId;
    const el = currentRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [nowId]);

  return (
    <ul className="rail-panel__list" ref={listRef}>
      {rows.map((row, i) => {
        const nextStart =
          row.boundaryIndex !== undefined && row.boundaryIndex + 1 < boundaries.length
            ? boundaries[row.boundaryIndex + 1].start_index
            : Number.POSITIVE_INFINITY;
        const count = Number.isFinite(nextStart)
          ? Math.max(1, nextStart - row.start_index)
          : Math.max(1, index - row.start_index + 1);
        const isNow = row.section_id === nowId;
        const done =
          row.included &&
          row.boundaryIndex !== undefined &&
          row.boundaryIndex < boundaries.length - 1 &&
          index >= nextStart;
        const checked = checkedById.get(row.section_id) !== false;
        const busy = pending.has(row.section_id);
        const depth = Math.max(0, (row.level ?? 1) - 1);
        const label = row.title || `Section ${i + 1}`;

        const jumpable = row.boundaryIndex !== undefined;

        return (
          <li
            key={row.section_id}
            ref={isNow ? currentRef : undefined}
            className={[
              "chaprow",
              isNow ? "is-now" : "",
              done ? "is-done" : "",
              checked ? "" : "is-off",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ ["--depth" as string]: String(Math.min(depth, 3)) }}
          >
            {/*
             * A jump target is a button; a row that cannot be jumped to is not.
             *
             * An excluded section has no `start_index`, so its row was a
             * *disabled* button — announced to a screen reader as "button,
             * unavailable", listed before a switch that does work, and skipped
             * by Tab so there is no way to reach the switch's label. As a
             * disabled button it also still carries `cursor: pointer` and
             * `title` advice that no click can act on. Plain markup that
             * contains the label and the meta line is the honest version: the
             * switch beside it is the only control that row has.
             */}
            {jumpable ? (
              <button
                type="button"
                className="chaprow__go"
                onClick={() => onSeekTo(row.boundaryIndex as number)}
                aria-current={isNow ? "true" : undefined}
              >
                <ChapterRowBody
                  label={label}
                  wordCount={row.word_count}
                  included={row.included}
                  done={done}
                  isNow={isNow}
                  startIndex={row.start_index}
                  count={count}
                  index={index}
                />
              </button>
            ) : (
              <div className="chaprow__go">
                <ChapterRowBody
                  label={label}
                  wordCount={row.word_count}
                  included={row.included}
                  done={done}
                  isNow={isNow}
                  startIndex={row.start_index}
                  count={count}
                  index={index}
                />
              </div>
            )}

            <button
              type="button"
              className={["chaprow__check", checked ? "is-on" : ""].join(" ")}
              role="switch"
              aria-checked={checked}
              aria-label={`${checked ? "Exclude" : "Include"} ${label}`}
              title={checked ? "Exclude from reading" : "Include in reading"}
              disabled={busy}
              onClick={() => onToggleSection(row.section_id, !checked)}
            >
              {busy ? (
                <Icon name="spinner" size={14} className="spinner__glyph" />
              ) : (
                <Icon name="check" size={13} weight={2.4} />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
});

/** The progress bar and the two lines of text inside one row. */
function ChapterRowBody({
  label,
  wordCount,
  included,
  done,
  isNow,
  startIndex,
  count,
  index,
}: {
  label: string;
  wordCount: number;
  included: boolean;
  done: boolean;
  isNow: boolean;
  startIndex: number;
  count: number;
  index: number;
}) {
  return (
    <>
      <span className="chaprow__bar" aria-hidden="true">
        <span
          className="chaprow__fill"
          style={{
            transform: `scaleX(${
              done ? 1 : isNow ? sectionProgress(startIndex, count, index) : 0
            })`,
          }}
        />
      </span>
      <span className="chaprow__text">
        <span className="chaprow__title">{label}</span>
        <span className="chaprow__meta">
          {fmtWords(wordCount, true)} words
          {included ? "" : " · not in the reading"}
        </span>
      </span>
    </>
  );
}

export function ChapterRail({
  open,
  onClose,
  boundaries,
  stream,
  selections,
  index,
  onSeekTo,
  canHover,
  onToggleSection,
  pending,
  pinned,
  onTogglePin,
}: Props) {
  /*
   * Derived once per change of `stream` or `selections`, not once per render.
   *
   * A new Map on every render is fine on its own, but it is also a new
   * reference every time — which would defeat the `memo` on `ChapterRows`
   * below, since the map is one of its props. It only actually depends on
   * those two inputs.
   */
  const checkedById = useMemo(
    () =>
      new Map(
        stream.map((s) => [s.section_id, selections[s.section_id] ?? s.default_checked]),
      ),
    [stream, selections],
  );

  return (
    <AnimatePresence>
      {open && (
        <div className="overlay overlay--right overlay--rail">
          <motion.div
            className="overlay__scrim overlay__scrim--soft"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.aside
            className={`rail-panel${canHover ? "" : " rail-panel--touch"}`}
            role="dialog"
            aria-label="Chapters"
            initial={{ x: 28, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 28, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
          >
            <header className="rail-panel__head">
              <div className="rail-panel__titles">
                <span className="kicker">Contents</span>
                <span className="rail-panel__count">
                  {boundaries.length} of {stream.length}{" "}
                  {stream.length === 1 ? "section" : "sections"}
                </span>
              </div>
              <div className="rail-panel__tools">
                <IconButton
                  name="expand"
                  label={pinned ? "Unpin contents" : "Pin contents open"}
                  size={17}
                  subtle
                  active={pinned}
                  onClick={onTogglePin}
                />
                <IconButton name="close" label="Close contents" size={17} subtle onClick={onClose} />
              </div>
            </header>

            {stream.length === 0 ? (
              <p className="rail-panel__empty">
                No chapter headings were detected in this book. It will read as one
                continuous stream.
              </p>
            ) : (
              <ChapterRows
                boundaries={boundaries}
                stream={stream}
                index={index}
                checkedById={checkedById}
                onSeekTo={onSeekTo}
                onToggleSection={onToggleSection}
                pending={pending}
              />
            )}

            <footer className="rail-panel__foot">
              <span className="dim">
                Excluding a section rebuilds the book's word stream.
              </span>
            </footer>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
