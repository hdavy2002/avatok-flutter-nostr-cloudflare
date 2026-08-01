#!/bin/bash
# Local emulator dev loop for AvaTOK (set up 2026-07-31).
#   ./scripts/dev-emulator.sh          -> boot emulator + run app with hot reload
#   ./scripts/dev-emulator.sh reload   -> hot reload  (design changes, keeps app state)
#   ./scripts/dev-emulator.sh restart  -> hot restart (full Dart restart)
#   ./scripts/dev-emulator.sh stop     -> stop the run
# Build output goes to ~/.avatok-build (kept OUT of iCloud on purpose).
export PATH="$HOME/development/flutter/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
APP="$(cd "$(dirname "$0")/../app" && pwd)"
# Backend: PROD by default (real account + content, same as the phone build).
# Use  AVATOK_BACKEND=staging ./scripts/dev-emulator.sh  for the staging worker.
# NOTE 2026-07-31: staging D1 is missing avatok_numbers.sql, so /api/me 500s there.
AVATOK_DEFINE=""
# Stamp the real commit into the build so the About screen shows exactly which
# code is running (CI does this via --dart-define=GIT_SHA; locally it defaulted
# to the useless literal "dev"). Appends -dirty when the tree has uncommitted work.
_sha=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null)
git -C "$(dirname "$0")/.." diff --quiet 2>/dev/null || _sha="${_sha}-dirty"
GIT_DEFINE="--dart-define=GIT_SHA=${_sha:-unknown}"
[ "$AVATOK_BACKEND" = "staging" ] && AVATOK_DEFINE="--dart-define=AVATOK_ENV=staging"
LOG=/tmp/flutter_run.log
tool_pid() { pgrep -f "dart-sdk/bin/dart.*flutter_tools.snapshot run" | head -1; }

case "$1" in
  reload)  p=$(tool_pid); [ -n "$p" ] && kill -SIGUSR1 "$p" && echo "hot reload sent"  || echo "app not running";;
  restart) p=$(tool_pid); [ -n "$p" ] && kill -SIGUSR2 "$p" && echo "hot restart sent" || echo "app not running";;
  stop)    p=$(tool_pid); [ -n "$p" ] && kill "$p" && echo stopped || echo "not running";;
  log)     tr '\r' '\n' < "$LOG" | grep -v "^[[:space:]]*$" | tail -40;;
  *)
    adb devices | grep -q emulator- || { echo "booting emulator..."; nohup flutter emulators --launch Pixel_10a >/dev/null 2>&1 &
      for i in $(seq 1 60); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 5; done; }
    cd "$APP" || exit 1
    echo "starting app (first build after a clean is slow; later runs ~1-2 min)"
    nohup flutter run -d emulator-5554 --debug $AVATOK_DEFINE $GIT_DEFINE > "$LOG" 2>&1 &
    echo "logs: tail -f $LOG   |   reload: $0 reload";;
esac
