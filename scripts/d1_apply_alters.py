#!/usr/bin/env python3
"""
d1_apply_alters.py — apply `ALTER TABLE ... ADD COLUMN` migrations idempotently.

WHY THIS EXISTS
  SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`. Every ALTER-style migration in
  worker/migrations/ therefore has the same failure mode: run it twice and the
  first duplicate column aborts the file. On a database where SOME columns exist
  and some don't (a half-applied or hand-patched DB — exactly how
  2026-07-18-listings-drift-columns.sql came about), a raw
  `wrangler d1 execute --file=...` aborts at the first duplicate and SILENTLY
  LEAVES THE REMAINING COLUMNS MISSING. That reads as "already applied" and turns
  into mystery 500s later.

  This runner reads `PRAGMA table_info(<table>)` first and issues ONLY the ALTERs
  whose columns are actually absent. Safe on a fresh DB (applies all), safe on a
  fully-migrated DB (no-op), and correct on a partially-migrated one (the case the
  .sql file cannot handle).

  The .sql file stays the source of truth for the schema — this script only parses
  ALTERs out of it. Schema is never defined here.

SAFETY
  All wrangler calls go through scripts/cf.sh, so the target resolves from
  $AVATOK_TARGET / .avatok-target / git branch, staging is the default, and
  production is fail-closed unless ALLOW_PROD=1. This script adds no bypass.
  It never DROPs, never rewrites data, and only ever ADDs a missing column.

USAGE
  scripts/d1_apply_alters.py <migration.sql> [--binding DB_META] [--dry-run]

  # preview against staging (touches nothing)
  scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-drift-columns.sql --dry-run

  # apply to staging
  scripts/d1_apply_alters.py worker/migrations/2026-07-18-listings-drift-columns.sql

  # apply to production (deliberate, per CLAUDE.md)
  ALLOW_PROD=1 scripts/d1_apply_alters.py worker/migrations/<file>.sql

  Pass the BINDING (DB_META), never a database_name: prod is `avatok-meta` and
  staging is `avatok-meta-staging`; the binding resolves correctly under --env.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CF_SH = REPO_ROOT / "scripts" / "cf.sh"

# ALTER TABLE <table> ADD [COLUMN] <col> <rest...>;   (comments stripped first)
ALTER_RE = re.compile(
    r"ALTER\s+TABLE\s+(?P<table>[\w\"'`\[\]]+)\s+ADD\s+(?:COLUMN\s+)?(?P<col>[\w\"'`\[\]]+)\s+(?P<rest>[^;]+);",
    re.IGNORECASE | re.DOTALL,
)


def unquote(ident: str) -> str:
    return ident.strip().strip('"').strip("'").strip("`").strip("[]")


def strip_sql_comments(sql: str) -> str:
    """Drop -- line comments and /* */ blocks so commented-out ALTERs (and the
    ALTERs quoted inside a file's header docs) are never parsed as real work."""
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    return "\n".join(re.sub(r"--.*$", "", line) for line in sql.splitlines())


def parse_alters(sql: str) -> list[tuple[str, str, str]]:
    """-> [(table, column, full_statement)] in file order."""
    out = []
    for m in ALTER_RE.finditer(strip_sql_comments(sql)):
        table = unquote(m.group("table"))
        col = unquote(m.group("col"))
        stmt = " ".join(m.group(0).split())
        out.append((table, col, stmt))
    return out


def cf(binding: str, *args: str) -> subprocess.CompletedProcess:
    cmd = [str(CF_SH), "worker", "d1", "execute", binding, "--remote", *args]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO_ROOT))


def existing_columns(binding: str, table: str) -> set[str]:
    proc = cf(binding, "--json", "--command", f"PRAGMA table_info({table});")
    if proc.returncode != 0:
        sys.exit(
            f"error: PRAGMA table_info({table}) failed (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    # wrangler prints human noise around the JSON payload; take the outermost [...].
    text = proc.stdout
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        sys.exit(f"error: could not parse wrangler --json output:\n{text}")
    try:
        payload = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        sys.exit(f"error: could not parse wrangler --json output: {e}\n{text}")

    cols: set[str] = set()
    for block in payload if isinstance(payload, list) else [payload]:
        for row in (block or {}).get("results", []) or []:
            name = row.get("name")
            if name:
                cols.add(name)
    if not cols:
        sys.exit(
            f"error: table '{table}' has no columns / does not exist on this database.\n"
            f"Run the table's base migration first (e.g. migrations/listings.sql)."
        )
    return cols


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("migration", help="path to a .sql file containing ALTER TABLE ... ADD COLUMN statements")
    ap.add_argument("--binding", default="DB_META", help="D1 binding name (default: DB_META)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; change nothing")
    args = ap.parse_args()

    path = Path(args.migration)
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    if not path.is_file():
        sys.exit(f"error: no such file: {path}")

    alters = parse_alters(path.read_text())
    if not alters:
        sys.exit(
            f"error: no ALTER TABLE ... ADD COLUMN statements in {path.name}.\n"
            f"This runner only handles additive column migrations; for CREATE TABLE\n"
            f"files use: scripts/cf.sh worker d1 execute {args.binding} --remote --file=..."
        )

    tables = sorted({t for t, _, _ in alters})
    print(f"{path.name}: {len(alters)} ALTER(s) across {len(tables)} table(s): {', '.join(tables)}")

    present: dict[str, set[str]] = {t: existing_columns(args.binding, t) for t in tables}

    todo = []
    for table, col, stmt in alters:
        if col in present[table]:
            print(f"  skip   {table}.{col} — already present")
        else:
            print(f"  APPLY  {table}.{col}")
            todo.append((table, col, stmt))

    if not todo:
        print("\nNothing to do — database already matches this migration.")
        return 0

    if args.dry_run:
        print(f"\n--dry-run: {len(todo)} statement(s) NOT executed:")
        for _, _, stmt in todo:
            print(f"  {stmt}")
        return 0

    print()
    for table, col, stmt in todo:
        proc = cf(args.binding, "--command", stmt)
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout).strip()
            # Benign race: someone/something added it between our PRAGMA and now.
            if "duplicate column name" in err.lower():
                print(f"  ok     {table}.{col} — appeared concurrently, nothing to do")
                continue
            print(f"  FAILED {table}.{col}\n{err}", file=sys.stderr)
            print(
                f"\nStopped after {len(todo)} planned / partial application. Re-run this\n"
                f"script — it re-reads PRAGMA and resumes only what is still missing.",
                file=sys.stderr,
            )
            return 1
        print(f"  ok     {table}.{col} added")

    print(f"\nDone — {len(todo)} column(s) added.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
