#!/usr/bin/env bash
#
# build-dmg.sh — Build a styled, UNSIGNED AvaTok .dmg for direct-download testing.
#
# Run on a Mac (DMG creation + Flutter macOS build are macOS-only).
# Prereqs:
#   - Flutter with macOS desktop enabled  (flutter config --enable-macos-desktop)
#   - The macOS target generated          (flutter create --platforms=macos .  in app/)
#   - create-dmg                          (brew install create-dmg)
#
# This produces dist/AvaTok.dmg with the branded background + drag-to-Applications
# layout. It is NOT signed or notarized — fine for testing on your own Mac.
# First launch on any Mac: right-click AvaTok.app → Open (to bypass Gatekeeper),
# or run:  xattr -dr com.apple.quarantine /Applications/AvaTok.app
#
set -euo pipefail

# ---- paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
ASSETS_DIR="$SCRIPT_DIR/assets"
DIST_DIR="$SCRIPT_DIR/dist"

APP_NAME="AvaTok"                       # display name shown in Finder / .app
BUILT_APP="$APP_DIR/build/macos/Build/Products/Release/avatok_call.app"
STAGED_APP="$DIST_DIR/$APP_NAME.app"    # renamed copy used for packaging
DMG_OUT="$DIST_DIR/$APP_NAME.dmg"
BG_IMG="$ASSETS_DIR/dmg-background.png" # @2x sibling auto-used by Finder

# ---- 1. build the macOS app (release) ------------------------------------
echo "==> flutter build macos --release"
cd "$APP_DIR"
flutter build macos --release

if [[ ! -d "$BUILT_APP" ]]; then
  echo "ERROR: build not found at $BUILT_APP" >&2
  echo "       (check the product name in macos/Runner.xcodeproj if it differs)" >&2
  exit 1
fi

# ---- 2. stage a renamed copy (so Finder shows 'AvaTok', not 'avatok_call') ----
echo "==> staging $APP_NAME.app"
rm -rf "$DIST_DIR"; mkdir -p "$DIST_DIR"
cp -R "$BUILT_APP" "$STAGED_APP"

# Strip any inherited quarantine + apply an ad-hoc signature so the app at least
# launches cleanly on the BUILDING Mac without re-triggering "damaged app".
xattr -cr "$STAGED_APP" || true
codesign --force --deep --sign - "$STAGED_APP" || true   # '-' = ad-hoc (unsigned)

# ---- 3. build the styled DMG --------------------------------------------
echo "==> create-dmg"
rm -f "$DMG_OUT"
create-dmg \
  --volname "$APP_NAME" \
  --background "$BG_IMG" \
  --window-pos 200 120 \
  --window-size 660 420 \
  --icon-size 128 \
  --icon "$APP_NAME.app" 175 212 \
  --app-drop-link 486 212 \
  --hide-extension "$APP_NAME.app" \
  --no-internet-enable \
  "$DMG_OUT" \
  "$STAGED_APP"

echo ""
echo "==> Done:  $DMG_OUT"
echo "    Test:  open \"$DMG_OUT\"  then drag AvaTok to Applications."
echo "    First run: right-click AvaTok.app → Open (unsigned build)."
