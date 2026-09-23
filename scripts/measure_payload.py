"""
Measure what the /words payload actually costs on the wire.

Run from the repo root:

    $env:PYTHONIOENCODING="utf-8"
    .\\.venv\\Scripts\\python.exe scripts\\measure_payload.py

This exists because "the payload is 4 MB" and "the payload is slow" are two
different claims, and only the second one justifies work. It reports the raw
size, the gzip size, and the lean-encoding size for the same book so the three
can be compared rather than guessed at.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent.parent
BOOKS_DIR = BASE_DIR / "books"


def human(n: int) -> str:
    return f"{n:,} B ({n / 1024:.1f} KiB)"


def collect(book_id: str) -> tuple[list[dict], list[dict]]:
    """The same selection logic `get_words` uses, minus the Flask layer."""
    meta = json.loads((BOOKS_DIR / book_id / "meta.json").read_text(encoding="utf-8"))
    book_dir = BOOKS_DIR / book_id

    words: list[dict] = []
    boundaries: list[dict] = []
    for entry in meta["stream"]:
        if not entry.get("default_checked", False):
            continue
        payload = json.loads((book_dir / entry["file"]).read_text(encoding="utf-8"))
        boundaries.append({"section_id": entry["section_id"], "start_index": len(words)})
        words.extend(payload["words"])
    return words, boundaries


def main() -> int:
    book_id = sys.argv[1] if len(sys.argv) > 1 else ""
    if not book_id:
        candidates = sorted(p.name for p in BOOKS_DIR.iterdir() if p.is_dir())
        if not candidates:
            print("No books present.")
            return 1
        book_id = candidates[0]
    print(f"book: {book_id}")

    words, boundaries = collect(book_id)
    print(f"words: {len(words):,}")

    # The shape the API returns today: one object per word.
    verbose = {"book_id": book_id, "boundaries": boundaries, "words": words}
    raw = json.dumps(verbose, separators=(",", ":")).encode("utf-8")

    # The lean shape: one 3-element array per word. No repeated keys at all.
    lean = {
        "book_id": book_id,
        "boundaries": boundaries,
        "words": [[w["text"], w["orp"], w["pause"]] for w in words],
    }
    raw_lean = json.dumps(lean, separators=(",", ":")).encode("utf-8")

    print()
    print("as shipped today (objects)")
    print(f"  raw          {human(len(raw))}")
    print(f"  gzip         {human(len(gzip.compress(raw, 6)))}")
    print(f"  gzip -9      {human(len(gzip.compress(raw, 9)))}")
    print()
    print("lean ([text, orp, pause])")
    print(f"  raw          {human(len(raw_lean))}")
    print(f"  gzip         {human(len(gzip.compress(raw_lean, 6)))}")
    print(f"  gzip -9      {human(len(gzip.compress(raw_lean, 9)))}")
    print()
    gz = len(gzip.compress(raw, 6))
    gz_lean = len(gzip.compress(raw_lean, 6))
    print(f"gzip alone:            {len(raw) / gz:.1f}x smaller")
    print(f"lean raw:              {len(raw) / len(raw_lean):.1f}x smaller")
    print(f"lean + gzip vs today:  {len(raw) / gz_lean:.1f}x smaller")

    # Informational only: is a lean *wire* shape lossless for this data?
    dropped = sum(1 for w in words if set(w) > {"text", "orp", "pause"})
    print()
    print(f"words carrying keys beyond text/orp/pause: {dropped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
