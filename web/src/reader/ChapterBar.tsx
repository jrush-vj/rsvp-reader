import { motion } from "framer-motion";
import { useMemo } from "react";
import { fmtWords } from "../lib/format";
import { sectionProgress } from "../lib/format";
import type { Boundary } from "../lib/types";

/**
 * The chapter bar.
 * ---------------------------------------------------------------------------
 * Proportional to *length*, not to chapter count.
 *
 * The original drew one even segment per chapter, which lies about a book: a
 * two-page prologue and a sixty-page chapter looked identical, so the bar was
 * useless for judging where you were. Segments are now sized by `word_count`.
 *
 * A floor is applied at `total / 220` words. Without it a very short section —
 * front matter, a one-page interlude — collapses to a sliver that cannot be
 * clicked or even seen. 220 words is roughly the size below which a section is
 * no longer a meaningful unit of navigation.
 */

interface Props {
  boundaries: Boundary[];
  /** Current word index, for the fill and the highlighted segment. */
  index: number;
  onSeekTo: (boundaryIndex: number) => void;
  className?: string;
}

export function ChapterBar({ boundaries, index, onSeekTo, className = "" }: Props) {
  const segments = useMemo(() => {
    if (!boundaries.length) return [];
    const totalWords = boundaries.reduce((sum, b) => sum + Math.max(0, b.word_count || 0), 0);
    if (totalWords <= 0) {
      return boundaries.map((b) => ({ b, share: 1, start: 0 }));
    }
    const floor = totalWords / 220;
    return boundaries.map((b) => {
      const words = Math.max(0, b.word_count || 0);
      return { b, share: Math.max(words, floor), start: b.start_index };
    });
  }, [boundaries]);

  if (!segments.length) return null;

  // The last segment must own everything after its start, so a boundary list
  // that does not reach the final word cannot leave a gap at the right.
  const currentAt = (() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].start <= index) return i;
    }
    return 0;
  })();

  const totalShare = segments.reduce((sum, s) => sum + s.share, 0);

  return (
    <div className={`chapbar ${className}`.trim()} role="group" aria-label="Chapters">
      {segments.map((s, i) => {
        const isPast = i < currentAt;
        const isNow = i === currentAt;
        const nextStart =
          i + 1 < segments.length ? segments[i + 1].start : Number.POSITIVE_INFINITY;
        const count =
          Number.isFinite(nextStart)
            ? Math.max(1, nextStart - s.start)
            : Math.max(1, index - s.start + 1);
        const fill = isPast ? 1 : isNow ? sectionProgress(s.start, count, index) : 0;
        const label = s.b.title || s.b.full_title || "Untitled section";

        return (
          <button
            key={`${s.b.section_id}-${i}`}
            type="button"
            className={[
              "chapbar__seg",
              isPast ? "is-past" : "",
              isNow ? "is-now" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ flexGrow: s.share / totalShare }}
            onClick={() => onSeekTo(i)}
            title={`${label} — ${fmtWords(s.b.word_count, true)} words`}
            aria-label={`Go to ${label}, ${fmtWords(s.b.word_count, true)} words`}
            aria-current={isNow ? "true" : undefined}
          >
            <motion.span
              className="chapbar__fill"
              initial={false}
              animate={{ scaleX: fill }}
              transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
            />
          </button>
        );
      })}
    </div>
  );
}
