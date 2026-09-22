"""
Exercise the library API against a real processed book.

Run against a throwaway copy of a book directory so the checks that write
(state saves, section toggles, deletion) cannot damage a real reader's
progress. The checks are chosen around the failures that are invisible until
they bite:

  * a partial state save that silently clears the reader's chapter choices
  * the flattened reading stream disagreeing with the picker's word counts
  * path traversal through a book id, which reaches arbitrary directories
  * a checked-off chapter that still contributes words to the stream
"""

import json
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app
import clientbuild

SOURCE = Path("books/a8cacf49")
SCRATCH = Path("books/apiverify")
failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"{'ok  ' if condition else 'FAIL'} {label}{f'  ({detail})' if detail else ''}")
    if not condition:
        failures.append(label)


# A scratch copy of a real book, with its id rewritten to match its directory
# so nothing here touches the original.
if SCRATCH.exists():
    shutil.rmtree(SCRATCH)
shutil.copytree(SOURCE, SCRATCH)
meta_path = SCRATCH / "meta.json"
meta = json.loads(meta_path.read_text(encoding="utf-8"))
original_meta = dict(meta)
meta["book_id"] = SCRATCH.name
meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

# The copy carries whatever the reader last saved, and a saved choice is merged
# over the book's defaults. Leaving it in place would make every "falls back to
# the defaults" check below assert the reader's own selections instead, so they
# would pass or fail depending on where someone had stopped. Reset the copy to a
# book nobody has opened yet.
(SCRATCH / "state.json").write_text(
    json.dumps(
        {"book_id": SCRATCH.name, "word_index": 0, "section_id": None, "selections": {}},
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)

client = app.app.test_client()

# ---------------------------------------------------------------------------
# Library listing
# ---------------------------------------------------------------------------

response = client.get("/api/books")
check("GET /api/books -> 200", response.status_code == 200, str(response.status_code))
library = response.get_json()["books"]
check("scratch book listed", any(b["book_id"] == SCRATCH.name for b in library))

listed = next(b for b in library if b["book_id"] == SCRATCH.name)
check(
    "listing carries progress fields",
    all(k in listed for k in ("percent", "word_index", "chosen_words", "started", "finished")),
)
check(
    "chosen words equals the checked sections' words",
    listed["chosen_words"]
    == sum(e["word_count"] for e in meta["stream"] if e["default_checked"]),
    f"{listed['chosen_words']}",
)

# ---------------------------------------------------------------------------
# Opening a book
# ---------------------------------------------------------------------------

response = client.get(f"/api/books/{SCRATCH.name}")
check("GET /api/books/<id> -> 200", response.status_code == 200, str(response.status_code))
opened = response.get_json()
check("open returns meta, state and book", {"meta", "state", "book"} <= set(opened))
check(
    "the returned selections cover every playable section",
    {e["section_id"] for e in meta["stream"]} <= set(opened["state"]["selections"]),
)
check(
    "unpicked selections fall back to the book's own defaults",
    all(
        opened["state"]["selections"][e["section_id"]] == e["default_checked"]
        for e in meta["stream"]
    ),
)

# ---------------------------------------------------------------------------
# The reading stream
# ---------------------------------------------------------------------------

response = client.get(f"/api/books/{SCRATCH.name}/words")
check("GET words -> 200", response.status_code == 200, str(response.status_code))
stream = response.get_json()

checked = [e for e in meta["stream"] if e["default_checked"]]
check(
    "stream word total equals the sum of checked sections",
    stream["total_words"] == sum(e["word_count"] for e in checked),
    f"{stream['total_words']}",
)
check("every checked section has a boundary", len(stream["boundaries"]) == len(checked))
check(
    "boundaries are contiguous and ordered",
    all(
        boundaries["start_index"] + boundaries["word_count"] == following["start_index"]
        for boundaries, following in zip(stream["boundaries"], stream["boundaries"][1:])
    ),
)
check("first boundary starts at zero", stream["boundaries"][0]["start_index"] == 0)
check(
    "boundary word counts match the picker",
    all(b["word_count"] == e["word_count"] for b, e in zip(stream["boundaries"], checked)),
)
check("word list length matches the total", len(stream["words"]) == stream["total_words"])
check(
    "every word is fully annotated",
    all(set(w) == {"text", "orp", "pause"} for w in stream["words"]),
)

# ---------------------------------------------------------------------------
# Partial state saves must not clobber what they omit
# ---------------------------------------------------------------------------

first_checked = checked[0]["section_id"]
response = client.put(
    f"/api/books/{SCRATCH.name}/state",
    json={"selections": {first_checked: False}},
)
check("PUT state -> 200", response.status_code == 200, str(response.status_code))
check(
    "saving selections applied the change",
    response.get_json()["state"]["selections"][first_checked] is False,
)

response = client.put(f"/api/books/{SCRATCH.name}/state", json={"word_index": 1234})
saved = response.get_json()["state"]
check("a word_index-only save keeps the earlier selections", saved["selections"][first_checked] is False)
check(
    "a word_index-only save keeps every playable section",
    {e["section_id"] for e in meta["stream"]} <= set(saved["selections"]),
)

response = client.put(f"/api/books/{SCRATCH.name}/state", json={"word_index": "not a number"})
check("a non-numeric word_index is rejected", response.status_code == 400, str(response.status_code))

# The unchecked chapter must now be absent from the stream, and the saved index
# must survive into the listing.
response = client.get(f"/api/books/{SCRATCH.name}/words")
after = response.get_json()
check(
    "unchecking a section removes it from the stream",
    all(b["section_id"] != first_checked for b in after["boundaries"]),
)
check(
    "removing a section removes exactly its words",
    after["total_words"] == stream["total_words"] - checked[0]["word_count"],
)

listed = next(b for b in client.get("/api/books").get_json()["books"] if b["book_id"] == SCRATCH.name)
check("listing reflects the saved position", listed["word_index"] == 1234, str(listed["word_index"]))
check("listing recalculates the percentage", listed["percent"] > 0, f"{listed['percent']}%")

# ---------------------------------------------------------------------------
# Toggling one section
# ---------------------------------------------------------------------------

last_checked = checked[-1]["section_id"]
response = client.patch(f"/api/books/{SCRATCH.name}/sections/{last_checked}", json={"checked": False})
check("PATCH section -> 200", response.status_code == 200, str(response.status_code))
check("PATCH applied the toggle", response.get_json()["state"]["selections"][last_checked] is False)

response = client.patch(f"/api/books/{SCRATCH.name}/sections/s_999", json={"checked": True})
check("PATCH on an unknown section -> 404", response.status_code == 404, str(response.status_code))

response = client.patch(f"/api/books/{SCRATCH.name}/sections/{last_checked}", json={})
check("PATCH without a checked field -> 400", response.status_code == 400, str(response.status_code))

# ---------------------------------------------------------------------------
# Bad input and path traversal
# ---------------------------------------------------------------------------

response = client.get("/api/books/nosuchbook")
check("unknown book -> 404", response.status_code == 404, str(response.status_code))

for hostile in ("..", "....", "a/b", "a%2Fb", "x" * 40):
    response = client.get(f"/api/books/{hostile}")
    check(
        f"hostile id {hostile[:12]!r} is refused",
        response.status_code in (400, 404),
        str(response.status_code),
    )

response = client.delete("/api/books/..")
check("deleting a traversal id is refused", response.status_code in (400, 404), str(response.status_code))

response = client.post("/api/books", data={}, content_type="multipart/form-data")
check("upload with no file field -> 400", response.status_code == 400, str(response.status_code))

response = client.post(
    "/api/books",
    data={"file": (__import__("io").BytesIO(b"not a pdf"), "notes.txt")},
    content_type="multipart/form-data",
)
check("non-PDF upload -> 400", response.status_code == 400, str(response.status_code))

# ---------------------------------------------------------------------------
# Deleting a book
# ---------------------------------------------------------------------------

response = client.delete(f"/api/books/{SCRATCH.name}")
check("DELETE book -> 200", response.status_code == 200, str(response.status_code))
check("the book directory is gone", not SCRATCH.exists())
check("the book is gone from the listing", SCRATCH.name not in {b["book_id"] for b in client.get("/api/books").get_json()["books"]})

# The real book must be untouched by any of this.
real = json.loads((SOURCE / "meta.json").read_text(encoding="utf-8"))
check("the real book's meta is unchanged", real["total_words"] == original_meta["total_words"])

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for failure in failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("All checks passed.")
