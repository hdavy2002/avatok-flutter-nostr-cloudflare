#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cf.sh — the ONLY approved way to run wrangler against AvaTok infrastructure.
#
# WHY THIS EXISTS
#   `wrangler deploy` and `wrangler kv key put ...` with no `--env` resolve the
#   TOP-LEVEL wrangler.toml block — i.e. PRODUCTION. There is no prompt, no
#   confirmation, no output that says "prod". A staging task typed without
#   `--env staging` silently rewrites production D1 bindings, KV flags, and the
#   live Worker. This wrapper removes that footgun.
#
# HOW THE TARGET IS RESOLVED (in order):
#   1. $AVATOK_TARGET  — explicit "prod" | "staging"
#   2. current git branch — `main` => prod, everything else => staging
#
# PRODUCTION IS FAIL-CLOSED. Resolving to prod aborts unless ALLOW_PROD=1 is
# set. Staging needs nothing. The safe path is the default path, so an agent or
# a human who doesn't know which environment this session is for lands on
# staging and cannot touch live users.
#
# USAGE
#   scripts/cf.sh <dir> <wrangler args...>
#     scripts/cf.sh worker deploy
#     ALLOW_PROD=1 scripts/cf.sh worker deploy
#     AVATOK_TARGET=staging scripts/cf.sh consumers deploy
#     scripts/cf.sh worker kv key get platform_config --binding TOKENS --remote
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 2 ]]; then
  echo "usage: scripts/cf.sh <dir> <wrangler args...>" >&2
  echo "  e.g. scripts/cf.sh worker deploy" >&2
  exit 64
fi

DIR="$1"; shift

if [[ ! -f "$REPO_ROOT/$DIR/wrangler.toml" ]]; then
  echo "cf.sh: no wrangler.toml in '$DIR'" >&2
  exit 66
fi

# --- resolve target -------------------------------------------------------
# Priority: env var  >  .avatok-target file  >  git branch. The FILE is the one
# the owner controls in plain English ("we're working on staging") — the AI
# writes it, reads it, and obeys it. Everything else is a fallback.
TARGET_FILE="$REPO_ROOT/.avatok-target"

if [[ -n "${AVATOK_TARGET:-}" ]]; then
  TARGET="$AVATOK_TARGET"
  SOURCE="AVATOK_TARGET env var"
elif [[ -f "$TARGET_FILE" ]]; then
  TARGET="$(tr -d '[:space:]' < "$TARGET_FILE")"
  SOURCE=".avatok-target file"
else
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [[ "$BRANCH" == "main" ]]; then
    TARGET="prod"
  else
    TARGET="staging"
  fi
  SOURCE="git branch '$BRANCH'"
fi

case "$TARGET" in
  prod|staging) ;;
  *) echo "cf.sh: AVATOK_TARGET must be 'prod' or 'staging' (got '$TARGET')" >&2; exit 64 ;;
esac

# --- production gate ------------------------------------------------------
if [[ "$TARGET" == "prod" && "${ALLOW_PROD:-}" != "1" ]]; then
  cat >&2 <<EOF

  ╔══════════════════════════════════════════════════════════════╗
  ║  REFUSING TO TOUCH PRODUCTION                                 ║
  ╚══════════════════════════════════════════════════════════════╝

  Resolved target : prod   (from $SOURCE)
  Command         : wrangler $* (in $DIR/)

  This would hit LIVE users: production D1, R2, KV feature flags and
  the deployed Worker. Nothing has been run.

  If you meant staging (you almost always do):
      AVATOK_TARGET=staging scripts/cf.sh $DIR $*
    or switch off the 'main' branch.

  If you really mean production, say so out loud:
      ALLOW_PROD=1 scripts/cf.sh $DIR $*

EOF
  exit 77
fi

# --- run ------------------------------------------------------------------
ENV_ARGS=()
[[ "$TARGET" == "staging" ]] && ENV_ARGS=(--env staging)

echo "cf.sh: target=$TARGET (from $SOURCE) dir=$DIR" >&2
[[ "$TARGET" == "prod" ]] && echo "cf.sh: *** PRODUCTION — ALLOW_PROD=1 was set ***" >&2

cd "$REPO_ROOT/$DIR"
# macOS ships bash 3.2, where expanding an EMPTY array under `set -u` throws
# "ENV_ARGS[@]: unbound variable" (fixed only in bash 4.4). The ${arr[@]+...}
# idiom expands to nothing when the array is empty — prod deploys (no --env
# flag) died on this exact line.
exec npx wrangler "$@" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"}
