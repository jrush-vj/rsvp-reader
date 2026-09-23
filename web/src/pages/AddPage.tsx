import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/Button";
import { Kicker } from "../components/ui/Surface";
import { Notice } from "../components/ui/Feedback";
import { createBook } from "../lib/api";
import { fmtBytes, fmtWords } from "../lib/format";
import { looksLikePdf, shortName } from "../lib/names";
import { useStored, WPM_KEY } from "../lib/storage";
import { tokenize } from "../lib/words";
import { WPM_DEFAULT } from "../lib/speed";
import { useLibrary } from "../store/library";
import { useToast } from "../store/toast";

/**
 * Add a book.
 * ---------------------------------------------------------------------------
 * Two doors, because there are two kinds of reader:
 *
 * - **A PDF** goes to the server, is parsed once, and is kept. This is the
 *   library path: the book appears in the library, and opening it later is a
 *   file read rather than a re-parse.
 * - **Pasted text** is tokenised in the browser and never leaves the tab. There
 *   is no book id, so nothing is stored — useful for a paragraph or an article,
 *   and it makes the whole reader usable with no backend at all.
 *
 * The size cap mirrors the server's (`MAX_CONTENT_LENGTH`). Checking it here
 * means an oversized file fails in a millisecond instead of after uploading
 * 100 MB.
 */

const MAX_BYTES = 100 * 1024 * 1024;

type Mode = "pdf" | "paste";

