"""
Write a PDF with a page but no text operators.

Stands in for a scanned book: the page exists and renders, but there is
nothing for a text extractor to pull out, which is exactly the condition
the OCR message in POST /api/books is there to report.
"""

import sys
from pathlib import Path

from pypdf import PdfWriter

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "tmp/blank.pdf")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    OUT.parent.mkdir(parents=True, exist_ok=True)

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with OUT.open("wb") as fh:
        writer.write(fh)

    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
