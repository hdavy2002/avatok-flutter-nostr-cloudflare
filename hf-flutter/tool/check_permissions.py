#!/usr/bin/env python3
"""[HF-NATIVE-0] Permission allow-list guard for the native Hello Fraands app.

The app may ask for INTERNET, CAMERA, RECORD_AUDIO and POST_NOTIFICATIONS, plus the few permissions that the
libraries we ship merge in on their own. Anything else (phone, SMS, contacts, call log, location, media,
foreground services, ...) fails the build.

    python3 hf-flutter/tool/check_permissions.py --manifest path/to/merged/AndroidManifest.xml
    python3 hf-flutter/tool/check_permissions.py --apk path/to/app-release.apk     # needs aapt2 (Android SDK build-tools)
    python3 hf-flutter/tool/check_permissions.py --self-test                       # proves the guard rejects CALL_PHONE

Plain python3, no dependencies.
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import sys

# Declared by us in android/app/src/main/AndroidManifest.xml.
DECLARED = {
    "android.permission.INTERNET": "API calls",
    "android.permission.CAMERA": "host selfie video (10 s, code on screen)",
    "android.permission.RECORD_AUDIO": "host voice introduction",
    "android.permission.POST_NOTIFICATIONS": "push notifications (Android 13+)",
}

# Merged in by libraries. Each one is listed with the reason, so a reviewer can say yes or no.
MERGED = {
    "com.android.vending.BILLING": "in_app_purchase (Google Play Billing): buying tokens",
    "android.permission.ACCESS_NETWORK_STATE": "Firebase Messaging / PostHog / cached_network_image: is the network up",
    "android.permission.WAKE_LOCK": "Firebase Messaging: deliver a push while the phone sleeps (also audioplayers)",
    "com.google.android.c2dm.permission.RECEIVE": "Firebase Messaging: receive push from Google",
    "android.permission.RECEIVE_BOOT_COMPLETED": "only if a library adds it (justify in the PR before allowing more)",
}

# The app-private dynamic receiver permission AndroidX adds: <package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
DYNAMIC_RECEIVER_SUFFIX = ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"

ALLOWED = set(DECLARED) | set(MERGED)


def names_from_manifest(text: str) -> list[str]:
    found = re.findall(
        r"<uses-permission(?:-sdk-23)?\b[^>]*?android:name\s*=\s*\"([^\"]+)\"", text)
    return sorted(set(found))


def names_from_apk(apk: str) -> list[str]:
    candidates = []
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or ""
    if sdk:
        candidates = sorted(glob.glob(os.path.join(sdk, "build-tools", "*", "aapt2")), reverse=True)
    aapt2 = candidates[0] if candidates else "aapt2"
    out = subprocess.run([aapt2, "dump", "permissions", apk], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"check_permissions: aapt2 failed ({aapt2}): {out.stderr.strip() or out.stdout.strip()}")
    found = re.findall(r"uses-permission(?:-sdk-23)?: name='([^']+)'", out.stdout)
    if not found:
        sys.exit("check_permissions: aapt2 printed no permissions, refusing to pass on an empty read:\n" + out.stdout)
    return sorted(set(found))


def verdict(names: list[str]) -> tuple[list[str], list[str]]:
    ok, bad = [], []
    for n in names:
        if n in ALLOWED or n.endswith(DYNAMIC_RECEIVER_SUFFIX):
            ok.append(n)
        else:
            bad.append(n)
    return ok, bad


def report(names: list[str]) -> int:
    ok, bad = verdict(names)
    print("Permissions in the merged manifest:")
    for n in ok:
        why = DECLARED.get(n) or MERGED.get(n) or "app-private (AndroidX dynamic receiver)"
        print(f"  ok    {n}  ({why})")
    for n in bad:
        print(f"  DENY  {n}")
    if bad:
        print("::error::Forbidden permission(s) in the merged manifest: " + ", ".join(bad) +
              ". Remove the source or add <uses-permission android:name=\"...\" tools:node=\"remove\"/> to the app manifest.")
        return 1
    print(f"{len(ok)} permissions, all on the allow-list.")
    return 0


def self_test() -> int:
    good = """<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.INTERNET"/>
      <uses-permission android:name="android.permission.CAMERA" />
      <uses-permission android:name="com.android.vending.BILLING"/>
      <permission android:name="com.example.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"/>
      <uses-permission android:name="com.example.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"/>
    </manifest>"""
    bad = good.replace("</manifest>",
                       '<uses-permission android:name="android.permission.CALL_PHONE"/></manifest>')
    _, denied_good = verdict(names_from_manifest(good))
    _, denied_bad = verdict(names_from_manifest(bad))
    if denied_good:
        print("self-test FAILED: the clean manifest was rejected:", denied_good)
        return 1
    if denied_bad != ["android.permission.CALL_PHONE"]:
        print("self-test FAILED: CALL_PHONE was not rejected:", denied_bad)
        return 1
    print("self-test ok: CALL_PHONE is rejected, the clean manifest passes.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--manifest" in argv:
        path = argv[argv.index("--manifest") + 1]
        with open(path, encoding="utf-8") as f:
            names = names_from_manifest(f.read())
        if not names:
            sys.exit("check_permissions: no <uses-permission> found, refusing to pass on an empty read")
        return report(names)
    if "--apk" in argv:
        return report(names_from_apk(argv[argv.index("--apk") + 1]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
