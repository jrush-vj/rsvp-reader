"""Print a built book's section tree so its shape can be eyeballed."""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

book_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "books/a8cacf49")
meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))

def render(nodes, depth=0):
    for node in nodes:
        mark = "*" if node.get("default_checked") is True else " "
        kind = node["entry_type"]
        badge = {"chapter": "ch", "sub": "sub", "part": "PART", "front_matter": "front", "back_matter": "back"}.get(kind, kind)
        print(
            f"{'  ' * depth}[{mark}] {node['id']} {badge:<5} "
            f"p{node['start_page']:>3}-{node['end_page']:<3} {node['word_count']:>6}w  "
            f"{node['full_title'][:58]!r}"
        )
        render(node["children"], depth + 1)


render(meta["sections"])
