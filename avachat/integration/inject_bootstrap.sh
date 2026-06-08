#!/usr/bin/env bash
# Injects the AvaChat bootstrap into the 0xchat entrypoint WITHOUT committing a
# change into the 0xchat submodule. CI runs this after checkout; locally a dev
# can run it once. Idempotent.
#
# It:
#   1. adds `avachat` as a path dependency in 0xchat-app-main/pubspec.yaml
#   2. inserts `await AvaChatBootstrap.init();` before the first runApp(...) in
#      0xchat-app-main/lib/main.dart, plus the import.
#
# If 0xchat upstream changes its entrypoint, adjust the markers below.
set -euo pipefail

APP=external/0xchat-app-main
MAIN="$APP/lib/main.dart"
PUBSPEC="$APP/pubspec.yaml"

if ! grep -q "AvaChatBootstrap.init" "$MAIN"; then
  # import
  sed -i "1i import 'package:avachat/avachat.dart';" "$MAIN"
  # call before the first runApp(
  sed -i "0,/runApp(/s//await AvaChatBootstrap.init();\n  runApp(/" "$MAIN"
  echo "injected bootstrap into $MAIN"
else
  echo "bootstrap already present in $MAIN"
fi

if ! grep -q "avachat:" "$PUBSPEC"; then
  # add under dependencies: (path to our integration package)
  awk '
    /^dependencies:/ && !done {
      print; print "  avachat:"; print "    path: ../../avachat"; done=1; next
    } { print }
  ' "$PUBSPEC" > "$PUBSPEC.tmp" && mv "$PUBSPEC.tmp" "$PUBSPEC"
  echo "added avachat path dependency to $PUBSPEC"
else
  echo "avachat dependency already present in $PUBSPEC"
fi
