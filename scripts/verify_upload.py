"""
Exercise the upload route end to end with a real PDF.

The unit-level checks elsewhere never touch `/api/books` POST, which is the
only route that runs the whole pipeline - save, hash, detect, tokenise, write -
inside the request. It is also the route where a failure leaves junk on disk,
so this confirms a rejected upload leaves nothing behind.
"""

import io
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app
import clientbuild

PDF = Path("books/a8cacf49/book.pdf")
failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"{'ok  ' if condition else 'FAIL'} {label}{f'  ({detail})' if detail else ''}")
    if not condition:
        failures.append(label)


client = app.app.test_client()

expected_id = clientbuild.book_id_for(PDF)
target = app.BOOKS_DIR / expected_id

# Read the PDF before touching the directory, since moving the book aside moves
# its stored copy too.
pdf_bytes = PDF.read_bytes()

# The upload writes to the content-addressed directory, which may already hold
# a real library book. Move it aside for the duration so the route is genuinely
# exercised rather than silently skipped, and put it back whatever happens -
# a verifier must never be the reason someone loses their reading progress.
aside = target.with_name(f"{expected_id}.verifysave")
had_real_book = target.exists()
if had_real_book:
    if aside.exists():
        shutil.rmtree(aside)
    shutil.move(str(target), str(aside))

try:
    data = {"file": (io.BytesIO(pdf_bytes), PDF.name)}
    response = client.post(
        "/api/books", data=data, content_type="multipart/form-data"
    )

    check("POST /api/books -> 201", response.status_code == 201, str(response.status_code))

    if response.status_code != 201:
        print(response.get_json())
        raise SystemExit(1)

    body = response.get_json()
    meta = body["meta"]

    check("book id is the PDF's content hash", body["book"]["book_id"] == expected_id, expected_id)
    check("the book directory was created", target.is_dir())
    check("the PDF was kept for reprocessing", (target / "book.pdf").is_file())
    check("meta.json was written", (target / "meta.json").is_file())
    check("state.json was written", (target / "state.json").is_file())
    check("every section has a client payload", len(list((target / "client").glob("*.json"))) == meta["readable_count"])
    check("the original filename was recorded", meta["filename"] == PDF.name, meta["filename"])
    check("detection ran the outline strategy", meta["method"] == "outline", meta["method"])
    check("some sections are checked by default", meta["checked_count"] > 0, str(meta["checked_count"]))

    # The response's own stream must agree with what is on disk.
    check("reported readable count matches the stream", len(meta["stream"]) == meta["readable_count"])
    check(
        "reported total words matches the stream",
        meta["total_words"] == sum(e["word_count"] for e in meta["stream"]),
    )

    # A scanned PDF (no extractable text) must be rejected cleanly.
    blank = client.post(
        "/api/books",
        data={"file": (io.BytesIO(b"%PDF-1.4\n%%EOF\n"), "scan.pdf")},
        content_type="multipart/form-data",
    )
    check("an unreadable PDF is rejected", blank.status_code in (400, 422), str(blank.status_code))
    check(
        "the rejection explains what to do",
        "OCR" in blank.get_json().get("error", "") or "Could not read" in blank.get_json().get("error", ""),
    )

    junk = [d for d in app.BOOKS_DIR.iterdir() if d.is_dir() and not (d / "meta.json").exists()]
    check("no junk book directory was left behind", junk == [], ", ".join(d.name for d in junk))
finally:
    if had_real_book:
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(str(aside), str(target))
        check("the pre-existing book was restored", target.is_dir())
    else:
        shutil.rmtree(target, ignore_errors=True)
        check("the verification book was cleaned up", not target.exists())

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for failure in failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("All checks passed.")
