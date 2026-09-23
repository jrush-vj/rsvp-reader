/**
 * Server payload types.
 * ---------------------------------------------------------------------------
 * These mirror what `app.py` returns. They are hand-written rather than
 * generated, so each field carries a note about what the server actually
 * guarantees — the ones that matter are the merge semantics on `PUT /state`
 * and the fact that `words` is pre-filtered by the saved selections.
 */

/** One entry in `meta.stream`: the playback order, already flattened. */
export interface StreamEntry {
  section_id: string;
  file: string;
  title: string | null;
  full_title: string | null;
  entry_type: string | null;
  level: number;
  start_page: number | null;
  end_page: number | null;
  word_count: number;
  /**
   * Whether the section starts checked.
   *
   * Front and back matter (copyright, index, notes) is `false`, as are the
   * bonus subchapters — which is how the reader avoids offering a reader the
   * parts of a book they almost never want.
   */
  default_checked: boolean;
}

/** One node of the section tree in `meta.sections`. */
export interface SectionNode {
  section_id: string;
  title: string | null;
  full_title?: string | null;
  entry_type?: string | null;
  level?: number;
  start_page?: number | null;
  end_page?: number | null;
  word_count?: number;
  is_readable?: boolean;
  children?: SectionNode[];
}

/** `meta.json` — the book's structure, written once at processing time. */
export interface BookMeta {
  schema: number;
  book_id: string;
  filename: string;
  created: string;
  total_pages: number;
  /** Which detector strategy won: `outline`, `contents`, `fonts`, `whole_doc`. */
  method: string;
  confidence: number | null;
  notes?: string | null;
  front_matter_pages?: number;
  total_words: number;
  readable_count: number;
  checked_count: number;
  stream: StreamEntry[];
  sections: SectionNode[];
}

/** `state.json` — where the reader is and what they have chosen, per book. */
export interface BookState {
  book_id: string;
  updated?: string;
  word_index: number;
  section_id: string | null;
  /**
   * A **superset** of the stream: the server records every leaf, including
   * front and back matter the reader is never offered. Always look up the ids
   * you care about rather than iterating this map.
   */
  selections: Record<string, boolean>;
}

/** A book as the library list needs it: identity plus progress. */
export interface BookSummary {
  book_id: string;
  filename: string;
  created: string;
  /** When the reader last had this book open; null if never started. */
  updated: string | null;
  total_pages: number;
  method: string;
  confidence: number | null;
  /** Every word in the book, including the parts not chosen. */
  total_words: number;
  readable_count: number;
  /** Sections the reader has chosen, and the words they add up to. */
  chosen_count: number;
  chosen_words: number;
  word_index: number;
  section_id: string | null;
  /** Progress against `chosen_words`, not the whole book. */
  percent: number;
  started: boolean;
  finished: boolean;
}

/** One word of the reading stream. */
export interface ApiWord {
  text: string;
  orp: number;
  pause: number;
}

/** A chapter boundary inside the flattened stream. */
export interface Boundary {
  section_id: string;
  title: string | null;
  full_title: string | null;
  entry_type: string | null;
  level: number;
  /** Where this section begins in the flat `words` array. */
  start_index: number;
  word_count: number;
}

/** `GET /api/books/<id>/words` — the whole reading stream in one payload. */
export interface StreamPayload {
  book_id: string;
  filename: string;
  method: string;
  total_words: number;
  boundaries: Boundary[];
  /** Only the checked sections, concatenated in document order. */
  words: ApiWord[];
}

/** A file the user picked, held client-side until it is sent. */
export interface PickedFile {
  file: File;
  name: string;
  size: number;
}
