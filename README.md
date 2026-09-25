# RSVP Reader

A local speed-reading app for books and notes. Drop in a PDF, pick the parts
worth reading, and read them one word at a time at your own pace — with the
chapter title shown full-screen each time you cross into a new section, so you
always know where you are.

Everything runs on your own machine. There is no AI model, no API key, and no
network call beyond the local app process.

---

## What it does

1. **You drop in a PDF.** The backend extracts its text and works out its
   structure — parts, chapters, subchapters and the front/back matter you
   probably don't want to read.
2. **You pick what to read.** A tree of checkboxes, one per section, each with a
   word count and a short preview of the opening words so you can tell a real
   chapter from a stray heading. Parent rows select or clear everything beneath
   them, and the footer shows the running word count and estimated reading time.
3. **You read.** The chosen sections are joined into one continuous stream. At
   each chapter or subchapter boundary the title fills the screen for a few
   seconds — skippable with Space, Enter, Escape or a click — and then the words
   start from that section's first word.

The app is a multi-page desktop interface with a sidebar and chapter rail. The
React UI in `web/` is bundled inside the Tauri application; it is not separately
hosted as a website.

Your position and your section choices are saved per book, so closing and
reopening the app offers **Resume** or **Start over**.

---

## Desktop App

BookTube is a Tauri desktop application for Windows and Linux. Install the
platform/architecture package from the latest GitHub Release. The app runs its
local PDF-processing backend on loopback and stores books and reading state in
the operating system's application-data directory. No browser, Python install,
account, or network connection is needed after installation.

### Development

Install Node.js 22, Python 3.11+, Rust, and the Tauri system prerequisites for
your OS. Install the Python and npm dependencies, then launch the desktop app:

```bash
python -m pip install -r requirements.txt
npm ci
npm ci --prefix web
npm run dev
```

To build locally, install PyInstaller and package for your current Rust target:

```bash
python -m pip install pyinstaller
npm run build
```

Linux builds also require Tauri's WebKitGTK and GTK development packages.

Pushes to `master` publish prerelease builds automatically. Pushing a `v*` tag
(for example `v1.1.0`) publishes a versioned GitHub Release. The workflow builds
Windows x64 and ARM64 NSIS installers and Linux x64 and ARM64 AppImage and `.deb`
packages on native GitHub Actions runners.

---

## Using it

### Pages

| Page      | Route        | What it is                                                     |
| --------- | ------------ | -------------------------------------------------------------- |
| Home      | `#/`          | Library overview and continue reading                     |
| Library   | `#/library`   | Processed books, with **Open** and **Delete**              |
| Add a book| `#/add`       | PDF drop zone and paste box                                 |
| Reader    | `#/read/<id>` | Select sections, then read the book                        |

**Home.** Shows reading activity and offers to continue the most recent book.

**Add a book.** Drop a PDF on the drop zone, or click to browse. The PDF is
parsed once and kept, so reopening it later does not require parsing it again.
The paste box reads a block of text locally without adding it to the library.

**Library.** Lists processed books with word count, section count, detection
method, and reading progress. **Open** or **Resume** opens a book; **Delete**
removes it from local app data.

**Reader.** Choose which sections to read, then start or resume playback. The
chapter bar, chapter rail, and title cards all navigate the same reading stream.

### While reading

The reader has three pieces of chapter chrome, all built from the same list of
boundaries the title cards use:

- a **chapter bar** under the seek slider, each segment as wide as its chapter
  is long, so the current chapter is one click away and its density is visible;
- a **quick-links rail** on the right, one line per chapter with a progress bar,
  opened with **Chapters** or `C`. It opens by itself on a wide window;
- the **title card** at each boundary, which holds playback still until you
  dismiss it.

| Key                | Does                                                  |
| ------------------ | ----------------------------------------------------- |
| `Space`            | play / pause                                          |
| `←` `→`            | ten seconds back / forward                            |
| `↑` `↓`            | reading speed, in steps of 50 wpm                     |
| `PgUp` / `PgDn`    | previous / next chapter (`PgUp` restarts the current one first) |
| `C`                | open / close the chapter rail                         |
| `F`                | full screen — hides the sidebar and the page padding   |
| `R`                | restart the book                                      |
| `Esc`              | close the rail, or bring the controls back             |

Full screen is remembered between sessions. The controls fade out a couple of
seconds into playback and come back on any key or mouse movement; while the rail
is open they stay put, since they are how you step chapters.

