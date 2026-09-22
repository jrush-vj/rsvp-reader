"""
Section rendering and heading trimming.
=======================================

Turns a detected section - a page range with a title - into the actual words
the reader will step through.

Two things happen here that a naive "dump the page range" would get wrong.

**Trimming the heading out of the body.** A section's range starts on the page
its title is printed on, so the first line of the text *is* the title:

    Introduction                <- the heading
    MY STORY                    <- the subtitle
    In the summer of 2012, ...  <- the prose

The reader shows that title in a full-screen overlay before the section starts,
so leaving it in the body means the reader immediately re-reads the title as a
run of RSVP words. Trimming it is what makes the overlay and the stream line up.

**Collapsing whitespace.** Page text is a sequence of laid-out lines, so a word
split across a line break arrives hyphenated and each line break would
otherwise become a word boundary of its own.

Both steps are shared with the detector's own text handling via
`detector.normalise_prose`, which is what allows the invariant

    meta.json word_count == len(client/<id>.json["words"])

to hold: the number the picker shows and the number of words the reader
actually steps through are counted from the same string.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import detector
import tokenizer
from detector import Section

# How far into a section the heading is allowed to be. A heading sits at the
# top of its first page; if the match is further down than this, it is a
# coincidence in the prose rather than the heading itself.
HEADING_SEARCH_WORDS = 24

# Longest title worth looking for, in characters. Guards against a whole
# sentence in some malformed outline entry being treated as a heading.
_MAX_TITLE_CHARS = 160


def _normalise_line(text: str) -> str:
    """Comparable form of a line or title: lowercase alphanumerics only."""
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _title_forms(section: Section) -> list[list[str]]:
    """
    Every spelling of this section's heading, as sequences of normalised lines.

    A heading can be printed as a bare number above its title ("2" then "How
    Your Habits Shape Your Identity"), as the number and title on one line, or
    as a title wrapped over two lines. Rather than guess which, each plausible
    rendering is offered as a candidate and the longest matching one wins.
    """
    forms: list[list[str]] = []
    for title in (section.title, section.clean_title, section.display_title):
        title = (title or "").strip()
        if not title or len(title) > _MAX_TITLE_CHARS:
            continue
        lines = [part for part in title.split("\n") if part.strip()]
        normalised = [_normalise_line(part) for part in lines]
        normalised = [part for part in normalised if part]
        if normalised and normalised not in forms:
            forms.append(normalised)
    return forms


def strip_heading(section: Section, pages: list) -> str:
    """
    Return the section's readable text with its own printed heading removed.

    Works on the prose itself rather than on structured lines, because the body
    text comes from pypdf's better-spaced extraction and the two disagree about
    spacing. A prefix of the prose is compared against the known spellings of
    the heading, and only a small number of opening words are considered, since
    a heading sits at the top of its first page.
    """
    text = detector.normalise_prose(detector.range_text(pages, section.start_page, section.end_page))
    if not text:
        return ""

    forms = _title_forms(section)
    if not forms:
        return text

    words = text.split()
    # Only the opening words can hold the heading, and a heading is short.
    window = words[:HEADING_SEARCH_WORDS]
    joined: list[str] = []
    for word in window:
        joined.append(word)

    best_end = 0
    for form in forms:
        end = _match_prose(joined, form)
        if end > best_end:
            best_end = end

    if not best_end:
        return text

    return " ".join(words[best_end:])


def _match_prose(words: list[str], normalised: list[str]) -> int:
    """
    Match a heading against the opening words, returning how many to drop.

    The heading may be printed across one run of words or split over lines, and
    a bare chapter number may sit in front of it, so the comparison tries both
    a plain match and one that tolerates an optional leading numeric token.
    """
    target = "".join(normalised)

    # Plain match: the heading's own text starts the section.
    consumed = _consume(words, 0, target)
    if consumed:
        return consumed

    # A bare number may precede the title ("2" then "How Your Habits...").
    if words and words[0].isdigit():
        consumed = _consume(words, 1, target)
        if consumed:
            return 1 + consumed

    return 0


def _consume(words: list[str], start: int, target: str) -> int:
    """How many words from `start` spell exactly `target`, or 0."""
    accumulated = ""
    for index in range(start, min(len(words), start + len(target) + 8)):
        accumulated += _normalise_line(words[index])
        if accumulated == target:
            return index + 1 - start
        if not target.startswith(accumulated):
            return 0
    return 0


def section_words(section: Section, pages: list) -> list[dict]:
    """
    The annotated words for a section, heading removed.

    This is the single source of truth for a section's text. `word_count` on
    the section and the length of this list are the same number by
    construction, because both derive from `strip_heading`'s output.
    """
    return tokenizer.tokenize(strip_heading(section, pages))


def readable_leaves(roots: list[Section]) -> list[Section]:
    """
    Every section that contributes words to the reading stream, in order.

    Order is document order, not tree order, so the reader's continuous stream
    visits a part's chapters in the sequence they appear in the book.
    """
    ordered = sorted(
        (section for root in roots for section in root.walk()),
        key=lambda section: (section.start_page, section.level),
    )
    return [section for section in ordered if section.is_readable]


def apply_word_counts(roots: list[Section], pages: list) -> dict[str, int]:
    """
    Set every leaf's word count from its own trimmed text.

    Called after detection so the count the picker displays is measured from
    precisely the words the reader will step through, rather than from the
    untrimmed page range.
    """
    counts: dict[str, int] = {}
    for root in roots:
        for section in root.walk():
            if section.children:
                continue
            words = section_words(section, pages)
            section.word_count = len(words)
            words_text = " ".join(word["text"] for word in words)
            section.preview = detector.make_preview(words_text)
            counts[section.id] = section.word_count

    for root in roots:
        _roll_up(root)

    return counts


def _roll_up(section: Section) -> None:
    """Containers report the sum of their children."""
    for child in section.children:
        _roll_up(child)
    if section.children:
        section.word_count = sum(child.word_count for child in section.children)
        section.end_page = max(child.end_page for child in section.children)
