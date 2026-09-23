"""Put the canonical book's saved position back where the reader left it.

Browser tests drive the real reader, and the reader PUTs `word_index` as it
advances, so exercising any book mutates its `state.json`. The user's own
position in `a8cacf49` was 3069 / s_005; a test pass had moved it to 116 / s_003.
Run this after any browser session that opened the reader.
"""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BOOK = "a8cacf49"
WANT_INDEX = 3069
WANT_SECTION = "s_005"

path = Path(__file__).resolve().parent.parent / "books" / BOOK / "state.json"
state = json.loads(path.read_text(encoding="utf-8"))
before = (state.get("word_index"), state.get("section_id"))

state["word_index"] = WANT_INDEX
state["section_id"] = WANT_SECTION
path.write_text(json.dumps(state, indent=2), encoding="utf-8")

after = json.loads(path.read_text(encoding="utf-8"))
print(f"books/{BOOK}/state.json")
print(f"  before: {before[0]} / {before[1]}")
print(f"  after:  {after['word_index']} / {after['section_id']}")
print(f"  selections kept: {len(after.get('selections', {}))}")
assert after["word_index"] == WANT_INDEX
assert after["section_id"] == WANT_SECTION
print("OK")
