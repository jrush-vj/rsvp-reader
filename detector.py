"""
Section detection.
==================

Works out the structure of a book - its parts, chapters and subchapters - using
only heuristics. No AI model, no API key, no network call.

Detection runs as a cascade, best signal first:

  1. outline  - the PDF's own bookmark tree. Most books made by a real
                typesetter (or converted by calibre) carry this, and it gives
                exact titles, nesting and target pages.
  2. contents - the printed contents page. Page numbers are usually hyperlink
                destinations rather than visible text in modern PDFs, so we
                read the link annotations first and fall back to parsing
                dot-leader lines.
  3. fonts    - cluster text by font size and weight. A heading is reliably
                larger or bolder than body text, so this finds structure even
                in a PDF with no outline and no contents page.
  4. whole    - last resort: treat the document as one long section so the
                reader still works.

Whichever strategy wins, it produces a flat list of `_Entry` records. Those all
flow through the same `build_sections` step, so boundary repair, divider
detection and hierarchy building behave identically no matter how the entries
were found.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pdftext import (  # noqa: F401
    PdfReader,
    TextLine,
    build_page_lookup,
    open_reader,
    read_pages,
    resolve_page,
)

# How far a link rectangle's centre may sit from a text baseline and still be
# considered the same contents entry, in PDF points.
LINK_LINE_TOLERANCE = 12.0

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------

# A section this short is a divider page ("THE 1ST LAW"), not real content.
# Atomic Habits' part dividers run 6-13 words, so 30 leaves clear headroom.
MIN_DIVIDER_WORDS = 30

# How far to search forward when repairing a bookmark that points backwards.
REPAIR_SEARCH_WINDOW = 40

# Confidence score reported for each strategy.
CONFIDENCE = {
    "outline": 0.95,
    "contents": 0.7,
    "fonts": 0.45,
    "whole_doc": 0.2,
}

FRONT_MATTER_PATTERNS = (
    "titlepage",
    "copyright",
    "epigraph",
    "contents",
    "tableofcontents",
    "dedication",
    "halftitle",
    "cover",
    "praise",
    "alsoby",
    "frontmatter",
    "listofillustrations",
    "listoffigures",
    "foreword",
    "preface",
    "acknowledgements",  # often front, sometimes back; treated as skippable either way
    "acknowledgments",
)

BACK_MATTER_PATTERNS = (
    "index",
    "notes",
    "endnotes",
    "bibliography",
    "references",
    "furtherreading",
    "abouttheauthor",
    "aboutthepublisher",
    "glossary",
    "credits",
    "permissions",
    "appendix",
)

# Leading "12 " or "Chapter 12" or "Part II" prefixes on outline titles.
_NUMERIC_PREFIX = re.compile(
    r"^\s*(?:chapter|part|section|appendix)?\s*"
    r"(?:\d{1,3}|[IVXLC]{1,7})\b[.:)\u2014-]?\s+",
    re.IGNORECASE,
)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# A word hyphenated across a line break: "exam-\nple" is one word, "example".
_HYPHEN_BREAK_RE = re.compile(r"(\w)-\s*\n\s*(\w)")


def _join_wrapped_hyphen(match: re.Match) -> str:
    """
    Rejoin a word hyphenated across a line break.

    "self-\nestablishing" is one word and the hyphen must go; "Two-\nMinute
    Rule" is a hyphenated compound and the hyphen must stay. The letter after
    the break tells the two apart: a lowercase continuation was split mid-word
    by the typesetter, while a capital starts a word of its own. Joining that
    capital would fuse a compound ("TwoMinute"), which is a worse defect than
    the one being repaired.
    """
    following = match.group(2)
    return f"{match.group(1)}-{following}" if following.isupper() else f"{match.group(1)}{following}"

# Runs of spaces or tabs left behind once newlines are folded into spaces.
_INNER_WS_RE = re.compile(r"[ \t]+")


# ---------------------------------------------------------------------------
# Section model
# ---------------------------------------------------------------------------


@dataclass
class Section:
    """One node of the detected structure tree."""

    id: str = ""
    title: str = ""
    subtitle: str = ""
    prefix: str = ""
    clean_title: str = ""
    level: int = 1
    entry_type: str = "chapter"  # part | chapter | sub | front_matter | back_matter
    start_page: int = 1
    end_page: int = 1
    word_count: int = 0
    preview: str = ""
    default_checked: bool = False
    children: list["Section"] = field(default_factory=list)

    @property
    def is_container(self) -> bool:
        return bool(self.children)

    @property
    def is_readable(self) -> bool:
        """
        Whether this node is real content someone would want to read.

        Only leaves qualify. A part or an appendix that contains chapters is
        organisation, not text: its words are its children's words, so reading
        the container as well would duplicate every word beneath it.

        Front and back matter are excluded even when they are leaves, so the
        copyright page and the index stay out of the reading stream while
        still appearing in the picker for context.
        """
        return (
            not self.children
            and self.entry_type in ("chapter", "sub")
            and self.word_count > 0
        )

    @property
    def display_title(self) -> str:
        return f"{self.title} - {self.subtitle}" if self.subtitle else self.title

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.clean_title or self.title,
            "full_title": self.display_title,
            "prefix": self.prefix,
            "subtitle": self.subtitle,
            "level": self.level,
            "entry_type": self.entry_type,
            "start_page": self.start_page,
            "end_page": self.end_page,
            "word_count": self.word_count,
            "preview": self.preview,
            "default_checked": self.default_checked,
            "children": [child.to_dict() for child in self.children],
        }

    def walk(self):
        """Yield this node then every descendant, in document order."""
        yield self
        for child in self.children:
            yield from child.walk()


@dataclass
class _Entry:
    """A raw structure marker, before hierarchy and boundaries are resolved."""

    title: str
    page: int
    level: int = 1
    subtitle: str = ""
    size: float = 0.0


@dataclass
class Detection:
    """The result of a detection run."""

    method: str
    confidence: float
    notes: list[str]
    sections: list[Section]
    front_matter_pages: list[int] = field(default_factory=list)
    total_pages: int = 0

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "confidence": round(self.confidence, 2),
            "notes": self.notes,
            "front_matter_pages": self.front_matter_pages,
            "sections": [s.to_dict() for s in self.sections],
        }

    @property
    def readable_sections(self) -> list[Section]:
        out: list[Section] = []
        for section in self.sections:
            out.extend(s for s in section.walk() if s.is_readable)
        return out


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def normalise(text: str) -> str:
    """Collapse text to lowercase alphanumerics, for fuzzy title matching."""
    return _NON_ALNUM.sub("", (text or "").lower())


def page_text(pages: list, number: int) -> str:
    """All text on a 1-based page number, or an empty string."""
    if 1 <= number <= len(pages):
        return pages[number - 1].text
    return ""


def range_text(pages: list, start: int, end: int) -> str:
    """Text spanning an inclusive 1-based page range."""
    if start > end:
        return ""
    start = max(1, start)
    end = min(len(pages), end)
    return "\n".join(pages[i].text for i in range(start - 1, end))


def count_words(text: str) -> int:
    return len(text.split())


def normalise_prose(text: str) -> str:
    """
    Turn extracted page text into the exact prose the reader will display.

    Page text is a sequence of laid-out lines, so a word split across a line
    break arrives hyphenated ("exam-" then "ple") and every line break would
    otherwise become a word boundary of its own. Normalising here - once, in
    the detector - means the word count recorded in `meta.json` and the words
    written to the client files come from a single function.

    That matters because the previous generator counted words one way and
    wrote them another, so the two disagreed. Any consumer that trusts the
    count (a progress bar, a resume position, a picker's word total) was
    silently wrong as a result. The invariant the pipeline now holds is:

        meta.json word_count == len(client/<id>.json["words"])

    for every section, and that is only achievable if both sides count the
    same string.
    """
    text = _HYPHEN_BREAK_RE.sub(_join_wrapped_hyphen, text or "")
    text = text.replace("\n", " ")
    return _INNER_WS_RE.sub(" ", text).strip()


def make_preview(text: str, limit: int = 14) -> str:
    """
    A short human-readable snippet for the picker.

    Skips the first line when it looks like the section's own heading, so the
    preview shows prose rather than repeating the title.
    """
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if len(lines) > 1:
        lines = lines[1:]
    words = " ".join(lines).split()
    return " ".join(words[:limit])


def locate_page(
    pages: list,
    title: str,
    start_page: int,
    body_size: float = 0.0,
    exclude: set[int] | None = None,
) -> int | None:
    """
    Find the page a section heading actually appears on.

    Used to repair bookmarks that point backwards. PDF outlines in the wild
    contain genuinely wrong destinations - Atomic Habits' "Introduction: My
    Story" bookmark points at the title page - so trusting them blindly
    collapses several sections onto one page.

    Matching is done on alphanumerics only, with spaces removed, so a heading
    split across two lines ("Introduction" / "My Story") still matches its
    single-line bookmark title.

    The search prefers a hit on a line set in heading-sized type, because the
    title also occurs on the contents page as a small-type listing. Without
    that preference the contents page wins purely by coming first, and the
    section swallows the table of contents into its own text.
    """
    target = normalise(title)
    if len(target) < 5:
        return None

    exclude = exclude or set()
    last = min(len(pages), start_page + REPAIR_SEARCH_WINDOW)
    window = [pages[i] for i in range(start_page, last + 1) if (i + 1) not in exclude]

    # Best case: the title is printed as a heading.
    if body_size > 0:
        for page in window:
            for line in page.lines:
                if line.size >= body_size + 2.0 and target in normalise(line.text):
                    return page.number

    # Otherwise accept any occurrence on a non-excluded page.
    for page in window:
        if target in normalise(page.text):
            return page.number

    # Long titles often differ slightly from the printed heading, so retry on
    # a prefix before giving up.
    partial = target[: max(6, int(len(target) * 0.6))]
    for page in window:
        if partial in normalise(page.text):
            return page.number

    return None


def classify_by_title(title: str) -> str | None:
    """Flag obvious front/back matter from its title alone."""
    key = normalise(title)
    if not key:
        return None

    for pattern in FRONT_MATTER_PATTERNS:
        if key.startswith(pattern) or key == pattern:
            return "front_matter"

    for pattern in BACK_MATTER_PATTERNS:
        if key.startswith(pattern) or key == pattern:
            return "back_matter"

    return None


def strip_numeric_prefix(title: str) -> tuple[str, str]:
    """
    Split "1 The Surprising Power of Atomic Habits" into ("1", "The
    Surprising Power of Atomic Habits").

    Keeping the number separate lets the picker render it as a badge while the
    overlay shows a clean title.
    """
    match = _NUMERIC_PREFIX.match(title or "")
    if not match:
        return "", (title or "").strip()
    return match.group(0).strip(), title[match.end():].strip()


# ---------------------------------------------------------------------------
# Strategy 1: embedded outline
# ---------------------------------------------------------------------------


def entries_from_outline(reader) -> list[_Entry]:
    """Read the bookmark tree into entries, preserving nesting as levels."""
    by_ref, by_pair = build_page_lookup(reader)

    def walk(nodes, level: int, out: list[_Entry]) -> None:
        for node in nodes:
            if isinstance(node, list):
                walk(node, level + 1, out)
                continue

            title = str(getattr(node, "title", "") or "").strip()
            if not title:
                continue

            page = resolve_page(reader, node, by_ref, by_pair)
            if page is not None:
                out.append(_Entry(title=title, page=page, level=level))

    try:
        outline = reader.outline
    except Exception:
        return []

    entries: list[_Entry] = []
    try:
        walk(outline, 1, entries)
    except Exception:
        pass
    return entries


# ---------------------------------------------------------------------------
# Strategy 2: contents page
# ---------------------------------------------------------------------------


def find_contents_pages(reader, pages: list, limit: int = 15) -> list[int]:
    """
    Identify which physical pages hold the contents listing.

    Two independent signals: a page carrying many internal link annotations
    (the clickable contents of a digital edition), or a page whose opening
    line is literally "Contents".
    """
    found: list[int] = []

    for index in range(min(limit, len(reader.pages))):
        try:
            annots = reader.pages[index].get("/Annots")
        except Exception:
            annots = None

        internal_links = 0
        for annot in annots or []:
            try:
                obj = annot.get_object()
                if obj.get("/Subtype") != "/Link":
                    continue
                if obj.get("/Dest") is not None or obj.get("/A") is not None:
                    internal_links += 1
            except Exception:
                continue

        if internal_links >= 3:
            found.append(index + 1)
            continue

        if index < len(pages):
            first_line = pages[index].lines[0].text.strip().lower() if pages[index].lines else ""
            if first_line in ("contents", "table of contents"):
                found.append(index + 1)

    return found


def entries_from_contents(reader, pages: list) -> tuple[list[_Entry], list[int]]:
    """
    Build entries from the contents page.

    Prefers hyperlink destinations, which give exact target pages, and falls
    back to dot-leader text parsing.

    Modern PDFs carry contents pages whose page numbers exist only as
    annotations - the printed "42" is not in the text layer at all - so the
    hyperlink path is the reliable one. Each link is paired with the text line
    it sits on by comparing the links's vertical centre to the line's baseline,
    which is what makes "Chapter 4" map to page 52 rather than to whichever
    line happens to be nearest a corner of the rectangle.
    """
    contents_pages = find_contents_pages(reader, pages)
    if not contents_pages:
        return [], []

    by_ref, by_pair = build_page_lookup(reader)
    entries: list[_Entry] = []
    links_used = False

    for page_number in contents_pages:
        try:
            page = reader.pages[page_number - 1]
        except Exception:
            continue

        try:
            annots = page.get("/Annots") or []
        except Exception:
            annots = []

        links: list[tuple[float, int]] = []
        for annot in annots:
            try:
                obj = annot.get_object()
                if obj.get("/Subtype") != "/Link":
                    continue

                rect = obj.get("/Rect")
                if rect is None:
                    continue

                dest = obj.get("/Dest")
                if dest is None:
                    action = obj.get("/A")
                    if action is not None:
                        dest = action.get_object().get("/D")

                target = resolve_page(reader, dest, by_ref, by_pair)
                if target is None:
                    continue

                # Centre of the rectangle: link boxes are generous and their
                # top edge often overlaps the previous entry's baseline.
                top, bottom = float(rect[3]), float(rect[1])
                links.append(((top + bottom) / 2.0, target))
            except Exception:
                continue

        if not links:
            continue

        links_used = True
        links.sort(key=lambda pair: -pair[0])  # PDF y grows upwards
        lines = pages[page_number - 1].lines if page_number - 1 < len(pages) else []
        claimed: set[int] = set()

        for centre, target in links:
            best_index, best_delta = None, None
            for index, line in enumerate(lines):
                if index in claimed:
                    continue
                delta = abs(line.y - centre)
                if best_delta is None or delta < best_delta:
                    best_index, best_delta = index, delta

            if best_index is None or best_delta is None or best_delta > LINK_LINE_TOLERANCE:
                continue

            claimed.add(best_index)
            line = lines[best_index]
            title = line.text.strip().strip(".")
            if title:
                entries.append(_Entry(title=title, page=target, level=1, size=line.size))

    if entries:
        return apply_contents_levels(entries, pages), contents_pages

    # A contents page with no usable links: parse dot-leader lines instead.
    from pdftext import find_toc_lines

    for hit in find_toc_lines(pages):
        entries.append(_Entry(title=hit["title"], page=hit["target_page"], level=1))

    if not entries and links_used:
        return [], contents_pages

    return entries, contents_pages


def apply_contents_levels(entries: list[_Entry], pages: list) -> list[_Entry]:
    """
    Infer contents-page hierarchy from font size.

    A contents listing prints parts in larger type than the chapters beneath
    them, so the distinct sizes on the page rank into levels. This matters
    beyond neatness: without it every entry is a sibling, so a skipped appendix
    cannot suppress the sub-entries it contains, and those would arrive
    ticked for reading.

    The page's own title ("Contents") is dropped, since it is the heading of
    the listing rather than an entry in it.
    """
    candidates = [e for e in entries if e.size > 0]
    if len(candidates) < 3:
        for entry in entries:
            entry.level = 1
        return entries

    sizes = sorted({round(entry.size, 1) for entry in candidates}, reverse=True)

    # The largest size is usually the word "Contents"; if only that one line
    # carries it, drop it and re-rank on what remains.
    if len(sizes) > 1:
        biggest = sizes[0]
        holders = [e for e in candidates if round(e.size, 1) == biggest]
        if len(holders) == 1 and normalise(holders[0].title) in ("contents", "tableofcontents"):
            entries = [e for e in entries if e is not holders[0]]
            sizes = sizes[1:]

    level_of = {size: min(index + 1, 3) for index, size in enumerate(sizes)}
    for entry in entries:
        entry.level = level_of.get(round(entry.size, 1), 1)

    return entries


# ---------------------------------------------------------------------------
# Strategy 3: font clustering
# ---------------------------------------------------------------------------


def estimate_body_size(pages: list) -> float:
    """
    The font size carrying the most characters is the body text size.

    Measured per line with `dominant_size` rather than the line's maximum size,
    because some PDFs emit decorative initials as oversized runs. Judging by
    the maximum makes an ordinary paragraph line read as a 37pt heading, which
    both misstates the body size and invents headings out of prose.
    """
    tally: dict[float, int] = {}
    for page in pages:
        for line in page.lines:
            visible = line.text.strip()
            if visible:
                size = line.dominant_size
                tally[size] = tally.get(size, 0) + len(visible)
    if not tally:
        return 0.0
    return max(tally.items(), key=lambda kv: kv[1])[0]


def is_drop_cap_line(line: TextLine, body_size: float) -> bool:
    """
    True if a line's opening letter is set far larger than its own body text.

    Chapter openers begin with a decorative initial - "O**N THE FINAL day**
    of my sophomore year" - which makes the line's maximum font size look
    like a heading's. It isn't: the rest of the line is ordinary body text, so
    treating it as one both invents a chapter and steals the first line of the
    real chapter's text.
    """
    if not line.runs or body_size <= 0:
        return False

    # A decorative initial can land anywhere in the run list, not only first:
    # some converters emit the glyph and its following letter as separate runs,
    # so "T" and "H" precede the rest of the word.
    oversized = [run for run in line.runs if run.size >= body_size * 1.5]
    if not oversized:
        return False

    # Any ordinary run on the same line means this is text with a big initial,
    # not a title set in display type.
    return any(run.size <= body_size + 1.0 for run in line.runs)


def is_heading_line(line: TextLine, body_size: float) -> bool:
    """
    Whether a line reads as a heading.

    Larger than body text is the strong signal, but the line must still be
    short: a heading does not run to a full line of prose. PDFs whose converter
    marks ordinary sentences with a display-sized first glyph otherwise promote
    body text to chapter titles. Bold at body size counts only when the line is
    short and doesn't end like a sentence, which filters bolded mid-sentence
    emphasis. Drop caps are rejected outright.
    """
    if is_drop_cap_line(line, body_size):
        return False

    if line.size >= body_size + 2.0:
        # A real heading's characters are all set in the display size. Prose
        # whose converter marked a decorative initial with a display size has
        # its remaining characters in body type, so its dominant size is body.
        return line.dominant_size >= body_size + 2.0

    if (
        line.bold
        and line.size >= body_size - 0.5
        and line.is_short
        and not line.ends_like_a_sentence
        and not line.text.endswith(".")
    ):
        return True
    return False


def entries_from_fonts(pages: list) -> list[_Entry]:
    """Cluster heading-like lines into entries, ranking sizes into levels."""
    body_size = estimate_body_size(pages)
    if body_size <= 0:
        return []

    candidates: list[tuple[int, float, TextLine]] = []
    for page in pages:
        for line in page.lines:
            if is_heading_line(line, body_size):
                candidates.append((page.number, line.size, line))

    if len(candidates) < 3:
        return []

    # Distinct heading sizes, largest first, become levels 1, 2, 3...
    sizes = sorted({round(size, 1) for _, size, _ in candidates}, reverse=True)
    level_of = {size: min(index + 1, 3) for index, size in enumerate(sizes)}

    entries: list[_Entry] = []
    for page_number, size, line in candidates:
        if line.text.isupper() and len(line.text.split()) > 8:
            continue  # a shouty paragraph, not a heading
        entries.append(
            _Entry(title=line.text.strip(), page=page_number, level=level_of[round(size, 1)])
        )

    return entries


# ---------------------------------------------------------------------------
# Shared builder
# ---------------------------------------------------------------------------


def repair_pages(
    entries: list[_Entry], pages: list, notes: list[str], exclude_pages: set[int] | None = None
) -> None:
    """
    Force entry pages to be non-decreasing, searching the text for the truth.

    Outline destinations are frequently stale - a bookmark can point at the
    front of the book while its heading sits hundreds of pages later - and
    those errors would otherwise produce zero-length or negative page ranges.
    """
    repaired = 0
    previous = 0
    body_size = estimate_body_size(pages)

    for entry in entries:
        if entry.page >= previous and entry.page >= 1:
            previous = entry.page
            continue

        located = locate_page(
            pages, entry.title, max(1, previous), body_size, exclude_pages
        )
        if located is not None and located >= previous:
            entry.page = located
            repaired += 1
        else:
            entry.page = max(previous, 1)

        previous = entry.page

    if repaired:
        notes.append(f"Repaired {repaired} out-of-order bookmark page(s) by matching heading text.")


def merge_same_page_pairs(entries: list[_Entry], notes: list[str]) -> list[_Entry]:
    """
    Collapse runs of entries that share a page and a level into one entry.

    Two distinct things get merged here, both of which otherwise become
    separate sections claiming the same page - which means the same text is
    read twice:

    * A divider and its strapline. Part openers print the part name and the
      part's strapline on one page - "The 1st Law" above "Make It Obvious" -
      and a bookmark tree lists them as two entries. Left alone they become two
      near-empty sections with identical text, which is precisely the
      corruption the previous generator produced.

    * A heading wrapped over several lines. Some PDFs set a chapter title as
      three separate lines - "2", "How Your Habits Shape Your Identity (and
      Vice", "Versa)" - each of which looks like its own heading.

    Numbered headings are only kept apart when their numbers differ: "1 The
    Surprising Power" and "2 How Your Habits Shape Your Identity" are adjacent
    chapters that merely share a page, and fusing them would lose a chapter.
    A bare number followed by its title should merge.
    """
    merged: list[_Entry] = []
    consumed = 0

    index = 0
    while index < len(entries):
        current = entries[index]
        run = [current.title]
        number = strip_numeric_prefix(current.title)[0]
        index += 1

        while index < len(entries):
            following = entries[index]
            following_number = strip_numeric_prefix(following.title)[0]

            same_page = (
                following.page == current.page
                and following.level == current.level
                and bool(following.title)
            )

            # Two differently numbered chapters are genuinely separate even
            # when they share a page.
            distinct_chapters = bool(number) and bool(following_number) and number != following_number

            if not same_page or distinct_chapters:
                break

            run.append(following.title)
            index += 1
            consumed += 1

        if len(run) > 1:
            current.subtitle = " ".join(run[1:])

        merged.append(current)

    if consumed:
        notes.append(f"Merged {consumed} extra titl(es) sharing a page with another heading.")

    return merged


def build_sections(
    entries: list[_Entry],
    pages: list,
    notes: list[str],
    exclude_pages: set[int] | None = None,
) -> list[Section]:
    """
    Turn flat entries into a bounded, typed, hierarchical tree.

    Three passes: repair pages, merge shared-page divider pairs, then walk the
    list assigning page ranges and attaching children by level.
    """
    total_pages = len(pages)
    entries = [e for e in entries if e.title]
    if not entries:
        return []

    repair_pages(entries, pages, notes, exclude_pages)
    entries = merge_same_page_pairs(entries, notes)

    # A page range runs to the page before the next entry. Containers get
    # their range from their children afterwards.
    sections: list[Section] = []
    for index, entry in enumerate(entries):
        next_page = entries[index + 1].page if index + 1 < len(entries) else total_pages + 1
        end_page = max(entry.page, min(next_page - 1, total_pages))

        flagged = classify_by_title(entry.title)
        prefix, clean_title = strip_numeric_prefix(entry.title)

        sections.append(
            Section(
                title=entry.title,
                subtitle=entry.subtitle,
                prefix=prefix,
                clean_title=clean_title,
                level=entry.level,
                entry_type=flagged or ("chapter" if entry.level == 1 else "sub"),
                start_page=min(entry.page, total_pages),
                end_page=end_page,
            )
        )

    # Nest by level: level 1 is top, deeper levels attach to the nearest
    # shallower predecessor.
    roots: list[Section] = []
    stack: list[Section] = []

    for section in sections:
        while stack and stack[-1].level >= section.level:
            stack.pop()

        if stack:
            stack[-1].children.append(section)
        else:
            roots.append(section)
        stack.append(section)

    return roots


def apply_content_stats(roots: list[Section], pages: list, notes: list[str]) -> None:
    """
    Fill word counts and previews, then reclassify divider pages as parts.

    Leaves take the text of their own page range. Containers sum their
    children and inherit their page span, because the divider page itself
    belongs to the part, not to the first chapter inside it.
    """
    leaves = [s for root in roots for s in root.walk() if not s.children]

    for section in leaves:
        text = range_text(pages, section.start_page, section.end_page)
        section.word_count = count_words(text)
        section.preview = make_preview(text)

    # A very short section that is followed by more sections is a divider page
    # ("THE 1ST LAW"), not reading material. The final section is exempt: a
    # short last section is just a short last section.
    dividers = []
    for index, section in enumerate(leaves):
        if index == len(leaves) - 1:
            continue
        if section.word_count < MIN_DIVIDER_WORDS and section.entry_type in ("chapter", "sub"):
            section.entry_type = "part"
            dividers.append(section.title)
            # A divider's own words are not content, so it contributes none.
            section.word_count = sum(child.word_count for child in section.children)

    if dividers:
        notes.append(
            f"Reclassified {len(dividers)} low-word-count divider page(s) as parts: "
            + ", ".join(dividers[:5])
            + (" ..." if len(dividers) > 5 else "")
        )

    def roll_up(section: Section) -> None:
        for child in section.children:
            roll_up(child)
        if section.children:
            section.word_count = sum(child.word_count for child in section.children)
            section.end_page = max(child.end_page for child in section.children)
            span = range_text(pages, section.start_page, section.end_page)
            section.preview = make_preview(span)

    for root in roots:
        roll_up(root)

    # Parts nest the chapters that follow them. Promote any part that has no
    # children yet but is followed by chapters at the same level.
    regroup_parts(roots, notes)


def regroup_parts(roots: list[Section], notes: list[str]) -> None:
    """
    Make parts contain the chapters printed under them.

    A bookmark tree lists a part and its chapters as siblings, because that's
    how the printed page nests them. The picker wants real nesting, so each
    part adopts the following siblings.
    """
    regrouped: list[Section] = []
    current_part: Section | None = None

    for section in roots:
        # Front and back matter stand outside the parts. A part must not adopt
        # them, or the notes and index would be filed under "Advanced
        # Tactics" and the picker would offer them as if they were chapters.
        if section.entry_type in ("front_matter", "back_matter"):
            current_part = None
            regrouped.append(section)
            continue

        if section.entry_type == "part":
            current_part = section
            regrouped.append(current_part)
            continue

        if current_part is not None:
            current_part.children.append(section)
        else:
            regrouped.append(section)

    # Report a trailing part that never got chapters, so detection notes show
    # why the picker would offer no leaves under it.
    if current_part is not None and not current_part.children:
        notes.append(f"'{current_part.title}' is a part with no chapters after it.")

    roots[:] = regrouped

    # Recompute containers now that parts have children.
    for root in roots:
        if root.children:
            root.word_count = sum(child.word_count for child in root.children)
            root.end_page = max(child.end_page for child in root.children)


def mark_defaults(roots: list[Section]) -> None:
    """
    Decide which sections are ticked when the picker first opens.

    Reading material starts selected; front and back matter starts cleared,
    matching the request to skip contents, preface and index pages.

    Suppression is inherited only from front and back matter, so a sub-section
    inside a skipped appendix stays cleared too. A part is deliberately
    neutral: it is a heading with no text of its own, so it is never ticked,
    but the chapters printed under it still are.
    """

    def visit(section: Section, parent_checked: bool) -> None:
        suppressed = section.entry_type in ("front_matter", "back_matter")
        section.default_checked = (
            parent_checked
            and not suppressed
            and section.entry_type != "part"
            and section.word_count > 0
        )
        passes_on = parent_checked and not suppressed
        for child in section.children:
            visit(child, passes_on)

    for root in roots:
        visit(root, True)


def assign_ids(roots: list[Section]) -> None:
    """Give every node a stable, document-ordered id used for filenames."""
    counter = 0
    for root in roots:
        for section in root.walk():
            section.id = f"s_{counter:03d}"
            counter += 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def detect(reader, pages: list | None = None) -> Detection:
    """
    Detect a document's structure, trying each strategy in order of trust.

    `pages` may be supplied by callers that already extracted structured text,
    since parsing a large PDF twice is the slowest part of an upload.
    """
    if pages is None:
        pages = read_pages(reader)

    total_pages = len(pages)
    notes: list[str] = []

    if total_pages == 0:
        return Detection(
            method="whole_doc",
            confidence=CONFIDENCE["whole_doc"],
            notes=["No extractable text - this PDF is probably scanned images."],
            sections=[],
            total_pages=0,
        )

    # Contents pages list every title, so they must never be treated as the
    # page where a section starts.
    contents_pages = set(find_contents_pages(reader, pages))

    # 1. Embedded outline.
    entries = entries_from_outline(reader)
    if len(entries) >= 3:
        notes.append(f"Read {len(entries)} bookmark(s) from the PDF outline.")
        roots = build_sections(entries, pages, notes, contents_pages)
        apply_content_stats(roots, pages, notes)
        mark_defaults(roots)
        assign_ids(roots)
        return Detection(
            method="outline",
            confidence=CONFIDENCE["outline"],
            notes=notes,
            sections=roots,
            front_matter_pages=sorted(contents_pages),
            total_pages=total_pages,
        )

    # 2. Contents page.
    entries, detected_contents = entries_from_contents(reader, pages)
    if len(entries) >= 3:
        notes.append(f"Parsed {len(entries)} entr(ies) from the contents page.")
        roots = build_sections(entries, pages, notes, set(detected_contents))
        apply_content_stats(roots, pages, notes)
        mark_defaults(roots)
        assign_ids(roots)
        return Detection(
            method="contents",
            confidence=CONFIDENCE["contents"],
            notes=notes,
            sections=roots,
            front_matter_pages=detected_contents,
            total_pages=total_pages,
        )

    # 3. Font clustering.
    entries = entries_from_fonts(pages)
    if len(entries) >= 3:
        notes.append(f"Clustered {len(entries)} heading(s) by font size and weight.")
        roots = build_sections(entries, pages, notes, contents_pages)
        apply_content_stats(roots, pages, notes)
        mark_defaults(roots)
        assign_ids(roots)
        return Detection(
            method="fonts",
            confidence=CONFIDENCE["fonts"],
            notes=notes,
            sections=roots,
            front_matter_pages=sorted(contents_pages),
            total_pages=total_pages,
        )

    # 4. Give up gracefully.
    notes.append("No chapters or headings detected; using the whole document as one section.")
    whole_text = range_text(pages, 1, total_pages)
    whole = Section(
        id="s_000",
        title="Entire document",
        clean_title="Entire document",
        level=1,
        entry_type="chapter",
        start_page=1,
        end_page=total_pages,
        word_count=count_words(whole_text),
        preview=make_preview(whole_text),
        default_checked=True,
    )
    return Detection(
        method="whole_doc",
        confidence=CONFIDENCE["whole_doc"],
        notes=notes,
        sections=[whole],
        total_pages=total_pages,
    )


def detect_from_path(path: str) -> Detection:
    """Convenience wrapper for scripts."""
    return detect(open_reader(path))
