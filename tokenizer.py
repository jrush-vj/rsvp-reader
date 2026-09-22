"""
Word tokenisation for the reader.
=================================

Turns prose into the per-word records the reader steps through. Each word
carries two numbers derived from nothing but the word's own spelling:

  - orp:   which character to highlight, the Optimal Recognition Point. The
           eye's natural landing point shifts right as a word gets longer, but
           in discrete steps rather than linearly, so this is a lookup table
           rather than arithmetic.
  - pause: a multiplier on the base per-word delay. Punctuation earns a beat -
           a full stop more than a comma, a semicolon in between - which is
           what stops RSVP reading from feeling like a machine gun.

These live here, in one module, rather than beside the web app, because two
independent callers need them to agree exactly:

  * `app.py`          - the live `/api/upload` path, which tokenises a PDF on
                        the fly without touching disk.
  * `clientbuild.py`  - the offline path, which pre-tokenises a book's
                        sections into files the browser can fetch directly.

When these were separate copies, a change to one silently desynchronised the
other and the same book read differently depending on how it was opened.
"""

from __future__ import annotations

import re
import string

WORD_RE = re.compile(r"\S+")

# Punctuation that ends a thought and deserves the longest beat.
_SENTENCE_END = (".", "!", "?")
# A softer break - the reader is still inside one sentence.
_CLAUSE_END = (";", ":")
# The briefest pause: a breath, not a stop.
_COMMA_END = (",", ")", "\u201d", '"')


def orp_index(word: str) -> int:
    """
    Which character index in `word` to highlight, as the Optimal Recognition
    Point.

    Position is taken from the word's core - the letters, with surrounding
    punctuation stripped - because punctuation should not push the highlight
    off the word. Quotes and brackets still occupy real character positions
    though, so the highlight is shifted right by however many punctuation
    characters lead the word, then clamped to stay inside it.
    """
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


def pause_multiplier(word: str) -> float:
    """
    How much longer than the base per-word delay this word should hold.

    Long words also gain a little time, since they take longer to recognise,
    so the multiplier is accumulated rather than chosen: a long word ending a
    sentence is both a sentence end and a long word.
    """
    multiplier = 1.0

    if word.endswith(_SENTENCE_END):
        multiplier = 2.6
    elif word.endswith(_CLAUSE_END):
        multiplier = 2.0
    elif word.endswith(_COMMA_END):
        multiplier = 1.5

    core = word.strip(string.punctuation)
    if len(core) >= 10:
        multiplier += 0.3
    if len(core) >= 14:
        multiplier += 0.3

    return round(multiplier, 2)


def tokenize(text: str) -> list[dict]:
    """
    Split text into annotated words.

    Whitespace is the only delimiter, so hyphenated words, em-dashes drawn as
    characters and contractions all survive as the reader will see them.
    """
    return [
        {
            "text": match.group(0),
            "orp": orp_index(match.group(0)),
            "pause": pause_multiplier(match.group(0)),
        }
        for match in WORD_RE.finditer(text)
    ]
