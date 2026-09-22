"""
RSVP Reader Backend
====================

Two things live here.

**The library.** A book is uploaded once, processed once, and then kept on disk
as a directory under `books/`. Opening it later is a file read, not a PDF parse,
which is what makes the library screen instant and the reader's progress
resumable across restarts.

**The single-shot flow.** `POST /api/upload` still takes a PDF and hands back a
tokenised word list in one response, for a reader that wants nothing stored. It
shares its tokeniser with the library path, so a book reads identically
whichever door it came through.

Every word carries:

  - ``text``:  the word itself
  - ``orp``:   character index to highlight (Optimal Recognition Point)
  - ``pause``: a multiplier on the base per-word delay, so punctuation gets a
               natural extra beat instead of flying past at reading speed

Setup:
    pip install -r requirements.txt
    python app.py
    -> serves on http://0.0.0.0:5000
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import clientbuild
import detector
import pdftext
import tokenizer

BASE_DIR = Path(__file__).resolve().parent
HTML_FILENAME = "rsvp_reader.html"
BOOKS_DIR = BASE_DIR / "books"

app = Flask(__name__)
CORS(app)  # harmless now that we serve same-origin; keeps file:// usage working too

app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB upload cap


# ---------------------------------------------------------------------------
# On-disk helpers
# ---------------------------------------------------------------------------


def book_path(book_id: str) -> Path:
    """
    The directory for a book id, refusing anything that escapes `books/`.

    A book id arrives from the URL, so a value like `../../etc` would otherwise
    let a request read or delete arbitrary directories. Only the exact shape we
    generate is accepted.
    """
    if not book_id or not book_id.isalnum() or len(book_id) > 32:
        raise ValueError("bad book id")
    return BOOKS_DIR / book_id


def read_json(path: Path, default=None):
    """Load a JSON file, returning `default` when it is absent or corrupt."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        return default


def write_json(path: Path, payload) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_meta(book_id: str) -> dict | None:
    return read_json(book_path(book_id) / "meta.json")


def load_state(book_id: str) -> dict:
    state = read_json(book_path(book_id) / "state.json")
    if not isinstance(state, dict):
        return {
            "book_id": book_id,
            "word_index": 0,
            "section_id": None,
            "selections": {},
        }
    return state


def default_selections(meta: dict) -> dict[str, bool]:
    """The checked/unchecked map a book's own defaults describe."""
    return {
        entry["section_id"]: bool(entry.get("default_checked"))
        for entry in meta.get("stream", [])
    }


def resolve_selections(meta: dict, state: dict) -> dict[str, bool]:
    """
    The checked map to actually play back: the book's defaults, with anything
    the reader has changed laid over the top.

    Merging rather than choosing between the two means a section that appeared
    after a reprocess is playable straight away, while a saved choice always
    beats the default it replaced. On-disk selections may also mention sections
    that are not in the stream - `state.json` records every leaf, including the
    front and back matter the reader is never offered - so the result is a
    superset and callers must look up the ids they care about.
    """
    return {**default_selections(meta), **(state.get("selections") or {})}


def extract_text(pdf_path: Path) -> str:
    """
    A PDF's whole text as one prose string, for the single-shot flow.

    This deliberately runs the same extraction the library path uses - read the
    pages structurally, then normalise - rather than a plain pypdf call. A
    quick extract would split every drop cap and fuse words across missing
    spaces, so the same book would read noticeably worse through `/api/upload`
    than through the library.
    """
    pages = pdftext.read_pages(pdftext.open_reader(str(pdf_path)))
    return detector.normalise_prose(detector.range_text(pages, 1, len(pages)))



# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------


def summarise(meta: dict, state: dict) -> dict:
    """
    A book as the library screen needs it: identity plus reading progress.

    Progress is measured in words against the sections the reader has actually
    chosen, not against the whole book, so the bar reflects the reading the
    user set up rather than a total they never agreed to.
    """
    selections = resolve_selections(meta, state)

    chosen = [
        entry
        for entry in meta.get("stream", [])
        if selections.get(entry["section_id"], entry.get("default_checked", False))
    ]
    chosen_words = sum(entry["word_count"] for entry in chosen)

    index = int(state.get("word_index") or 0)
    index = max(0, index)
    if chosen_words and index > chosen_words:
        index = chosen_words

    percent = round(index / chosen_words * 100) if chosen_words else 0

    return {
        "book_id": meta.get("book_id"),
        "filename": meta.get("filename"),
        "created": meta.get("created"),
        "total_pages": meta.get("total_pages"),
        "method": meta.get("method"),
        "confidence": meta.get("confidence"),
        "total_words": meta.get("total_words"),
        "readable_count": meta.get("readable_count", len(meta.get("stream", []))),
        "chosen_count": len(chosen),
        "chosen_words": chosen_words,
        "word_index": index,
        "section_id": state.get("section_id"),
        "percent": percent,
        "started": index > 0,
        "finished": bool(chosen_words) and index >= chosen_words,
    }


