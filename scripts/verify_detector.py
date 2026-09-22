"""
Assert the properties detection must hold, instead of eyeballing output.

The interesting failure mode is silent: if two readable sections claim the same
pages, the reader shows that text twice and nothing looks obviously wrong. So
overlap among readable leaves is checked explicitly, along with the other
invariants the rest of the pipeline relies on.
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import detector
from pdftext import open_reader, read_pages

PDF = sys.argv[1] if len(sys.argv) > 1 else "books/a8cacf49/book.pdf"

reader = open_reader(PDF)
pages = read_pages(reader)
total_pages = len(pages)

failures: list[str] = []
warnings: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def check_detection(label: str, result: detector.Detection) -> None:
    prefix = f"[{label}] "
    readable = result.readable_sections

    check(len(result.sections) > 0, prefix + "no sections produced")
    check(len(readable) > 0, prefix + "no readable sections produced")

    # Ids must be unique, because they become filenames on disk.
    ids = [s.id for root in result.sections for s in root.walk()]
    check(len(ids) == len(set(ids)), prefix + f"duplicate section ids ({len(ids)} vs {len(set(ids))})")

    for section in readable:
        check(section.word_count > 0, prefix + f"readable section '{section.title}' has 0 words")
        check(bool(section.preview), prefix + f"readable section '{section.title}' has no preview")
        check(
            1 <= section.start_page <= total_pages,
            prefix + f"'{section.title}' start_page {section.start_page} out of range",
        )
        check(
            1 <= section.end_page <= total_pages,
            prefix + f"'{section.title}' end_page {section.end_page} out of range",
        )
        check(
            section.start_page <= section.end_page,
            prefix + f"'{section.title}' has inverted range "
            f"{section.start_page}-{section.end_page}",
        )
        # The whole-document fallback is one section spanning the entire book by
        # definition, so a wide range is only suspicious for real detections.
        if result.method != "whole_doc":
            check(
                section.end_page - section.start_page < 200,
                prefix + f"'{section.title}' spans an implausible page range",
            )

    # Pages must not be claimed twice by readable leaves, or the reader would
    # display the same text more than once.
    claims: dict[int, str] = {}
    for section in readable:
        for page_number in range(section.start_page, section.end_page + 1):
            if page_number in claims:
                check(
                    False,
                    prefix + f"page {page_number} claimed by both "
                    f"'{claims[page_number]}' and '{section.title}'",
                )
            else:
                claims[page_number] = section.title

    # Pages must advance through the document.
    ordered = sorted(readable, key=lambda s: s.start_page)
    for earlier, later in zip(ordered, ordered[1:]):
        check(
            later.start_page >= earlier.start_page,
            prefix + f"'{later.title}' starts before '{earlier.title}'",
        )

    computed = sum(s.word_count for s in readable)
    if result.method in ("outline", "contents"):
        # Whole-document word count is the ceiling; sections may legitimately
        # cover less because front and back matter are excluded.
        whole = detector.count_words(detector.range_text(pages, 1, total_pages))
        check(
            computed <= whole,
            prefix + f"section words {computed} exceed whole-document words {whole}",
        )
        ratio = computed / whole if whole else 0
        if ratio < 0.5:
            warnings.append(prefix + f"only {ratio:.0%} of document words are in readable sections")
        print(f"{prefix}coverage {computed}/{whole} words ({ratio:.0%})")

    checked = [s for s in readable if s.default_checked]
    check(len(checked) > 0, prefix + "nothing is checked by default")
    print(f"{prefix}{len(result.sections)} top-level, {len(readable)} readable, {len(checked)} checked")


print(f"PDF: {PDF}  ({total_pages} pages)\n")

check_detection("outline", detector.detect(reader, pages))

real_outline = detector.entries_from_outline
real_contents = detector.entries_from_contents
real_fonts = detector.entries_from_fonts

detector.entries_from_outline = lambda _reader: []
check_detection("contents", detector.detect(reader, pages))

detector.entries_from_contents = lambda _reader, _pages: ([], [])
check_detection("fonts", detector.detect(reader, pages))

detector.entries_from_fonts = lambda _pages: []
check_detection("whole_doc", detector.detect(reader, pages))

detector.entries_from_outline = real_outline
detector.entries_from_contents = real_contents
detector.entries_from_fonts = real_fonts

print()
if warnings:
    print("WARNINGS")
    for warning in warnings:
        print("  -", warning)

if failures:
    print("FAILURES")
    for failure in failures:
        print("  -", failure)
    print(f"\n{len(failures)} check(s) failed.")
    raise SystemExit(1)

print(f"All checks passed ({len(warnings)} warning(s)).")
