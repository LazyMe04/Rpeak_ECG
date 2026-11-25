"""Find user-visible English that never reaches t().

Not a proof of coverage: it looks for JSX text nodes and literal attributes that
start with a capital letter and are not already wrapped. Anything it prints is
worth a look; anything it misses is caught by reading the page.

Usage: python -I find_untranslated.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
SRC = APP / "src"
SKIP = {"i18n.tsx", "i18n.vi.ts", "i18n.vi.model.ts"}

# JSX text: a line that is plain words, indented, and ends with punctuation or
# a closing tag. Excludes code by requiring a capital letter or a quote at the
# start and no `{`, `=` or `(` before the text.
TEXT = re.compile(r"^\s{6,}([A-Z“\"][^{}<>=()]*[a-z.,;:!?”\"—%)])\s*$")
ATTR = re.compile(r'(title|aria-label|placeholder|alt)="([^"]{4,})"')
# Generated op strings in ModelPage are English at runtime, translated at the
# call site; they are not human-written prose, so they are skipped by file.
ALLOW_ATTR = {
    # Section titles: `Section` renders `t(title)` itself.
    "title",
}


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    total = 0
    for path in sorted(SRC.rglob("*.tsx")):
        if path.name in SKIP:
            continue
        rel = path.relative_to(APP).as_posix()
        lines = path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines, 1):
            m = TEXT.match(line)
            if m:
                text = m.group(1).strip()
                # Skip comments and obvious code.
                if text.startswith("//") or text.startswith("*"):
                    continue
                print(f"{rel}:{i}: {text[:90]}")
                total += 1
            for m in ATTR.finditer(line):
                if m.group(1) in ALLOW_ATTR:
                    continue
                print(f"{rel}:{i}: @{m.group(1)}=\"{m.group(2)[:80]}\"")
                total += 1
    print(f"\n{total} candidate(s)")


if __name__ == "__main__":
    main()
