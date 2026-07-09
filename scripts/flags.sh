#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# flags.sh — read/write the `platform_config` KV feature-flag blob SAFELY.
#
# Every call routes through scripts/cf.sh, so the environment is resolved from
# the git branch (or $AVATOK_TARGET) and PRODUCTION is fail-closed behind
# ALLOW_PROD=1. You cannot flip a live user-facing flag by accident.
#
# WRITES ARE DELTAS. `set` changes ONLY the keys you named and leaves the rest
# of the blob untouched. It never re-materializes the code defaults into KV —
# that was the old bug where touching one flag rewrote all ~40.
#
# USAGE
#   scripts/flags.sh get                        # print the stored overrides
#   scripts/flags.sh get <key>                  # print one stored key
#   scripts/flags.sh effective                  # code defaults + stored overrides
#   scripts/flags.sh set k=v [k=v ...]          # merge those keys, keep the rest
#   scripts/flags.sh unset <key> [<key> ...]    # drop overrides -> code default wins
#   scripts/flags.sh prune                      # drop stored keys equal to the code default
#
#   Values: true | false | <number>
#
#   scripts/flags.sh set ringbackEnabled=true                # -> staging (default)
#   ALLOW_PROD=1 scripts/flags.sh set ringbackEnabled=true   # -> production
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF="$REPO_ROOT/scripts/cf.sh"
MERGE="$REPO_ROOT/scripts/_flags_merge.py"
KEY="platform_config"
BINDING="TOKENS"

kv_get() {
  # `|| echo {}` — the key may never have been written in this environment.
  "$CF" worker kv key get "$KEY" --binding "$BINDING" --remote 2>/dev/null || echo '{}'
}

kv_put() {
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  "$CF" worker kv key put "$KEY" --path "$tmp" --binding "$BINDING" --remote
  rm -f "$tmp"
}

# Extract the DEFAULTS object from routes/config.ts (single source of truth for
# which flags exist and what type each one is).
defaults_json() {
  local out; out="$(mktemp)"
  python3 - "$REPO_ROOT/worker/src/routes/config.ts" > "$out" <<'PY'
import re, sys, json
src = open(sys.argv[1]).read()
i = src.index("const DEFAULTS: PlatformConfig = {")
body, depth, end = src[i:], 0, None
for n, ch in enumerate(body):
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = n
            break
body = body[body.index('{'):end + 1]
body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
body = re.sub(r'//.*', '', body)
out = {}
for m in re.finditer(r'(\w+)\s*:\s*(true|false|-?\d+)', body):
    k, v = m.group(1), m.group(2)
    out[k] = True if v == 'true' else False if v == 'false' else int(v)
print(json.dumps(out))
PY
  echo "$out"
}

usage() { sed -n '2,27p' "$0" >&2; exit 64; }

CMD="${1:-}"; shift || true

case "$CMD" in
  get)
    blob="$(kv_get)"
    if [[ $# -eq 1 ]]; then
      python3 -c 'import json,sys
d = json.loads(sys.stdin.read() or "{}")
k = sys.argv[1]
print(json.dumps(d[k]) if k in d else "<no override — using the code default>")' "$1" <<<"$blob"
    else
      python3 -m json.tool <<<"${blob:-'{}'}"
    fi
    ;;

  effective)
    defs="$(defaults_json)"
    kv_get | python3 -c 'import json,sys
defs = json.loads(open(sys.argv[1]).read())
over = json.loads(sys.stdin.read() or "{}")
print(json.dumps({**defs, **over}, indent=2, sort_keys=True))' "$defs"
    rm -f "$defs"
    ;;

  set)
    [[ $# -ge 1 ]] || usage
    defs="$(defaults_json)"
    kv_get | python3 "$MERGE" merge "$defs" "$@" | kv_put
    rm -f "$defs"
    ;;

  unset)
    [[ $# -ge 1 ]] || usage
    defs="$(defaults_json)"
    kv_get | python3 "$MERGE" unset "$defs" "$@" | kv_put
    rm -f "$defs"
    ;;

  prune)
    defs="$(defaults_json)"
    kv_get | python3 "$MERGE" prune "$defs" | kv_put
    rm -f "$defs"
    ;;

  *) usage ;;
esac
