#!/usr/bin/env bash
set -euo pipefail

# Device-lab harness only. It never builds or deploys. The operator starts the
# already-approved CI artifact/debug session, then uses this to capture the
# device and app evidence required by Wave 13/Wave 9.
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/development/flutter/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

case "${1:-check}" in
  check)
    adb devices
    echo "Flutter session:"
    pgrep -af "flutter_tools.snapshot run" || true
    ;;
  log)
    adb logcat -v threadtime -s flutter:* WebRTC:* AudioTrack:* AudioManager:* \
      | tee "$project_dir/device-lab-conference.log"
    ;;
  snapshot)
    out="$project_dir/device-lab-$(date +%Y%m%d-%H%M%S).txt"
    {
      echo "timestamp=$(date -u +%FT%TZ)"
      adb devices
      adb shell dumpsys media.audio_flinger
      adb shell dumpsys audio
      adb shell dumpsys bluetooth_manager
      adb shell dumpsys connectivity
    } > "$out"
    echo "$out"
    ;;
  *)
    echo "usage: $0 [check|log|snapshot]" >&2
    exit 2
    ;;
esac