---

## Command line

Process a book without the UI:

```bash
python clientbuild.py path/to/book.pdf
```

It derives the book id from a hash of the PDF's own bytes, so reprocessing the
same file lands in the same directory while a different edition gets its own.
Options: `--book-id` to override the id, `--out` to choose the output directory,
`--no-pdf` to skip copying the original into it.

---

## How It's Put Together

```
app.py            loopback-only Flask API sidecar
detector.py       finds the book's structure (heuristics only)
pdftext.py        PDF -> per-page lines plus font metadata
sections.py       turns entries into a tree, strips headings, counts words
tokenizer.py      text -> words, with ORP index and pause multiplier per word
clientbuild.py    writes the per-section word files the frontend reads
src-tauri/        Rust/Tauri desktop host and backend sidecar lifecycle
web/              React + Vite desktop frontend
desktop/          Python backend bundling helper
scripts/          verifiers and one-off inspection tools
```

### Detection

Structure is found by a cascade, best signal first:

| Strategy   | Source                                                        |
| ---------- | ------------------------------------------------------------- |
| `outline`  | the PDF's own bookmark tree — exact titles, nesting and pages   |
| `contents` | the printed contents page; link annotations first, then dot-leader lines |
| `fonts`    | cluster text by font size and weight, since headings stand out |
| `whole`    | last resort: one long section, so the reader still works       |

Whichever wins, the same downstream steps run, so hierarchy building and
boundary repair behave identically regardless of how the entries were found.

### Schema v2, on disk

```
<app-data>/books/<book_id>/
    book.pdf              the original, so a book can be reprocessed
    meta.json             the structure, with word counts and previews
    state.json            where you left off and which sections you chose
    client/<section_id>.json   one readable section's words, precomputed
```

Words are precomputed because tokenising is deterministic — the same text
always yields the same words, offsets and pauses — so opening a book is a file
read instead of a PDF parse, and the backend serving an already-processed book
never touches `pypdf`.

`clientbuild.py` documents the one invariant it enforces, from a single source
string so the two numbers cannot drift:

```
meta.json word_count == len(client/<section_id>.json["words"])
```

### API

| Method   | Path                                  | Purpose                              |
| -------- | ------------------------------------- | ------------------------------------ |
| `GET`    | `/api/books`                          | list processed books                 |
| `POST`   | `/api/books`                          | upload and process a PDF (201)       |
| `GET`    | `/api/books/<id>`                     | one book: summary, structure, choices |
| `DELETE` | `/api/books/<id>`                     | remove a book                        |
| `GET`    | `/api/books/<id>/words`               | the chosen sections, joined, for reading |
| `GET`    | `/api/books/<id>/state`               | saved position and choices           |
| `PUT`    | `/api/books/<id>/state`               | merge a position and/or choices       |
| `PATCH`  | `/api/books/<id>/sections/<section_id>` | toggle one section                 |
| `GET`    | `/api/health`                         | local backend health check           |

A PDF with no extractable text is rejected with **422** and an explanation that
it is probably scanned images needing OCR first. That is deliberate: OCR is not
attempted here.

---

## Verifying it

With the local backend running:

```bash
python scripts/verify_tokenizer.py                            # token offsets and pauses
python scripts/verify_detector.py                             # structure detection heuristics
python scripts/verify_api.py                                   # endpoint behaviour
python scripts/verify_book.py                                  # on-disk book vs schema
python scripts/verify_upload.py                                # library PDF upload validation
python scripts/verify_ui_contract.py http://127.0.0.1:5000 <book_id>   # the JSON the UI reads
```

`verify_ui_contract.py` is the load-bearing one for the frontend: it checks that
every field the UI dereferences actually exists, that boundaries line up with
the word stream, and that the sections offered to the picker really are ones the
server will accept a change for.

`scripts/show_tree.py` and `scripts/compare_schema.py` are inspection tools
rather than pass/fail checks — the first prints a detected structure, the second
compares an on-disk book against the current schema.

---

## Limits, on purpose

- **Heuristics only.** No language model decides what a chapter is, so a
  badly-tagged PDF can still be structured wrongly. The picker exists so you can
  fix it by hand.
- **No OCR.** Scanned PDFs are refused with a clear message rather than
  silently producing nothing.
- **PDF only.** No EPUB.
- **One machine.** No accounts and no cross-device sync; state is saved in the
  operating system's app-data directory.
