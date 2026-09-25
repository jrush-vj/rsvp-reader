"""
RSVP Reader Backend
====================

Two things live here.

**The library.** A book is uploaded once, processed once, and then kept on disk
as a directory under `books/`. Opening it later is a file read, not a PDF parse,
which is what makes the library screen instant and the reader's progress
resumable across restarts.

Setup:
    pip install -r requirements.txt
    python app.py
    -> serves the local API on http://127.0.0.1:5000
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

import clientbuild

BASE_DIR = Path(os.environ.get("RSVP_APP_ROOT", Path(__file__).resolve().parent))
DATA_DIR = os.environ.get("RSVP_DATA_DIR")
BOOKS_DIR = Path(DATA_DIR) / "books" if DATA_DIR else BASE_DIR / "books"

app = Flask(__name__, static_folder=None)
CORS(app, origins=["tauri://localhost", "http://tauri.localhost", "http://localhost:5173"])

app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB upload cap

# Flask pretty-prints JSON when the app is in debug mode, on the theory that a
# human is reading the response. In this app the debug flag is on during
# development and the largest response is 60k word objects, so the theory costs
# real work on every request to `/words`: it expands 2.2 MB of JSON into 4.2 MB
# of indented text, which then has to be gzipped, sent, and parsed. The
# indentation is pure overhead — the browser is the only consumer, and `curl`
# is just as legible with `python -m json.tool` on the other end.
#
# Setting this explicitly means the payload is the same whichever mode the
# server runs in, so what is measured in development is what ships.
app.json.compact = True


# ---------------------------------------------------------------------------
# Response compression and caching
# ---------------------------------------------------------------------------
#
# The reading stream is the one response in this app that is genuinely large:
# ~60k word objects for a full-length book. Measured on the reference book it
# is 2.2 MB of compact JSON, and `jsonify`'s pretty-printing inflates that to
# 4.2 MB on the wire. Both of those numbers are paid before the reader can show
# the first word, so this is the single highest-leverage thing the server does.
#
# The fix is not a new encoding — it is gzip. The stream is 59,619 near-identical
# objects, which is close to the best case for DEFLATE, and it lands at 193 KB:
# an 11.4x reduction for one wrappper function and no change to the API shape.
# A hand-rolled `[text, orp, pause]` array encoding was measured too and only
# bought a further 13% *on top of* gzip (165 KB vs 193 KB), which is not worth
# a client-side rewrite of how words are constructed. So the contract stays.
#
# Compression is applied only to JSON. The content-hashed bundles under
# `/assets/` are already compressed for their own formats (the JS and CSS are
# minified, the fonts and images are binary), so re-deflating them would burn
# CPU per request to save nothing.
COMPRESS_MIN_BYTES = 1024

# The reference payload deflates at roughly 11:1. A response that does not
# shrink to at least this fraction is incompressible (already-compressed data
# mislabelled as JSON, say), and sending it unencoded is the honest choice.
COMPRESS_MIN_RATIO = 0.9


@app.after_request
def compress_json(response):
    """
    Gzip JSON responses when the client will take them.

    Written by hand rather than pulled in as a dependency: `flask-compress`
    would be a new pinned requirement for one `gzip.compress` call, and this
    app deliberately keeps its dependency list short enough to read.
    """
    # `Accept-Encoding` is a comma-separated list that may carry a quality
    # value, so `"gzip" in value` is the check — a plain equality test would
    # miss `gzip;q=0.8` and `br, gzip`.
    accepts_gzip = "gzip" in (request.headers.get("Accept-Encoding") or "")
    if not accepts_gzip:
        return response

    if response.mimetype != "application/json":
        return response

    # Only a fully-buffered, successful, unencoded body can be compressed here.
    # A 304 carries no body at all, and re-encoding a streaming response would
    # mean holding all of it in memory first.
    if response.status_code != 200 or response.direct_passthrough or response.headers.get("Content-Encoding"):
        return response

    body = response.get_data()
    if len(body) < COMPRESS_MIN_BYTES:
        return response

    packed = gzip.compress(body, compresslevel=6)
    if len(packed) >= len(body) * COMPRESS_MIN_RATIO:
        return response

    response.set_data(packed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(packed))

    # Essential, not decorative. Without it a shared cache is entitled to hand
    # this gzipped body to a client that never asked for gzip, and to hand an
    # uncompressed body to one that did.
    response.headers.add("Vary", "Accept-Encoding")
    return response


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
        # When the reader last had this book open, or None if it never has.
        # `created` is the upload time and never moves, so the library list
        # sorts and labels on this one to answer "what was I reading?".
        "updated": state.get("updated"),
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


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(
        host=os.environ.get("RSVP_HOST", "127.0.0.1"),
        port=int(os.environ.get("RSVP_PORT", "5000")),
        debug=False,
        use_reloader=False,
    )