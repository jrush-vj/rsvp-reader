"""
Structure-preserving PDF text extraction.
=========================================

The naive extractor in app.py flattens the whole document: newlines become
spaces, so page boundaries, paragraphs and any notion of a heading are lost
before we ever get a chance to look at them.

This module keeps that information. For every page it returns logical lines,
and for every line it knows the font size, whether the font is bold, and where
the line sits on the page. Headings are overwhelmingly likely to differ from
body text in exactly those attributes, which is what lets detector.py infer a
document's structure with no AI model and no API key.

Nothing here is PDF-library-agnostic on purpose: pypdf is pure Python, so it
installs cleanly on the Windows ARM64 machine this project runs on, whereas
binary-wheel libraries are a real risk there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from io import BytesIO

from pypdf import PdfReader, mult

# Font names that indicate a heavier weight. pypdf hands us the raw
# /BaseFont string, e.g. "/AAAAAA+Garamond-Bold" or "/Arial,Black".
BOLD_MARKERS = (
    "bold",
    "black",
    "heavy",
    "semibold",
    "demibold",
    "extrabold",
    "ultra",
)

_INNER_WS = re.compile(r"\s+")

# A contents-page entry, e.g. "Chapter 3 .......... 45" or "The 1st Law    50".
# Three-or-more spaces counts as a leader because justified contents pages
# often align page numbers with whitespace rather than actual dot leaders.
_TOC_LINE = re.compile(
    r"^(?P<title>.+?)\s*(?:\.{2,}|\u00b7{2,}|_{2,}|\s{3,})\s*(?P<page>\d{1,4})\s*$"
)


def is_bold_font(font_name: str) -> bool:
    """True if a PDF font name looks like a bold/heavy face."""
    low = (font_name or "").lower()
    return any(marker in low for marker in BOLD_MARKERS)


def parse_toc_line(text: str):
    """
    If `text` looks like a contents-page entry, return (title, page_number).

    Returns None otherwise. Titles shorter than two characters are rejected so
    that stray dotted lines don't register as entries.
    """
    stripped = (text or "").strip()
    if len(stripped) < 4:
        return None

    match = _TOC_LINE.match(stripped)
    if not match:
        return None

    title = match.group("title").strip(" .\u00b7-_")
    if len(title) < 2:
        return None

    try:
        page = int(match.group("page"))
    except ValueError:
        return None

    return title, page


@dataclass
class TextRun:
    """A single drawing command's worth of text, with its styling."""

    text: str
    size: float
    bold: bool
    font: str
    x: float
    y: float


@dataclass
class TextLine:
    """Runs sharing a baseline, merged into one logical line of text."""

    text: str
    size: float  # largest font size appearing on the line
    bold: bool  # character-weighted majority weight
    x: float
    y: float
    runs: list[TextRun] = field(default_factory=list)

    @property
    def char_count(self) -> int:
        return len(self.text)

    @property
    def dominant_size(self) -> float:
        """
        The font size actually carrying this line's characters.

        `size` is the largest size anywhere on the line, which is exactly what
        finding a heading wants - a heading is defined by reaching a display
        size. Estimating *body* text wants the opposite, and the two diverge
        sharply on PDFs whose converter emits decorative initials as oversized
        runs: "ANNE THORNDIKE" carries one 37pt 'N' and thirty 8pt characters.
        The largest size reports 37; the character-weighted mode reports 8.
        """
        if not self.runs:
            return self.size

        tally: dict[float, int] = {}
        for run in self.runs:
            visible = run.text.strip()
            if visible:
                key = round(run.size, 1)
                tally[key] = tally.get(key, 0) + len(visible)
        if not tally:
            return self.size
        return max(tally.items(), key=lambda item: item[1])[0]

    @property
    def is_short(self) -> bool:
        return len(self.text) <= 60

    @property
    def ends_like_a_sentence(self) -> bool:
        return self.text.rstrip().endswith((".", ",", ";", ":"))