@app.route("/api/books", methods=["GET"])
def list_books():
    """Every processed book, most recently added first."""
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)

    books = []
    for directory in BOOKS_DIR.iterdir():
        if not directory.is_dir():
            continue
        meta = read_json(directory / "meta.json")
        if not isinstance(meta, dict) or "book_id" not in meta:
            # An unprocessed PDF or a half-written directory; not a book yet.
            continue
        books.append(summarise(meta, load_state(meta["book_id"])))

    books.sort(key=lambda book: book.get("created") or "", reverse=True)
    return jsonify({"books": books})


@app.route("/api/books", methods=["POST"])
def create_book():
    """
    Process an uploaded PDF into a new library book.

    The upload is written to a temporary file first because detection reads the
    PDF from disk. The book directory is only kept once processing has produced
    something readable, so a malformed or scanned PDF leaves no half-built book
    behind.
    """
    upload_file = request.files.get("file")
    if upload_file is None:
        return jsonify({
            "error": "No file field in request. Send multipart/form-data with key 'file'."
        }), 400
    if not upload_file.filename:
        return jsonify({"error": "Empty filename."}), 400
    if not upload_file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only .pdf files are supported."}), 400

    BOOKS_DIR.mkdir(parents=True, exist_ok=True)

    handle, temp_name = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    temp_path = Path(temp_name)

    try:
        upload_file.save(temp_path)
        book_id = clientbuild.book_id_for(temp_path)
        meta = clientbuild.build(
            temp_path,
            book_dir=BOOKS_DIR / book_id,
            book_id=book_id,
            filename=upload_file.filename,
        )
    except AssertionError:
        raise
    except Exception as exc:  # malformed / encrypted / unreadable PDF
        return jsonify({"error": f"Could not read this PDF: {exc}"}), 400
    finally:
        temp_path.unlink(missing_ok=True)

    if not meta.get("readable_count"):
        # Structure was found but no text worth reading, which in practice means
        # the pages are scans. Say so plainly rather than opening an empty reader.
        shutil.rmtree(BOOKS_DIR / meta["book_id"], ignore_errors=True)
        return jsonify({
            "error": "No extractable text found. This PDF is likely scanned "
                     "images rather than real text, so it would need OCR first."
        }), 422

    return jsonify({
        "book": summarise(meta, load_state(meta["book_id"])),
        "meta": meta,
    }), 201


