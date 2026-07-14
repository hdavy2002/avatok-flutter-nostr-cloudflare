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
  # A MISSING KEY AND A FAILED READ ARE NOT THE SAME THING.
  #
  # This used to be `... 2>/dev/null || echo '{}'`, which collapsed every
  # failure into an empty blob. cf.sh is fail-closed on production (it aborts
  # unless ALLOW_PROD=1), so `scripts/flags.sh get` against prod printed a
  # confident `{}` — INDISTINGUISHABLE from "production has no overrides", and
  # `effective` then reported the bare code defaults as if they were live. Prod
  # actually carries a full override blob (callMenuEnabled, receptTakeoverGuard,
  # shellV2, …), so this silently invited exactly the wrong conclusion about
  # what live users are running. 2026-07-14: it nearly did.
  #
  # Now: only a genuinely-absent key falls back to `{}`. Anything else is loud
  # and non-zero, so `set -e`/`pipefail` stops the caller rather than merging
  # into a phantom empty blob.
  local out err rc=0
  err="$(mktemp)"
  out="$("$CF" worker kv key get "$KEY" --binding "$BINDING" --remote 2>"$err")" || rc=$?
  if [[ $rc -eq 0 ]]; then
    rm -f "$err"
    # A written-but-empty value is still "no overrides".
    if [[ -z "${out//[[:space:]]/}" ]]; then echo '{}'; else printf '%s\n' "$out"; fi
    return 0
  fi
  # ONLY a genuine get-miss may fall back to `{}`. Keep this pattern NARROW: a
  # bare `not found` also matches "npx: command not found", "Namespace not
  # found", "Account not found" and auth failures — each of which would then be
  # reported as "production has no overrides" and, worse, let a merge write that
  # phantom blob back. Cloudflare returns code 10009 for a KV get-miss.
  if grep -qiE 'key not found|10009' "$err"; then
    rm -f "$err"
    echo '{}' # the key has never been written in this environment — genuinely empty
    return 0
  fi
  echo "flags.sh: FAILED to read '$KEY' — this is NOT an empty blob." >&2
  # Resolve the target the way cf.sh does (env > .avatok-target > branch) so the
  # hint is accurate: treating an UNSET env var as prod told people chasing a
  # genuine staging failure to go find a permissions problem that isn't there.
  local _tgt="${AVATOK_TARGET:-}"
  if [[ -z "$_tgt" && -f "$REPO_ROOT/.avatok-target" ]]; then
    _tgt="$(tr -d '[:space:]' < "$REPO_ROOT/.avatok-target")"
  fi
  if [[ "$_tgt" == "prod" && "${ALLOW_PROD:-}" != "1" ]]; then
    echo "flags.sh: reading PRODUCTION flags requires ALLOW_PROD=1 (reads are safe):" >&2
    echo "flags.sh:   ALLOW_PROD=1 scripts/flags.sh get" >&2
  fi
  sed 's/^/flags.sh: /' "$err" >&2
  rm -f "$err"
  return 1
}

kv_put() {
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  # LAST LINE OF DEFENCE — never write a ZERO-BYTE or non-JSON blob over live
  # flags. kv_put only ever sees EOF when an upstream stage died, so "no bytes"
  # always means "something failed", never "the user wants no overrides"; such a
  # write silently reverts every override to the code default for live users and
  # then reads back as a perfectly innocent `{}`.
  #
  # NOTE a literal `{}` IS legitimate and must be allowed through — that's the
  # normal result of `prune` when every override equals its code default, or of
  # `unset`ting the last remaining key. Only the empty FILE is the failure
  # signal. (Rejecting `{}` here would silently break prune/unset.)
  if [[ ! -s "$tmp" ]] || ! python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if isinstance(d, dict) else 1)' "$tmp" 2>/dev/null; then
    echo "flags.sh: REFUSING to write an empty/invalid platform_config." >&2
    echo "flags.sh: an upstream stage failed — the stored blob is untouched." >&2
    rm -f "$tmp"; return 1
  fi
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

  # ── NEVER pipe kv_get straight into kv_put ────────────────────────────────
  # Pipeline members run CONCURRENTLY: kv_put would already have WRITTEN by the
  # time bash evaluates the pipeline's exit status, so `set -e`/`pipefail` gives
  # you no protection at all. A failed read prints nothing on stdout, the merge
  # helper turns empty stdin into `{}`, and kv_put then writes a one-key blob
  # OVER THE REAL FLAGS — every override (callMenuEnabled, receptTakeoverGuard,
  # shellV2, …) silently reverts to code defaults for live users. The prod gate
  # only masks this while it's refusing; the live hazard is a TRANSIENT read
  # failure during `ALLOW_PROD=1 flags.sh set …`, i.e. exactly when someone is
  # deliberately flipping a production flag.
  #
  # So: materialise EVERY stage into a variable first. `blob="$(kv_get)"` and
  # `new="$(… "$MERGE" …)"` each make `set -e` abort BEFORE kv_put can run. The
  # merge stage matters just as much as the read: _flags_merge.py exits non-zero
  # on an unknown flag, a bad value type, or a malformed k=v — so a single typo
  # (`set ringbackEnabld=true`) would otherwise hand kv_put zero bytes and wipe
  # the blob. kv_put refuses empty input as a backstop, but don't rely on it.
  effective)
    defs="$(defaults_json)"; trap 'rm -f "$defs"' EXIT
    blob="$(kv_get)"
    python3 -c 'import json,sys
defs = json.loads(open(sys.argv[1]).read())
over = json.loads(sys.stdin.read() or "{}")
print(json.dumps({**defs, **over}, indent=2, sort_keys=True))' "$defs" <<<"$blob"
    ;;

  set)
    [[ $# -ge 1 ]] || usage
    defs="$(defaults_json)"; trap 'rm -f "$defs"' EXIT
    blob="$(kv_get)"
    new="$(printf '%s' "$blob" | python3 "$MERGE" merge "$defs" "$@")"
    printf '%s' "$new" | kv_put
    ;;

  unset)
    [[ $# -ge 1 ]] || usage
    defs="$(defaults_json)"; trap 'rm -f "$defs"' EXIT
    blob="$(kv_get)"
    new="$(printf '%s' "$blob" | python3 "$MERGE" unset "$defs" "$@")"
    printf '%s' "$new" | kv_put
    ;;

  prune)
    defs="$(defaults_json)"; trap 'rm -f "$defs"' EXIT
    blob="$(kv_get)"
    new="$(printf '%s' "$blob" | python3 "$MERGE" prune "$defs")"
    printf '%s' "$new" | kv_put
    ;;

  *) usage ;;
esac