@dataclass
class PageText:
    """
    One page: its structured lines plus pypdf's own rendering of it.

    Two views of the same page, because they answer different questions.

    `lines` carries structure - font size, weight, position - which is what
    finding headings needs. It is rebuilt from individual draw operations, and
    its spacing is reconstructed from run geometry (see `_line_text`), which
    recovers the spaces pypdf misses and keeps decorative initials joined to
    the word they begin.

    `flat` is pypdf's own `extract_text()`. It is kept as the fallback for a
    page whose runs could not be collected, but it is not preferred: its own
    layout analysis splits every drop cap in the book into a stray letter
    ("O N THE FINAL"), which the reader would show as two words where the page
    has one.
    """

    number: int  # 1-based, matching how humans count pages
    width: float
    height: float
    lines: list[TextLine] = field(default_factory=list)
    flat: str = ""

    @property
    def text(self) -> str:
        """
        The page's prose, preferring the geometry-rebuilt lines.

        Falls back to pypdf's extraction only when no runs were recovered, so
        a page still yields text if the structured pass came up empty.
        """
        joined = "\n".join(line.text for line in self.lines)
        if joined:
            return joined
        return self.flat

    @property
    def char_count(self) -> int:
        return sum(line.char_count for line in self.lines)


def open_reader(source):
    """
    Build a PdfReader from a path or from raw bytes.

    Bytes are wrapped in BytesIO so a Flask upload can be parsed without ever
    touching the filesystem.
    """
    if isinstance(source, (bytes, bytearray)):
        return PdfReader(BytesIO(bytes(source)))
    return PdfReader(source)


def _collect_runs(page) -> list[TextRun]:
    """Pull every text run on a page along with its size/weight/position."""
    runs: list[TextRun] = []

    def visitor(text, cm, tm, font_dict, font_size):
        if not text or not text.strip():
            return

        try:
            matrix = mult(tm, cm)
            x, y = float(matrix[4]), float(matrix[5])
        except Exception:
            # Geometry is a nice-to-have; losing it must not cost us the text.
            x, y = 0.0, 0.0

        font = ""
        if font_dict:
            try:
                font = str(font_dict.get("/BaseFont", "") or "")
            except Exception:
                font = ""

        runs.append(
            TextRun(
                text=text,
                size=float(font_size or 0.0),
                bold=is_bold_font(font),
                font=font,
                x=x,
                y=y,
            )
        )

    try:
        page.extract_text(visitor_text=visitor)
    except Exception:
        # A single unreadable page shouldn't abort the whole document.
        return []

    return runs


# A word break must be at least this fraction of a body glyph's width to be
# believed; smaller gaps are kerning between runs of the same word.
_SPACE_FRACTION = 0.5

# Punctuation that binds to the word before it, so no space is inserted.
_ATTACHING_PUNCTUATION = ",.;:!?)]}\u201d\u2019'\"-"


def _line_text(cluster: list[TextRun]) -> str:
    """
    Rebuild a line's text from its runs, restoring the spaces pypdf dropped.

    pypdf marks spaces it noticed with a tab, but its detection misses some
    boundaries: "THARP" followed by "IS" arrives as two runs with nothing
    between them, and plain concatenation yields "THARPIS". The gap between
    those runs is an ordinary inter-word space, and the geometry still records
    it, so a lost separator is recovered from the x positions instead of being
    guessed from the letters.

    The complication is decorative initials. A chapter opens with an oversized
    first letter drawn as its own run - "T" at 37pt followed by "WYLA" at 8pt -
    and the gap after a big glyph is *wider* than a space, because the glyph
    itself is wider. Read as a break, that splits every first word in the book
    ("T WYLA"). So an oversized single glyph never ends a word, however wide
    the gap after it looks.
    """
    if not cluster:
        return ""

    parts: list[str] = []
    previous: TextRun | None = None

    for run in cluster:
        cleaned = _INNER_WS.sub(" ", run.text.replace("\t", " ")).strip()
        if not cleaned:
            continue

        if previous is not None:
            # pypdf's own tab, or a leading space it kept, is a space it saw.
            marked = run.text[:1] in ("\t", " ")

            sizes = [size for size in (previous.size, run.size) if size > 0]
            glyph = (min(sizes) * _SPACE_FRACTION) if sizes else 0.0
            wide = bool(glyph) and (run.x - previous.x) >= glyph

            def single(text: str) -> bool:
                stripped = text.strip()
                return len(stripped) == 1 and stripped.isalnum()

            # An oversized single glyph begins a word; the run that follows it
            # merely finishes that word, so no separator goes between them. The
            # reverse is not true: a glyph following ordinary text is a new word
            # even when it is drawn large. That is what separates the second
            # letter of a drop cap ("TWYLA" | "T" | "HARP") from the first.
            #
            # A drop cap is occasionally split into *two* glyphs at different
            # sizes instead - "A" at 20pt then "N" at 37pt then "NE" - which no
            # amount of column arithmetic can distinguish from a real space,
            # since the second glyph starts further right than the first ends.
            # Two abutting single letters drawn at markedly different sizes are
            # one initial, not two words.
            decorative = (
                single(previous.text)
                and previous.size >= run.size * 1.5
            ) or (
                single(previous.text)
                and single(run.text)
                and (run.size >= previous.size * 1.5 or previous.size >= run.size * 1.5)
            )

            attaches = cleaned[0] in _ATTACHING_PUNCTUATION
            hyphen = previous.text.strip().strip("\t ") == "-"

            if (marked or wide) and not decorative and not attaches and not hyphen:
                parts.append(" ")

        parts.append(cleaned)
        previous = run

    return "".join(parts).strip()


