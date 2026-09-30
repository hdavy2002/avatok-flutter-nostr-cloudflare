#!/usr/bin/env bash
# [SAATHUM-BRAND-CENTRAL-GUARD-2 2026-09-30] pre-push: refuse to publish a commit that
# adds a hand-typed brand name/domain (see CLAUDE.md "BRAND NAME + DOMAIN COME FROM ONE
# FILE"). Checks the COMMIT being pushed, not the working tree.
#
# Installed into the shared .git/hooks/pre-push on the owner's Mac by
# scripts/hooks/install-brand-guard.sh. Reads git's pre-push stdin:
#   <local_ref> <local_sha> <remote_ref> <remote_sha>
set -u
ZERO="0000000000000000000000000000000000000000"
TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
CHECKER="$TOP/scripts/check_brand_literals.py"
[ -f "$CHECKER" ] || exit 0

status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  [ "$local_sha" = "$ZERO" ] && continue            # branch deletion
  # Only commits that carry the guard's baseline can be judged by it.
  git cat-file -e "$local_sha:tool/brand_literals_baseline.json" 2>/dev/null || continue
  if ! python3 "$CHECKER" --rev "$local_sha"; then
    echo "pre-push: BLOCKED $local_ref -> $remote_ref — new hand-typed brand name/domain." >&2
    echo "pre-push: use BRAND (web/worker/consumers), Brand (Flutter) or {brand} (i18n); commit the fix; push again." >&2
    status=1
  fi
done
exit $status
