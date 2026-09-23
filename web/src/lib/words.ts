/**
 * Word model — the RSVP maths.
 * ---------------------------------------------------------------------------
 * Ported from `tokenizer.py`. These two numbers are derived from nothing but a
 * word's own spelling, so this file is the browser-side twin of the Python
 * module and the two must agree exactly: a book read through `/api/upload`
 * and the same book read from the library have to feel identical.
 *
 * The backend already tags every word, so this is not needed for library
 * books. It exists for text that has no server round trip — the paste box —
 * and as the single documented definition of the algorithm. `verify_tokenizer`
 * parity is why the constants below are written as literals rather than
 * derived.
 */

/** Word separators for the paste path: any run of whitespace. */
const WORD_SPLIT = /\s+/;

/**
 * Punctuation that ends a thought and deserves the longest beat.
 * Duplicated from the Python `_SENTENCE_END` / `_CLAUSE_END` / `_COMMA_END`.
 */
const SENTENCE_END = /[.!?]$/;
const CLAUSE_END = /[;:]$/;
const COMMA_END = /[,)"\u201d]$/;

/** ASCII punctuation, matching Python's `string.punctuation`. */
const PUNCT = new Set(
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(""),
);

/** The word with leading and trailing punctuation removed. */
export function coreWord(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && PUNCT.has(word[start])) start++;
  while (end > start && PUNCT.has(word[end - 1])) end--;
  return word.slice(start, end);
}

/** How many punctuation characters the word opens with. */
export function leadingPunctCount(word: string): number {
  let n = 0;
  for (const ch of word) {
    if (!PUNCT.has(ch)) break;
    n++;
  }
  return n;
}

/**
 * Which character index to highlight, as the Optimal Recognition Point.
 *
 * The eye's landing point moves right as a word lengthens, but in **discrete
 * steps rather than linearly**, so this is a lookup table and not arithmetic.
 * The step boundaries (1, 5, 9, 13) are the original tuned values.
 *
 * Position is taken from the word's *core* so punctuation never pushes the
 * highlight off the word, then shifted right by the leading punctuation the
 * word actually has (a quote occupies a real character position) and clamped
 * inside the string.
 */
export function orpIndex(word: string): number {
  const core = coreWord(word);
  const length = core.length || word.length;

  let idx: number;
  if (length <= 1) idx = 0;
  else if (length <= 5) idx = 1;
  else if (length <= 9) idx = 2;
  else if (length <= 13) idx = 3;
  else idx = 4;

  return Math.min(idx + leadingPunctCount(word), Math.max(word.length - 1, 0));
}

/**
 * How much longer than the base delay this word should hold.
 *
 * Accumulated rather than chosen: a long word ending a sentence is both a
 * sentence end *and* a long word, so the two bonuses stack. That is what stops
 * RSVP reading from feeling like a machine gun.
 */
export function pauseMultiplier(word: string): number {
  let m = 1.0;
  if (SENTENCE_END.test(word)) m = 2.6;
  else if (CLAUSE_END.test(word)) m = 2.0;
  else if (COMMA_END.test(word)) m = 1.5;

  const core = coreWord(word);
  if (core.length >= 10) m += 0.3;
  if (core.length >= 14) m += 0.3;

  // Rounded the same way Python rounds, so the two never differ in the last
  // decimal place and a parity test can compare them directly.
  return Math.round(m * 100) / 100;
}

/** One word as the reader steps through it. */
export interface Word {
  text: string;
  /** Index of the character to paint in the pivot colour. */
  orp: number;
  /** Multiplier on the base per-word delay. */
  pause: number;
}

/** Turn a word into its reading record. */
export function toWord(text: string): Word {
  return { text, orp: orpIndex(text), pause: pauseMultiplier(text) };
}

/** Split prose into reading records. Used by the paste path only. */
export function tokenize(text: string): Word[] {
  return text
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map(toWord);
}

/**
 * Split a word into its three display parts around the pivot index.
 *
 * Clamping happens here as well as in `orpIndex` because a payload written by
 * an older build could carry an index that runs off a shorter word.
 */
export function splitAtOrp(word: Word): [string, string, string] {
  const o = Math.max(0, Math.min(word.orp, word.text.length - 1));
  return [word.text.slice(0, o), word.text.charAt(o), word.text.slice(o + 1)];
}
