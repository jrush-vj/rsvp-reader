"""
Build the client payload for a book.
====================================

Detection answers *where* the chapters are. This module answers *what words the
reader steps through*, and writes them to disk in the shape the frontend reads.

The output is split by concern:

    books/<book_id>/
        book.pdf              the original, kept so a book can be reprocessed
        meta.json             everything about the book's structure
        state.json            where the reader left off, and what is checked
        client/<id>.json      one readable section's words, annotation included

**Why the words are precomputed rather than parsed on demand.** Tokenising is
deterministic - the same text always yields the same words, offsets and pauses -
so it only needs doing once. Writing it out means opening a book is a file read
instead of a PDF parse, and it means the running server never needs pypdf at
all for a book that has already been processed.

**The one invariant.** For every readable section:

    meta.json word_count == len(client/<id>.json["words"])

This is not decoration. The picker shows the count and the reader steps through
the list; when they disagree, the reader's progress bar lies and its resume
position lands in the wrong place. Both numbers therefore come from the same
string - `sections.section_words` - and are asserted here rather than trusted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import detector
import pdftext
import sections

# Bumped whenever the on-disk shape changes, so a stale directory can be told
# apart from a current one without guessing from its contents.
SCHEMA_VERSION = 2


def book_id_for(pdf_path: Path) -> str:
    """
    A stable id for a book, derived from the PDF's own bytes.

    Content-addressed rather than random so reprocessing the same file lands in
    the same directory - which is what makes "reprocess this book" safe to run
    twice - while a different edition of the same title gets its own id.
    """
    digest = hashlib.sha256()
    with pdf_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:8]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _leaf_state(roots: list[detector.Section]) -> dict:
    """The default checked/unchecked map, keyed by section id."""
    selections: dict[str, bool] = {}
    for root in roots:
        for section in root.walk():
            if section.children:
                continue
            selections[section.id] = section.default_checked
    return selections


def build(
    pdf_path: str | Path,
    book_dir: str | Path | None = None,
    book_id: str | None = None,
    filename: str | None = None,
    keep_pdf: bool = True,
) -> dict:
    """
    Process one PDF into a book directory and return its meta dictionary.

    `book_dir` defaults to `books/<book_id>`. The PDF is copied in unless
    `keep_pdf` is false, which is what allows a book to be reprocessed after
    the detection rules change without asking the user to upload it again.
    """
    pdf_path = Path(pdf_path).resolve()
    if not pdf_path.exists():
        raise FileNotFoundError(pdf_path)

    book_id = book_id or book_id_for(pdf_path)
    book_dir = Path(book_dir) if book_dir else pdf_path.parent.parent / book_id
    client_dir = book_dir / "client"

    reader = pdftext.open_reader(str(pdf_path))
    pages = pdftext.read_pages(reader)
    result = detector.detect(reader, pages)

    # Word counts come from the trimmed text, not the page range: the heading is
    # removed from the body before it is counted, so the picker's number is the
    # number of words the reader will actually step through.
    counts = sections.apply_word_counts(result.sections, pages)

    leaves = sections.readable_leaves(result.sections)

    book_dir.mkdir(parents=True, exist_ok=True)
    client_dir.mkdir(parents=True, exist_ok=True)

    # Clear stale payloads first. A directory reprocessed under new detection
    # rules can have fewer sections than before, and a leftover file would
    # otherwise linger as an orphan the picker never references.
    for stale in client_dir.glob("*.json"):
        stale.unlink()

    stream: list[dict] = []
    total_words = 0

    for section in leaves:
        words = sections.section_words(section, pages)

        # The invariant, checked at the moment of writing rather than after.
        expected = counts.get(section.id)
        if expected is not None and expected != len(words):
            raise AssertionError(
                f"word count for {section.id} is {expected} in meta but "
                f"{len(words)} in the token stream"
            )

        payload = {
            "book_id": book_id,
            "section_id": section.id,
            "title": section.clean_title or section.title,
            "full_title": section.display_title,
            "entry_type": section.entry_type,
            "start_page": section.start_page,
            "end_page": section.end_page,
            "words": words,
        }
        target = client_dir / f"{section.id}.json"
        target.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        total_words += len(words)
        stream.append(
            {
                "section_id": section.id,
                "file": f"client/{section.id}.json",
                "title": section.clean_title or section.title,
                "full_title": section.display_title,
                "entry_type": section.entry_type,
                "level": section.level,
                "start_page": section.start_page,
                "end_page": section.end_page,
                "word_count": len(words),
                "default_checked": section.default_checked,
            }
        )

    checked = sum(1 for section in leaves if section.default_checked)

    meta = {
        "schema": SCHEMA_VERSION,
        "book_id": book_id,
        "filename": filename or pdf_path.name,
        "created": _now(),
        "total_pages": result.total_pages,
        "method": result.method,
        "confidence": round(result.confidence, 2),
        "notes": result.notes,
        "front_matter_pages": result.front_matter_pages,
        "total_words": total_words,
        "readable_count": len(leaves),
        "checked_count": checked,
        # The playback order, flattened once here so the frontend never has to
        # infer it from the tree.
        "stream": stream,
        "sections": [section.to_dict() for section in result.sections],
    }

    if keep_pdf:
        stored = book_dir / "book.pdf"
        if stored.resolve() != pdf_path:
            stored.write_bytes(pdf_path.read_bytes())

    (book_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Written once, and left alone thereafter, so reprocessing a book does not
    # discard the reader's own progress and choices.
    state_path = book_dir / "state.json"
    if not state_path.exists():
        state_path.write_text(
            json.dumps(
                {
                    "book_id": book_id,
                    "updated": _now(),
                    "word_index": 0,
                    "section_id": None,
                    "selections": _leaf_state(result.sections),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    return meta


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a book's client payload.")
    parser.add_argument("pdf", help="path to the PDF to process")
    parser.add_argument("--book-id", default=None, help="override the derived id")
    parser.add_argument("--out", default=None, help="override the output directory")
    parser.add_argument(
        "--no-pdf",
        action="store_true",
        help="do not copy the PDF into the book directory",
    )
    args = parser.parse_args()

    meta = build(
        args.pdf,
        book_dir=args.out,
        book_id=args.book_id,
        keep_pdf=not args.no_pdf,
    )

    print(f"book {meta['book_id']} -> {args.out or 'books/' + meta['book_id']}")
    print(f"  method      {meta['method']} (confidence {meta['confidence']})")
    print(f"  pages       {meta['total_pages']}")
    print(f"  readable    {meta['readable_count']} sections, {meta['total_words']} words")
    print(f"  checked     {meta['checked_count']} by default")
    for note in meta["notes"]:
        print(f"  note        {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
