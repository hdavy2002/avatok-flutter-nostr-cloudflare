#!/usr/bin/env bash
# [SAATHUM-BRAND-CENTRAL-GUARD-2] Install the brand guard in front of the existing
# pre-push hook (the graphify/graphiti one, which never blocks). Idempotent.
#   bash scripts/hooks/install-brand-guard.sh
set -eu
HOOKS="$(git rev-parse --git-common-dir)/hooks"
HOOK="$HOOKS/pre-push"
if [ -f "$HOOK" ] && grep -q "SAATHUM-BRAND-CENTRAL-GUARD-2" "$HOOK"; then
  echo "brand guard already installed in $HOOK"; exit 0
fi
if [ -f "$HOOK" ]; then mv "$HOOK" "$HOOKS/pre-push.graphiti"; fi
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# [SAATHUM-BRAND-CENTRAL-GUARD-2] 1) brand guard (blocks)  2) graphiti hook (never blocks)
INPUT="$(cat)"
TOP="$(git rev-parse --show-toplevel 2>/dev/null)"
GUARD="$TOP/scripts/hooks/pre-push-brand-guard.sh"
if [ -f "$GUARD" ]; then
  printf '%s\n' "$INPUT" | bash "$GUARD" || exit 1
fi
NEXT="$(dirname "$0")/pre-push.graphiti"
[ -x "$NEXT" ] && printf '%s\n' "$INPUT" | "$NEXT" "$@"
exit 0
EOF
chmod +x "$HOOK"
echo "brand guard installed in $HOOK (previous hook kept as pre-push.graphiti)"
