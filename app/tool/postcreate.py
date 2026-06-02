#!/usr/bin/env python3
"""Patch the Flutter-generated android/ project for WebRTC calling.

Run AFTER `flutter create --platforms=android .` in CI. Idempotent.
- Adds camera/mic/network permissions to the main AndroidManifest.xml
- Bumps minSdk to 24 (flutter_webrtc needs >=23; spec wants 24)
"""
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]  # app/
PERMS = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_CONNECT",
]


def patch_manifest() -> None:
    man = APP / "android/app/src/main/AndroidManifest.xml"
    if not man.exists():
        print(f"!! manifest not found at {man}")
        sys.exit(1)
    text = man.read_text()
    lines = []
    for p in PERMS:
        if p not in text:
            lines.append(f'    <uses-permission android:name="{p}" />')
    if lines:
        block = "\n".join(lines) + "\n"
        text = re.sub(r"(<manifest[^>]*>)", r"\1\n" + block, text, count=1)
        man.write_text(text)
        print(f"manifest: added {len(lines)} permission(s)")
    else:
        print("manifest: permissions already present")


def patch_min_sdk() -> None:
    kts = APP / "android/app/build.gradle.kts"
    groovy = APP / "android/app/build.gradle"
    if kts.exists():
        t = kts.read_text()
        t2 = re.sub(r"minSdk\s*=\s*flutter\.minSdkVersion", "minSdk = 24", t)
        t2 = re.sub(r"minSdk\s*=\s*\d+", "minSdk = 24", t2)
        if t2 != t:
            kts.write_text(t2)
            print("build.gradle.kts: minSdk = 24")
        else:
            print("build.gradle.kts: minSdk unchanged (check manually if build fails)")
    elif groovy.exists():
        t = groovy.read_text()
        t2 = re.sub(r"minSdkVersion\s+flutter\.minSdkVersion", "minSdkVersion 24", t)
        t2 = re.sub(r"minSdkVersion\s+\d+", "minSdkVersion 24", t2)
        if t2 != t:
            groovy.write_text(t2)
            print("build.gradle: minSdkVersion 24")
        else:
            print("build.gradle: minSdk unchanged")
    else:
        print("!! no android app build.gradle(.kts) found")
        sys.exit(1)


if __name__ == "__main__":
    patch_manifest()
    patch_min_sdk()
    print("postcreate: done")
