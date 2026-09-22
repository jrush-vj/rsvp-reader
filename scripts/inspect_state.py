"""Show the saved selections for a book beside its readable leaves.

Written while investigating why the picker and the saved state disagreed about
which sections are checked: the answer was not obvious from either file alone,
so this prints them side by side.
"""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
book_dir = ROOT / "books" / sys.argv[1]

meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
state = json.loads((book_dir / "state.json").read_text(encoding="utf-8"))
sel = state.get("selections") or {}


def walk(nodes, depth=0):
    for n in nodes:
        yield n, depth
        yield from walk(n.get("children") or [], depth + 1)


print(f"meta keys: {sorted(meta)}")
print(f"stream ids: {len(meta.get('stream') or [])}")
print(f"state keys: {sorted(state)}")
print(f"selections: {len(sel)}")
print()

print(f"{'id':8} {'type':8} {'lvl':4} {'words':>7}  {'checked':8} title")
print("-" * 96)
for node, depth in walk(meta["sections"]):
    kids = bool(node.get("children"))
    is_leaf = not kids and node["word_count"] > 0
    if not is_leaf:
        continue
    checked = sel.get(node["id"], "(absent)")
    print(f"{node['id']:8} {node['entry_type']:8} {node['level']:<4} "
          f"{node['word_count']:>7}  {str(checked):8} {node['title'][:48]}")

print()
# `stream` is the list of sections the server publishes as playable. Each entry
# carries its own default_checked, so a section outside the stream is shown in
# the picker for orientation but never offered.
stream = meta.get("stream") or []
print(f"stream holds {len(stream)} entr(ies):")
missing = [s["section_id"] for s in stream if s["section_id"] not in sel]
print(f"  stream ids absent from selections: {missing or 'none'}")

unchecked = [s["section_id"] for s in stream if not sel.get(s["section_id"])]
print(f"  stream ids stored unchecked: {unchecked or 'none'}")

defaults = [s["section_id"] for s in stream if not s.get("default_checked")]
print(f"  stream ids defaulting to unchecked: {defaults or 'none'}")

readable = {node["id"] for node, _ in walk(meta["sections"])
            if not node.get("children") and node["word_count"] > 0}
not_offered = sorted(readable - {s["section_id"] for s in stream})
print(f"  readable leaves NOT offered: {not_offered or 'none'}")
