# RSVP Reader

A local speed-reading app for books and notes. Drop in a PDF, pick the parts
worth reading, and read them one word at a time at your own pace — with the
chapter title shown full-screen each time you cross into a new section, so you
always know where you are.

Everything runs on your own machine. There is no AI model, no API key, and no
network call beyond `localhost`.

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

Your position and your section choices are saved per book, so closing the tab
and coming back offers **Resume** or **Start over**.

---

## Setup

Python 3.11 or newer.

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt     # macOS / Linux
```

Then start the server:

```bash
python app.py
```

Open <http://localhost:5000>. That single address serves both the API and the
reader UI, so there is no second file to open.

`requirements.txt` pins `pypdf` rather than PyMuPDF on purpose: it is pure
Python, so it installs on Windows on ARM64 where PyMuPDF publishes no wheel.

---

## Using it

**Add a book.** On the first visit you land on the upload screen. Drop a PDF on
the drop zone, or click to browse. The PDF is parsed once and kept, so opening
it again later is a file read rather than a re-parse.

**Paste text instead.** If you just want to read a block of text — meeting
notes, an article — use the paste box. That path needs no backend and nothing is
saved.

**Library.** Every processed book is listed with its word count, section count,
the detection method used, and how far through it you are. **Open** (or
**Resume**) goes to the picker; **Delete** asks first and names the file.

**The picker.** Rows you can act on have a live checkbox; front and back matter
the reader is deliberately not offered are dimmed and disabled, shown so the
book's structure stays legible. **Select all** / **Select none** work on the
whole tree. If you have a saved position, a note at the top offers **Resume** or
**Start over**.

**While reading.** Space toggles play, the arrow keys nudge speed and jump
ten seconds either way, and `R` restarts the book. The controls fade out while
you read and come back on mouse movement.

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

## How it's put together

```
app.py            Flask API and static file server
detector.py       finds the book's structure (heuristics only)
pdftext.py        PDF -> per-page lines plus font metadata
sections.py       turns entries into a tree, strips headings, counts words
tokenizer.py      text -> words, with ORP index and pause multiplier per word
clientbuild.py    writes the per-section word files the frontend reads
rsvp_reader.html  the entire frontend: one file, vanilla JS, no build step
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
books/<book_id>/
    book.pdf              the original, so a book can be reprocessed
    meta.json             the structure, with word counts and previews
    state.json            where you left off and which sections you chose
    client/<section_id>.json   one readable section's words, precomputed
```

Words are precomputed because tokenising is deterministic — the same text
always yields the same words, offsets and pauses — so opening a book is a file
read instead of a PDF parse, and a server serving an already-processed book
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
| `POST`   | `/api/upload`                         | tokenise a PDF, store nothing        |
| `GET`    | `/`                                   | the reader UI                        |

A PDF with no extractable text is rejected with **422** and an explanation that
it is probably scanned images needing OCR first. That is deliberate: OCR is not
attempted here.

---

## Verifying it

With the server running:

```bash
python scripts/verify_tokenizer.py                            # token offsets and pauses
python scripts/verify_api.py                                   # endpoint behaviour
python scripts/verify_upload.py                                # upload validation
python scripts/verify_ui_contract.py http://127.0.0.1:5000 <book_id>   # the JSON the UI reads
python scripts/check_reader_js.py                              # frontend script and its element ids
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
- **One machine.** No accounts and no cross-device sync; state is a file next to
  the book.
