#!/usr/bin/env python3
"""Patch the Flutter-generated android/ project for WebRTC calling.

Run AFTER `flutter create --platforms=android .` in CI. Idempotent.
- Adds camera/mic/network permissions to the main AndroidManifest.xml
- minSdk 24, compileSdk 35, targetSdk 35 (flutter_webrtc androidx deps need 35)
- Forces compileSdk 35 on plugin subprojects (flutter_webrtc pins a lower one)
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
    # FCM wake-on-call (incoming-call full-screen notification)
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_FULL_SCREEN_INTENT",
    "android.permission.WAKE_LOCK",
]


def patch_manifest() -> None:
    man = APP / "android/app/src/main/AndroidManifest.xml"
    if not man.exists():
        print(f"!! manifest not found at {man}")
        sys.exit(1)
    text = man.read_text()
    lines = [f'    <uses-permission android:name="{p}" />' for p in PERMS if p not in text]
    if lines:
        block = "\n".join(lines) + "\n"
        text = re.sub(r"(<manifest[^>]*>)", r"\1\n" + block, text, count=1)
        man.write_text(text)
        print(f"manifest: added {len(lines)} permission(s)")
    else:
        print("manifest: permissions already present")


def patch_sdks() -> None:
    kts = APP / "android/app/build.gradle.kts"
    groovy = APP / "android/app/build.gradle"
    if kts.exists():
        t = kts.read_text()
        t = re.sub(r"minSdk\s*=\s*(flutter\.minSdkVersion|\d+)", "minSdk = 24", t)
        t = re.sub(r"compileSdk\s*=\s*(flutter\.compileSdkVersion|\d+)", "compileSdk = 35", t)
        t = re.sub(r"targetSdk\s*=\s*(flutter\.targetSdkVersion|\d+)", "targetSdk = 35", t)
        kts.write_text(t)
        print("build.gradle.kts: minSdk=24, compileSdk=36, targetSdk=35")
    elif groovy.exists():
        t = groovy.read_text()
        t = re.sub(r"minSdkVersion\s+(flutter\.minSdkVersion|\d+)", "minSdkVersion 24", t)
        t = re.sub(r"compileSdkVersion?\s+(flutter\.compileSdkVersion|\d+)", "compileSdk 35", t)
        t = re.sub(r"targetSdkVersion\s+(flutter\.targetSdkVersion|\d+)", "targetSdkVersion 35", t)
        groovy.write_text(t)
        print("build.gradle: minSdk=24, compileSdk=36, targetSdk=35")
    else:
        print("!! no android app build.gradle(.kts) found")
        sys.exit(1)


def patch_root_compile_sdk() -> None:
    """flutter_webrtc pins a low compileSdk; override every subproject to 35."""
    root_kts = APP / "android/build.gradle.kts"
    root_g = APP / "android/build.gradle"
    marker = "AVATOK_FORCE_COMPILE_SDK"
    if root_kts.exists():
        t = root_kts.read_text()
        if marker not in t:
            t += f'''
// {marker}: plugins (e.g. flutter_webrtc) pin a low compileSdk; override.
subprojects {{
    if (name != "app") {{
        afterEvaluate {{
            extensions.findByName("android")?.let {{ ext ->
                runCatching {{
                    (ext as com.android.build.gradle.BaseExtension).compileSdkVersion(35)
                }}
            }}
        }}
    }}
}}
'''
            root_kts.write_text(t)
            print("root build.gradle.kts: forced subproject compileSdk 35")
    elif root_g.exists():
        t = root_g.read_text()
        if marker not in t:
            t += f'''
// {marker}
subprojects {{
    afterEvaluate {{ project ->
        if (project.hasProperty("android")) {{
            project.android {{ compileSdkVersion 36 }}
        }}
    }}
}}
'''
            root_g.write_text(t)
            print("root build.gradle: forced subproject compileSdk 35")


def patch_firebase() -> None:
    """Apply the google-services Gradle plugin + place google-services.json."""
    src = APP.parent / "firebase/google-services.json"
    dest = APP / "android/app/google-services.json"
    if src.exists():
        dest.write_text(src.read_text())
        print("google-services.json placed in android/app/")
    else:
        print(f"!! google-services.json not found at {src}")

    settings = APP / "android/settings.gradle.kts"
    if settings.exists():
        t = settings.read_text()
        if "com.google.gms.google-services" not in t:
            t = re.sub(
                r'(id\("org\.jetbrains\.kotlin\.android"\)[^\n]*\n)',
                r'\1    id("com.google.gms.google-services") version "4.4.2" apply false\n',
                t, count=1)
            settings.write_text(t)
            print("settings.gradle.kts: google-services plugin declared")

    appgradle = APP / "android/app/build.gradle.kts"
    if appgradle.exists():
        t = appgradle.read_text()
        if "com.google.gms.google-services" not in t:
            t = re.sub(
                r'(id\("kotlin-android"\)\n)',
                r'\1    id("com.google.gms.google-services")\n',
                t, count=1)
            appgradle.write_text(t)
            print("app build.gradle.kts: google-services plugin applied")


def patch_desugaring() -> None:
    """flutter_local_notifications requires core library desugaring."""
    kts = APP / "android/app/build.gradle.kts"
    if not kts.exists():
        return
    t = kts.read_text()
    if "isCoreLibraryDesugaringEnabled" not in t:
        if re.search(r"compileOptions\s*\{", t):
            t = re.sub(r"(compileOptions\s*\{)",
                       r"\1\n        isCoreLibraryDesugaringEnabled = true", t, count=1)
        else:
            t = re.sub(r"(android\s*\{)",
                       r"\1\n    compileOptions {\n        isCoreLibraryDesugaringEnabled = true\n"
                       r"        sourceCompatibility = JavaVersion.VERSION_11\n        targetCompatibility = JavaVersion.VERSION_11\n    }",
                       t, count=1)
    if "desugar_jdk_libs" not in t:
        t += ('\n\ndependencies {\n'
              '    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n}\n')
    kts.write_text(t)
    print("desugaring enabled (flutter_local_notifications)")


if __name__ == "__main__":
    patch_manifest()
    patch_sdks()
    patch_root_compile_sdk()
    patch_firebase()
    patch_desugaring()
    print("postcreate: done")