def _group_lines(runs: list[TextRun], y_tolerance: float = 2.5) -> list[TextLine]:
    """
    Cluster runs into logical lines by baseline, then order them top-to-bottom.

    PDF's y axis points up, so sorting by descending y walks the page in
    reading order. Comparing against the cluster's first baseline (rather than
    the previous run's) stops a long line from drifting into its neighbour.
    """
    if not runs:
        return []

    ordered = sorted(runs, key=lambda r: (-r.y, r.x))
    clusters: list[list[TextRun]] = [[ordered[0]]]

    for run in ordered[1:]:
        if abs(run.y - clusters[-1][0].y) <= y_tolerance:
            clusters[-1].append(run)
        else:
            clusters.append([run])

    lines: list[TextLine] = []
    for cluster in clusters:
        cluster.sort(key=lambda r: r.x)

        # pypdf marks some -- but not all -- word boundaries with a tab, and
        # our own run concatenation sees neither. Rebuild the line from the
        # runs' geometry so dropped spaces are recovered and decorative initials
        # are not mistaken for word breaks.
        text = _line_text(cluster)
        if not text:
            continue

        sizes = [run.size for run in cluster if run.size > 0]
        bold_chars = sum(len(run.text) for run in cluster if run.bold)
        total_chars = sum(len(run.text) for run in cluster) or 1

        lines.append(
            TextLine(
                text=text,
                size=max(sizes) if sizes else 0.0,
                bold=bold_chars >= total_chars * 0.6,
                x=min(run.x for run in cluster),
                y=cluster[0].y,
                runs=cluster,
            )
        )

    return lines


def build_page_lookup(reader) -> tuple[dict, dict]:
    """
    Build fast lookup tables from indirect references to 1-based page numbers.

    Needed because a destination is often an explicit array like
    `[pageRef /XYZ left top zoom]`, and pypdf's
    `get_destination_page_number` only understands Destination objects and
    named destinations - handed an array it raises. Link annotations in real
    contents pages are usually arrays, so without this the whole
    contents-page strategy silently returns nothing.

    Two keys are returned because indirect references are hashable but are
    compared by object, so an equal-but-distinct reference from a different
    part of the document may not match. A plain (idnum, generation) tuple
    always will.
    """
    by_ref: dict = {}
    by_pair: dict[tuple[int, int], int] = {}

    for index, page in enumerate(reader.pages):
        try:
            reference = page.indirect_reference
        except Exception:
            continue

        if reference is None:
            continue

        by_ref[reference] = index + 1

        idnum = getattr(reference, "idnum", None)
        if idnum is not None:
            by_pair[(idnum, getattr(reference, "generation", 0))] = index + 1

    return by_ref, by_pair


