#!/usr/bin/env python3
"""Patch the Flutter-generated android/ project for WebRTC calling.

Run AFTER `flutter create --platforms=android .` in CI. Idempotent.
- Adds camera/mic/network permissions to the main AndroidManifest.xml
- minSdk 24, compileSdk 35, targetSdk 35 (flutter_webrtc androidx deps need 35)
- Forces compileSdk 35 on plugin subprojects (flutter_webrtc pins a lower one)
"""
import base64
import re
import shutil
import sys
from pathlib import Path

APP_LABEL = "AvaTOK"  # home-screen name

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
    # Chat media: pick/share images, video, audio (Android 13+ scoped media)
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_AUDIO",
    # Native incoming-call UI (flutter_callkit_incoming / ConnectionService)
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
    "android.permission.MANAGE_OWN_CALLS",
    # Location share
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    # Read the device address book to find/invite friends (flutter_contacts)
    "android.permission.READ_CONTACTS",
    # Unread app-icon badge count (red dot + number, WhatsApp-style). Android has
    # NO single standard badge API — each OEM launcher reads its own permission.
    # We declare the FULL set once (no per-device branching): each is a harmless
    # no-op on launchers that don't use it, and app_badge_plus + the launcher pick
    # whichever applies. Modern launchers (Android 8+) also derive the count from
    # the active notification's setNumber(), which needs no permission at all.
    "com.sec.android.provider.badge.permission.READ",     # Samsung
    "com.sec.android.provider.badge.permission.WRITE",    # Samsung
    "com.htc.launcher.permission.READ_SETTINGS",          # HTC
    "com.htc.launcher.permission.UPDATE_SHORTCUT",        # HTC
    "com.sonyericsson.home.permission.BROADCAST_BADGE",   # Sony
    "com.sonymobile.home.permission.PROVIDER_INSERT_BADGE",  # Sony
    "com.anddoes.launcher.permission.UPDATE_COUNT",       # Apex
    "com.majeur.launcher.permission.UPDATE_BADGE",        # Solid
    "com.huawei.android.launcher.permission.CHANGE_BADGE",   # Huawei
    "com.huawei.android.launcher.permission.READ_SETTINGS",  # Huawei
    "com.huawei.android.launcher.permission.WRITE_SETTINGS", # Huawei
    "me.everything.badger.permission.BADGE_COUNT_READ",   # EverythingMe
    "me.everything.badger.permission.BADGE_COUNT_WRITE",  # EverythingMe
    "com.oppo.launcher.permission.READ_SETTINGS",         # Oppo
    "com.oppo.launcher.permission.WRITE_SETTINGS",        # Oppo
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
        print(f"manifest: added {len(lines)} permission(s)")
    else:
        print("manifest: permissions already present")
    # Home-screen app name.
    new = re.sub(r'android:label="[^"]*"', f'android:label="{APP_LABEL}"', text, count=1)
    if new != text:
        text = new
        print(f'manifest: android:label="{APP_LABEL}"')
    # Use the round icon variant where the launcher supports it.
    if "android:roundIcon" not in text:
        text = re.sub(r'(android:icon="@mipmap/ic_launcher")',
                      r'\1\n        android:roundIcon="@mipmap/ic_launcher_round"', text, count=1)
        print("manifest: android:roundIcon set")
    man.write_text(text)


def patch_launcher_icon() -> None:
    """Install the AvaTOK launcher icons (legacy + adaptive) from app/android-res/
    into the freshly-generated android res tree (flutter create ships a default
    icon each run, so we overlay ours every build)."""
    src = APP / "android-res"
    dest = APP / "android/app/src/main/res"
    if not src.exists():
        print(f"!! android-res not found at {src}")
        return
    shutil.copytree(src, dest, dirs_exist_ok=True)
    print("launcher icon: AvaTOK mipmaps + adaptive icon installed")


AGP_VERSION = "8.9.1"   # androidx.browser 1.9.0 / navigationevent 1.0.2 (transitive, CI floats versions) require >= 8.9.1
GRADLE_DIST = "8.11.1"  # minimum Gradle for AGP 8.9.x


def patch_agp() -> None:
    """Flutter's template pins an older Android Gradle plugin (8.7.0). Newer
    androidx transitives refuse it; bump AGP (+ the Gradle wrapper when too old)."""
    settings = APP / "android/settings.gradle.kts"
    if settings.exists():
        t = settings.read_text()
        t2 = re.sub(r'(id\("com\.android\.application"\)\s+version\s+")[\d.]+(")',
                    r"\g<1>" + AGP_VERSION + r"\g<2>", t, count=1)
        if t2 != t:
            settings.write_text(t2)
            print(f"settings.gradle.kts: AGP {AGP_VERSION}")
        else:
            print("settings.gradle.kts: AGP pattern not found (template changed?)")
    wrapper = APP / "android/gradle/wrapper/gradle-wrapper.properties"
    if wrapper.exists():
        t = wrapper.read_text()
        m = re.search(r"gradle-(\d+)\.(\d+)(?:\.(\d+))?-", t)
        if m and (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) < (8, 11, 1):
            t = re.sub(r"gradle-[\d.]+-(all|bin)\.zip", f"gradle-{GRADLE_DIST}-\\1.zip", t)
            wrapper.write_text(t)
            print(f"gradle wrapper: bumped to {GRADLE_DIST}")
        else:
            print("gradle wrapper: already new enough")


