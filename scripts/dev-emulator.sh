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
if [ "$AVATOK_BACKEND" = "staging" ]; then
  AVATOK_DEFINE="--dart-define=AVATOK_ENV=staging"
  # Gradle reads the environment variable (not the Dart define) to add the
  # `.staging` applicationId suffix. Export both halves so a physical-device
  # debug run installs beside production instead of replacing it.
  export AVATOK_ENV=staging
fi
LOG=/tmp/flutter_run.log
tool_pids() { pgrep -f "dart-sdk/bin/dart.*flutter_tools.snapshot run"; }

case "$1" in
  reload)  p=$(tool_pids); [ -n "$p" ] && { echo "$p" | xargs kill -SIGUSR1; echo "hot reload sent to all sessions"; } || echo "app not running";;
  restart) p=$(tool_pids); [ -n "$p" ] && { echo "$p" | xargs kill -SIGUSR2; echo "hot restart sent to all sessions"; } || echo "app not running";;
  stop)    p=$(tool_pids); [ -n "$p" ] && { echo "$p" | xargs kill; echo stopped; } || echo "not running";;
  phones)
    cd "$APP" || exit 1
    devices=$(adb devices | awk 'NR>1 && $2 == "device" && $1 !~ /^emulator-/ { print $1 }')
    [ -n "$devices" ] || { echo "no physical phones attached"; exit 1; }
    for device in $devices; do
      log="/tmp/flutter_run_${device}.log"
      echo "starting hot-reload session on $device"
      nohup flutter run -d "$device" --debug $AVATOK_DEFINE $GIT_DEFINE > "$log" 2>&1 &
      echo "logs: $log"
    done
    ;;
  phone)
    [ -n "$2" ] || { echo "usage: $0 phone <device-serial>"; exit 1; }
    cd "$APP" || exit 1
    exec flutter run -d "$2" --debug $AVATOK_DEFINE $GIT_DEFINE
    ;;
  attach)
    [ -n "$2" ] || { echo "usage: $0 attach <device-serial>"; exit 1; }
    adb -s "$2" shell am start -n ai.avatok.avatok_call/.MainActivity >/dev/null
    cd "$APP" || exit 1
    exec flutter attach -d "$2"
    ;;
  log)     tr '\r' '\n' < "$LOG" | grep -v "^[[:space:]]*$" | tail -40;;
  *)
    # [CALL-MIC-OBS-1] `-allow-host-audio` is MANDATORY for any call testing.
    #
    # Without it the emulator does not fail, warn, or deny the microphone — it
    # hands the guest a perfectly working AudioRecord that returns ZEROS. The
    # emulator's own help text says so: "Allows sending of audio from audio
    # input devices. Otherwise, zeroes out audio."
    #
    # Cost of not knowing that (2026-08-03/04): eight consecutive emulator→phone
    # calls where the phone reported `remote_quiet` with inbound audio_level
    # pinned at ~3e-05 while receiving a flawless 250-packet/5s RTP stream at 0%
    # concealment. Inside the guest everything passed — RECORD_AUDIO granted,
    # hw.audioInput=yes, `verifyAudioConfig: PASS` on TYPE_BUILTIN_MIC — so the
    # silence was invisible from every angle except this flag. It also sent a
    # real audio-focus bug hunt down the wrong path first.
    #
    # `flutter emulators --launch` cannot pass emulator flags, so boot the
    # emulator directly. Falls back to the flutter path if the binary moves.
    adb devices | grep -q emulator- || { echo "booting emulator (host audio input ENABLED)..."
      if [ -x "$ANDROID_HOME/emulator/emulator" ]; then
        nohup "$ANDROID_HOME/emulator/emulator" -avd Pixel_10a -allow-host-audio >/dev/null 2>&1 &
      else
        echo "WARNING: emulator binary not found; falling back WITHOUT -allow-host-audio (mic will be silent)"
        nohup flutter emulators --launch Pixel_10a >/dev/null 2>&1 &
      fi
      for i in $(seq 1 60); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 5; done; }
    cd "$APP" || exit 1
    echo "starting app (first build after a clean is slow; later runs ~1-2 min)"
    nohup flutter run -d emulator-5554 --debug $AVATOK_DEFINE $GIT_DEFINE > "$LOG" 2>&1 &
    echo "logs: tail -f $LOG   |   reload: $0 reload";;
esac
