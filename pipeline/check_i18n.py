"""Extract `t(...)` keys, check dictionary coverage, and report gaps.

The dictionary is keyed by the English sentence, so this is the whole audit:
  1. every key a source file asks for must exist in `vi` (or it silently
     falls back to English);
  2. every key in `vi` must be asked for by some source (or it is dead weight
     and probably means a string was edited on one side only);
  3. the `{placeholders}` in a key must match those in its value, or
     interpolation silently leaves `{n}` on the screen.

A call is read as "every string literal between `t(` and its matching close
paren", so a ternary (`t(on ? "Hide Segments" : "Segments")`) yields both
branches -- each one reaches the screen on its own. Interpolated arguments
after a key must not be string literals or they would be counted as keys too;
`t("...", { ... })` satisfies that.

Not a parser. If a call ever contains a literal that is not a sentence, this
will report it as an untranslated key, which is the harmless direction to be
wrong in.

Usage:
  python -I check_i18n.py            # report and gate
  python -I check_i18n.py --write    # (re)write keys_template.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
SRC = APP / "src"

PLACE = re.compile(r"\{(\w+)\}")
# A dict entry: `"Key": "Value",` / `Key: "Value",`, possibly with the value
# wrapped onto the next line, which `prettier` does to long sentences.
ENTRY = re.compile(
    r"""^[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z_$][\w$]*))"""
    r"""\s*:[ \t]*\n?[ \t]*"((?:[^"\\]|\\.)*)" """.strip(),
    re.MULTILINE,
)
# A literal that is a comparison operand, not a sentence: `panel === "segments"`.
COMPARE_BEFORE = re.compile(r"[=!]==?\s*$")
STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')
# Messages composed with a template literal, e.g. the hooks' `"no model at
# ... — ${detail}"`. The static part is the sentence that reaches `td()`, so it
# counts as "appears in the source" for the indirect-key check; the `${...}`
# substitutions are not sentences and are stripped before the comparison.
TEMPLATE = re.compile(r"`((?:[^`\\]|\\.)*)`")
INTERP = re.compile(r"\$\{[^}]*\}")
# `t(` not preceded by an identifier character, a dot, or `this.`
CALL = re.compile(r"(?<![\w$.])t\(")


def unescape(s: str) -> str:
    return s.replace('\\"', '"').replace("\\\\", "\\").replace("\\n", "\n")


def call_literals(text: str, open_paren: int) -> list[str]:
    """String literals at the top level of the call whose `(` is at `open_paren`.

    Only literals before the first nested bracket are keys. That keeps arguments
    out: `t("Patient {id}", { id: String(p).padStart(5, "0") })` must not report
    `"0"` as a sentence. A ternary at the top level
    (`t(on ? "Hide Segments" : "Segments")`) still yields both branches, which
    is wanted -- each reaches the screen on its own.
    """
    depth = 0
    i = open_paren
    end = len(text)
    quote: str | None = None
    span_end = end
    while i < end:
        c = text[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "/" and text[i : i + 2] == "//":
            nl = text.find("\n", i)
            i = end if nl < 0 else nl
            continue
        if c in "\"'`":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                span_end = i
                break
        elif c in "[{":
            span_end = i
            break
        i += 1
    span = text[open_paren + 1 : span_end]

    out: list[str] = []
    for m in STRING.finditer(span):
        # `panel === "segments"` is the condition of a ternary, not a sentence.
        if COMPARE_BEFORE.search(span[max(0, m.start() - 8) : m.start()]):
            continue
        out.append(unescape(m.group(1)))
    return out


def all_literals() -> set[str]:
    """Every string literal anywhere in `src`, for the indirect-key check.

    Template literals are cut at their first `${}` so `no model at ... — ${msg}`
    contributes the sentence, not the whole concatenation: `td()` splits on the
    same dash and looks that sentence up.
    """
    out: set[str] = set()
    for path in sorted(list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts"))):
        if path.name in ("i18n.tsx", "i18n.vi.ts", "i18n.vi.tsx"):
            continue
        text = path.read_text(encoding="utf-8")
        out.update(unescape(m.group(1)) for m in STRING.finditer(text))
        for m in TEMPLATE.finditer(text):
            head = INTERP.split(m.group(1))[0].rstrip()
            # `"<sentence> — ${detail}"` is the form `td()` understands, and it
            # keys the text before the dash.
            if head.endswith("—"):
                head = head[:-1].rstrip()
            if head:
                out.add(unescape(head))
    return out


def source_keys() -> dict[str, list[str]]:
    """Every `t(...)` literal, mapped to the files that ask for it."""
    found: dict[str, list[str]] = {}
    for path in sorted(list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts"))):
        if path.name in ("i18n.tsx", "i18n.vi.ts", "i18n.vi.tsx"):
            continue
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(APP))
        for m in CALL.finditer(text):
            for key in call_literals(text, m.end() - 1):
                found.setdefault(key, [])
                if rel not in found[key]:
                    found[key].append(rel)
    return found


def read_dict() -> dict[str, str]:
    """The `vi` maps, parsed out of the two dictionary files.

    The chrome and the model card live in separate files so either can be read
    without scrolling the other; the audit treats them as one dictionary.
    """
    entries: dict[str, str] = {}
    for name, marker in (
        ("i18n.vi.ts", "export const VI:"),
        ("i18n.vi.model.ts", "export const VI_MODEL:"),
    ):
        body = (APP / "src" / "lib" / name).read_text(encoding="utf-8").split(marker, 1)[1]
        for quoted, single, bare, value in ENTRY.findall(body):
            if bare in ("export", "const", "return", "default"):
                continue
            key = unescape(quoted or single or bare)
            if key in entries:
                print(f"duplicate key across files: {key!r} (second in {name})")
            entries[key] = unescape(value)
    return entries


def main() -> None:
    # Windows consoles default to cp1252, which cannot encode the "·" and "→"
    # in the very keys this tool exists to report on.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    keys = source_keys()
    if args.write:
        path = APP / "keys_template.json"
        path.write_text(
            json.dumps({k: "" for k in sorted(keys)}, indent=1, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"wrote {path.name} with {len(keys)} keys")
        return

    vi = read_dict()
    missing = [k for k in keys if k not in vi]
    # A key can reach `t()` through a variable: `t(CLASS_LABEL[sym])`,
    # `t(hrv.reason)`. That literal is not inside a `t(` call, so it only counts
    # as used when it also appears somewhere in the source. Without this the
    # report would demand deleting translations that are live.
    literals = all_literals()
    indirect = {k for k in vi if k in literals and k not in keys}
    unused = [k for k in vi if k not in keys and k not in indirect]
    bad_place = [
        (k, v) for k, v in vi.items() if set(PLACE.findall(k)) != set(PLACE.findall(v))
    ]

    if not args.quiet:
        if missing:
            print(f"missing from vi ({len(missing)}):")
            for k in missing:
                print(f"  - {k}   [{', '.join(keys[k])}]")
        if unused:
            print(f"unused in vi ({len(unused)}):")
            for k in unused:
                print(f"  + {k}")
        if bad_place:
            print(f"placeholder mismatch ({len(bad_place)}):")
            for k, v in bad_place:
                print(f"  ! {k}\n    -> {v}")

    total = len(keys)
    done = total - len(missing)
    print(
        f"{done}/{total} keys translated, {len(unused)} unused, "
        f"{len(bad_place)} mismatched, {len(indirect)} reached through a variable"
    )
    if missing or unused or bad_place:
        sys.exit(1)


if __name__ == "__main__":
    main()