def resolve_page(reader, dest, by_ref: dict | None = None, by_pair: dict | None = None) -> int | None:
    """
    Resolve a PDF destination of any shape to a 1-based page number.

    Handles the three forms seen in practice: a `Destination` object (what
    pypdf produces from an outline), a string naming an entry in the document's
    named destinations, and an explicit array whose first element is a page
    reference. Returns None rather than raising, since a single broken link
    should not abort detection.
    """
    if dest is None:
        return None

    if by_ref is None or by_pair is None:
        by_ref, by_pair = build_page_lookup(reader)

    # Named destination, e.g. "/chapter_3".
    if isinstance(dest, str):
        try:
            named = reader.named_destinations.get(dest)
        except Exception:
            named = None
        if named is None:
            return None
        return resolve_page(reader, named, by_ref, by_pair)

    # pypdf Destination object.
    try:
        resolved = reader.get_destination_page_number(dest)
        if resolved is not None:
            return resolved + 1
    except Exception:
        pass

    # Explicit array: [pageRef /XYZ left top zoom].
    try:
        first = dest[0]
    except Exception:
        return None

    if isinstance(first, int):
        # A direct page index rather than a reference.
        return first + 1

    try:
        page_object = first.get_object()
    except Exception:
        page_object = None

    for reference in (first, getattr(page_object, "indirect_reference", None)):
        if reference is None:
            continue
        if reference in by_ref:
            return by_ref[reference]
        pair = (getattr(reference, "idnum", None), getattr(reference, "generation", 0))
        if pair[0] is not None and pair in by_pair:
            return by_pair[pair]

    # Last resort: pypdf can number a page object we already hold.
    if page_object is not None:
        try:
            return reader.get_page_number(page_object) + 1
        except Exception:
            pass

    return None


def read_pages(reader, max_pages: int | None = None) -> list[PageText]:
    """
    Extract every page (or the first `max_pages`) as structured text.

    Pages that fail to parse come back empty rather than raising, because a
    library book with one bad page is still worth reading.
    """
    pages: list[PageText] = []
    total = len(reader.pages)

    for index in range(total):
        if max_pages is not None and index >= max_pages:
            break

        try:
            page = reader.pages[index]
        except Exception:
            pages.append(PageText(number=index + 1, width=0.0, height=0.0))
            continue

        try:
            box = page.mediabox
            width, height = float(box.width), float(box.height)
        except Exception:
            width, height = 0.0, 0.0

        try:
            flat = page.extract_text() or ""
        except Exception:
            # A page whose prose cannot be extracted is still worth keeping for
            # its structure; the reader simply skips its words.
            flat = ""

        pages.append(
            PageText(
                number=index + 1,
                width=width,
                height=height,
                lines=_group_lines(_collect_runs(page)),
                flat=flat,
            )
        )

    return pages


def read_outline(reader) -> list[dict]:
    """
    Flatten the PDF's bookmark outline into a list of
    {"title", "page", "level"} dicts, where level 1 is top-most.

    Returns an empty list when the document has no usable outline, which is
    common for consumer PDFs and is exactly why detector.py needs fallbacks.
    """

    def walk(node, level: int, out: list[dict]) -> None:
        for entry in node:
            if isinstance(entry, list):
                walk(entry, level + 1, out)
                continue

            page_number = None
            try:
                resolved = reader.get_destination_page_number(entry)
                if resolved is not None:
                    page_number = resolved + 1  # PDF pages are 0-based
            except Exception:
                page_number = None

            out.append(
                {
                    "title": str(getattr(entry, "title", "") or "").strip(),
                    "page": page_number,
                    "level": level,
                }
            )

    try:
        outline = reader.outline
    except Exception:
        return []

    items: list[dict] = []
    try:
        walk(outline, 1, items)
    except Exception:
        return items
    return items


def has_outline_key(reader) -> bool:
    """
    Whether the raw /Outlines key exists in the document catalog.

    This is a stronger signal than read_outline() returning nothing: it
    distinguishes "the PDF has no bookmarks" from "the bookmarks could not be
    parsed".
    """
    try:
        return "/Outlines" in reader.root_object
    except Exception:
        return False


def find_toc_lines(pages: list[PageText], page_limit: int = 25) -> list[dict]:
    """
    Scan the opening pages for contents-page entries.

    Each result is {"page", "title", "target_page"}. The tally of hits per
    physical page tells detector.py which page the contents actually sits on,
    so it can be marked as skipped front matter.
    """
    found: list[dict] = []
    for page in pages[:page_limit]:
        for line in page.lines:
            parsed = parse_toc_line(line.text)
            if parsed:
                title, target = parsed
                found.append({"page": page.number, "title": title, "target_page": target})
    return found