@app.route("/api/books/<book_id>", methods=["GET"])
def get_book(book_id: str):
    """A book's structure, its saved state, and the playback order."""
    try:
        meta = load_meta(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400

    if meta is None:
        return jsonify({"error": f"No book {book_id}."}), 404

    state = load_state(book_id)
    merged = resolve_selections(meta, state)
    state["selections"] = {entry["section_id"]: merged[entry["section_id"]] for entry in meta.get("stream", [])}

    return jsonify({"book": summarise(meta, state), "meta": meta, "state": state})


@app.route("/api/books/<book_id>", methods=["DELETE"])
def delete_book(book_id: str):
    """Remove a book and everything stored for it."""
    try:
        path = book_path(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400

    if not path.exists():
        return jsonify({"error": f"No book {book_id}."}), 404

    shutil.rmtree(path)
    return jsonify({"deleted": book_id})


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


@app.route("/api/books/<book_id>/words", methods=["GET"])
def get_words(book_id: str):
    """
    The whole reading stream for a book, as one payload.

    Playback is continuous across the sections the reader chose, so this
    concatenates them in document order and records where each begins. The
    frontend then steps a single index through one flat list and still knows
    when to raise a chapter title, which is far simpler than stitching
    per-section fetches together at each boundary and hoping both sides agree.

    Only the checked sections are included, so unchecking a chapter genuinely
    removes it from what gets read rather than merely hiding it.
    """
    try:
        meta = load_meta(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400

    if meta is None:
        return jsonify({"error": f"No book {book_id}."}), 404

    state = load_state(book_id)
    selections = resolve_selections(meta, state)
    book_dir = BOOKS_DIR / book_id

    words: list[dict] = []
    boundaries: list[dict] = []
    missing: list[str] = []

    for entry in meta.get("stream", []):
        section_id = entry["section_id"]
        if not selections.get(section_id, entry.get("default_checked", False)):
            continue

        payload = read_json(book_dir / entry["file"])
        if not isinstance(payload, dict) or not isinstance(payload.get("words"), list):
            missing.append(section_id)
            continue

        boundaries.append({
            "section_id": section_id,
            "title": entry.get("title"),
            "full_title": entry.get("full_title"),
            "entry_type": entry.get("entry_type"),
            "level": entry.get("level"),
            "start_index": len(words),
            "word_count": len(payload["words"]),
        })
        words.extend(payload["words"])

    if missing:
        return jsonify({
            "error": "This book is missing content for some chapters; "
                     f"reprocess it to rebuild them ({', '.join(missing[:5])})."
        }), 409

    return jsonify({
        "book_id": book_id,
        "filename": meta.get("filename"),
        "method": meta.get("method"),
        "total_words": len(words),
        "boundaries": boundaries,
        "words": words,
    })


@app.route("/api/books/<book_id>/state", methods=["GET"])
def get_state(book_id: str):
    try:
        meta = load_meta(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400
    if meta is None:
        return jsonify({"error": f"No book {book_id}."}), 404

    state = load_state(book_id)
    if not state.get("selections"):
        state["selections"] = resolve_selections(meta, state)
    return jsonify(state)


@app.route("/api/books/<book_id>/state", methods=["PUT"])
def put_state(book_id: str):
    """
    Save where the reader is and what they have chosen.

    Called often and from a debounce, so the body is treated as a partial
    update: a request carrying only `word_index` must not wipe the reader's
    chapter choices. That is exactly the bug a whole-object overwrite causes
    when two saves race.
    """
    try:
        meta = load_meta(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400
    if meta is None:
        return jsonify({"error": f"No book {book_id}."}), 404

    body = request.get_json(silent=True) or {}
    state = load_state(book_id)
    state["selections"] = resolve_selections(meta, state)

    if "word_index" in body:
        try:
            index = int(body["word_index"])
        except (TypeError, ValueError):
            return jsonify({"error": "word_index must be an integer."}), 400
        state["word_index"] = max(0, index)

    if "section_id" in body:
        state["section_id"] = body["section_id"]

    if "selections" in body and isinstance(body["selections"], dict):
        valid = {entry["section_id"] for entry in meta.get("stream", [])}
        for section_id, checked in body["selections"].items():
            if section_id in valid:
                state["selections"][section_id] = bool(checked)

    state["book_id"] = book_id
    state["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    write_json(book_path(book_id) / "state.json", state)
    return jsonify({"book": summarise(meta, state), "state": state})


@app.route("/api/books/<book_id>/sections/<section_id>", methods=["PATCH"])
def patch_section(book_id: str, section_id: str):
    """
    Check or uncheck one section.

    Only the selection changes - a section's words are fixed once processed -
    so this touches `state.json` and never the client payload, and never the
    PDF. Checking a chapter back on is therefore instant.
    """
    try:
        meta = load_meta(book_id)
    except ValueError:
        return jsonify({"error": "Invalid book id."}), 400
    if meta is None:
        return jsonify({"error": f"No book {book_id}."}), 404

    valid = {entry["section_id"] for entry in meta.get("stream", [])}
    if section_id not in valid:
        return jsonify({"error": f"No readable section {section_id}."}), 404

    body = request.get_json(silent=True) or {}
    if "checked" not in body:
        return jsonify({"error": "Send {'checked': true|false}."}), 400

    state = load_state(book_id)
    state["selections"] = resolve_selections(meta, state)
    state["selections"][section_id] = bool(body["checked"])
    state["book_id"] = book_id
    state["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    write_json(book_path(book_id) / "state.json", state)
    return jsonify({"book": summarise(meta, state), "state": state})


# ---------------------------------------------------------------------------
# Standalone single-shot flow (nothing stored)
# ---------------------------------------------------------------------------


@app.route("/", methods=["GET"])
def index():
    """
    Serve the reader UI directly, so http://localhost:5000 is the only
    address you need to remember - no separate file:// tab required.
    Requires rsvp_reader.html to sit next to this app.py.
    """
    html_path = BASE_DIR / HTML_FILENAME
    if not html_path.exists():
        return (
            f"{HTML_FILENAME} not found next to app.py. "
            f"Put both files in the same folder ({BASE_DIR}).",
            500,
        )
    return send_from_directory(BASE_DIR, HTML_FILENAME)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/upload", methods=["POST"])
def upload():
    """
    Tokenise a PDF in one request and store nothing.

    Kept for the standalone reader and as the fallback when a book does not
    need to be kept. It shares `tokenizer` with the library path, so the words
    come out annotated identically either way.
    """
    upload_file = request.files.get("file")
    if upload_file is None:
        return jsonify({
            "error": "No file field in request. Send multipart/form-data with key 'file'."
        }), 400
    if not upload_file.filename:
        return jsonify({"error": "Empty filename."}), 400
    if not upload_file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only .pdf files are supported."}), 400

    handle, temp_name = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    temp_path = Path(temp_name)

    try:
        upload_file.save(temp_path)
        text = extract_text(temp_path)
    except Exception as exc:  # malformed / encrypted / unreadable PDF
        return jsonify({"error": f"Could not read this PDF: {exc}"}), 400
    finally:
        temp_path.unlink(missing_ok=True)

    if not text:
        return jsonify({
            "error": "No extractable text found. This PDF is likely scanned "
                     "images rather than real text, so it would need OCR first."
        }), 422

    words = tokenizer.tokenize(text)
    return jsonify({
        "filename": upload_file.filename,
        "word_count": len(words),
        "words": words,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)