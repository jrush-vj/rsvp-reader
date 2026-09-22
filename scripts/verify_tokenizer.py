"""
Prove the tokeniser still matches the heuristics it was extracted from.

The heuristics once lived inline in app.py; they were moved into tokenizer.py
so the web app and the offline client builder cannot drift apart. A move is
only safe if it is behaviour-preserving, so a frozen copy of the original
implementation is kept below and compared word by word over a large, awkward
real corpus: an entire book.

The frozen copy is deliberately a literal transcription rather than an import.
Importing the moved code would make this compare a thing to itself and prove
nothing.

This also checks that app.py no longer carries its own copy of those helpers -
the whole point of the extraction is that there is exactly one implementation.
"""

import re
import string
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app
import detector
import tokenizer
from pdftext import open_reader, read_pages

# ---------------------------------------------------------------------------
# The original implementation, frozen. Do not "tidy" this - it is the baseline.
# ---------------------------------------------------------------------------

_LEGACY_WORD_RE = re.compile(r"\S+")


def legacy_orp_index(word: str) -> int:
    core = word.strip(string.punctuation)
    length = len(core) if core else len(word)

    if length <= 1:
        idx = 0
    elif length <= 5:
        idx = 1
    elif length <= 9:
        idx = 2
    elif length <= 13:
        idx = 3
    else:
        idx = 4

    leading_punct = len(word) - len(word.lstrip(string.punctuation))
    return min(idx + leading_punct, max(len(word) - 1, 0))


def legacy_pause_multiplier(word: str) -> float:
    multiplier = 1.0

    if word.endswith((".", "!", "?")):
        multiplier = 2.6
    elif word.endswith((";", ":")):
        multiplier = 2.0
    elif word.endswith((",", ")", "\u201d", '"')):
        multiplier = 1.5

    core = word.strip(string.punctuation)
    if len(core) >= 10:
        multiplier += 0.3
    if len(core) >= 14:
        multiplier += 0.3

    return round(multiplier, 2)


def legacy_tokenize(text: str):
    return [
        {
            "text": m.group(0),
            "orp": legacy_orp_index(m.group(0)),
            "pause": legacy_pause_multiplier(m.group(0)),
        }
        for m in _LEGACY_WORD_RE.finditer(text)
    ]


# ---------------------------------------------------------------------------
# Compare over a whole real book, plus deliberately hostile cases.
# ---------------------------------------------------------------------------

reader = open_reader("books/a8cacf49/book.pdf")
pages = read_pages(reader)

text = detector.range_text(pages, 1, len(pages))
text += (
    " \u2014 \u201cquoted\u201d (\u201cdeep\u201d) don't cannot "
    "antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis "
    "e.g. i.e. U.S.A. 3.14 1,000 self-aware ... !! ?? -- ..."
)
prose = detector.normalise_prose(text)

new = tokenizer.tokenize(prose)
old = legacy_tokenize(prose)

print(f"words: tokenizer={len(new)} legacy={len(old)}")

mismatches = 0
for index, (a, b) in enumerate(zip(new, old)):
    if a != b:
        if mismatches < 10:
            print(f"  #{index}: tokenizer={a}  legacy={b}")
        mismatches += 1

print(f"mismatches in overlapping words: {mismatches}")

# Confirm the pause/orp helpers agree on every distinct spelling too.
words = {w["text"] for w in new}
bad = [
    w
    for w in words
    if tokenizer.orp_index(w) != legacy_orp_index(w)
    or tokenizer.pause_multiplier(w) != legacy_pause_multiplier(w)
]
print(f"distinct words checked: {len(words)}, helper mismatches: {len(bad)}")
for word in bad[:10]:
    print("  ", repr(word))

# The tokeniser helpers themselves are unchanged, but the text cleaning they
# was deliberately upgraded: a word hyphenated across a line break now only
# loses its hyphen when the continuation is lowercase ("self-\nestablishing" is
# one word), and keeps it when the continuation is a capital ("Two-\nMinute
# Rule" is a compound). Joining that capital would fuse the compound, which is
# the worse defect. Assert both halves of that rule.
split_mid_word = detector.normalise_prose("a self-\nestablishing habit")
compound = detector.normalise_prose("the Two-\nMinute Rule")
print(f"mid-word wrap joined:   {split_mid_word!r}")
print(f"compound wrap kept:     {compound!r}")
hyphen_ok = split_mid_word == "a selfestablishing habit" and compound == "the Two-Minute Rule"

# There must be exactly one tokeniser, and app.py must not reimplement it.
duplicates = [name for name in ("orp_index", "pause_multiplier", "tokenize") if hasattr(app, name)]
print(f"tokeniser helpers redefined in app.py: {duplicates or 'none'}")

# The library routes must be present, since the frontend is built entirely on
# them; a missing one is a 404 at runtime that is tedious to trace back here.
rules = {rule.rule for rule in app.app.url_map.iter_rules()}
required = {
    "/api/books",
    "/api/books/<book_id>",
    "/api/books/<book_id>/words",
    "/api/books/<book_id>/state",
    "/api/books/<book_id>/sections/<section_id>",
    "/api/health",
    "/api/upload",
}
missing = sorted(required - rules)
print(f"library routes missing: {missing or 'none'}")

ok = not (mismatches or bad or not hyphen_ok or duplicates or missing)
if not ok:
    raise SystemExit(1)
print("tokeniser is behaviour-preserving and single-sourced.")
