#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""[SHIP-GATE-1] Ship-readiness gate: flags, a success manifest, and telemetry.

WHY THIS EXISTS
---------------
Over 2026-08-07/08 four call fixes shipped to production. THREE OF THEM DID
NOTHING, and nobody noticed until the owner tested by hand and complained. The
three failures were process failures, not coding failures — each one was
mechanically detectable, and nothing was looking:

  1. A TWO-SIDED feature was called "shipped" with only ONE phone on the build.
     [CALL-PRESENCE-1] added a device heartbeat; the heartbeat lives IN THE APP,
     so the callee's phone — still on the previous build — could not send one.
     The feature was untestable by construction. PostHog showed exactly one
     person on build 10524 and everyone else on 10523 or older. A query would
     have said so in ten seconds.

  2. The telemetry ARRIVED, and every single event said FAILURE.
     `call_presence_decision presence=unknown decision=ring_unknown` on every
     call. `call_receptionist_trigger trigger=ring_timeout_no_receipts
     ring_count=0` on every call. The agent checked that events were FLOWING,
     not that they carried the VALUES that mean it worked. Both were visible
     within minutes of the first test call.

  3. A written report to the owner cited two "known issues" from an agent's
     saved memory notes WITHOUT OPENING THE CODE. Both had been fixed two days
     earlier ([CALL-QOS-RED-1] and [CALL-SFU-SURVIVE-1], both 2026-08-06). An
     external audit caught it, not us.

There is a precedent in this repo for turning "nobody stopped X" into a script:
`tool/check_design_guard.py`. This is that, for shipping. It runs on plain
`python3` with NO pip/pub dependencies and NO Flutter toolchain, because this
repo has no local build toolchain (CLAUDE.md) and CI must run it in a bare
ubuntu container in ~1 second.

THE THREE CHECKS
----------------
`--check flags`      OFFLINE. Every remote-config key the CLIENT reads must be
                     declared on the SERVER, or it is a FAKE flag that can never
                     be flipped. `inAppUpdateEnabled` shipped exactly this way
                     (CLAUDE.md, 2026-07-15): a documented brake on a feature
                     that auto-installs updates, which `putConfig` would have
                     400'd `unknown key` on. Parses the client getters in
                     `app/lib/core/remote_config.dart` and the `PlatformConfig`
                     interface / `DEFAULTS` object / `numericKeys` Set in
                     `worker/src/routes/config.ts`, and fails on:
                       * a client key absent from `DEFAULTS`      (FAKE FLAG)
                       * a client key absent from `PlatformConfig`
                       * a NUMERIC client key absent from `numericKeys`
                         (`flags.sh set <key>=N` 400s `bad type`)

                     `scripts/check-config-contract.mjs` checks the same
                     contract (plus server-side orphans) and is the deeper of
                     the two — but it needs Node, and this check is a
                     PRECONDITION of `--check manifest` below (a success
                     definition may not point at a flag that cannot be flipped).
                     Keeping it here means the ship gate is one self-contained
                     python3 file with no toolchain of its own.

`--check manifest`   OFFLINE. THIS IS THE CORE OF THE WHOLE THING.
                     `tool/ship_manifest.json` records, PER SHIPPED ISSUE ID,
                     what success looks like IN TELEMETRY — the exact event and
                     the exact property value that means it worked. Every issue
                     id committed in the last `--days` days that touched `app/`
                     or `worker/` must have an entry. You cannot ship a
                     behaviour change without first writing down, in advance,
                     the number you will go and look at afterwards. Failure 2
                     above happens when nobody wrote that number down, so
                     "events are flowing" becomes the standard of proof.

`--check telemetry`  NEEDS NETWORK + `POSTHOG_PERSONAL_API_KEY`. Reads the
                     manifest, queries PostHog (project 139917, EU) over a
                     window, and fails when an assertion's events are ABSENT
                     *or* PRESENT-BUT-CARRYING-A-FAILURE-VALUE. Also implements
                     the two-phone gate: for `two_sided: true` issues it counts
                     DISTINCT persons on the newest `$app_build` in the window
                     and fails below `min_devices_on_build`.

                     WITH NO KEY IN THE ENVIRONMENT IT SKIPS, LOUDLY, AND EXITS
                     0. A missing secret must never fail CI, and must never be
                     mistaken for a pass.

`--check all`        flags + manifest, and telemetry ONLY when the key is set.

