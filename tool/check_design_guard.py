#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""[UI-DS-GUARD-1] Design-system drift guard for app/lib.

WHY THIS EXISTS
---------------
Over 2026-08-04/05 the app was migrated off its legacy design system: ~1,600
legacy design-system references, ~1,900 Material icons and ~220 stray radii were
folded onto the token files (`app/lib/core/ui/avatok_dark.dart` = `AD.*`,
`messenger_theme.dart` = `Msg.*`/`MsgColors.*`, `bubble_theme.dart`
= `BubbleTheme`). NOTHING stopped the next new screen re-introducing all of it.
This script is that "nothing" made into a check.

It runs on plain `python3` with NO pub/pip dependencies and NO Flutter
toolchain, because this repo has no local build toolchain (CLAUDE.md) and CI
must be able to run it in a bare ubuntu container in ~1 second.

THE TWO CHECKS
--------------
`--check colours`  Raw colour literals anywhere under `app/lib` EXCEPT the
                   sanctioned token files. Flags:
                     * `Color(0x…)`            -> use an `AD.*` token
                     * `Color.fromARGB/fromRGBO(…)`
                     * `Colors.<name>`         (see POLICY below)
                     * a bare `0xAARRGGBB` int used as a colour
                     * a `'#rrggbb'` hex colour string
`--check icons`    Bare Material `Icons.<name>` under `app/lib/features/**` and
                   `app/lib/shell/**`. The app standardised on Phosphor:
                   `PhosphorIcons.<name>(PhosphorIconsStyle.regular)`.

  !! THE FALSE POSITIVE THAT HAS ALREADY BITTEN SOMEONE HERE !!
  A naive `grep -n 'Icons\\.'` ALSO matches `PhosphorIcons.` and reports ~1,855
  hits in a tree that has ZERO real violations. The regex below uses an explicit
  negative lookbehind `(?<![A-Za-z0-9_$])Icons\\.` so `PhosphorIcons.`,
  `CupertinoIcons.`, `MyIcons.` etc. can never match. If this check ever reports
  hundreds of hits, someone has broken that lookbehind — fix the regex, do NOT
  regenerate the baseline.

POLICY: WHICH `Colors.*` ARE ALLOWED  (configurable, not absolute)
-----------------------------------------------------------------
`Colors.transparent`, `Colors.white` and `Colors.black` are pure sentinel
values, not brand colours: `transparent` is "no fill", and white/black are the
legitimate ink you put on a known fill (a white glyph on the orange
`AD.primaryBadge` pill; black text on `AD.inputField`). They carry no design
decision that a token could hold, and there are ~465 of them in-tree. Flagging
them would be 465 units of noise for zero design drift, and a check that shouts
on day one gets deleted.

Every OTHER `Colors.*` — `Colors.white70`, `Colors.black54`, `Colors.amber`,
`Colors.greenAccent`, the whole Material palette — IS a design decision made
outside the token files, and is flagged. `Colors.white70` in particular is
almost always meant to be `AD.textSecondary`.

The allowlist is a CLI knob, not a hard-coded rule:
    --material-allow transparent,white,black     (default)
    --material-allow transparent                 (tighter)
    --strict-material                            (allow nothing)

WHAT IS *NOT* FLAGGED (and why)
-------------------------------
* Comments. The tree is full of *good* comments like
  `static const _dot = AD.unreadAccent; // 0xFFF2A65A — the orange dot`, which
  document which token a hex used to be. A Dart-aware masker (`mask_comments`)
  blanks `//` and nested `/* */` while correctly stepping over strings, so a
  URL like `'https://x'` is never mistaken for a comment.
* Generated files (`*.g.dart`, `*.freezed.dart`, `*.gen.dart`).
* The sanctioned token files themselves — that IS where the hex lives.
* Known non-colour hex constants (FNV hash primes, bit masks) — see
  NON_COLOUR_HEX.
* Any line carrying an inline escape hatch (see below).

BASELINE, NOT BIG BANG
----------------------
Both checks compare against `tool/design_guard_baseline.json`, which records the
violations that existed when the guard was introduced. The check fails ONLY on
violations that are NOT in the baseline. So the guard is green on day one and
only ever fires on NEW drift.

