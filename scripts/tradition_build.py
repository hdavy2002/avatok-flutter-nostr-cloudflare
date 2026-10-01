#!/usr/bin/env python3
"""Build Specs/tradition/corpus.jsonl from the tradition library markdown files.

Plain python3, no dependencies. Fails loudly (exit 1) on any problem:
duplicate ids, missing fields, unknown topic/graha/weekday values,
passages under 40 or over 220 words, and banned promise words.

Usage: python3 scripts/tradition_build.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Specs" / "tradition"
OUT = SRC / "corpus.jsonl"

TOPICS = {"navagraha", "weekday", "deity", "chakra", "symbol", "puja", "dosha", "festival", "colour"}
GRAHAS = {"", "surya", "chandra", "mangal", "budh", "guru", "shukra", "shani", "rahu", "ketu"}
WEEKDAYS = {"", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
REQUIRED = ["topic", "title", "graha", "weekday", "deity", "source", "lang"]
ALLOWED_KEYS = set(REQUIRED)
MIN_WORDS, MAX_WORDS = 40, 220

# Banned promise wording (case-insensitive). "cure" is matched as a whole word
# (cure, cures, cured, curing is not matched on purpose: use of "curing" is avoided in content).
BANNED = [
    r"guarantee\w*",
    r"\bcure[sd]?\b",
    r"will remove",
    r"will fix",
    r"100\s*%",
    r"definitely",
]
BANNED_RE = [re.compile(p, re.I) for p in BANNED]
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def parse_file(path, errors):
    entries = []
    lines = path.read_text(encoding="utf-8").splitlines()
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if line.startswith("### "):
            eid = line[4:].strip()
            i += 1
            meta = {}
            while i < n and lines[i].startswith("- "):
                m = re.match(r"^- ([a-z_]+):\s*(.*)$", lines[i])
                if not m:
                    errors.append(f"{path.name}:{i+1}: malformed metadata line: {lines[i]!r}")
                else:
                    k, v = m.group(1), m.group(2).strip()
                    if k in meta:
                        errors.append(f"{path.name}:{i+1} [{eid}]: duplicate field {k}")
                    meta[k] = v
                i += 1
            body = []
            while i < n and not lines[i].startswith("### "):
                body.append(lines[i])
                i += 1
            text = " ".join(" ".join(body).split())
            entries.append((eid, meta, text, path.name))
        else:
            i += 1
    return entries


def main():
    errors = []
    files = sorted(p for p in SRC.glob("*.md") if p.name.lower() != "readme.md")
    if not files:
        print("FAIL: no topic files found in", SRC)
        return 1
    seen = {}
    records = []
    counts = {}
    for f in files:
        for eid, meta, text, fname in parse_file(f, errors):
            where = f"{fname} [{eid}]"
            counts[fname] = counts.get(fname, 0) + 1
            if not ID_RE.match(eid):
                errors.append(f"{where}: bad id (must be kebab-case)")
            if eid in seen:
                errors.append(f"{where}: duplicate id (also in {seen[eid]})")
            seen[eid] = fname
            for k in REQUIRED:
                if k not in meta:
                    errors.append(f"{where}: missing field '{k}'")
            for k in meta:
                if k not in ALLOWED_KEYS:
                    errors.append(f"{where}: unknown field '{k}'")
            for k in ("topic", "title", "source", "lang"):
                if k in meta and not meta[k]:
                    errors.append(f"{where}: empty required field '{k}'")
            if meta.get("topic") not in TOPICS:
                errors.append(f"{where}: unknown topic {meta.get('topic')!r}")
            if meta.get("graha", "") not in GRAHAS:
                errors.append(f"{where}: unknown graha {meta.get('graha')!r}")
            if meta.get("weekday", "") not in WEEKDAYS:
                errors.append(f"{where}: unknown weekday {meta.get('weekday')!r}")
            if meta.get("deity", "") != meta.get("deity", "").lower():
                errors.append(f"{where}: deity must be lowercase")
            wc = len(text.split())
            if wc < MIN_WORDS:
                errors.append(f"{where}: passage too short ({wc} words, min {MIN_WORDS})")
            if wc > MAX_WORDS:
                errors.append(f"{where}: passage too long ({wc} words, max {MAX_WORDS})")
            for rx in BANNED_RE:
                m = rx.search(text) or rx.search(meta.get("title", ""))
                if m:
                    errors.append(f"{where}: banned promise wording {m.group(0)!r}")
            records.append({
                "id": eid,
                "topic": meta.get("topic", ""),
                "title": meta.get("title", ""),
                "text": text,
                "source": meta.get("source", ""),
                "lang": meta.get("lang", ""),
                "graha": meta.get("graha", ""),
                "weekday": meta.get("weekday", ""),
                "deity": meta.get("deity", ""),
            })
    if errors:
        print(f"FAIL: {len(errors)} problem(s)")
        for e in errors:
            print("  -", e)
        return 1
    with OUT.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"OK: {len(records)} entries -> {OUT.relative_to(ROOT)}")
    for fname in sorted(counts):
        print(f"  {fname}: {counts[fname]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
