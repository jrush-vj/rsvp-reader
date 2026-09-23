"""
Write a small PDF that actually contains extractable text.

`make_blank_pdf.py` covers the "no text layer" case (a scanned book). This is
its opposite: a fixture with several pages of real text and a simple outline,
so the upload path can be exercised without shipping a copyrighted book.

Two modes:

    python scripts/make_text_pdf.py out.pdf                  # normal book
    python scripts/make_text_pdf.py out.pdf --no-outline     # no chapter marks

`--no-outline` is the interesting one for the detector: with no outline to
follow, it has to fall back to the printed contents page, which is the path a
real-world PDF takes far more often than the tidy one.

Uses only pypdf. reportlab is not installed, so the content stream and the font
resource are written by hand — the operators are short enough to be readable,
and it keeps the fixture dependency-free.
"""

from __future__ import annotations

import sys
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)

# Page geometry (US Letter, in points) and a monospaced-ish text placement that
# keeps every line inside the margins.
PAGE_W, PAGE_H = 612, 792
MARGIN_X = 72
FONT_SIZE = 12
LEADING = 16
FIRST_BASELINE = PAGE_H - 96

CHAPTERS: list[tuple[str, list[str]]] = [
    (
        "Introduction: Why This Fixture Exists",
        [
            "This document is generated, not published. It exists so the upload",
            "path can be tested end to end without shipping a real book, and so",
            "the detector has a document whose structure is known in advance.",
            "",
            "The text is deliberately plain. Every paragraph is a fixed number of",
            "characters wide, which means a rendering bug shows up as a ragged",
            "right edge rather than as a subtle spacing change.",
            "",
            "A generated fixture also makes the assertion honest: if the reader",
            "reports a different word count than this file contains, the fault is",
            "in the pipeline, not in the source document.",
        ],
    ),
    (
        "Chapter One: Filler, Deliberately",
        [
            "The quick brown fox jumps over the lazy dog. This sentence contains",
            "every letter of the alphabet, which is the only reason it is here.",
            "",
            "A second paragraph gives the extractor something to separate. PDF",
            "text extraction has no notion of a paragraph: it sees positioned",
            "glyphs, and it is the extractor's job to guess where lines end and",
            "paragraphs begin.",
            "",
            "That guess is what these fixtures probe. A blank line in this source",
            "becomes nothing at all in the content stream, and is still expected",
            "to come back out as a blank line. If it does not, the reader will",
            "get run-on paragraphs and nobody will know why.",
        ],
    ),
    (
        "Chapter Two: A Second Chapter",
        [
            "Chapter boundaries are where the interesting bugs live. A reader",
            "that mis-detects them jumps to the wrong place, which is worse than",
            "not offering chapters at all.",
            "",
            "So this chapter exists purely to be a boundary. It is short. It is",
            "unremarkable. Its whole purpose is that there are two of it.",
            "",
            "Reading speed is measured in words per minute, and this fixture is",
            "short enough to read in well under a minute at any plausible pace.",
        ],
    ),
]


def _escape(text: str) -> str:
    """Escape the three characters that are special inside a PDF string."""
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _content_stream(lines: list[str]) -> DecodedStreamObject:
    """Build a one-page content stream that prints `lines` top-down."""
    parts = ["BT", f"/F1 {FONT_SIZE} Tf", f"{LEADING} TL", f"{MARGIN_X} {FIRST_BASELINE} Td"]
    for line in lines:
        parts.append(f"({_escape(line)}) Tj T*")
    parts.append("ET")
    stream = DecodedStreamObject()
    stream.set_data("\n".join(parts).encode("latin-1", "replace"))
    return stream


def _font_resource() -> DictionaryObject:
    """A Helvetica font resource, so the page has something to draw with."""
    font = DictionaryObject()
    font[NameObject("/Type")] = NameObject("/Font")
    font[NameObject("/Subtype")] = NameObject("/Type1")
    font[NameObject("/BaseFont")] = NameObject("/Helvetica")
    return font


def build(out: Path, outline: bool) -> int:
    writer = PdfWriter()

    for title, body in CHAPTERS:
        lines = [title, ""] + body
        page = writer.add_blank_page(width=PAGE_W, height=PAGE_H)
        page[NameObject("/Contents")] = writer._add_object(_content_stream(lines))  # type: ignore[attr-defined]
        resources = DictionaryObject()
        fonts = DictionaryObject()
        fonts[NameObject("/F1")] = writer._add_object(_font_resource())  # type: ignore[attr-defined]
        resources[NameObject("/Font")] = fonts
        resources[NameObject("/ProcSet")] = DictionaryObject(
            {NameObject("/PDF"): NumberObject(1)}
        )
        page[NameObject("/Resources")] = resources
        if outline:
            writer.add_outline_item(title, len(writer.pages) - 1)

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as fh:
        writer.write(fh)

    words = sum(len(" ".join([t] + b).split()) for t, b in CHAPTERS)
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(writer.pages)} pages, ~{words} words)")
    print(f"outline: {'yes' if outline else 'no'}")
    return 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0] if args else "tmp/fixture.pdf")
    return build(out, outline="--no-outline" not in sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
