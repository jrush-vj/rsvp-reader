"""
Sanity-check the generated text fixture: does it extract, and how much text?

Run after `make_text_pdf.py` to confirm the PDF really carries a text layer
before blaming the upload endpoint for an empty stream.

    python scripts/verify_text_pdf.py tmp/fixture.pdf
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pdftext import open_reader, read_outline, read_pages  # noqa: E402


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "tmp/fixture.pdf")
    if not path.exists():
        print(f"missing: {path}")
        return 1

    reader = open_reader(path)
    pages = read_pages(reader)
    outline = read_outline(reader)

    total = 0
    for i, page in enumerate(pages, start=1):
        text = "\n".join(line.text for line in page.lines)
        words = len(text.split())
        total += words
        head = text.replace("\n", " | ")[:90]
        print(f"page {i}: {len(page.lines)} lines, {words} words -> {head}")

    print(f"\npages: {len(pages)}   words: {total}   outline entries: {len(outline)}")
    for entry in outline:
        print(f"  outline: {entry.get('title')!r} -> page {entry.get('page')}")

    if total == 0:
        print("\nFAIL: no text extracted, so the fixture is useless for upload tests.")
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