def patch_sdks() -> None:
    kts = APP / "android/app/build.gradle.kts"
    groovy = APP / "android/app/build.gradle"
    if kts.exists():
        t = kts.read_text()
        t = re.sub(r"minSdk\s*=\s*(flutter\.minSdkVersion|\d+)", "minSdk = 24", t)
        t = re.sub(r"compileSdk\s*=\s*(flutter\.compileSdkVersion|\d+)", "compileSdk = 36", t)
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
                    (ext as com.android.build.gradle.BaseExtension).compileSdkVersion(36)
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


def patch_kotlin_langver() -> None:
    """posthog_flutter pins Kotlin languageVersion 1.6, which the bundled Kotlin
    2.x compiler rejects ('Language version 1.6 is no longer supported; use 2.0
    or greater'). Force a supported version for that subproject so the app builds
    without dropping analytics."""
    root_kts = APP / "android/build.gradle.kts"
    if not root_kts.exists():
        return
    t = root_kts.read_text()
    marker = "AVATOK_KOTLIN_LANGVER"
    if marker in t:
        return
    t += f'''
// {marker}: some plugins (e.g. posthog_flutter) pin Kotlin languageVersion 1.6,
// which the bundled Kotlin 2.x compiler rejects. Force a supported version on the
// affected subproject(s).
subprojects {{
    if (name == "posthog_flutter") {{
        afterEvaluate {{
            tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {{
                compilerOptions {{
                    languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
                    apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
                }}
            }}
        }}
    }}
}}
'''
    root_kts.write_text(t)
    print("root build.gradle.kts: forced posthog_flutter Kotlin languageVersion 2.0")


def patch_signing() -> None:
    """Sign EVERY build (CI and local) with the SAME committed debug keystore so a
    new APK installs straight over the previous one.

    Relying on AGP's auto-generated ~/.android/debug.keystore produced a DIFFERENT
    signature on each build (verified: the shipped APK's cert did NOT match the
    committed keystore), which is exactly why every install hit "package conflicts
    with an existing package" and forced an uninstall. We decode the committed
    keystore into android/app/ and point an EXPLICIT signingConfig at it with the
    standard debug credentials, so the signature is identical on every build.

    ALSO injects a `release` signingConfig that reads env vars
    (ANDROID_UPLOAD_KEYSTORE_PATH/ALIAS/STORE_PASSWORD/KEY_PASSWORD). The release
    buildType picks the upload keystore when those env vars are set
    (CI .aab build for Play Store) and falls back to the debug keystore when
    they're not (CI APK build for side-loading). That way both lanes keep working
    out of the same generated android/ project."""
    b64 = APP / "android-keystore/debug.keystore.base64"
    if not b64.exists():
        print("!! debug.keystore.base64 not found — signing NOT pinned")
        return
    ks = APP / "android/app/avatok-debug.keystore"
    ks.write_bytes(base64.b64decode(b64.read_text()))

    kts = APP / "android/app/build.gradle.kts"
    groovy = APP / "android/app/build.gradle"
    if kts.exists():
        t = kts.read_text()
        if "avatok-debug.keystore" in t:
            print("signing: already pinned"); return
        block = (
            '    signingConfigs {\n'
            '        getByName("debug") {\n'
            '            storeFile = file("avatok-debug.keystore")\n'
            '            storePassword = "android"\n'
            '            keyAlias = "androiddebugkey"\n'
            '            keyPassword = "android"\n'
            '        }\n'
            '        create("release") {\n'
            '            // CI exports these for the Play Store .aab build. If absent\n'
            '            // (e.g. APK side-load build), the release buildType below\n'
            '            // falls back to the debug keystore so the lane still works.\n'
            '            val uploadStore = System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH")\n'
            '            if (!uploadStore.isNullOrEmpty()) {\n'
            '                storeFile = file(uploadStore)\n'
            '                storePassword = System.getenv("ANDROID_UPLOAD_STORE_PASSWORD")\n'
            '                keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")\n'
            '                keyPassword = System.getenv("ANDROID_UPLOAD_KEY_PASSWORD")\n'
            '            }\n'
            '        }\n'
            '    }\n'
        )
        t2 = re.sub(r"(android\s*\{\s*\n)", r"\1" + block, t, count=1)
        if t2 == t:
            print("!! could not inject signingConfigs into build.gradle.kts"); sys.exit(1)
        # Switch the release buildType to the upload keystore WHEN the env var is
        # set; otherwise keep the existing debug-key fallback so APK builds work.
        t2 = re.sub(
            r'release\s*\{\s*\n(?:\s*//[^\n]*\n)*\s*signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)',
            'release {\n            signingConfig = if (System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH").isNullOrEmpty()) signingConfigs.getByName("debug") else signingConfigs.getByName("release")',
            t2, count=1)
        kts.write_text(t2)
        print("signing: pinned debug keystore + env-var release keystore (build.gradle.kts)")
    elif groovy.exists():
        t = groovy.read_text()
        if "avatok-debug.keystore" in t:
            print("signing: already pinned"); return
        block = (
            '    signingConfigs {\n'
            '        debug {\n'
            '            storeFile file("avatok-debug.keystore")\n'
            '            storePassword "android"\n'
            '            keyAlias "androiddebugkey"\n'
            '            keyPassword "android"\n'
            '        }\n'
            '    }\n'
        )
        t2 = re.sub(r"(android\s*\{\s*\n)", r"\1" + block, t, count=1)
        if t2 == t:
            print("!! could not inject signingConfigs into build.gradle"); sys.exit(1)
        groovy.write_text(t2)
        print("signing: pinned committed debug keystore (build.gradle)")


if __name__ == "__main__":
    patch_manifest()
    patch_launcher_icon()
    patch_agp()
    patch_sdks()
    patch_root_compile_sdk()
    patch_firebase()
    patch_desugaring()
    patch_kotlin_langver()
    patch_signing()
    print("postcreate: done")