The baseline is keyed `path -> token -> count`, deliberately NOT `path:line`.
Line numbers churn on every edit (a 12k-line file was being split while this was
written); a line-keyed baseline would fire spuriously on unrelated refactors.
Counts are line-number-proof: it only fires when a file gains an occurrence.

    python3 tool/check_design_guard.py --check all
    python3 tool/check_design_guard.py --check colours --list
    python3 tool/check_design_guard.py --check colours --update-baseline

    --update-baseline rewrites ONLY that check's section of the JSON.

>>> THE CORRECT RESPONSE TO A FAILURE IS TO USE A TOKEN, NOT TO RUN
>>> --update-baseline. The baseline is a record of debt, not an allowlist.
>>> Growing it is how the migration silently un-happens.

INLINE ESCAPE HATCH (rare, needs a reason)
------------------------------------------
For values that genuinely cannot be a token — a native/platform API that takes a
literal hex STRING, e.g. flutter_callkit's `backgroundColor: '#11A37F'` — put
this on the same line or the line directly above:

    // design-guard: allow — CallKit's native API takes a hex string, not a Color

A bare `// design-guard: allow` with no reason after it is REJECTED, so the
hatch cannot be used as a silent mute.

EXIT CODES
----------
0 clean · 1 new violations found · 2 bad usage / IO error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "tool" / "design_guard_baseline.json"

LIB = "app/lib"

# The three files that are ALLOWED to contain raw colour hex — they are the
# token definitions. Everything else must reference them.
SANCTIONED_COLOUR_FILES = {
    "app/lib/core/ui/avatok_dark.dart",
    "app/lib/core/ui/messenger_theme.dart",
    "app/lib/core/ui/bubble_theme.dart",
}

# Icons are only policed in product surfaces. core/ has a couple of deliberate
# platform/glue references and is not where screens get written.
ICON_SCOPES = ("app/lib/features/", "app/lib/shell/")

GENERATED_SUFFIXES = (".g.dart", ".freezed.dart", ".gen.dart", ".config.dart")

# Material colours that carry no design decision. See POLICY in the docstring.
DEFAULT_MATERIAL_ALLOW = ("transparent", "white", "black")

# 8-digit hex that is provably not a colour. Without these the bare-hex rule
# flags FNV-1a hashing (`0x811c9dc5`, `0x01000193`) and 32-bit masks.
NON_COLOUR_HEX = {
    "0xffffffff",  # 32-bit mask. As a colour it would be Color(0xFFFFFFFF),
                   # which the Color(0x…) rule catches separately.
    "0x7fffffff",
    "0x0fffffff",
    "0x811c9dc5",  # FNV-1a offset basis
    "0x01000193",  # FNV-1a prime
}

ESCAPE_HATCH = re.compile(r"//\s*design-guard:\s*allow\b(?P<reason>.*)$")

# --------------------------------------------------------------------------- #
# Rules
# --------------------------------------------------------------------------- #

# NOTE on every lookbehind below: `(?<![A-Za-z0-9_$])` is what stops
# `PhosphorIcons.` matching `Icons.` and `MyColor(` matching `Color(`.
RE_COLOR_CTOR = re.compile(r"(?<![A-Za-z0-9_$])Color\(\s*(?:const\s+)?0x[0-9a-fA-F]+")
RE_COLOR_FROM = re.compile(r"(?<![A-Za-z0-9_$])Color\.from(?:ARGB|RGBO)\s*\(")
RE_MATERIAL = re.compile(r"(?<![A-Za-z0-9_$])Colors\.([A-Za-z_][A-Za-z0-9_]*)")
RE_BARE_HEX = re.compile(r"(?<![A-Za-z0-9_$.])0x[0-9a-fA-F]{8}(?![0-9a-fA-F])")
RE_HEX_STRING = re.compile(r"['\"]#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?['\"]")
RE_ICONS = re.compile(r"(?<![A-Za-z0-9_$])Icons\.([A-Za-z_][A-Za-z0-9_]*)")

TOKEN_HINT = (
    "use an AD.* token from app/lib/core/ui/avatok_dark.dart "
    "(surfaces AD.bg/AD.card/AD.headerFooter, ink AD.textPrimary/"
    "AD.textSecondary/AD.textTertiary, borders AD.borderHairline/AD.borderCard, "
    "accent AD.primaryBadge) — or Msg.*/MsgColors.* (messenger_theme.dart) / "
    "BubbleTheme (bubble_theme.dart). Add a new token there if none fits."
)