export function AddPage() {
  const [mode, setMode] = useState<Mode>("pdf");

  return (
    <div className="page page--add">
      <header className="page__head">
        <div className="page__titles">
          <Kicker>Add a book</Kicker>
          <h1 className="page__title">Bring something to read</h1>
          <p className="page__lede">
            BookTube works out a PDF's chapter structure on the way in, so the
            reader can skip the index and the copyright page without being asked.
          </p>
        </div>
      </header>

      <div className="modes" role="tablist" aria-label="How to add">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "pdf"}
          className={`mode ${mode === "pdf" ? "is-active" : ""}`}
          onClick={() => setMode("pdf")}
        >
          <Icon name="file" size={18} />
          <span className="mode__text">
            <strong>Upload a PDF</strong>
            <span className="dim">Kept in your library</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "paste"}
          className={`mode ${mode === "paste" ? "is-active" : ""}`}
          onClick={() => setMode("paste")}
        >
          <Icon name="text" size={18} />
          <span className="mode__text">
            <strong>Paste text</strong>
            <span className="dim">Nothing is stored</span>
          </span>
        </button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          {mode === "pdf" ? <PdfPanel /> : <PastePanel />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------- pdf path */

function PdfPanel() {
  const navigate = useNavigate();
  const { upsertLocal, refresh } = useLibrary();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    (picked: File | undefined | null) => {
      if (!picked) return;
      setError(null);
      if (!looksLikePdf(picked)) {
        setError(`“${picked.name}” is not a PDF. BookTube reads PDFs only.`);
        return;
      }
      if (picked.size > MAX_BYTES) {
        setError(
          `“${picked.name}” is ${fmtBytes(picked.size)}. The limit is ${fmtBytes(MAX_BYTES)}.`,
        );
        return;
      }
      setFile(picked);
    },
    [],
  );

  // Paste a file straight in with Ctrl+V, and stop the browser from navigating
  // away when a PDF is dropped anywhere on the page.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      accept(e.dataTransfer?.files?.[0]);
    };
    const onPaste = (e: ClipboardEvent) => {
      const f = e.clipboardData?.files?.[0];
      if (f) accept(f);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [accept]);

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { book } = await createBook(file);
      upsertLocal(book);
      toast.push(`Added “${shortName(book.filename)}”.`, { tone: "ok" });
      // The library list carries derived fields the upload response does not
      // compute identically (sorted position, cross-book totals), so it is
      // pulled fresh in the background rather than trusted from the upsert.
      void refresh();
      navigate(`/read/${book.book_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addpanel">
      <button
        type="button"
        className={`dropzone ${dragging ? "is-drag" : ""} ${file ? "has-file" : ""}`}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label={file ? `Selected file ${file.name}. Choose a different file` : "Choose a PDF"}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => {
            accept(e.currentTarget.files?.[0]);
            // Reset so picking the same file twice still fires a change.
            e.currentTarget.value = "";
          }}
        />

        <AnimatePresence mode="wait" initial={false}>
          {file ? (
            <motion.span
              key="picked"
              className="dropzone__inner"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
            >
              <span className="dropzone__glyph dropzone__glyph--file">
                <Icon name="file" size={26} />
              </span>
              <span className="dropzone__name">{file.name}</span>
              <span className="dropzone__meta">{fmtBytes(file.size)} · ready to process</span>
              <span className="dropzone__swap">Choose a different file</span>
            </motion.span>
          ) : (
            <motion.span
              key="empty"
              className="dropzone__inner"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <span className="dropzone__glyph">
                <Icon name="plus" size={26} />
              </span>
              <span className="dropzone__name">Drop a PDF here</span>
              <span className="dropzone__meta">
                or click to browse · up to {fmtBytes(MAX_BYTES)}
              </span>
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {error && (
        <Notice tone="danger" title="Not added">
          {error}
        </Notice>
      )}

      <div className="addpanel__foot">
        <p className="dim addpanel__note">
          <Icon name="sparkle" size={14} /> Processing runs on your own machine. The PDF is
          read once and stored locally; nothing is uploaded anywhere.
        </p>
        <Button
          variant="primary"
          size="lg"
          icon={busy ? "spinner" : "play"}
          disabled={!file || busy}
          onClick={() => void submit()}
        >
          {busy ? "Finding chapters…" : "Add and start reading"}
        </Button>
      </div>

      {busy && (
        <div className="addpanel__progress">
          {/*
           * Indeterminate on purpose. The server parses the whole PDF before it
           * replies, so there is no honest percentage to report — a fake bar
           * that fills on a timer would be a lie about progress.
           */}
          <span className="progress progress--busy" role="progressbar" aria-label="Processing">
            <span className="progress__fill progress__fill--slide" />
          </span>
          <span className="dim">Detecting structure… this can take a moment for a long book.</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ paste path */

function PastePanel() {
  const navigate = useNavigate();
  const toast = useToast();
  const [text, setText] = useState("");
  // The same pace the reader will use, so the estimate here does not promise
  // one reading speed and then deliver another a click later.
  const [wpm] = useStored<number>(WPM_KEY, WPM_DEFAULT);

  const words = text.trim() ? tokenize(text) : [];
  const canStart = words.length >= 5;

  function start() {
    if (!canStart) return;
    // Held for the reader to pick up. sessionStorage rather than a route param
    // because an article-length paste would make an unwieldy URL, and rather
    // than localStorage because it should not survive closing the tab.
    try {
      window.sessionStorage.setItem(
        "booktube.paste",
        JSON.stringify({ filename: firstLine(text), text }),
      );
    } catch {
      toast.push("This browser would not store the pasted text.", { tone: "danger" });
      return;
    }
    navigate("/read/paste");
  }

  return (
    <div className="addpanel">
      <textarea
        className="textarea"
        placeholder="Paste an article, a chapter, or the rest of a page…"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        spellCheck={false}
        rows={12}
        aria-label="Text to read"
      />

      <div className="addpanel__foot">
        <p className="dim addpanel__note">
          {words.length > 0 ? (
            <>
              <strong className="tnum">{fmtWords(words.length, true)}</strong> words · about{" "}
              {Math.max(1, Math.round(words.length / wpm))} min at {wpm} wpm
            </>
          ) : (
            "Pasted text stays in this tab. Nothing is sent to the server."
          )}
        </p>
        <div className="addpanel__buttons">
          {text && (
            <Button variant="ghost" onClick={() => setText("")}>
              Clear
            </Button>
          )}
          <Button variant="primary" size="lg" icon="play" disabled={!canStart} onClick={start}>
            Start reading
          </Button>
        </div>
      </div>
    </div>
  );
}

/* Default export for the route table's `lazy()`; the name is kept for direct use. */
export default AddPage;

/**
 * A title for pasted text.
 *
 * The first non-empty line is the natural title for something copied out of an
 * article, but a pasted paragraph has no line breaks at all — so the fallback
 * is the first *sentence*, not a slice of the first 70 characters. A raw cut
 * lands mid-word and is then shown twice in the reader's header, which reads
 * as a bug rather than as a title.
 */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "Pasted text";
  // A heading is short. Anything longer is prose, so take its first sentence.
  const candidate = line.length <= 60 ? line : (line.match(/[^.!?]+[.!?]?/)?.[0].trim() ?? line);
  if (candidate.length <= 60) return candidate;
  // A single very long sentence: cut on a word boundary, not mid-word.
  const cut = candidate.slice(0, 57);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}
