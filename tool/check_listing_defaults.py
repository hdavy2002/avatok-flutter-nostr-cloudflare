#!/usr/bin/env python3
"""
[LIST-DEFAULTS-LEN-1 2026-09-05] The wizard's prefilled listing defaults must
satisfy the worker's own attrs limits.

WHY THIS EXISTS
---------------
`web/src/lib/listingDefaults.ts` prefills house rules, steps and bullets when a
creator picks a category. `ListingWizard` applies those defaults automatically
from step 4 onward, and every per-step save sends the WHOLE accumulated body —
so a default that violates a server limit 422s a step the creator has not even
reached yet, on content they never typed.

That happened on 2026-09-05. The cooking default carried the house-rule heading
'Camera on your station is optional' (34 chars) against a 32-char server cap.
The owner was blocked on step 5, "How it works", by a rule belonging to step 6,
and the wizard reported it as "That didn't go through. Please try again" — a
retry that could never succeed. An astrology default was one character over too,
and would have done the same to the next creator who picked that category.

Client-side validation does NOT catch this: `validateStep` only checks the step
in front of the creator, and these defaults are injected without ever being
edited or seen.

The limits are duplicated between the two files by necessity (one TypeScript
client, one TypeScript worker, no shared module), so they drift silently. This
is the thing that notices.

    python3 tool/check_listing_defaults.py

Plain python3, no deps, no toolchain. Exits non-zero listing every offender.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = ROOT / "web/src/lib/listingDefaults.ts"
WORKER = ROOT / "worker/src/routes/listings.ts"

# field -> (key_a, max_a, key_b, max_b). Mirrors contentAttrsError() in
# worker/src/routes/listings.ts; verify_limits() below proves they still agree.
PAIR_RULES = {
    "content_house_rules": ("heading", 32, "body", 200),
    "content_how_it_works": ("label", 24, "body", 240),
    "content_faq": ("q", 120, "a", 300),
}
# field -> max string length, for plain string arrays.
STR_RULES = {
    "content_what_you_get": 80,
    "content_who_for": 80,
    "content_not_for": 80,
    "content_can_do": 80,
    "content_cant_do": 80,
}


def verify_limits() -> list[str]:
    """Re-read the caps out of the worker so this file cannot quietly go stale.

    If someone tightens a limit in the worker and not here, the check would keep
    passing while production started rejecting — which is the exact failure mode
    this script exists to prevent, one level up.
    """
    src = WORKER.read_text(encoding="utf-8")
    problems = []
    for field, (ka, ma, kb, mb) in PAIR_RULES.items():
        m = re.search(rf"{field} must be [^\"]*{ka}<=(\d+),\s*{kb}<=(\d+)", src)
        if not m:
            problems.append(f"{field}: could not find the worker's limit string — this checker may be out of date")
            continue
        wa, wb = int(m.group(1)), int(m.group(2))
        if (wa, wb) != (ma, mb):
            problems.append(
                f"{field}: worker says {ka}<={wa}, {kb}<={wb} but this script checks "
                f"{ka}<={ma}, {kb}<={mb} — update PAIR_RULES"
            )
    return problems


def strings_in(block: str, key: str) -> list[str]:
    """Every `key: '...'` value in a TS object-literal block, quotes unescaped."""
    out = []
    for m in re.finditer(rf"\b{key}:\s*(['\"`])(.*?)(?<!\\)\1", block, re.S):
        out.append(m.group(2).replace("\\'", "'").replace('\\"', '"'))
    return out


def main() -> int:
    if not DEFAULTS.exists():
        print(f"check_listing_defaults: {DEFAULTS} not found", file=sys.stderr)
        return 2

    src = DEFAULTS.read_text(encoding="utf-8")
    failures = []

    stale = verify_limits()
    for s in stale:
        failures.append(("LIMIT DRIFT", s))

    # Object-pair fields: pull each {..} literal that carries the first key.
    for field, (ka, ma, kb, mb) in PAIR_RULES.items():
        for m in re.finditer(
            rf"\{{\s*{ka}:\s*(['\"])(.*?)(?<!\\)\1\s*,\s*{kb}:\s*(['\"])(.*?)(?<!\\)\3\s*\}}",
            src, re.S,
        ):
            a, b = m.group(2), m.group(4)
            line = src[: m.start()].count("\n") + 1
            if len(a) > ma:
                failures.append((field, f"line {line}: {ka} is {len(a)}/{ma} chars — {a!r}"))
            if len(b) > mb:
                failures.append((field, f"line {line}: {kb} is {len(b)}/{mb} chars — {b[:60]!r}…"))

    # Plain string-array fields: check every string inside the array literal.
    for field, cap in STR_RULES.items():
        for m in re.finditer(rf"\b{field}:\s*\[(.*?)\]", src, re.S):
            block = m.group(1)
            base = src[: m.start()].count("\n") + 1
            for sm in re.finditer(r"(['\"])(.*?)(?<!\\)\1", block, re.S):
                val = sm.group(2)
                if len(val) > cap:
                    failures.append((field, f"~line {base}: {len(val)}/{cap} chars — {val[:60]!r}…"))

    if failures:
        print("check_listing_defaults: FAILED\n")
        for field, msg in failures:
            print(f"  [{field}] {msg}")
        print(
            "\nThese are PREFILLED defaults. The wizard applies them automatically from\n"
            "step 4 and sends the whole body on every save, so an over-length default\n"
            "422s a creator on a step they have not reached, with content they never\n"
            "typed. Shorten the string — do not raise the worker's limit to match.\n"
        )
        return 1

    print("check_listing_defaults: OK — every prefilled default is within the worker's limits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
