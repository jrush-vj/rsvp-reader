import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, IconButton, LinkButton } from "../components/ui/Button";
import { Card, Chip, Kicker } from "../components/ui/Surface";
import { EmptyState, Notice, Progress, Skeleton } from "../components/ui/Feedback";
import { Dialog } from "../components/ui/Overlay";
import { deleteBook } from "../lib/api";
import { fmtDate, fmtMinutes, fmtWords, minsFor } from "../lib/format";
import { shortName } from "../lib/names";
import type { BookSummary } from "../lib/types";
import { useLibrary } from "../store/library";
import { useToast } from "../store/toast";

/**
 * The library.
 * ---------------------------------------------------------------------------
 * A grid of books, each with the only two things that matter about it: how far
 * in you are, and how long is left. Sorting is fixed — most recently *read*
 * first, falling back to when a book was added for the ones never opened —
 * because a personal library is small enough that a sort control would be more
 * chrome than it is worth.
 */

type Filter = "all" | "reading" | "finished";

export function LibraryPage() {
  const { books, initialLoading, loading, error, refresh, removeLocal } = useLibrary();
  const [params] = useSearchParams();
  const focus = params.get("focus");

  const [filter, setFilter] = useState<Filter>("all");
  const [pendingDelete, setPendingDelete] = useState<BookSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const shown = useMemo(() => {
    // Most recently read first, falling back to when it was added for a book
    // that has never been opened. Sorting on `created` alone would bury the
    // one you were in the middle of under everything uploaded after it.
    const stamp = (b: BookSummary) => b.updated || b.created || "";
    const list = [...books].sort((a, b) => stamp(b).localeCompare(stamp(a)));
    if (filter === "reading") return list.filter((b) => b.started && !b.finished);
    if (filter === "finished") return list.filter((b) => b.finished);
    return list;
  }, [books, filter]);

  const counts = useMemo(
    () => ({
      all: books.length,
      reading: books.filter((b) => b.started && !b.finished).length,
      finished: books.filter((b) => b.finished).length,
    }),
    [books],
  );

  async function confirmDelete() {
    const book = pendingDelete;
    if (!book) return;
    setBusy(true);
    // Optimistic: the row disappears immediately, and comes back if the server
    // refuses. Deleting is irreversible server-side, so a slow spinner on a
    // destructive action is worse than a brief lie.
    removeLocal(book.book_id);
    try {
      await deleteBook(book.book_id);
      toast.push(`Deleted “${shortName(book.filename)}”.`, { tone: "ok" });
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : "Could not delete that book.",
        { tone: "danger" },
      );
      await refresh();
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  return (
    <div className="page page--library">
      <header className="page__head">
        <div className="page__titles">
          <Kicker>Library</Kicker>
          <h1 className="page__title">
            {counts.all === 0
              ? "Your books"
              : `${counts.all} ${counts.all === 1 ? "book" : "books"}`}
          </h1>
          {counts.all > 0 && (
            <p className="page__lede">
              {counts.reading > 0
                ? `${counts.reading} in progress, ${counts.finished} finished.`
                : `${counts.finished} finished.`}
            </p>
          )}
        </div>

        <div className="page__actions">
          <IconButton
            name="restart"
            label="Refresh library"
            onClick={() => void refresh()}
            disabled={loading}
          />
          <LinkButton to="/add" variant="primary" icon="plus">
            Add a book
          </LinkButton>
        </div>
      </header>

      {error && (
        <Notice
          tone="danger"
          title="Could not reach the library"
          action={
            <Button size="sm" variant="glass" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {counts.all > 0 && (
        <div className="filters" role="tablist" aria-label="Filter books">
          {(
            [
              ["all", "All"],
              ["reading", "Reading"],
              ["finished", "Finished"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`filter ${filter === key ? "is-active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
              <span className="filter__count tnum">{counts[key]}</span>
            </button>
          ))}
        </div>
      )}

      {initialLoading ? (
        <div className="bookgrid">
          {[0, 1, 2, 3].map((k) => (
            <Card key={k} className="bookcard bookcard--skeleton">
              <Skeleton width="70%" height={17} />
              <Skeleton width="40%" height={11} />
              <Skeleton width="100%" height={6} radius={999} />
              <Skeleton width="55%" height={11} />
            </Card>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <Card>
          {filter !== "all" && counts.all > 0 ? (
            <EmptyState
              icon="eye"
              title={filter === "reading" ? "Nothing in progress" : "Nothing finished yet"}
              body="Switch back to All to see everything in your library."
              action={
                <Button variant="glass" onClick={() => setFilter("all")}>
                  Show all books
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No books yet"
              body="Add a PDF and BookTube will find its chapters, skip the index, and remember where you stopped."
              action={
                <LinkButton to="/add" variant="primary" icon="plus">
                  Add your first book
                </LinkButton>
              }
            />
          )}
        </Card>
      ) : (
        <div className="bookgrid">
          <AnimatePresence initial={false}>
            {shown.map((book) => (
              <BookCard
                key={book.book_id}
                book={book}
                highlighted={book.book_id === focus}
                onDelete={() => setPendingDelete(book)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onClose={() => !busy && setPendingDelete(null)}
        title="Delete this book?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" onClick={() => void confirmDelete()} disabled={busy}>
              {busy ? "Deleting…" : "Delete book"}
            </Button>
          </>
        }
      >
        <p>
          <strong>{pendingDelete ? shortName(pendingDelete.filename) : ""}</strong> and
          everything stored for it will be removed from disk, including your reading
          position.
        </p>
        <p className="dim">
          {fmtWords(pendingDelete?.chosen_words ?? 0, true)} words will be deleted.
          The original PDF on your computer is not touched. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------ book card */

function BookCard({
  book,
  highlighted,
  onDelete,
}: {
  book: BookSummary;
  highlighted: boolean;
  onDelete: () => void;
}) {
  const pct = Math.max(0, Math.min(1, (book.percent || 0) / 100));
  const left = Math.max(0, (book.chosen_words || 0) - (book.word_index || 0));
  const name = shortName(book.filename);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      className={["bookcard card", highlighted ? "is-focus" : ""].filter(Boolean).join(" ")}
    >
      <div className="bookcard__top">
        <span className="bookcard__spine" aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
        <div className="bookcard__id">
          <h2 className="bookcard__name" title={book.filename}>
            {name}
          </h2>
          <span className="bookcard__meta">
            {book.total_pages} pages · {fmtWords(book.chosen_words, true)} words ·{" "}
            {/* "read 2 h ago" is the useful half of a timestamp; the upload
                date only matters for a book that has never been opened. */}
            {book.updated ? `read ${fmtDate(book.updated)}` : `added ${fmtDate(book.created)}`}
          </span>
        </div>
        <IconButton
          name="trash"
          label={`Delete ${name}`}
          size={16}
          subtle
          className="bookcard__del"
          onClick={onDelete}
        />
      </div>

      <div className="bookcard__chips">
        {book.finished ? (
          <Chip tone="ok">Finished</Chip>
        ) : book.started ? (
          <Chip tone="accent">In progress</Chip>
        ) : (
          <Chip>Not started</Chip>
        )}
        {book.confidence !== null && <Chip>{Math.round((book.confidence ?? 0) * 100)}% outline</Chip>}
        <Chip>{book.readable_count} chapters</Chip>
      </div>

      <div className="bookcard__meter">
        <Progress value={pct} label={`${Math.round(pct * 100)} percent read`} />
        <div className="bookcard__meter-row">
          <span className="tnum">{Math.round(pct * 100)}%</span>
          <span className="dim">
            {!book.started
              ? `${fmtWords(book.chosen_words, true)} words`
              : book.finished
                ? "Complete"
                : `${fmtMinutes(minsFor(left, 600))} left`}
          </span>
        </div>
      </div>

      <div className="bookcard__foot">
        <Link to={`/read/${book.book_id}`} className="bookcard__open">
          <Icon name="play" size={15} />
          {book.finished ? "Read again" : book.started ? "Resume" : "Start reading"}
        </Link>
      </div>
    </motion.article>
  );
}

/* Default export for the route table's `lazy()`; the name is kept for direct use. */
export default LibraryPage;
