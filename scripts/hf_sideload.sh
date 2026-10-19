#!/usr/bin/env bash
# [HF-SIDELOAD-1] Install a CI-built Hello Fraands APK on the USB-connected phone (owner decision 2026-10-20).
# No local Flutter / Android SDK: CI builds the APK (hf-flutter.yml mode=apk), this only downloads and installs it.
#
#   scripts/hf_sideload.sh                 # newest successful mode=apk run
#   scripts/hf_sideload.sh <run-id>        # a specific run
#   scripts/hf_sideload.sh --fresh [id]    # uninstall first (needed once when switching from the Play build: different signing key; logs you out)
#
# Needs: adb + scrcpy (brew install --cask android-platform-tools; brew install scrcpy), gh logged in.
set -euo pipefail
cd "$(dirname "$0")/.."

FRESH=0
if [[ "${1:-}" == "--fresh" ]]; then FRESH=1; shift; fi
RUN="${1:-}"
PKG=$(python3 -c "import json;print(json.load(open('Specs/brand.json'))['hfPlayPackageId'])")

DEV=$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')
[[ -n "$DEV" ]] || { echo "No phone. Turn on USB debugging, plug in, unlock, tap Allow."; adb devices -l; exit 1; }

OUT=$(mktemp -d)
if [[ -n "$RUN" ]]; then
  gh run download "$RUN" -n hf-flutter-apk -D "$OUT"
else
  # newest successful run that carries an APK artifact (mode=apk)
  for id in $(gh run list --workflow hf-flutter.yml --status success -L 30 --json databaseId --jq '.[].databaseId'); do
    if gh run download "$id" -n hf-flutter-apk -D "$OUT" >/dev/null 2>&1; then RUN=$id; break; fi
  done
fi
APK=$(ls "$OUT"/*.apk 2>/dev/null | head -1 || true)
[[ -n "$APK" ]] || { echo "No APK found. Start one: gh workflow run hf-flutter.yml --ref main -f mode=apk -f demo=false"; exit 1; }
echo "Using APK from run $RUN"

if [[ $FRESH == 1 ]]; then
  echo "Removing the installed app first (you will be signed out) ..."
  adb -s "$DEV" uninstall "$PKG" >/dev/null 2>&1 || true
fi
echo "Installing on $DEV ..."
if ! adb -s "$DEV" install -r "$APK"; then
  echo "Install refused. If it says INSTALL_FAILED_UPDATE_INCOMPATIBLE, the phone has the Play build (other signing key): re-run with --fresh."
  exit 1
fi
adb -s "$DEV" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
echo "Installed run $RUN on $DEV and opened it. Mirror the screen with: scrcpy"
rm -rf "$OUT"
