"""Verify a built book directory: schema, files, and the word-count invariant."""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

book_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "books/a8cacf49")

meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
state = json.loads((book_dir / "state.json").read_text(encoding="utf-8"))

problems: list[str] = []

print(f"book {meta['book_id']}  schema={meta['schema']}  method={meta['method']}")
print(f"  {meta['readable_count']} readable, {meta['total_words']} words, {meta['checked_count']} checked")
print()

# Every stream entry must have a file, and its words must match the meta count.
seen_ids: set[str] = set()
total = 0
_STREAM_KEYS = (
    "section_id", "file", "title", "full_title", "entry_type",
    "level", "start_page", "end_page", "word_count", "default_checked",
)

for entry in meta["stream"]:
    missing = [key for key in _STREAM_KEYS if key not in entry]
    if missing:
        problems.append(f"stream entry missing {missing}")
        continue

    section_id = entry["section_id"]
    if section_id in seen_ids:
        problems.append(f"duplicate id in stream: {section_id}")
    seen_ids.add(section_id)

    path = book_dir / entry["file"]
    if not path.exists():
        problems.append(f"missing payload: {entry['file']}")
        continue

    payload = json.loads(path.read_text(encoding="utf-8"))
    words = payload["words"]
    total += len(words)

    if len(words) != entry["word_count"]:
        problems.append(
            f"{section_id}: stream says {entry['word_count']} words, file has {len(words)}"
        )
    if payload["section_id"] != section_id:
        problems.append(f"{section_id}: payload id is {payload['section_id']}")
    if payload["book_id"] != meta["book_id"]:
        problems.append(f"{section_id}: payload book_id is {payload['book_id']}")

    for word in words:
        if set(word) != {"text", "orp", "pause"}:
            problems.append(f"{section_id}: unexpected word shape {sorted(word)}")
            break

if total != meta["total_words"]:
    problems.append(f"total_words is {meta['total_words']} but files hold {total}")

# Now the same check against the nested tree, which is what the picker renders.
def walk(nodes):
    for node in nodes:
        yield node
        yield from walk(node["children"])


tree_leaves = [n for n in walk(meta["sections"]) if not n["children"]]

# Only leaves that are real content belong in the stream. Front and back matter
# (entry_type "front"/"back") and empty leaves stay in the tree for context but
# contribute no words, so their absence from the stream is correct.
readable = [
    n for n in tree_leaves
    if n["entry_type"] in ("chapter", "sub") and n["word_count"] > 0
]
readable_ids = {n["id"] for n in readable}

excluded = [n for n in tree_leaves if n["id"] not in readable_ids]
if excluded:
    print("--- leaves held out of the stream ---")
    for node in excluded:
        print(f"  {node['id']}  {node['entry_type']:<7} {node['word_count']:>6}w  {node['title'][:56]!r}")
    print()

if readable_ids != seen_ids:
    problems.append(f"tree ids and stream ids differ: {readable_ids ^ seen_ids}")

for node in walk(meta["sections"]):
    for key in ("id", "title", "full_title", "level", "entry_type", "start_page", "end_page", "word_count", "children"):
        if key not in node:
            problems.append(f"{node.get('id')}: node missing {key}")

print("--- first 12 sections ---")
for entry in meta["stream"][:12]:
    print(f"  {entry['section_id']}  L{entry['level']} {entry['entry_type']:<8} "
          f"p{entry['start_page']:>3}-{entry['end_page']:<3} {entry['word_count']:>5}w  "
          f"{entry['full_title'][:52]!r}")

print()
print(f"checked default: {sum(1 for v in state['selections'].values() if v)} / {len(state['selections'])}")
print(f"state word_index={state['word_index']} section_id={state['section_id']}")

print()
if problems:
    print(f"FAILURES ({len(problems)}):")
    for problem in problems[:25]:
        print(f"  {problem}")
    raise SystemExit(1)
print("All checks passed.")
