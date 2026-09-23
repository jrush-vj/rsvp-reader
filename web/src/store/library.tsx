import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { listBooks } from "../lib/api";
import type { BookSummary } from "../lib/types";

/**
 * The library, shared by every page.
 * ---------------------------------------------------------------------------
 * Both Home and Library need the book list, and the reader invalidates it
 * (reading changes progress). Holding it in one place means one fetch per
 * navigation rather than one per page, and one place to fix staleness.
 *
 * There is deliberately no polling. A local, single-user app has exactly one
 * writer, so an explicit `refresh()` after a mutation is both simpler and more
 * accurate than a timer that guesses.
 */

interface LibraryValue {
  books: BookSummary[];
  loading: boolean;
  /** True only for the very first load, so a refresh never blanks the page. */
  initialLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Drop one book locally, for an optimistic delete. */
  removeLocal: (bookId: string) => void;
  /** Replace one book locally, for an optimistic re-check. */
  upsertLocal: (book: BookSummary) => void;
}

const Ctx = createContext<LibraryValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow first request resolving after a newer one.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await listBooks();
      if (mine !== seq.current) return;
      setBooks(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err.message : "Could not load your library.");
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setLoadedOnce(true);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeLocal = useCallback((bookId: string) => {
    setBooks((prev) => prev.filter((b) => b.book_id !== bookId));
  }, []);

  const upsertLocal = useCallback((book: BookSummary) => {
    setBooks((prev) => {
      const at = prev.findIndex((b) => b.book_id === book.book_id);
      if (at === -1) return [book, ...prev];
      const next = prev.slice();
      next[at] = book;
      return next;
    });
  }, []);

  const value = useMemo<LibraryValue>(
    () => ({
      books,
      loading,
      initialLoading: loading && !loadedOnce,
      error,
      refresh,
      removeLocal,
      upsertLocal,
    }),
    [books, loading, loadedOnce, error, refresh, removeLocal, upsertLocal],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary(): LibraryValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useLibrary must be used inside <LibraryProvider>.");
  return value;
}

/** The book most recently read, which is what "Continue reading" offers. */
export function mostRecent(books: BookSummary[]): BookSummary | null {
  // `updated` is when the book was last read; `created` is when it was
  // uploaded and never moves. Ranking on `created` alone would send you into
  // whichever book was added last rather than the one you were actually in
  // the middle of, which is the opposite of what "Continue reading" means.
  const stamp = (b: BookSummary) => b.updated || b.created || "";

  const started = books.filter((b) => b.started && !b.finished);
  if (started.length) {
    return started.reduce((best, b) => (stamp(b) > stamp(best) ? b : best));
  }
  return books[0] ?? null;
}

/** Totals across the library, used by the Home page. */
export function totals(books: BookSummary[]) {
  return books.reduce(
    (acc, b) => {
      acc.words += b.chosen_words || 0;
      acc.read += Math.min(b.word_index || 0, b.chosen_words || 0);
      acc.pages += b.total_pages || 0;
      if (b.started && !b.finished) acc.reading += 1;
      if (b.finished) acc.finished += 1;
      return acc;
    },
    { words: 0, read: 0, pages: 0, reading: 0, finished: 0 },
  );
}
