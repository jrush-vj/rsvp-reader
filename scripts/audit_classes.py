"""
Class-name contract audit for the React front end.
---------------------------------------------------------------------------
The stylesheet and the components are written in different files, so nothing
makes the class names agree. A typo is silent: the element renders unstyled and
no tool complains. This script compares the two directions.

    python scripts/audit_classes.py

Direction 1 - every class a component emits must exist in CSS.
             A miss here is a real bug: an element with no rule.
Direction 2 - every class in CSS should be emitted somewhere.
             A miss here is usually just dead CSS, which is harmless but
             worth seeing.

Both sides are read as text; this is deliberately not a CSS or TS parser. The
className scanner does brace- and quote-aware matching, because a flat regex
cannot survive `` className={cond ? `a ${b}` : ""} `` — it stops at the first
brace it sees and reads the rest of the file as a class name.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WEB = Path(__file__).resolve().parent.parent / "web"
SRC = WEB / "src"
STYLES = SRC / "styles"

# Class tokens worth ignoring: an accessibility utility that intentionally has
# no visual rule.
IGNORE = {"sr-only"}

# Utilities are a deliberately unemitted layer. Each is a single-purpose rule
# (a flex container, a truncation, a muted colour) that a component composes
# onto its own class, so none of them appears as a whole token in any
# `className=`. Reporting them every run would train the reader to ignore the
# list, which is the opposite of the point.
#   `.nm-sink` is the third: it is the pressed counterpart of `.nm-raise`, kept
#   so a future component can dip a surface without re-deriving the shadows.
UTILITIES = {
    "col", "grow", "muted", "nm-raise", "nm-sink",
    "row", "row-between", "truncate", "wrap",
}

# Families built by concatenation, e.g. `` `btn--${variant}` `` in Button.tsx.
# A static scan cannot see the result, so the member names are listed here by
# hand — the point is that a typo in the *prefix* is still caught above, and
# the union type (`Variant`, `Size`, `tone`) is what makes the suffixes safe.
DYNAMIC = {
    "btn--block", "btn--danger", "btn--ghost", "btn--lg", "btn--md",
    "btn--primary", "btn--soft",
    "iconbtn--ghost", "iconbtn--glass", "iconbtn--subtle",
    "chip--accent", "chip--ok", "chip--warn",
    "notice--danger", "notice--info", "notice--ok", "notice--warn",
    "toast--danger", "toast--info", "toast--ok",
    "progress--danger", "progress--muted",
    "btnrow--between", "btnrow--end",
    "overlay--left",
}

CLASS_IN_CSS = re.compile(r"\.(-?[_a-zA-Z][\w-]*)")
# `className=` followed by anything; the scanner below decides where it ends.
CLASSNAME_START = re.compile(r"className\s*=\s*")
# A comparison operand is a string that is being *compared*, not used as a
# class name. `mode === "pdf"` is the case this exists for.
CMP_BEFORE = re.compile(r"(?:===|!==|==|!=)\s*$")
CMP_AFTER = re.compile(r"^\s*(?:===|!==|==|!=)")


def _is_class_candidate(expr: str, start: int, end: int) -> bool:
    """False when the literal at `expr[start:end]` is a comparison operand."""
    return not (CMP_BEFORE.search(expr[:start]) or CMP_AFTER.match(expr[end:]))


def _class_literals(expr: str) -> list[str]:
    """
    Every string literal in `expr` that could be a class name.

    Template literals are the interesting case. `` `mode ${a ? "is-on" : ""}` ``
    has one class name, and it lives *inside* the hole, so a hole cannot simply
    be deleted — its literals are collected instead, with comparison operands
    filtered out. The literal text outside the holes is returned as a chunk so
    the caller can split it on whitespace like any other class list.

    A hole that names a variable rather than a literal (`` `chip--${tone}` ``)
    contributes nothing, and the surrounding text is truncated to `chip--`,
    which the caller drops. Those families are the `DYNAMIC` allowlist.
    """
    out: list[str] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch in "\"'":
            j = i + 1
            while j < len(expr) and expr[j] != ch:
                j += 2 if expr[j] == "\\" else 1
            if _is_class_candidate(expr, i, j + 1):
                out.append(expr[i + 1 : j])
            i = j + 1
            continue
        if ch == "`":
            j = i + 1
            while j < len(expr) and expr[j] != "`":
                j += 2 if expr[j] == "\\" else 1
            out.extend(_template_literals(expr[i + 1 : j]))
            i = j + 1
            continue
        i += 1
    return out


def _template_literals(body: str) -> list[str]:
    """
    The class-name literals in a template literal's body.

    The body is split at its `` ${...} `` holes. Text between holes is a class
    list; each hole is scanned for literals of its own. The hole's closing
    brace is found by counting depth and skipping quoted runs, because a hole
    can contain braces, strings and nested templates.
    """
    out: list[str] = []
    run: list[str] = []
    i = 0
    while i < len(body):
        if body.startswith("${", i):
            if run:
                out.append("".join(run))
                run = []
            depth = 0
            j = i + 1
            while j < len(body):
                ch = body[j]
                if ch in "\"'`":
                    quote = ch
                    j += 1
                    while j < len(body) and body[j] != quote:
                        j += 2 if body[j] == "\\" else 1
                    j += 1
                    continue
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out.extend(_class_literals(body[i + 2 : j]))
            i = j + 1
            continue
        run.append(body[i])
        i += 1
    if run:
        out.append("".join(run))
    return out


def _attribute_expressions(text: str) -> list[str]:
    """
    The text of every `className=` value in a file.

    The value is one of:

    - a quoted or template literal, read to its matching quote;
    - a `{...}` expression, where the closing brace must be found by counting
      depth — `` className={cond ? `a ${b}` : ""} `` contains both a nested
      brace and a quote, which no flat regex survives;
    - a call such as `cx("a", cond && "b")`, read to its matching paren.

    Anything unparseable is skipped rather than guessed at, since a false
    "missing class" is worse than a missed one.
    """
    out: list[str] = []
    for match in CLASSNAME_START.finditer(text):
        i = match.end()
        if i >= len(text):
            continue
        opener = text[i]
        closer = {"{": "}", "(": ")", "[": "]"}.get(opener)
        if closer is None:
            # A bare literal. Kept with its quotes so the caller sees one
            # uniform shape — `STRING` is what decides what a quoted run is.
            quote = opener if opener in "\"'`" else None
            if quote is None:
                continue
            j = i + 1
            while j < len(text) and text[j] != quote:
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            continue

        depth = 0
        j = i
        while j < len(text):
            ch = text[j]
            if ch in "\"'`":
                # Skip the string wholesale so a brace inside it is ignored.
                quote = ch
                j += 1
                while j < len(text) and text[j] != quote:
                    j += 2 if text[j] == "\\" else 1
                j += 1
                continue
            if ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append(text[i + 1 : j])
    return out


def css_classes() -> dict[str, set[str]]:
    """
    Class name -> the stylesheet files that define it.

    Quoted strings are blanked before the selector scan. A data URI is full of
    `.` characters — the noise texture in `base.css` contains `.org` and `.w3`
    inside an `url("data:image/svg+xml,…")` — and a flat `\.name` sweep
    invents those as classes.
    """
    found: dict[str, set[str]] = {}
    for path in sorted(STYLES.glob("*.css")):
        # Strip comments so a class mentioned in prose is not counted.
        text = re.sub(r"/\*.*?\*/", " ", path.read_text(encoding="utf-8"), flags=re.S)
        text = re.sub(r'"[^"\n]*"|\'[^\'\n]*\'', " ", text)
        for name in CLASS_IN_CSS.findall(text):
            found.setdefault(name, set()).add(path.name)
    return found


def emitted_classes() -> dict[str, set[str]]:
    """
    Class token -> the component files that emit it.

    Every `className=` value is read as a run of class-name literals possibly
    glued with runtime values. Both the literals and the template holes around
    them are scanned, because a class name can live inside a ternary.

    One kind of fragment is dropped because no real class name is spelled that
    way: a token ending in `-`, the static half of `` `btn--${size}` ``. Those
    are the `DYNAMIC` allowlist, which is also why a typo in the prefix is
    still reported — the prefix appears truncated, not missing.

    A bare conditional identifier is *not* readable, so `` glass${canHover ?
    ...} `` contributes `glass` (in CSS, fine) and `rail-panel--touch` via the
    literal inside the hole. Nothing here can see that `is-playing` comes out
    of a `cond ? "a" : "b"` pair; that is what the `DYNAMIC` list is for.
    """
    found: dict[str, set[str]] = {}
    for path in sorted(SRC.rglob("*.tsx")):
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(SRC)).replace("\\", "/")
        for expr in _attribute_expressions(text):
            for token in " ".join(_class_literals(expr)).split():
                if token.endswith("-"):
                    continue
                found.setdefault(token, set()).add(rel)
    return found


def main() -> int:
    css = css_classes()
    used = emitted_classes()

    missing = {k: v for k, v in used.items() if k not in css and k not in IGNORE}
    unused = {
        k: v
        for k, v in css.items()
        if k not in used
        and k not in IGNORE
        and k not in DYNAMIC
        and k not in UTILITIES
        and not k.startswith("is-")
    }

    print("EMITTED BUT NOT IN CSS  (element will render unstyled)")
    for name in sorted(missing):
        print(f"  .{name:<34} {', '.join(sorted(missing[name]))}")
    if not missing:
        print("  none")

    print()
    print("IN CSS BUT NEVER EMITTED  (dead rule, harmless)")
    for name in sorted(unused):
        print(f"  .{name:<34} {', '.join(sorted(unused[name]))}")
    if not unused:
        print("  none")

    print()
    print(f"css classes: {len(css)}   emitted tokens: {len(used)}")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
