"""Check the exact JSON the reader UI reads, against a running backend.

The reader is a hand-written page with no framework and no types, so a field
renamed on the server shows up only as `undefined` in the browser. This asserts
the shape the UI actually dereferences, field by field, so a contract break is
reported here rather than discovered by clicking.

Usage: python scripts/verify_ui_contract.py [base_url] [book_id]
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5000").rstrip("/")
BOOK_ID = sys.argv[2] if len(sys.argv) > 2 else None

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}" + (f"  ({detail})" if detail else ""))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as res:
        return json.loads(res.read().decode("utf-8")), res.status


print(f"backend {BASE}")
print()

# ---- /api/books : the library screen ----
print("GET /api/books")
data, status = get("/api/books")
check("200", status == 200)
check("has 'books' list", isinstance(data.get("books"), list))
books = data["books"]
check("at least one book to test with", len(books) > 0, f"got {len(books)}")

# Fields renderLibrary/bookRow dereference unconditionally.
for field in (
    "book_id", "filename", "total_pages", "method", "total_words",
    "readable_count", "chosen_count", "chosen_words", "word_index",
    "percent", "started", "finished",
):
    check(f"book row has '{field}'", field in books[0], f"keys: {sorted(books[0])}")

book = None
if BOOK_ID:
    book = next((b for b in books if b["book_id"] == BOOK_ID), None)
else:
    book = books[0]
if book is None:
    print(f"FAIL: no book with id {BOOK_ID}")
    raise SystemExit(1)
print(f"  (using book {book['book_id']}  {book['filename']})")
print()

bid = book["book_id"]

# ---- /api/books/<id> : the picker screen ----
print(f"GET /api/books/{bid}")
data, status = get(f"/api/books/{bid}")
check("200", status == 200)
for key in ("book", "meta", "state"):
    check(f"has '{key}'", key in data)

check("state has 'selections'", "selections" in data["state"])
check("meta has 'sections'", "sections" in data["meta"])

sections = data["meta"]["sections"]


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children") or [])


all_nodes = list(walk(sections))

# buildNode dereferences these on every node.
for field in ("id", "title", "entry_type", "word_count"):
    present = [n for n in all_nodes if field in n]
    check(f"all {len(all_nodes)} sections have '{field}'", len(present) == len(all_nodes))

leaves = [n for n in all_nodes if not (n.get("children") or []) and n["word_count"] > 0]
check("at least one playable leaf", len(leaves) > 0, f"got {len(leaves)}")

# refreshPicker counts leaves; openBook's resume row reads book.chosen_words.
check("book.chosen_words is a number", isinstance(data["book"]["chosen_words"], int))
check("book.percent is a number", isinstance(data["book"]["percent"], (int, float)))

# The picker only offers a checkbox for a section the server is prepared to
# accept a change for - PATCH rejects anything outside the selections map - so
# a readable leaf missing from that map would be shown but not selectable.
# That is intended for front and back matter, so it is reported rather than
# asserted against; what must hold is that every offered id is a real leaf.
sel_map = data["state"]["selections"]
leaf_ids = {n["id"] for n in leaves}
offered = set(sel_map)
check("every offered section is a readable leaf", offered <= leaf_ids,
      str(sorted(offered - leaf_ids)[:5]))

not_offered = sorted(leaf_ids - offered)
print(f"  info {len(offered)} offered, {len(not_offered)} readable leaf/leaves not offered"
      f"{' (' + ', '.join(not_offered) + ')' if not_offered else ''}")
print()

# ---- /api/books/<id>/words : the reader ----
print(f"GET /api/books/{bid}/words")
data, status = get(f"/api/books/{bid}/words")
check("200", status == 200)
for key in ("words", "boundaries", "filename"):
    check(f"has '{key}'", key in data)

words = data["words"]
bnds = data["boundaries"]
check("words non-empty", len(words) > 0, f"got {len(words)}")
check("boundaries non-empty", len(bnds) > 0, f"got {len(bnds)}")

# renderWord reads text/orp; scheduleNext reads pause and multiplies by it.
bad = [i for i, w in enumerate(words[:2000])
       if not isinstance(w.get("text"), str) or not isinstance(w.get("orp"), int)
       or not isinstance(w.get("pause"), (int, float))]
check("every word has text/orp/pause", not bad, f"first bad index {bad[:3]}")
check("orp is inside the word",
      all(0 <= w["orp"] < len(w["text"]) for w in words[:2000] if w["text"]))
check("pause is positive",
      all(w["pause"] > 0 for w in words[:2000]))

# showTitle/sectionAt/updateProgress read these.
for field in ("section_id", "title", "full_title", "entry_type", "level",
              "start_index", "word_count"):
    present = [b for b in bnds if field in b]
    check(f"all {len(bnds)} boundaries have '{field}'", len(present) == len(bnds))

check("boundary level is an int (showTitle compares level > 1)",
      all(isinstance(b["level"], int) for b in bnds))

# startBook sets nextBoundary with findIndex(start_index >= idx); if the first
# boundary did not sit at 0, a fresh read would never announce the first chapter.
starts = [b["start_index"] for b in bnds]
check("boundaries are in ascending order", starts == sorted(starts))
check("first boundary starts at index 0", starts[0] == 0, f"starts at {starts[0]}")
check("every start_index is in range", all(0 <= s < len(words) for s in starts))

# The overlay is shown when the reader arrives at start_index, so each boundary
# must own at least one word, otherwise it could never be reached mid-play.
check("every boundary owns words",
      all(b["word_count"] > 0 for b in bnds),
      str([b["section_id"] for b in bnds if b["word_count"] <= 0][:5]))

# word_count in meta must equal the words actually served, or the picker's
# estimate and the reader's progress would disagree.
total = sum(b["word_count"] for b in bnds)
check("boundary word_counts sum to the stream length", total == len(words),
      f"sum {total} vs {len(words)}")

# Preview is what makes a leaf identifiable in the picker.
no_preview = [n["id"] for n in leaves if not (n.get("preview") or "").strip()]
check("every readable leaf has a preview", not no_preview, str(no_preview[:5]))
print()

# ---- ids line up across the two endpoints ----
print("cross-endpoint consistency")
bnd_ids = {b["section_id"] for b in bnds}
print(f"  boundaries {len(bnd_ids)}, offered selections {len(sel_map)}, readable leaves {len(leaf_ids)}")
check("boundaries are a subset of offered selections", bnd_ids <= offered,
      str(sorted(bnd_ids - offered)[:5]))

# A boundary is only served for a checked section, so every boundary id must be
# checked - otherwise the picker says unchecked while the reader plays it.
checked = {k for k, v in sel_map.items() if v}
check("every served boundary is checked", bnd_ids <= checked,
      str(sorted(bnd_ids - checked)[:5]))

# The check above reads the API's merged view, which is what the picker paints
# but not what the server actually stored: /api/books/<id> merges the saved
# state over the defaults, so a selection that was never persisted still reads
# as checked. Compare the served boundaries against state.json on disk too, so a
# boundary that only exists because of a default is caught here. The book may be
# owned by a different working copy, in which case the file is not on this disk
# and the check is skipped rather than failed.
state_path = ROOT / "books" / bid / "state.json"
if state_path.exists():
    disk = json.loads(state_path.read_text(encoding="utf-8"))
    disk_sel = disk.get("selections") or {}
    disk_checked = {k for k, v in disk_sel.items() if v}
    check("every served boundary is checked in state.json on disk",
          bnd_ids <= disk_checked, str(sorted(bnd_ids - disk_checked)[:5]))
else:
    print(f"  skip state.json check (not found at {state_path})")
print()

print("=" * 60)
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