MANIFEST SHAPE
--------------
    "CALL-PRESENCE-1": {
      "description": "one line, plain English",
      "two_sided": true,                 // needs BOTH phones on the new build
      "min_devices_on_build": 2,         // distinct persons on the newest build
      "flags": ["callPresenceRouting", "presenceFreshSec"],
      "success": [
        {"event": "call_presence_decision", "property": "presence",
         "not_in": ["unknown"]},
        {"event": "call_presence_decision", "property": "decision",
         "not_in": ["ring_unknown"]}
      ]
    }

  An assertion is `{"event": ..., "property": ...}` plus ONE comparison:
      "equals": <literal>          exact value
      "equals_property": "<other>" equal to ANOTHER property on the same event
                                   (this is how "the route we asked for is the
                                   route we got" is expressed)
      "not_in": [...]              value must not be any of these
      "in": [...]                  value must be one of these
      "lt" / "lte" / "gt" / "gte": <number>
      "exists": true               property present and non-empty
  Optional on any assertion:
      "where":       {"prop": "value", ...}  filter the population first
      "min_events":  N (default 1)           fail if fewer than N events landed
      "since_days":  N                       override the window for this one
      "min_pass_rate": 0..1 (default 1.0)    tolerate a KNOWN, EXPLAINED share of
                                             legitimate misses (a slow network on
                                             a latency budget). Every value below
                                             1.0 needs a `note` saying which real
                                             cases it covers — a pass rate is not
                                             a place to hide a partial failure.

BASELINE, NOT BIG BANG
----------------------
Both offline checks are baselined against `tool/ship_readiness_baseline.json`:
pre-existing fake flags and issue ids that shipped BEFORE this gate landed are
recorded there, so the gate was green on day one and fires only on NEW debt.

>>> THE BASELINE IS A RECORD OF DEBT, NOT AN ALLOWLIST. When this fails, DECLARE
>>> THE FLAG or WRITE THE MANIFEST ENTRY. Do NOT run --update-baseline; growing
>>> it is how the next silent no-op ships.

    python3 tool/check_ship_readiness.py --check all
    python3 tool/check_ship_readiness.py --check flags --list
    python3 tool/check_ship_readiness.py --check manifest --days 14
    POSTHOG_PERSONAL_API_KEY=phx_... python3 tool/check_ship_readiness.py \
        --check telemetry --window-days 3

INLINE ESCAPE HATCH (rare, needs a reason)
------------------------------------------
A commit that genuinely ships no user-visible behaviour (a comment sweep, a
doc, a test-only change) can be exempted from `--check manifest` by adding its
issue id to the manifest with `"no_telemetry": "<reason>"` instead of
`success`. A reason is MANDATORY, exactly like the design guard's
`// design-guard: allow — <reason>`, so the hatch cannot be a silent mute.

EXIT CODES
----------
0 clean (or telemetry skipped for a missing key) · 1 violations · 2 usage/IO
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "tool" / "ship_readiness_baseline.json"
DEFAULT_MANIFEST = REPO_ROOT / "tool" / "ship_manifest.json"

CLIENT_CONFIG = "app/lib/core/remote_config.dart"
SERVER_CONFIG = "worker/src/routes/config.ts"

# Paths whose commits are behaviour a user can feel, and therefore need a
# success definition. A change confined to Specs/, tool/, scripts/ or a .md
# ships nothing to a phone and is not gated.
SHIPPING_PATHS = ("app/", "worker/")

POSTHOG_HOST = "https://eu.posthog.com"
POSTHOG_PROJECT = 139917
POSTHOG_KEY_ENV = "POSTHOG_PERSONAL_API_KEY"

ISSUE_RE = re.compile(r"^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\]")

BAR = "-" * 78


# --------------------------------------------------------------------------- #
# Comment masking (Dart and TypeScript share the same comment syntax)
# --------------------------------------------------------------------------- #

def mask_comments(text: str, nest: bool = False) -> str:
    """Blank out `//` and `/* */` comments, preserving byte offsets.

    Same idea as tool/check_design_guard.py's masker: comment bodies become
    spaces so line numbers stay exact, and strings are STEPPED OVER rather than
    blanked so a key name inside `_b('someFlag', …)` is still visible. Without
    this, every `/// Mirrors config.ts \\`someKey\\`` docstring in
    remote_config.dart (there are hundreds) would be parsed as a real getter.

    `nest` MATTERS AND THE DEFAULT IS THE TYPESCRIPT ONE. Dart nests block
    comments; TypeScript does NOT. config.ts is full of JSDoc blocks that
    mention route globs like `/api/callrec/*` — with nesting on, that `/*`
    opens a second level, the block's own `*/` only closes one, and EVERY
    remaining line of the file is masked away. The visible symptom is
    `parse_server_config` finding a PlatformConfig interface with ~180 keys
    missing, i.e. the gate cheerfully declaring most of the app's flags fake.
    Pass nest=True only for Dart.
    """
    out = list(text)
    i, n = 0, len(text)
    depth = 0
    while i < n:
        ch = text[i]
        if depth:
            if nest and text.startswith("/*", i):
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
        if ch in "\"'`":
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
                if not triple and ch != "`" and text[i] == "\n":
                    break  # unterminated single-line string; bail at EOL
                i += 1
            continue
        i += 1
    return "".join(out)


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


# --------------------------------------------------------------------------- #
# CHECK 1 — flags (client keys must be declared server-side)
# --------------------------------------------------------------------------- #

# `static bool get x => _b('someFlag', false);`
RE_CLIENT_BOOL = re.compile(r"\b_b\(\s*'([A-Za-z_][A-Za-z0-9_]*)'")
# `(_asNum(_cfg['someNum'])?.toInt()) ?? 90`
RE_CLIENT_NUM = re.compile(r"\b_asNum\(\s*_cfg\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]")
# Any other direct read off the config blob.
RE_CLIENT_ANY = re.compile(r"\b_cfg\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]")

RE_TS_FIELD = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:")
RE_TS_STRING = re.compile(r"'([^']+)'|\"([^\"]+)\"")


def parse_client_keys(root: Path):
    """{key: {'kind': 'bool'|'num'|'raw', 'line': int}} read by the Flutter client."""
    path = root / CLIENT_CONFIG
    if not path.is_file():
        raise SystemExit("ship-gate: %s does not exist (wrong --root?)" % path)
    raw = path.read_text(encoding="utf-8", errors="replace")
    code = mask_comments(raw, nest=True)  # Dart nests block comments

    keys = {}
    for kind, rx in (("num", RE_CLIENT_NUM), ("bool", RE_CLIENT_BOOL),
                     ("raw", RE_CLIENT_ANY)):
        for m in rx.finditer(code):
            name = m.group(1)
            # First match wins, and `num` is scanned first on purpose: a numeric
            # getter must be recorded as numeric so the numericKeys rule applies.
            if name not in keys:
                keys[name] = {"kind": kind, "line": line_of(code, m.start())}
    return keys


def _block(code: str, opener: str, terminator: str):
    """Lines between the line containing `opener` and the first line whose
    STRIPPED text equals `terminator`.

    Deliberately line-based rather than brace-counting. Brace counting is the
    obvious implementation and it does not work here: `mask_comments` steps OVER
    string literals instead of blanking them (it has to, or the key names inside
    `_b('someFlag', …)` would vanish), so a `{`, `}` or `]` inside any string in
    config.ts unbalances the count and the block silently comes back empty —
    which reads as "this file declares no flags at all", i.e. every client key is
    a fake flag. All three blocks we want are top-level and close at column 0.
    """
    lines = code.splitlines()
    start = next((i for i, ln in enumerate(lines) if opener in ln), None)
    if start is None:
        return None
    for j in range(start + 1, len(lines)):
        if lines[j].strip() == terminator:
            return "\n".join(lines[start + 1:j])
    return None


def parse_server_config(root: Path):
    """(interface_keys, defaults_keys, numeric_keys) from worker/src/routes/config.ts."""
    path = root / SERVER_CONFIG
    if not path.is_file():
        raise SystemExit("ship-gate: %s does not exist (wrong --root?)" % path)
    code = mask_comments(path.read_text(encoding="utf-8", errors="replace"))

    iface = _block(code, "export interface PlatformConfig {", "}")
    if iface is None:
        raise SystemExit("ship-gate: could not find `export interface "
                         "PlatformConfig {` in %s" % SERVER_CONFIG)
    interface_keys = {m.group(1) for m in
                      (RE_TS_FIELD.match(ln) for ln in iface.splitlines()) if m}

    defaults = _block(code, "const DEFAULTS: PlatformConfig = {", "};")
    if defaults is None:
        raise SystemExit("ship-gate: could not find `const DEFAULTS: "
                         "PlatformConfig = {` in %s" % SERVER_CONFIG)
    defaults_keys = {m.group(1) for m in
                     (RE_TS_FIELD.match(ln) for ln in defaults.splitlines()) if m}

    nums = _block(code, "numericKeys = new Set([", "]);")
    numeric_keys = set()
    if nums is not None:
        for m in RE_TS_STRING.finditer(nums):
            numeric_keys.add(m.group(1) or m.group(2))
    return interface_keys, defaults_keys, numeric_keys


FLAG_HINTS = {
    "missing_from_DEFAULTS":
        "FAKE FLAG. Add the key to `DEFAULTS` in worker/src/routes/config.ts. "
        "Until you do, `putConfig` answers 400 `unknown key`, so the client's "
        "compile-time fallback is this flag's PERMANENT value and the kill "
        "switch documented above the getter does not exist.",
    "missing_from_PlatformConfig":
        "Add the key to the `PlatformConfig` interface in "
        "worker/src/routes/config.ts, in the SAME change as the DEFAULTS entry "
        "(`const DEFAULTS: PlatformConfig` is an excess-property error without "
        "it, so this normally means the interface half was forgotten).",
    "missing_from_numericKeys":
        "NUMERIC key. Add it to the `numericKeys` Set in "
        "worker/src/routes/config.ts, or `scripts/flags.sh set <key>=N` answers "
        "400 `bad type` and the value can never be tuned. (Booleans must NOT be "
        "listed there.)",
}


def scan_flags(root: Path):
    """[(key, kind, line, violation)] — one row per (key, broken contract)."""
    client = parse_client_keys(root)
    interface_keys, defaults_keys, numeric_keys = parse_server_config(root)

    out = []
    for key, info in sorted(client.items()):
        if key not in defaults_keys:
            out.append((key, info["kind"], info["line"], "missing_from_DEFAULTS"))
        if key not in interface_keys:
            out.append((key, info["kind"], info["line"],
                        "missing_from_PlatformConfig"))
        if info["kind"] == "num" and key not in numeric_keys:
            out.append((key, info["kind"], info["line"],
                        "missing_from_numericKeys"))
    return out


def flags_entries(rows):
    d = {}
    for key, _kind, _line, violation in rows:
        d.setdefault(key, [])
        if violation not in d[key]:
            d[key].append(violation)
    return {k: sorted(v) for k, v in sorted(d.items())}


def check_flags(root: Path, baseline: dict, args) -> int:
    rows = scan_flags(root)

    if args.list:
        for key, kind, line, violation in rows:
            print("%s:%d  %-28s %-28s %s"
                  % (CLIENT_CONFIG, line, key, kind, violation))
        print("# flags: %d broken contract(s) in tree" % len(rows))
        return 0

    section = baseline.get("flags", {})
    base = section.get("entries", {})
    new = [r for r in rows if r[3] not in base.get(r[0], [])]

    if not new:
        print("ship-gate[flags]: OK — %d client key(s) read, %d known contract "
              "gap(s), all within the baseline." % (
                  len(parse_client_keys(root)), len(rows)))
        return 0

    print(BAR, file=sys.stderr)
    print("SHIP GATE FAILED: flags — a client key the server does not declare "
          "is a FAKE FLAG", file=sys.stderr)
    print(BAR, file=sys.stderr)
    for key, kind, line, violation in sorted(new):
        print("", file=sys.stderr)
        print("%s:%d  %s  (%s)  ->  %s"
              % (CLIENT_CONFIG, line, key, kind, violation), file=sys.stderr)
        print("    FIX: %s" % FLAG_HINTS[violation], file=sys.stderr)
    print("", file=sys.stderr)
    print(BAR, file=sys.stderr)
    print("%d new fake/unflippable flag(s). Reproduce locally:\n    "
          "python3 tool/check_ship_readiness.py --check flags" % len(new),
          file=sys.stderr)
    print("Fix by DECLARING the key server-side. Do NOT run --update-baseline: "
          "that\nrecords the flag as permanently unflippable and the kill "
          "switch stays fiction.", file=sys.stderr)
    print(BAR, file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- #
# CHECK 2 — manifest (every shipped issue must declare what success looks like)
# --------------------------------------------------------------------------- #

COMPARISONS = ("equals", "equals_property", "not_in", "in",
               "lt", "lte", "gt", "gte", "exists")


def load_json(path: Path, what: str):
    if not path.exists():
        raise SystemExit("ship-gate: %s not found (%s)" % (path, what))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SystemExit("ship-gate: %s is not valid JSON: %s" % (path, exc))


def manifest_issues(manifest: dict) -> dict:
    """The issue entries, skipping the `_readme`-style metadata keys."""
    return {k: v for k, v in manifest.items() if not k.startswith("_")}


def validate_manifest(manifest: dict, defaults_keys, flag_violations):
    """[problem strings] — schema + flag-reference validation."""
    problems = []
    for issue, entry in sorted(manifest_issues(manifest).items()):
        where = "manifest entry %s" % issue
        if not isinstance(entry, dict):
            problems.append("%s: must be an object" % where)
            continue

        hatch = entry.get("no_telemetry")
        if hatch is not None:
            if not isinstance(hatch, str) or not hatch.strip(" \t-—:"):
                problems.append(
                    "%s: `no_telemetry` needs a REASON, not a bare value. It is "
                    "the escape hatch for a commit that ships no user-visible "
                    "behaviour; a reason is mandatory so it cannot be a silent "
                    "mute." % where)
            if entry.get("success"):
                problems.append("%s: has BOTH `no_telemetry` and `success` — "
                                "pick one." % where)
        else:
            success = entry.get("success")
            if not isinstance(success, list) or not success:
                problems.append(
                    "%s: needs a non-empty `success` list — the exact event and "
                    "property VALUE that means it worked. \"events are flowing\" "
                    "is not a success definition (see the docstring, failure 2)."
                    % where)
                success = []
            for i, a in enumerate(success):
                tag = "%s success[%d]" % (where, i)
                if not isinstance(a, dict):
                    problems.append("%s: must be an object" % tag)
                    continue
                if not a.get("event"):
                    problems.append("%s: missing `event`" % tag)
                used = [c for c in COMPARISONS if c in a]
                if not used:
                    problems.append("%s: no comparison — one of %s is required."
                                    % (tag, ", ".join(COMPARISONS)))
                elif len(used) > 1:
                    problems.append("%s: %d comparisons (%s); use exactly one."
                                    % (tag, len(used), ", ".join(used)))
                if used and used[0] != "exists" and not a.get("property"):
                    problems.append("%s: `%s` needs a `property`" % (tag, used[0]))
                if "where" in a and not isinstance(a["where"], dict):
                    problems.append("%s: `where` must be an object" % tag)
                rate = a.get("min_pass_rate")
                if rate is not None:
                    if not isinstance(rate, (int, float)) or not 0 < rate <= 1:
                        problems.append("%s: `min_pass_rate` must be in (0, 1]"
                                        % tag)
                    elif rate < 1 and not str(a.get("note", "")).strip():
                        problems.append(
                            "%s: `min_pass_rate` below 1.0 needs a `note` saying "
                            "which REAL cases the slack covers. Unexplained slack "
                            "is where a partial failure hides." % tag)

            if not isinstance(entry.get("two_sided"), bool):
                problems.append("%s: `two_sided` must be true/false — is this "
                                "feature testable with one phone?" % where)
            mind = entry.get("min_devices_on_build")
            if not isinstance(mind, int) or isinstance(mind, bool) or mind < 1:
                problems.append("%s: `min_devices_on_build` must be an int >= 1"
                                % where)
            elif entry.get("two_sided") and mind < 2:
                problems.append(
                    "%s: `two_sided` is true but `min_devices_on_build` is %d. A "
                    "two-sided feature with one phone on the build is untestable "
                    "BY CONSTRUCTION — that is exactly how [CALL-PRESENCE-1] was "
                    "declared shipped." % (where, mind))

        flags = entry.get("flags", [])
        if not isinstance(flags, list):
            problems.append("%s: `flags` must be a list" % where)
            flags = []
        for f in flags:
            if f not in defaults_keys:
                problems.append(
                    "%s: flag `%s` is not in the Worker's DEFAULTS — it cannot be "
                    "flipped, so a success definition that depends on it is "
                    "fiction. Declare it in worker/src/routes/config.ts." %
                    (where, f))
            elif f in flag_violations:
                problems.append(
                    "%s: flag `%s` fails --check flags (%s) — fix the flag "
                    "contract before relying on it." %
                    (where, f, ", ".join(flag_violations[f])))
    return problems


def shipped_issues(root: Path, days: int):
    """{issue_id: [subject, …]} for commits in the window touching app/ or worker/.

    Ownership is read from the `[ISSUE-ID]` commit prefix, exactly like
    scripts/git_safe_push.py — every agent commits as the same git user, so the
    author field cannot tell them apart (CLAUDE.md, Git protocol).
    """
    cmd = ["git", "-C", str(root), "log", "--since=%d days ago" % days,
           "--name-only", "--pretty=format:%x00%s"]
    try:
        raw = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=60).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        print("ship-gate[manifest]: git unavailable (%s) — skipping the "
              "shipped-issue sweep; manifest schema is still validated." % exc,
              file=sys.stderr)
        return None

    issues = {}
    unattributed = []
    for record in raw.split("\0"):
        if not record.strip():
            continue
        lines = record.splitlines()
        subject = lines[0].strip()
        files = [f.strip() for f in lines[1:] if f.strip()]
        if not any(f.startswith(SHIPPING_PATHS) for f in files):
            continue
        m = ISSUE_RE.match(subject)
        if not m:
            unattributed.append(subject)
            continue
        issues.setdefault(m.group(1), []).append(subject)
    if unattributed:
        print("ship-gate[manifest]: note — %d commit(s) in the window touch "
              "app/ or worker/ with NO [ISSUE-ID] prefix, so they cannot be "
              "attributed or gated (%s%s)."
              % (len(unattributed), unattributed[0][:60],
                 ", …" if len(unattributed) > 1 else ""), file=sys.stderr)
    return issues


def check_manifest(root: Path, baseline: dict, manifest: dict, args) -> int:
    _iface, defaults_keys, _nums = parse_server_config(root)
    flag_violations = flags_entries(scan_flags(root))

    problems = validate_manifest(manifest, defaults_keys, flag_violations)

    section = baseline.get("manifest", {})
    grandfathered = set(section.get("grandfathered", []))
    entries = manifest_issues(manifest)

    missing = []
    issues = shipped_issues(root, args.days)
    if issues is not None:
        for issue, subjects in sorted(issues.items()):
            if issue in entries or issue in grandfathered:
                continue
            missing.append((issue, subjects))

    if args.list:
        for issue, entry in sorted(entries.items()):
            kind = ("no_telemetry" if entry.get("no_telemetry")
                    else "%d assertion(s)" % len(entry.get("success", [])))
            print("%-28s %-18s two_sided=%s min_devices=%s"
                  % (issue, kind, entry.get("two_sided"),
                     entry.get("min_devices_on_build")))
        print("# manifest: %d entry(ies), %d grandfathered, %d shipped issue(s) "
              "in the last %d day(s)"
              % (len(entries), len(grandfathered),
                 len(issues or {}), args.days))
        return 0

    if not problems and not missing:
        print("ship-gate[manifest]: OK — %d entry(ies) well-formed; every issue "
              "shipped in the last %d day(s) that touched app/ or worker/ has a "
              "success definition." % (len(entries), args.days))
        return 0

    print(BAR, file=sys.stderr)
    print("SHIP GATE FAILED: manifest — something shipped with no definition of "
          "success", file=sys.stderr)
    print(BAR, file=sys.stderr)

    for issue, subjects in missing:
        print("", file=sys.stderr)
        print("%s  ->  NO ENTRY in %s"
              % (issue, os.path.relpath(args.manifest, root)), file=sys.stderr)
        for s in subjects[:4]:
            print("    %s" % s[:100], file=sys.stderr)
        print("    FIX: add an entry saying what success looks like IN "
              "TELEMETRY — the\n         exact event and the exact property "
              "value. If this issue genuinely\n         ships no user-visible "
              "behaviour, use \"no_telemetry\": \"<reason>\".", file=sys.stderr)

    for p in problems:
        print("", file=sys.stderr)
        print("MALFORMED: %s" % p, file=sys.stderr)

    print("", file=sys.stderr)
    print(BAR, file=sys.stderr)
    print("%d issue(s) with no success definition, %d malformed entry problem(s)."
          "\nReproduce locally:\n    python3 tool/check_ship_readiness.py "
          "--check manifest" % (len(missing), len(problems)), file=sys.stderr)
    print("Write the entry. Do NOT run --update-baseline — grandfathering "
          "today's ship is\nexactly how three fixes went to prod on 2026-08-08 "
          "and did nothing.", file=sys.stderr)
    print(BAR, file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- #
# CHECK 3 — telemetry (assert SUCCESS VALUES, not arrival)
# --------------------------------------------------------------------------- #

def hq_str(v) -> str:
    """A HogQL string literal for any python scalar.

    Everything is compared AS A STRING via `toString(properties[…])`, because
    PostHog properties are JSON: a boolean `counted` comes back as `true`, an
    int `ms` as `1234`. Comparing strings avoids a whole class of silent
    type-coercion mismatches where the query returns 0 rows and looks like a
    clean pass.
    """
    if isinstance(v, bool):
        s = "true" if v else "false"
    elif v is None:
        s = ""
    else:
        s = str(v)
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def prop(name: str) -> str:
    """`properties['x']` — ALWAYS the bracket form.

    The dotted form `properties.$app_build` is a HogQL PARSE ERROR because of
    the `$`. Someone will reach for it; do not.
    """
    return "properties[%s]" % hq_str(name)


def num_prop(name: str) -> str:
    # `toFloat64OrNull` IS supported (verified live 2026-08-08), even though its
    # integer sibling `toInt64OrNull` is not. Do not "fix" this one to match.
    return "toFloat64OrNull(toString(%s))" % prop(name)


def str_prop(name: str) -> str:
    return "toString(%s)" % prop(name)


def predicate(a: dict) -> str:
    p = a.get("property")
    if "equals" in a:
        return "%s = %s" % (str_prop(p), hq_str(a["equals"]))
    if "equals_property" in a:
        return "%s = %s" % (str_prop(p), str_prop(a["equals_property"]))
    if "not_in" in a:
        return "%s NOT IN (%s)" % (
            str_prop(p), ", ".join(hq_str(v) for v in a["not_in"]))
    if "in" in a:
        return "%s IN (%s)" % (
            str_prop(p), ", ".join(hq_str(v) for v in a["in"]))
    for op, sql in (("lt", "<"), ("lte", "<="), ("gt", ">"), ("gte", ">=")):
        if op in a:
            return "(%s IS NOT NULL AND %s %s %s)" % (
                num_prop(p), num_prop(p), sql, float(a[op]))
    if "exists" in a:
        return "(%s IS NOT NULL AND %s != '')" % (prop(p), str_prop(p))
    raise SystemExit("ship-gate: assertion has no comparison: %r" % a)


def describe(a: dict) -> str:
    p = a.get("property", "")
    for op, word in (("equals", "=="), ("equals_property", "== property"),
                     ("lt", "<"), ("lte", "<="), ("gt", ">"), ("gte", ">=")):
        if op in a:
            return "%s.%s %s %s" % (a["event"], p, word, a[op])
    if "not_in" in a:
        return "%s.%s NOT IN %s" % (a["event"], p, a["not_in"])
    if "in" in a:
        return "%s.%s IN %s" % (a["event"], p, a["in"])
    return "%s.%s exists" % (a["event"], p)


def posthog_query(sql: str, key: str, timeout: int = 90):
    import urllib.error
    import urllib.request

    url = "%s/api/projects/%d/query/" % (POSTHOG_HOST, POSTHOG_PROJECT)
    body = json.dumps({"query": {"kind": "HogQLQuery", "query": sql}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": "Bearer %s" % key,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise RuntimeError("PostHog HTTP %s: %s\n    query: %s"
                           % (exc.code, detail, sql))
    except Exception as exc:  # network, timeout, bad JSON
        raise RuntimeError("PostHog query failed: %s\n    query: %s" % (exc, sql))


def where_clause(event: str, days: int, filters: dict) -> str:
    parts = ["event = %s" % hq_str(event),
             "timestamp > now() - INTERVAL %d DAY" % days]
    for k, v in sorted((filters or {}).items()):
        parts.append("%s = %s" % (str_prop(k), hq_str(v)))
    return " AND ".join(parts)


def check_telemetry(manifest: dict, args) -> int:
    key = os.environ.get(POSTHOG_KEY_ENV, "").strip()
    if not key:
        print(BAR)
        print("ship-gate[telemetry]: SKIPPED — no %s in the environment."
              % POSTHOG_KEY_ENV)
        print("")
        print("THIS IS NOT A PASS. Nothing was verified against production.")
        print("The telemetry check is what catches a fix that shipped, emitted")
        print("its events, and said FAILURE in every one of them — the")
        print("2026-08-08 `presence=unknown decision=ring_unknown` case.")
        print("Run it with a PostHog personal API key:")
        print("    POSTHOG_PERSONAL_API_KEY=phx_... \\")
        print("      python3 tool/check_ship_readiness.py --check telemetry")
        print(BAR)
        return 0

    # An HTTP header must be latin-1 encodable. A key pasted out of a doc (with
    # a `…` in it, say) otherwise dies deep inside urllib with a codec error
    # that reads like a bug in this script rather than a bad secret.
    try:
        key.encode("latin-1")
    except UnicodeEncodeError:
        print("ship-gate[telemetry]: %s contains non-ASCII characters — that is "
              "not a PostHog personal API key (they look like `phx_…`). Fix the "
              "secret." % POSTHOG_KEY_ENV, file=sys.stderr)
        return 1

    entries = manifest_issues(manifest)
    only = set(args.issue or [])
    failures = []
    checked = 0

    for issue, entry in sorted(entries.items()):
        if only and issue not in only:
            continue
        if entry.get("no_telemetry"):
            continue

        # ---- the two-phone gate ------------------------------------------- #
        if entry.get("two_sided"):
            need = entry.get("min_devices_on_build", 2)
            sql = (
                # `toInt(…)` — NOT `toInt64OrNull(…)`. HogQL does not have the
                # ClickHouse *OrNull family and answers 400 "Unsupported
                # function call 'toInt64OrNull(...)'. Perhaps you meant
                # 'toIPv6OrNull(...)'?", which is an unhelpful enough
                # suggestion to cost someone half an hour.
                "SELECT toInt(toString(%s)) AS build, "
                "count(DISTINCT person_id) AS people\n"
                "FROM events\n"
                "WHERE timestamp > now() - INTERVAL %d DAY "
                "AND toInt(toString(%s)) IS NOT NULL\n"
                "GROUP BY build ORDER BY build DESC LIMIT 5"
                % (prop("$app_build"), args.window_days, prop("$app_build"))
            )
            try:
                res = posthog_query(sql, key).get("results") or []
            except RuntimeError as exc:
                failures.append((issue, "two-phone gate", str(exc)))
                res = []
            if res:
                build, people = res[0][0], int(res[0][1])
                spread = ", ".join("%s:%s people" % (r[0], r[1]) for r in res)
                checked += 1
                if people < need:
                    failures.append((
                        issue, "two-phone gate",
                        "newest build %s has %d distinct person(s), need %d.\n"
                        "        Builds in the last %dd: %s\n"
                        "        A two-sided feature verified on ONE phone is "
                        "not verified. The other\n        side is still on the "
                        "old build and physically cannot do its half."
                        % (build, people, need, args.window_days, spread)))
            elif not failures or failures[-1][0] != issue:
                failures.append((issue, "two-phone gate",
                                 "no events carrying $app_build in the last %d "
                                 "day(s) — nobody is on any build?"
                                 % args.window_days))

        # ---- the success assertions --------------------------------------- #
        for a in entry.get("success", []):
            days = int(a.get("since_days", args.window_days))
            pred = predicate(a)
            where = where_clause(a["event"], days, a.get("where"))
            sql = ("SELECT count() AS total, countIf(%s) AS ok\n"
                   "FROM events\nWHERE %s" % (pred, where))
            try:
                res = posthog_query(sql, key).get("results") or [[0, 0]]
            except RuntimeError as exc:
                failures.append((issue, describe(a), str(exc)))
                continue
            total, ok = int(res[0][0]), int(res[0][1])
            checked += 1
            need = int(a.get("min_events", 1))

            if total < need:
                failures.append((
                    issue, describe(a),
                    "ABSENT — %d event(s) named `%s`%s in the last %dd, need %d."
                    "\n        Either the code path never ran, the emit is being "
                    "dropped (workerd\n        drops unawaited telemetry on "
                    "early-return paths — CLAUDE.md), or\n        nobody is on a "
                    "build that contains it."
                    % (total, a["event"],
                       (" matching %s" % a["where"]) if a.get("where") else "",
                       days, need)))
                continue

            rate = float(a.get("min_pass_rate", 1.0))
            if ok < total * rate or (rate >= 1.0 and ok < total):
                sample = ""
                if a.get("property"):
                    s = ("SELECT %s AS v, count() AS n\nFROM events\nWHERE %s "
                         "AND NOT (%s)\nGROUP BY v ORDER BY n DESC LIMIT 5"
                         % (str_prop(a["property"]), where, pred))
                    try:
                        rows = posthog_query(s, key).get("results") or []
                        sample = ", ".join("%s=%s (%s×)"
                                           % (a["property"], r[0], r[1])
                                           for r in rows)
                    except RuntimeError:
                        sample = "(sample query failed)"
                failures.append((
                    issue, describe(a),
                    "PRESENT BUT FAILING — %d/%d event(s) satisfy it (%.0f%%, "
                    "need %.0f%%).\n"
                    "        Failing values: %s\n"
                    "        The events ARRIVED. They say the fix did not work. "
                    "This is the exact\n        2026-08-08 case: "
                    "`presence=unknown decision=ring_unknown` on every call,\n"
                    "        reported as \"telemetry is flowing\"."
                    % (ok, total, 100.0 * ok / total, 100.0 * rate,
                       sample or "(none)")))

    if not failures:
        print("ship-gate[telemetry]: OK — %d assertion(s)/gate(s) checked "
              "against PostHog over %d day(s); every one carries a SUCCESS "
              "value." % (checked, args.window_days))
        return 0

    print(BAR, file=sys.stderr)
    print("SHIP GATE FAILED: telemetry — production does not agree that this "
          "worked", file=sys.stderr)
    print(BAR, file=sys.stderr)
    for issue, what, detail in failures:
        print("", file=sys.stderr)
        print("%s  ->  %s" % (issue, what), file=sys.stderr)
        print("        %s" % detail, file=sys.stderr)
    print("", file=sys.stderr)
    print(BAR, file=sys.stderr)
    print("%d failing assertion(s)/gate(s). Reproduce locally:\n    "
          "POSTHOG_PERSONAL_API_KEY=... python3 tool/check_ship_readiness.py "
          "--check telemetry" % len(failures), file=sys.stderr)
    print("Do NOT report this as shipped. Read the code, not your memory notes: "
          "a saved\nnote is a hint about WHERE to look, never a citation.",
          file=sys.stderr)
    print(BAR, file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- #
# Baseline
# --------------------------------------------------------------------------- #

BASELINE_README = (
    "Ship-gate debt that existed when tool/check_ship_readiness.py was "
    "introduced [SHIP-GATE-1]. The gate fails only on violations NOT recorded "
    "here, so it was green on day one. This is a record of DEBT, not an "
    "allowlist: fix a new fake flag by declaring the key server-side, and a new "
    "shipped issue by writing its success definition into tool/ship_manifest."
    "json. Do NOT run --update-baseline to get green."
)


def write_baseline(path: Path, checks, root: Path, days: int, manifest_path: str):
    doc = {}
    if path.exists():
        doc = load_json(path, "baseline")
    doc["_readme"] = BASELINE_README
    doc["version"] = 1

    if "flags" in checks:
        rows = scan_flags(root)
        doc["flags"] = {
            "description": "client keys the Worker does not (fully) declare",
            "total": len(rows),
            "entries": flags_entries(rows),
        }
    if "manifest" in checks:
        issues = shipped_issues(root, days) or {}
        # Anything that already HAS a success definition does not need
        # grandfathering — keep the debt list honest and as short as possible.
        declared = set(manifest_issues(load_json(Path(manifest_path),
                                                 "the ship manifest")))
        doc["manifest"] = {
            "description": ("issue ids that shipped BEFORE the ship gate landed "
                            "and therefore never had to declare success. NOT an "
                            "allowlist — nothing may be added here going forward"),
            "window_days_at_capture": days,
            "total": len(set(issues) - declared),
            "grandfathered": sorted(set(issues) - declared),
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    print("ship-gate: baseline updated -> %s" % os.path.relpath(path, root))


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="check_ship_readiness.py",
        description="Ship-readiness gate: flag contract, success manifest, "
                    "production telemetry.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run everything:  python3 tool/check_ship_readiness.py --check all")
    ap.add_argument("--check", choices=("flags", "manifest", "telemetry", "all"),
                    default="all")
    ap.add_argument("--root", default=str(REPO_ROOT))
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--days", type=int, default=7,
                    help="git window for --check manifest (default: %(default)s)")
    ap.add_argument("--window-days", type=int, default=7,
                    help="PostHog window for --check telemetry "
                         "(default: %(default)s)")
    ap.add_argument("--issue", action="append",
                    help="limit --check telemetry to this issue id (repeatable)")
    ap.add_argument("--list", action="store_true",
                    help="print what the offline checks see and exit 0")
    ap.add_argument("--update-baseline", action="store_true",
                    help="RECORD today's debt as the baseline. Only for a "
                         "deliberate, reviewed exception — the fix for a normal "
                         "failure is to declare the flag or write the entry.")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    baseline_path = Path(args.baseline).resolve()
    args.manifest = str(Path(args.manifest).resolve())

    if args.check == "all":
        checks = ["flags", "manifest"]
        if os.environ.get(POSTHOG_KEY_ENV, "").strip():
            checks.append("telemetry")
        else:
            checks.append("telemetry")  # runs, prints the loud SKIP, returns 0
    else:
        checks = [args.check]

    if args.update_baseline:
        write_baseline(baseline_path, [c for c in checks if c != "telemetry"],
                       root, args.days, args.manifest)
        return 0

    baseline = load_json(baseline_path, "baseline") if baseline_path.exists() else {}
    if not baseline and not args.list and set(checks) & {"flags", "manifest"}:
        print("ship-gate: NO BASELINE at %s — run `python3 "
              "tool/check_ship_readiness.py --update-baseline` once, then commit "
              "it." % os.path.relpath(baseline_path, root), file=sys.stderr)
        return 1

    manifest = None
    if set(checks) & {"manifest", "telemetry"}:
        manifest = load_json(Path(args.manifest), "the ship manifest")

    rc = 0
    for check in checks:
        if check == "flags":
            rc |= check_flags(root, baseline, args)
        elif check == "manifest":
            rc |= check_manifest(root, baseline, manifest, args)
        elif check == "telemetry":
            rc |= check_telemetry(manifest, args)
    return 1 if rc else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover
        print("ship-gate: %s" % exc, file=sys.stderr)
        sys.exit(2)
