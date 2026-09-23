"""Reset the throwaway test fixture to a pristine, fully-included state.

`books/ba497a34` is a 3-page generated PDF kept around because it loads
instantly, which makes it useful for exercising the reader. A section-toggle
round-trip test had left `s_002` excluded and the position part-read, so the
fixture no longer represented a fresh book. Run this after a test that opens it.
"""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
BOOK = "ba497a34"

book_dir = ROOT / "books" / BOOK
meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
state_path = book_dir / "state.json"
state = json.loads(state_path.read_text(encoding="utf-8"))

print(f"books/{BOOK}/state.json")
print(f"  before: index={state.get('word_index')} selections={state.get('selections')}")

# Every stream entry back to its own default. Deriving from the book rather than
# hardcoding `True` keeps this correct if the fixture is ever regenerated with a
# section that is meant to start unchecked.
state["selections"] = {
    entry["section_id"]: bool(entry.get("default_checked"))
    for entry in meta.get("stream", [])
}
first = meta["stream"][0]["section_id"] if meta.get("stream") else None
state["word_index"] = 0
state["section_id"] = first

state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

after = json.loads(state_path.read_text(encoding="utf-8"))
print(f"  after:  index={after['word_index']} section={after['section_id']}")
print(f"          selections={after['selections']}")
assert all(after["selections"].values()), "some section is still excluded"
assert after["word_index"] == 0
print("OK")
