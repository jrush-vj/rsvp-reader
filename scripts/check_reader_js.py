"""Extract the inline <script> from rsvp_reader.html so it can be parsed.

The reader is a single hand-written HTML file with one IIFE in it. A syntax
error there is invisible until the page is opened, and the failure mode is a
blank screen, so it is worth extracting the script and handing it to a real
JavaScript parser instead of eyeballing it.

Writes the extracted source to scripts/_reader_script.js and reports where the
block came from, then the caller runs `node --check` on it.
"""

import io
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "rsvp_reader.html"
OUT = ROOT / "scripts" / "_reader_script.js"


def main() -> int:
    html = HTML.read_text(encoding="utf-8")

    # Only the last <script> block matters; there is exactly one inline block
    # and no external scripts, so taking all of them and concatenating would
    # hide a duplicate rather than reveal it.
    blocks = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", html, re.S | re.I)
    if not blocks:
        print("FAIL: no <script> block found in rsvp_reader.html")
        return 1

    print(f"found {len(blocks)} inline <script> block(s)")

    lines = html.splitlines()
    start = next(
        (n for n, line in enumerate(lines, 1) if "<script" in line.lower()), 0
    )

    src = "\n".join(blocks)
    OUT.write_text(src, encoding="utf-8")

    body = src.strip()
    print(f"extracted {len(src):,} chars starting at HTML line {start + 1}")
    print(f"wrote {OUT.relative_to(ROOT)}")

    # Cheap structural sanity checks that a parser will not catch.
    if not body.startswith("(function"):
        print("WARN: block does not start with an IIFE")
    if not body.rstrip().endswith("})();"):
        print("WARN: block does not end with '})();'")
    strict = '"use strict"' in src
    print("declares 'use strict':", strict)

    id_count = len(re.findall(r"\bid\s*=\s*\"([^\"]+)\"", html))
    get_count = len(re.findall(r"getElementById\(", src))
    print(f"html has {id_count} id= attributes; script calls getElementById {get_count} time(s)")

    # A getElementById for an id that is not in the markup returns null, and
    # the first property access on it throws at load time - a blank reader.
    # Cross-checking the two lists catches that without opening a browser.
    html_ids = set(re.findall(r"\bid\s*=\s*\"([^\"]+)\"", html))
    wanted = re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", src)
    missing = sorted({w for w in wanted if w not in html_ids})
    unused = sorted(html_ids - set(wanted))

    if missing:
        print(f"FAIL: {len(missing)} id(s) looked up but absent from the markup:")
        for name in missing:
            print("  -", name)
        return 1
    print(f"ok: all {len(set(wanted))} looked-up id(s) exist in the markup")

    # Ids the script never fetches are not automatically wrong (the overlay bar
    # is styled but never read, for instance), so this is informational only.
    if unused:
        print(f"note: {len(unused)} id(s) in markup never fetched: {', '.join(unused)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