# Straight swaps for the Material shades that actually appear in this tree.
MATERIAL_SUGGESTIONS = {
    "white70": "AD.textSecondary (white 60%)",
    "white60": "AD.textSecondary (white 60%)",
    "white54": "AD.textTertiary (white 45%)",
    "white38": "AD.textFaint (white 30%)",
    "white24": "AD.textFaint (white 30%)",
    "black54": "AD.placeholderOnWhite (black 45%)",
    "black26": "AD.borderHairline",
    "black12": "AD.borderHairline",
    "grey": "AD.iconNeutral / AD.textSecondary",
    "red": "AD.danger",
    "green": "AD.online",
    "amber": "AD.unreadAccent",
    "orange": "AD.primaryBadge",
}

ICON_HINT = (
    "use PhosphorIcons.<name>(PhosphorIconsStyle.regular) from "
    "package:phosphor_flutter — the app standardised on Phosphor"
)


class Violation:
    __slots__ = ("path", "line", "col", "token", "text", "hint")

    def __init__(self, path, line, col, token, text, hint):
        self.path = path
        self.line = line
        self.col = col
        self.token = token
        self.text = text
        self.hint = hint

    def where(self):
        return "%s:%d:%d" % (self.path, self.line, self.col)


# --------------------------------------------------------------------------- #
# Dart-aware comment masking
# --------------------------------------------------------------------------- #

