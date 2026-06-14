#!/usr/bin/env python3
"""Patch the Flutter-generated macos/ project for AvaTok desktop (test .dmg).

Run AFTER `flutter create --platforms=macos .` in CI. Idempotent.

- Info.plist: display name "AvaTok" + camera/mic usage strings (so macOS doesn't
  kill the app the first time a call uses them).
- Entitlements (Release + DebugProfile): add the capabilities the app actually
  needs — outbound network (HTTP/WebSocket/WebRTC), camera, microphone, and
  user-selected file read/write. Without network.client the RELEASE build has no
  network access (the classic "works in debug, dead in release" macOS trap).
- Min window size + default size in MainFlutterWindow.swift for a desktop feel.

This is the macOS sibling of tool/postcreate.py (Android).
"""
import plistlib
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]            # app/
MACOS = APP / "macos"
RUNNER = MACOS / "Runner"

DISPLAY_NAME = "AvaTok"

INFO_ADDITIONS = {
    "CFBundleDisplayName": DISPLAY_NAME,
    "NSCameraUsageDescription": "AvaTok uses the camera for video calls.",
    "NSMicrophoneUsageDescription": "AvaTok uses the microphone for calls and voice notes.",
}

ENTITLEMENTS_ADDITIONS = {
    "com.apple.security.network.client": True,
    "com.apple.security.network.server": True,
    "com.apple.security.device.camera": True,
    "com.apple.security.device.audio-input": True,
    "com.apple.security.files.user-selected.read-write": True,
}


def patch_plist(path: Path, additions: dict):
    if not path.exists():
        print(f"  ! missing {path}", file=sys.stderr)
        return
    with path.open("rb") as f:
        data = plistlib.load(f)
    changed = False
    for k, v in additions.items():
        if data.get(k) != v:
            data[k] = v
            changed = True
    if changed:
        with path.open("wb") as f:
            plistlib.dump(data, f)
        print(f"  patched {path.relative_to(APP)}")
    else:
        print(f"  ok (unchanged) {path.relative_to(APP)}")


def patch_podfile():
    """Firebase macOS SDK needs a modern deployment target; Flutter defaults to
    10.14 which is too low (and trips FirebaseCoreInternal). Bump to 11.0 and
    force every Pod target's MACOSX_DEPLOYMENT_TARGET so the privacy-bundle
    sub-targets stop defaulting to 10.11."""
    pf = MACOS / "Podfile"
    if not pf.exists():
        print("  ! Podfile missing", file=sys.stderr)
        return
    src = pf.read_text()
    new = re.sub(r"platform :osx, '[\d.]+'", "platform :osx, '11.0'", src)
    if "AVATOK_DEPLOYMENT_TARGET" not in new:
        hook = (
            "\n# AVATOK_DEPLOYMENT_TARGET — force a modern target on every pod\n"
            "post_install do |installer|\n"
            "  installer.pods_project.targets.each do |target|\n"
            "    flutter_additional_macos_build_settings(target)\n"
            "    target.build_configurations.each do |config|\n"
            "      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '11.0'\n"
            "    end\n"
            "  end\n"
            "end\n"
        )
        # Drop in our own post_install; remove the stock one Flutter generated to
        # avoid defining it twice.
        new = re.sub(
            r"post_install do \|installer\|.*?\nend\n",
            "",
            new,
            flags=re.DOTALL,
        )
        new = new + hook
    if new != src:
        pf.write_text(new)
        print("  patched Podfile (deployment target 11.0)")
    else:
        print("  ok (unchanged) Podfile")


def patch_window():
    """Set a sensible minimum + default window size for desktop."""
    sw = RUNNER / "MainFlutterWindow.swift"
    if not sw.exists():
        print("  ! MainFlutterWindow.swift missing", file=sys.stderr)
        return
    src = sw.read_text()
    if "AVATOK_WINDOW_SIZE" in src:
        print("  ok (unchanged) MainFlutterWindow.swift")
        return
    inject = (
        "    // AVATOK_WINDOW_SIZE — desktop default + minimum\n"
        "    self.minSize = NSSize(width: 900, height: 640)\n"
        "    self.setContentSize(NSSize(width: 1180, height: 800))\n"
    )
    # Insert right after the window's super.awakeFromNib() / setFrame call.
    m = re.search(r"(self\.setFrame\([^\n]*\n)", src)
    if m:
        src = src[: m.end()] + inject + src[m.end():]
    else:
        # Fallback: inject after RegisterGeneratedPlugins or in awakeFromNib.
        src = src.replace(
            "super.awakeFromNib()",
            "super.awakeFromNib()\n" + inject,
            1,
        )
    sw.write_text(src)
    print("  patched MainFlutterWindow.swift (window size)")


def main():
    if not MACOS.exists():
        print("ERROR: macos/ not found — run `flutter create --platforms=macos .` first",
              file=sys.stderr)
        sys.exit(1)
    print("postcreate_macos:")
    patch_plist(RUNNER / "Info.plist", INFO_ADDITIONS)
    patch_plist(RUNNER / "Release.entitlements", ENTITLEMENTS_ADDITIONS)
    patch_plist(RUNNER / "DebugProfile.entitlements", ENTITLEMENTS_ADDITIONS)
    patch_podfile()
    patch_window()
    print("done.")


if __name__ == "__main__":
    main()
