#!/usr/bin/env python3
"""[SAATHUM-BRAND-CENTRAL-GUARD-1 2026-09-30] Block NEW hand-typed brand names/domains.

The public brand lives in Specs/brand.json (see CLAUDE.md "BRAND NAME + DOMAIN
COME FROM ONE FILE"). Code must read it from BRAND / Brand / {brand} tokens.
This check counts literal brand spellings per file and fails when any file has
MORE than tool/brand_literals_baseline.json records. The baseline is leftover
debt (comments, markdown help articles, identifiers that happen to match), not
an allowlist: when it fails, USE BRAND — do not grow the baseline.

    python3 scripts/check_brand_literals.py              # check (CI)
    python3 scripts/check_brand_literals.py --list       # show every hit
    python3 scripts/check_brand_literals.py --update-baseline   # ONLY after a
        deliberate cleanup that REDUCES counts, or a pure file move

Plain python3, no deps.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tool" / "brand_literals_baseline.json"
BRAND_JSON = ROOT / "Specs" / "brand.json"

SCAN_DIRS = ["web/src", "worker/src", "consumers/src", "app/lib", "shared/i18n/source"]
EXTS = {".ts", ".tsx", ".js", ".mjs", ".astro", ".dart", ".json", ".md", ".mdx", ".html"}
EXCLUDE = [
    re.compile(r"(^|/)brand\.(ts|dart)$"),          # generated mirrors
    re.compile(r"\.test\.|/test/|/__tests__/"),     # test fixtures
    re.compile(r"publicImageManifest\.json$"),      # file paths only
]


def patterns() -> list[re.Pattern]:
    b = json.loads(BRAND_JSON.read_text(encoding="utf-8"))
    words = {b["name"], b["nameUpper"], b["nameHindi"], b["nameCompact"]}
    pats = [re.compile(r"(?<![\w-])" + re.escape(w) + r"(?![\w-])") for w in sorted(words)]
    pats.append(re.compile(re.escape(b["domain"]), re.I))   # covers hosts, URLs, mailboxes
    return pats


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", *SCAN_DIRS], cwd=ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.splitlines()
            if Path(f).suffix in EXTS and not any(p.search(f) for p in EXCLUDE)]


def scan() -> tuple[dict[str, int], dict[str, list[str]]]:
    pats = patterns()
    counts: dict[str, int] = {}
    hits: dict[str, list[str]] = {}
    for f in tracked_files():
        try:
            text = (ROOT / f).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        n = 0
        for i, line in enumerate(text.splitlines(), 1):
            k = sum(len(p.findall(line)) for p in pats)
            if k:
                n += k
                hits.setdefault(f, []).append(f"{i}: {line.strip()[:140]}")
        if n:
            counts[f] = n
    return counts, hits


def main() -> int:
    args = sys.argv[1:]
    counts, hits = scan()
    if "--update-baseline" in args:
        BASELINE.write_text(json.dumps(dict(sorted(counts.items())), indent=2) + "\n", encoding="utf-8")
        print(f"brand-literals: baseline written ({sum(counts.values())} in {len(counts)} files)")
        return 0
    base = json.loads(BASELINE.read_text(encoding="utf-8")) if BASELINE.exists() else {}
    grown = {f: (base.get(f, 0), n) for f, n in counts.items() if n > base.get(f, 0)}
    if "--list" in args:
        for f in sorted(hits):
            for h in hits[f]:
                print(f"{f}:{h}")
    if grown:
        print("BRAND-LITERALS FAILED — new hand-typed brand name/domain. Use BRAND (web/worker/"
              "consumers), Brand (Flutter) or a {brand} token (i18n) instead. See CLAUDE.md.")
        for f, (was, now) in sorted(grown.items()):
            print(f"  {f}: {was} -> {now}")
            for h in hits.get(f, [])[:6]:
                print(f"      {h}")
        return 1
    shrunk = sum(1 for f, n in base.items() if counts.get(f, 0) < n)
    note = f" ({shrunk} file(s) now below baseline — `--update-baseline` will tidy it)" if shrunk else ""
    print(f"brand-literals: OK — {sum(counts.values())} leftover literal(s) in {len(counts)} file(s), none new{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