def mask_comments(text: str) -> str:
    """Blank out Dart comments, preserving every byte offset and newline.

    Comment bodies become spaces so line/column numbers stay exact. Strings are
    stepped over (not blanked) so `'https://x'` is not read as a comment and a
    hex colour STRING is still visible to the rules. Handles: `//`, nested
    `/* /* */ */`, `'`/`"`, triple-quoted, and raw `r'...'` strings.
    """
    out = list(text)
    i, n = 0, len(text)
    depth = 0
    while i < n:
        ch = text[i]
        if depth:
            if text.startswith("/*", i):
                depth += 1
                out[i] = out[i + 1] = " "
                i += 2
                continue
            if text.startswith("*/", i):
                depth -= 1
                out[i] = out[i + 1] = " "
                i += 2
                continue
            if ch != "\n":
                out[i] = " "
            i += 1
            continue
        if text.startswith("//", i):
            while i < n and text[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if text.startswith("/*", i):
            depth = 1
            out[i] = out[i + 1] = " "
            i += 2
            continue
        if ch in "\"'":
            raw = (
                i > 0
                and text[i - 1] == "r"
                and (i < 2 or not (text[i - 2].isalnum() or text[i - 2] in "_$"))
            )
            triple = text.startswith(ch * 3, i)
            delim = ch * 3 if triple else ch
            i += len(delim)
            while i < n:
                if not raw and text[i] == "\\":
                    i += 2
                    continue
                if text.startswith(delim, i):
                    i += len(delim)
                    break
                if not triple and text[i] == "\n":
                    break  # unterminated single-line string; bail at EOL
                i += 1
            continue
        i += 1
    return "".join(out)


# --------------------------------------------------------------------------- #
# Scanning
# --------------------------------------------------------------------------- #

def dart_files(root: Path, subdir: str):
    base = root / subdir
    if not base.is_dir():
        raise SystemExit("design-guard: %s does not exist (wrong --root?)" % base)
    for p in sorted(base.rglob("*.dart")):
        rel = p.relative_to(root).as_posix()
        if rel.endswith(GENERATED_SUFFIXES):
            continue
        yield p, rel


def hatched_lines(lines):
    """Line numbers (1-based) suppressed by `// design-guard: allow <reason>`."""
    out = set()
    for idx, line in enumerate(lines, 1):
        m = ESCAPE_HATCH.search(line)
        if m and m.group("reason").strip(" \t-—:"):
            out.add(idx)      # same line
            out.add(idx + 1)  # and the line directly below
    return out


def scan_colours(root: Path, material_allow):
    allow = set(material_allow)
    found = []
    for path, rel in dart_files(root, LIB):
        if rel in SANCTIONED_COLOUR_FILES:
            continue
        raw = path.read_text(encoding="utf-8", errors="replace")
        code_lines = mask_comments(raw).splitlines()
        raw_lines = raw.splitlines()
        skip = hatched_lines(raw_lines)

        for no, line in enumerate(code_lines, 1):
            if no in skip:
                continue
            snippet = raw_lines[no - 1].strip()[:160]
            ctor_spans = []

            for m in RE_COLOR_CTOR.finditer(line):
                ctor_spans.append(m.span())
                found.append(Violation(rel, no, m.start() + 1, "Color(0x…)",
                                       snippet, TOKEN_HINT))
            for m in RE_COLOR_FROM.finditer(line):
                ctor_spans.append(m.span())
                found.append(Violation(rel, no, m.start() + 1,
                                       m.group(0).rstrip("( \t") + "(…)",
                                       snippet, TOKEN_HINT))
            for m in RE_MATERIAL.finditer(line):
                name = m.group(1)
                if name in allow:
                    continue
                hint = MATERIAL_SUGGESTIONS.get(name)
                found.append(Violation(
                    rel, no, m.start() + 1, "Colors." + name, snippet,
                    ("use %s" % hint) if hint else TOKEN_HINT))
            for m in RE_BARE_HEX.finditer(line):
                if m.group(0).lower() in NON_COLOUR_HEX:
                    continue
                if any(a <= m.start() < b for a, b in ctor_spans):
                    continue  # already reported as Color(0x…)
                found.append(Violation(rel, no, m.start() + 1, "bare 0xAARRGGBB",
                                       snippet, TOKEN_HINT))
            for m in RE_HEX_STRING.finditer(line):
                found.append(Violation(
                    rel, no, m.start() + 1, "'#rrggbb' string", snippet,
                    TOKEN_HINT + " — if a native API demands a hex string, use "
                    "the inline `// design-guard: allow <reason>` hatch"))
    return found


def scan_icons(root: Path, _material_allow=None):
    found = []
    for path, rel in dart_files(root, LIB):
        if not rel.startswith(ICON_SCOPES):
            continue
        raw = path.read_text(encoding="utf-8", errors="replace")
        code_lines = mask_comments(raw).splitlines()
        raw_lines = raw.splitlines()
        skip = hatched_lines(raw_lines)
        for no, line in enumerate(code_lines, 1):
            if no in skip:
                continue
            for m in RE_ICONS.finditer(line):
                found.append(Violation(rel, no, m.start() + 1,
                                       "Icons." + m.group(1),
                                       raw_lines[no - 1].strip()[:160],
                                       ICON_HINT))
    return found


CHECKS = {
    "colours": ("raw colour literals outside the token files", scan_colours),
    "icons": ("bare Material Icons.* in feature code", scan_icons),
}

# --------------------------------------------------------------------------- #
# Baseline
# --------------------------------------------------------------------------- #

def load_baseline(path: Path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SystemExit("design-guard: %s is not valid JSON: %s" % (path, exc))


def tally(violations):
    counts = defaultdict(lambda: defaultdict(int))
    for v in violations:
        counts[v.path][v.token] += 1
    return {p: dict(sorted(t.items())) for p, t in sorted(counts.items())}


def baseline_size(section):
    return sum(sum(t.values()) for t in section.get("entries", {}).values())


def write_baseline(path: Path, check: str, violations, material_allow):
    doc = load_baseline(path)
    doc.setdefault("_readme", (
        "Violations that existed when tool/check_design_guard.py was introduced. "
        "The guard fails only on violations NOT recorded here. This is a record "
        "of DEBT, not an allowlist: fix a new violation with a token, do not run "
        "--update-baseline to silence it."))
    doc["version"] = 1
    doc[check] = {
        "description": CHECKS[check][0],
        "policy": ({"material_allow": sorted(material_allow)}
                   if check == "colours" else {}),
        "total": len(violations),
        "entries": tally(violations),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, sort_keys=False,
                               ensure_ascii=False) + "\n", encoding="utf-8")


def diff_against_baseline(violations, section):
    """Return (new_violations, stale_paths). A violation is NEW when its file
    holds more occurrences of that token than the baseline recorded."""
    base = section.get("entries", {})
    current = defaultdict(lambda: defaultdict(list))
    for v in violations:
        current[v.path][v.token].append(v)

    new = []
    for path, tokens in current.items():
        allowed_for_file = base.get(path, {})
        for token, occurrences in tokens.items():
            allowed = allowed_for_file.get(token, 0)
            if len(occurrences) > allowed:
                new.append((path, token, allowed, occurrences))

    live = {p for p in current}
    stale = sorted(p for p in base if p not in live)
    return new, stale


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

BAR = "-" * 78


def report(check, new, cmd):
    print(BAR, file=sys.stderr)
    print("DESIGN GUARD FAILED: %s (%s)" % (check, CHECKS[check][0]),
          file=sys.stderr)
    print(BAR, file=sys.stderr)
    total = 0
    for path, token, allowed, occurrences in sorted(new):
        excess = len(occurrences) - allowed
        total += excess
        print("", file=sys.stderr)
        print("%s  ->  %d new `%s` (baseline allows %d, found %d)"
              % (path, excess, token, allowed, len(occurrences)), file=sys.stderr)
        for v in occurrences:
            print("    %s   %s" % (v.where(), v.text), file=sys.stderr)
        if allowed:
            print("    ^ %d of the above are pre-existing (baseline); %d "
                  "%s new." % (allowed, excess,
                               "is" if excess == 1 else "are"), file=sys.stderr)
        print("    FIX: %s" % occurrences[0].hint, file=sys.stderr)
    print("", file=sys.stderr)
    print(BAR, file=sys.stderr)
    print("%d new violation(s). Reproduce locally:\n    %s" % (total, cmd),
          file=sys.stderr)
    print("Fix these by using a token. Do NOT run --update-baseline to silence "
          "them:\nthe baseline records the migration's leftover debt, and "
          "growing it undoes the\ndesign-system cleanup one commit at a time.",
          file=sys.stderr)
    print(BAR, file=sys.stderr)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="check_design_guard.py",
        description="Design-system drift guard for app/lib (colours + icons).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run all checks:  python3 tool/check_design_guard.py --check all")
    ap.add_argument("--check", choices=("colours", "icons", "all"), default="all")
    ap.add_argument("--root", default=str(REPO_ROOT),
                    help="repo root (default: the dir above this script)")
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--update-baseline", action="store_true",
                    help="RECORD today's violations as the new baseline. Only "
                         "for a deliberate, reviewed exception — the fix for a "
                         "normal failure is a token.")
    ap.add_argument("--list", action="store_true",
                    help="print every violation (baselined or not) and exit 0")
    ap.add_argument("--material-allow", default=",".join(DEFAULT_MATERIAL_ALLOW),
                    help="comma-separated Colors.<name> that stay legal "
                         "(default: %(default)s)")
    ap.add_argument("--strict-material", action="store_true",
                    help="allow no Colors.* at all (overrides --material-allow)")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    baseline_path = Path(args.baseline).resolve()
    material_allow = () if args.strict_material else tuple(
        s.strip() for s in args.material_allow.split(",") if s.strip())

    checks = ("colours", "icons") if args.check == "all" else (args.check,)
    doc = load_baseline(baseline_path)
    failed = False

    for check in checks:
        scan = CHECKS[check][1]
        violations = scan(root, material_allow)
        rel_baseline = os.path.relpath(baseline_path, root)
        cmd = "python3 tool/check_design_guard.py --check %s" % check

        if args.list:
            for v in violations:
                print("%s  %-24s %s" % (v.where(), v.token, v.text))
            print("# %s: %d total occurrence(s) in tree" % (check, len(violations)))
            continue

        if args.update_baseline:
            write_baseline(baseline_path, check, violations, material_allow)
            print("design-guard[%s]: baseline updated -> %s (%d entries across "
                  "%d file(s))" % (check, rel_baseline, len(violations),
                                   len(tally(violations))))
            continue

        section = doc.get(check, {})
        if not section:
            print("design-guard[%s]: NO BASELINE in %s — run `%s "
                  "--update-baseline` once, then commit it."
                  % (check, rel_baseline, cmd), file=sys.stderr)
            failed = True
            continue

        new, stale = diff_against_baseline(violations, section)
        if new:
            report(check, new, cmd)
            failed = True
        else:
            print("design-guard[%s]: OK — %d occurrence(s), all within the "
                  "baseline of %d." % (check, len(violations),
                                       baseline_size(section)))
            if stale:
                print("design-guard[%s]: note — %d baselined file(s) no longer "
                      "exist or are now clean (%s%s). Harmless; `--update-"
                      "baseline` will tidy it."
                      % (check, len(stale), ", ".join(stale[:3]),
                         ", …" if len(stale) > 3 else ""))

    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover
        print("design-guard: %s" % exc, file=sys.stderr)
        sys.exit(2)
