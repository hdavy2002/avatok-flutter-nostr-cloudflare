#!/usr/bin/env bash
# push_apk.sh — FRESH-install one APK onto EVERY connected Android target (phone + emulator).
#
# This is the "ship local" installer. It does NOT build anything — install only.
#
# Usage:
#   scripts/push_apk.sh                              # newest APK under app/build/ -> BOTH targets
#   scripts/push_apk.sh path/to/app.apk              # that APK -> BOTH targets
#   scripts/push_apk.sh path/to/app.apk ZA223K79KG   # that APK -> one serial only
#   scripts/push_apk.sh --keep-data [apk] [serial]   # in-place upgrade instead of fresh install
#
# DEFAULT IS A FRESH INSTALL: the package is UNINSTALLED first, then installed clean.
# Owner decision 2026-08-22 — the emulator hangs on in-place updates, so `adb install -r`
# is NOT the default. A fresh install WIPES APP DATA (you will be logged out on both
# targets). Use --keep-data when you specifically need the existing session preserved.
set -uo pipefail

ADB="${ADB:-/Users/davy/Library/Android/sdk/platform-tools/adb}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${PKG:-ai.avatok.avatok_call}"

FRESH=1
if [ "${1:-}" = "--keep-data" ]; then FRESH=0; shift; fi

[ -x "$ADB" ] || { echo "adb not found at $ADB (override with ADB=/path)"; exit 1; }

APK="${1:-}"
ONLY="${2:-}"

if [ -z "$APK" ]; then
  APK="$(find "$REPO/app/build" -name '*.apk' -type f -print0 2>/dev/null \
        | xargs -0 ls -t 2>/dev/null | head -1)"
  [ -n "$APK" ] || { echo "No APK found under app/build — pass one explicitly."; exit 1; }
  echo "Auto-selected newest APK: $APK"
fi
[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }

"$ADB" start-server >/dev/null 2>&1

# bash 3.2 safe (macOS ships 3.2 — no mapfile)
TARGETS=()
while IFS= read -r line; do
  [ -n "$line" ] && TARGETS+=("$line")
done < <("$ADB" devices | awk 'NR>1 && $2=="device"{print $1}')
if [ -n "$ONLY" ]; then TARGETS=("$ONLY"); fi
[ "${#TARGETS[@]}" -gt 0 ] || { echo "No authorized devices. Check USB debugging / 'adb devices'."; exit 1; }

echo "APK:  $APK  ($(du -h "$APK" | cut -f1))"
echo "Mode: $([ "$FRESH" = 1 ] && echo 'FRESH install (uninstall first — app data will be wiped)' || echo 'in-place upgrade (keeps data)')"
echo "Pkg:  $PKG"
echo "Targets: ${TARGETS[*]}"
echo

FAIL=0
for S in "${TARGETS[@]}"; do
  NAME="$("$ADB" -s "$S" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  echo "==> $S  ($NAME)"

  # Stop the running app first — installing over a live process is what wedges the emulator.
  "$ADB" -s "$S" shell am force-stop "$PKG" >/dev/null 2>&1

  if [ "$FRESH" = 1 ]; then
    echo "    uninstalling $PKG ..."
    "$ADB" -s "$S" uninstall "$PKG" >/dev/null 2>&1 || echo "    (not installed — continuing)"
    if "$ADB" -s "$S" install "$APK"; then
      echo "    OK (fresh install)"
    else
      echo "    FAILED"; FAIL=1
    fi
  else
    if "$ADB" -s "$S" install -r -d "$APK"; then
      echo "    OK (upgrade, data kept)"
    else
      echo "    upgrade failed — falling back to fresh install"
      "$ADB" -s "$S" uninstall "$PKG" >/dev/null 2>&1
      if "$ADB" -s "$S" install "$APK"; then echo "    OK (fresh install)"; else echo "    FAILED"; FAIL=1; fi
    fi
  fi
  echo
done

exit $FAIL
