import { memo } from "react";
import { splitAtOrp } from "../lib/words";
import type { Word } from "../lib/words";

/**
 * The reading stage: one word, with its pivot letter in the reserved red,
 * inside the ruled frame of the original reader.
 * ---------------------------------------------------------------------------
 * Geometry, which is the whole point of this component:
 *
 * The pre-part is right-aligned, the pivot letter sits in a fixed-width centre
 * column, and the post-part is left-aligned. That means the **pivot letter
 * never moves** as words change length — the eye can rest on one spot, which
 * is the single biggest factor in whether RSVP is comfortable or nauseating.
 *
 * The original reader got that stability from a monospace face, where every
 * advance was the same width, and its UI felt like a terminal as a result. Here
 * the face is a serif (the original's own `--serif`, Georgia) and the stability
 * comes from the grid instead: the pivot is always exactly one character, so it
 * gets its own `auto` track between two `minmax(0, 1fr)` halves of the line.
 * Equal halves put that one glyph on the centre of the screen, and the `0`
 * minimum stops a long word from widening its own half and dragging the pivot
 * sideways. Same steadiness as the monospace original, and it reads as a book
 * page rather than as code.
 *
 * The pivot track is the width of the glyph and no wider, because it is `auto`.
 * Reserving extra room for it — the column was once fixed at `2ch` — left half a
 * character of empty track beside a narrow pivot, so "high" was painted
 * "h i gh". A word's letters have to set solid, or it stops reading as a word.
 *
 * The frame — hairlines ruled above and below the word, with a short tick
 * rising from each toward the centre — is the original reader's, reproduced.
 * The gap between the two ticks is where the word sits, so the eye gets a fixed
 * crosshair to return to after each flash. That is why the pivot does not need
 * a marker drawn next to it.
 *
 * The pivot is the only red in the product. Nothing else in the interface uses
 * `--orp`, which is what makes it findable at a glance.
 */

interface Props {
  word: Word | undefined;
  /** Scale of the whole stage. */
  scale?: number;
  /**
   * Words per minute, repeated in the frame's bottom-right corner. The original
   * reader showed the speed there, and it is picked up by the eye without
   * leaving the word, which the control down in the transport bar is not.
   */
  wpm?: number;
}

export const ReaderWord = memo(function ReaderWord({
  word,
  scale = 1,
  wpm,
}: Props) {
  const text = word?.text ?? "";
  const [pre, pivot, post] = word ? splitAtOrp(word) : ["", "", ""];

  return (
    <div className="stage" aria-live="off">
      {/* The two vertical ticks. `top` climbs down from the upper rule and
          `bottom` climbs up from the lower one, so the gap between them frames
          the word at the vertical centre of the band. */}
      <span className="stage__tick stage__tick--top" aria-hidden="true" />
      <span className="stage__tick stage__tick--bottom" aria-hidden="true" />

      <div
        className="stage__word"
        style={{
          ["--stage-scale" as string]: String(scale),
        }}
      >
        {/* Announced once, in full, for a screen reader — never per word. */}
        <span className="sr-only">{text}</span>
        <span className="stage__line" aria-hidden="true">
          <span className="stage__pre">{pre}</span>
          <span className="stage__pivot">{pivot}</span>
          <span className="stage__post">{post}</span>
        </span>
      </div>

      {wpm ? (
        <span className="stage__wpm" aria-hidden="true">
          {wpm} wpm
        </span>
      ) : null}
    </div>
  );
});
