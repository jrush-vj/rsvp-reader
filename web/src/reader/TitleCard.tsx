import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { TitleCard } from "./useReader";

/**
 * The chapter title card.
 * ---------------------------------------------------------------------------
 * RSVP has no visible paragraph, so a chapter break would otherwise be
 * invisible: the reader would be reading one sentence and the next word would
 * already belong to a new chapter. This card is the only signal that a boundary
 * was crossed.
 *
 * It dismisses itself after `dwell` milliseconds, which the engine computes
 * from the text so a long title holds longer than "Prologue". Clicking it, or
 * pressing a key, skips the wait. A progress line across the bottom shows the
 * remaining dwell, so the pause reads as intentional rather than as a hang.
 */

interface Props {
  card: TitleCard | null;
  onDismiss: () => void;
}
export function TitleCardOverlay({ card, onDismiss }: Props) {
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!card) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Auto-resume keeps reading flowing; without it a paused reader would have
    // to press play at every chapter, which turns a feature into a chore.
    timer.current = window.setTimeout(onDismiss, card.dwell);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [card, onDismiss]);

  return (
    <AnimatePresence>
      {card && (
        <motion.div
          className="titlecard"
          role="status"
          aria-live="polite"
          onClick={onDismiss}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
        >
          <motion.div
            className="titlecard__inner"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            <span className="titlecard__kind">{card.kind}</span>
            <span className="titlecard__rule" aria-hidden="true" />
            {card.lead && <span className="titlecard__lead">{card.lead}</span>}
            <h2 className="titlecard__title">{card.title}</h2>
            {card.sub && <p className="titlecard__sub">{card.sub}</p>}

            <span className="titlecard__hint">Click to continue</span>
          </motion.div>

          <motion.span
            className="titlecard__timer"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: card.dwell / 1000, ease: "linear" }}
            aria-hidden="true"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
