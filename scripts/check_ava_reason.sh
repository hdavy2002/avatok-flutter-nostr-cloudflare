#!/usr/bin/env bash
#
# check_ava_reason.sh — AVA Engineering Law gate (AVA-CORE-6)
#
# THE SACRED RULE: no feature may call an LLM directly. Every AI invocation must
# go through ODL -> Governor -> Capability Registry -> avaReason(). This script is
# the grep gate that enforces it: it scans worker/src and consumers/src for direct
# model-call markers and fails if any appear OUTSIDE the ava_reason helper modules
# and OUTSIDE the ratcheting allowlist.
#
# macOS-compatible: plain POSIX grep only (no GNU-only flags), fixed-string (-F)
# matching so the marker punctuation is treated literally.
#
# Exit 0 => clean (only the one-line OK summary). Exit 1 => offenders listed.
#
# The allowlist (scripts/ava_reason_allowlist.txt) is a RATCHET: it was seeded with
# every pre-Phase-0 call site that had not yet been migrated. Removing a line as a
# call site migrates to avaReason() is expected and needs no review. ADDING a line
# is a review event — it means new direct-LLM code was introduced and someone must
# justify it.
#
# NOT wired into CI (builds are manual by owner decision); run by agents/humans and
# by future CI once builds are automated.

set -u

# Resolve repo root from this script's location (scripts/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "check_ava_reason: cannot cd to repo root" >&2; exit 2; }

ALLOWLIST="scripts/ava_reason_allowlist.txt"
SCAN_DIRS="worker/src consumers/src"

# Direct model-call markers (literal fixed strings).
MARKERS='openrouter.ai
env.AI.run(
.AI.run(
api.openai.com
generativelanguage.googleapis.com
api.deepseek.com'

# Build the grep -e arguments from the markers.
GREP_ARGS=()
while IFS= read -r m; do
  [ -n "$m" ] && GREP_ARGS+=(-e "$m")
done <<EOF
$MARKERS
EOF

# Collect raw matches (file:line:content) across the scan dirs.
RAW="$(grep -rnF "${GREP_ARGS[@]}" $SCAN_DIRS 2>/dev/null)"

# Load allowlisted relative paths (skip blanks and # comments; strip whitespace).
ALLOWED=""
if [ -f "$ALLOWLIST" ]; then
  ALLOWED="$(sed 's/#.*//' "$ALLOWLIST" | sed 's/[[:space:]]//g' | grep -v '^$' || true)"
fi

is_allowed() {
  # $1 = file path. Tolerated if it contains "ava_reason" or is in the allowlist.
  case "$1" in
    *ava_reason*) return 0 ;;
  esac
  [ -n "$ALLOWED" ] || return 1
  printf '%s\n' "$ALLOWED" | grep -qxF "$1"
}

OFFENDERS=""
OFFENDER_COUNT=0
if [ -n "$RAW" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    file="${line%%:*}"
    if is_allowed "$file"; then
      continue
    fi
    OFFENDERS="${OFFENDERS}${line}
"
    OFFENDER_COUNT=$((OFFENDER_COUNT + 1))
  done <<EOF
$RAW
EOF
fi

if [ "$OFFENDER_COUNT" -gt 0 ]; then
  echo "check_ava_reason: FAIL — $OFFENDER_COUNT direct model-call site(s) outside avaReason() and not allowlisted:" >&2
  echo "" >&2
  printf '%s' "$OFFENDERS" >&2
  echo "" >&2
  echo "Fix: route the call through avaReason() (worker/src/lib/ava_reason.ts or" >&2
  echo "consumers/src/ava_reason.ts). If this is a legitimate migration-in-progress," >&2
  echo "add the file to $ALLOWLIST — this is a REVIEW EVENT and needs an owner sign-off." >&2
  exit 1
fi

echo "check_ava_reason: OK — no direct model-call sites outside avaReason() (allowlist entries tolerated)."
exit 0
