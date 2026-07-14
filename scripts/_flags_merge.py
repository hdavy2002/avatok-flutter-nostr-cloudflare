#!/usr/bin/env python3
"""Helper for scripts/flags.sh — never call directly.

Reads the current KV blob on stdin, applies an operation, writes the new blob
on stdout. Human-readable notes go to stderr.

DELTA SEMANTICS: the output contains ONLY explicit overrides. Code defaults in
worker/src/routes/config.ts are never materialized into KV, so a change to a
default there keeps applying to every flag nobody has explicitly pinned.

  merge   <defaults.json> k=v [k=v ...]
  unset   <defaults.json> k [k ...]
  prune   <defaults.json>
"""
import json
import sys


def parse_value(raw, key, defaults):
    if key not in defaults:
        sys.exit(f"unknown flag: {key!r} (not in DEFAULTS in routes/config.ts)")
    want_num = isinstance(defaults[key], int) and not isinstance(defaults[key], bool)
    if want_num:
        try:
            return int(raw)
        except ValueError:
            sys.exit(f"{key} expects a number, got {raw!r}")
    if raw in ("true", "false"):
        return raw == "true"
    sys.exit(f"{key} expects true|false, got {raw!r}")


def main() -> None:
    op = sys.argv[1]
    defaults = json.loads(open(sys.argv[2]).read())
    args = sys.argv[3:]

    raw = sys.stdin.read().strip()
    # Empty stdin is NOT "no overrides" — it's an upstream read that produced
    # nothing, and deriving a blob from it means writing a near-empty
    # platform_config over the real one (every override silently reverting to
    # the code default for live users). The caller must pass a literal "{}" to
    # mean "genuinely empty". This is a backstop: flags.sh materialises the read
    # before the pipeline so `set -e` catches it first, but a pipeline is
    # concurrent — kv_put would already have written by the time bash noticed —
    # so refusing here protects every future caller too.
    if not raw:
        sys.exit(
            "_flags_merge: empty stdin — refusing to derive a flag blob from "
            "nothing (a failed read is not an empty blob; pass '{}' explicitly)"
        )
    blob = json.loads(raw)
    if not isinstance(blob, dict):
        sys.exit("stored platform_config is not a JSON object")

    if op == "merge":
        if not args:
            sys.exit("nothing to set")
        for pair in args:
            if "=" not in pair:
                sys.exit(f"expected key=value, got {pair!r}")
            k, v = pair.split("=", 1)
            blob[k] = parse_value(v, k, defaults)
        sys.stderr.write("set: %s\n" % ", ".join(args))

    elif op == "unset":
        gone = [k for k in args if blob.pop(k, None) is not None]
        sys.stderr.write(
            "unset: %s — now following the code default\n" % (", ".join(gone) or "nothing")
        )

    elif op == "prune":
        dropped = sorted(k for k, v in blob.items() if k in defaults and defaults[k] == v)
        blob = {k: v for k, v in blob.items() if k not in dropped}
        sys.stderr.write(
            "pruned %d key(s) that merely restated the code default: %s\n"
            % (len(dropped), ", ".join(dropped) or "none")
        )

    else:
        sys.exit(f"unknown op {op!r}")

    sys.stderr.write("remaining explicit overrides: %d\n" % len(blob))
    print(json.dumps(blob, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
