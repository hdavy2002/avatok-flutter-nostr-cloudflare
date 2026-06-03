#!/usr/bin/env python3
"""Android config for AvaConsult (RealtimeKit). Run after `flutter create`.

RealtimeKit needs compileSdk 36, core library desugaring, foreground-service
permissions, and the KeepAlive service. No flutter_webrtc here, so there's no
audioswitch namespace clash and no dual-WebRTC crash.
"""
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
PERMS = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    "android.permission.FOREGROUND_SERVICE_CAMERA",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
]
KEEPALIVE = (
    '        <service\n'
    '            android:name="com.cloudflare.realtimekit.ui.KeepAliveService"\n'
    '            android:enabled="true"\n'
    '            android:exported="false"\n'
    '            android:foregroundServiceType="mediaPlayback|camera|microphone" />\n'
)


def manifest():
    man = APP / "android/app/src/main/AndroidManifest.xml"
    t = man.read_text()
    lines = [f'    <uses-permission android:name="{p}" />' for p in PERMS if p not in t]
    if lines:
        t = re.sub(r"(<manifest[^>]*>)", r"\1\n" + "\n".join(lines) + "\n", t, count=1)
    if "KeepAliveService" not in t:
        t = t.replace("</application>", KEEPALIVE + "    </application>", 1)
    man.write_text(t)
    print(f"manifest: {len(lines)} perms + KeepAlive")


def sdks():
    kts = APP / "android/app/build.gradle.kts"
    t = kts.read_text()
    t = re.sub(r"minSdk\s*=\s*(flutter\.minSdkVersion|\d+)", "minSdk = 24", t)
    t = re.sub(r"compileSdk\s*=\s*(flutter\.compileSdkVersion|\d+)", "compileSdk = 36", t)
    t = re.sub(r"targetSdk\s*=\s*(flutter\.targetSdkVersion|\d+)", "targetSdk = 35", t)
    if "isCoreLibraryDesugaringEnabled" not in t:
        if re.search(r"compileOptions\s*\{", t):
            t = re.sub(r"(compileOptions\s*\{)", r"\1\n        isCoreLibraryDesugaringEnabled = true", t, count=1)
        else:
            t = re.sub(r"(android\s*\{)",
                       r"\1\n    compileOptions {\n        isCoreLibraryDesugaringEnabled = true\n"
                       r"        sourceCompatibility = JavaVersion.VERSION_11\n        targetCompatibility = JavaVersion.VERSION_11\n    }",
                       t, count=1)
    if "desugar_jdk_libs" not in t:
        t += '\n\ndependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n}\n'
    kts.write_text(t)
    print("build.gradle.kts: compileSdk 36 + desugaring")


def root_sdk():
    root = APP / "android/build.gradle.kts"
    t = root.read_text()
    if "AVACONSULT_COMPILE_SDK" not in t:
        t += '''
// AVACONSULT_COMPILE_SDK: RealtimeKit plugin modules need compileSdk 36.
subprojects {
    if (name != "app") {
        afterEvaluate {
            extensions.findByName("android")?.let { ext ->
                runCatching { (ext as com.android.build.gradle.BaseExtension).compileSdkVersion(36) }
            }
        }
    }
}
'''
        root.write_text(t)
        print("root: forced subproject compileSdk 36")


if __name__ == "__main__":
    manifest()
    sdks()
    root_sdk()
    print("postcreate: done")
