plugins {
    id("com.android.application")
    id("kotlin-android")
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    signingConfigs {
        getByName("debug") {
            storeFile = file("avatok-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        create("release") {
            // CI exports these env vars for the Play Store .aab build. If absent
            // (e.g. APK side-load build), the release buildType below falls back
            // to the debug keystore so that lane still works.
            val uploadStore = System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH")
            if (!uploadStore.isNullOrEmpty()) {
                storeFile = file(uploadStore)
                storePassword = System.getenv("ANDROID_UPLOAD_STORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_UPLOAD_KEY_PASSWORD")
            }
        }
    }
    namespace = "ai.avatok.avatok_call"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "ai.avatok.avatok_call"
        // Staging builds (AVATOK_ENV=staging) install side-by-side with the prod app
        // as ai.avatok.avatok_call.staging. NOTE: FCM push won't register on staging
        // until ai.avatok.avatok_call.staging is a real app in the avatok-e19ef Firebase
        // project (google-services.json currently has a duplicate client entry just so
        // the gms plugin's package check passes).
        if ((System.getenv("AVATOK_ENV") ?: "prod") == "staging") {
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
        }
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        targetSdk = 36
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // R8 code + resource shrinking is ON to trim the APK. proguard-rules.pro
            // keeps OPTIMIZATION and OBFUSCATION off (-dontoptimize/-dontobfuscate)
            // — the lower-risk subset — but enables dead-code/resource SHRINKING,
            // which is the real size win. Reflection/JNI-loaded native plugin
            // classes (sherpa-onnx, WebRTC/LiveKit, Stripe) are protected by -keep
            // rules there. Validate every change with a CI APK build + on-device
            // smoke test (Stripe PaymentSheet, calls, Ava voice) before shipping.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro")
            // CI exports ANDROID_UPLOAD_KEYSTORE_PATH for Play Store .aab builds → use
            // the upload keystore. Otherwise (local builds, side-load APK lane) keep
            // signing with the committed debug keystore so a new APK installs over
            // the previous one without uninstall.
            signingConfig = if (System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH").isNullOrEmpty())
                signingConfigs.getByName("debug")
            else
                signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}

// [STREAM-CALL-PILOT-4] Keep one M125 WebRTC binary in every build. Stream's
// SDK directly uses APIs that only exist in its M125 fork, while AvaTOK's
// recording/translation taps use a custom decoded-playback callback that the
// Stream fork omits. Pilot CI selects Stream's fork and fail-closes only those
// two optional taps; ordinary builds retain AvaTOK's existing WebRTC binary.
val streamCallSdk = System.getenv("STREAM_CALL_SDK") == "1"

// [CALL-RTK-6] flutter_webrtc ships com.github.davidliu:audioswitch (a fork) and
// realtimekit_core_android ships the Twilio original com.twilio:audioswitch —
// IDENTICAL package/class names, so the release merge fails with Duplicate class
// com.twilio.audioswitch.*. Keep the davidliu fork (superset of upstream, what
// flutter_webrtc links against) and exclude the Twilio original everywhere.
// If the RTK audio path ever throws NoSuchMethodError into com.twilio.audioswitch,
// this exclusion is where to look.
configurations.all {
    exclude(group = "com.twilio", module = "audioswitch")
    // [STREAM-LANE-1 2026-08-21] UNCONDITIONAL now (was `if (streamCallSdk)`).
    // stream_video_flutter → stream_webrtc_flutter ships
    // io.getstream:stream-video-webrtc-android (org.webrtc classes +
    // libjingle_peerconnection_so.so) in EVERY build, and realtimekit_core's
    // com.cloudflare.realtimekit:mobile-core-bridge transitively pulls
    // io.github.webrtc-sdk:android 125.x with the SAME class namespace and the
    // SAME .so name — run #609 failed mergeReleaseNativeLibs on exactly this.
    // One engine only: RTK's org.webrtc calls bind to Stream's 145.9.0 classes
    // at runtime (consult/conference are scheduled to migrate to Stream; if RTK
    // throws NoSuchMethodError into org.webrtc.*, this exclusion is where to look).
    exclude(group = "io.github.webrtc-sdk", module = "android")
    // The OLD pilot's binary (stream-webrtc-android 1.3.8) also collides with
    // stream-video-webrtc-android 145.9.0 (run #607) — keep it out even if a
    // stale pilot build ever re-enables STREAM_CALL_SDK.
    exclude(group = "io.getstream", module = "stream-webrtc-android")
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // [CALL-NATIVE-DECLINE-1] The notification Decline action must survive a
    // killed Flutter process. NativeCallDeclineBridge persists the signed action
    // as unique WorkManager work and retries it when connectivity returns.
    implementation("androidx.work:work-runtime:2.10.2")
    // [CALL-TRANSLATE-1] Native Gemini Live WebSocket for decoded WebRTC audio.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // [CALL-TRANSLATE-1] flutter_webrtc depends on this as `implementation`, which
    // Gradle keeps private to that module — CallTranslationAudioPlugin.java (in :app)
    // can't see org.webrtc.audio.JavaAudioDeviceModule without it declared here too.
    // Version MUST match flutter_webrtc's android/build.gradle exactly.
    // [STREAM-LANE-1 2026-08-21] Was a streamCallSdk pick between the old
    // pilot's 1.3.8 and webrtc-sdk 125.x — both are now excluded above. :app's
    // own org.webrtc references (CallTranslationAudioPlugin's
    // JavaAudioDeviceModule tap, CallRecorderPlugin) compile against the ONE
    // engine the whole APK ships: the same artifact stream_webrtc_flutter uses.
    // Version MUST match stream_webrtc_flutter's android/build.gradle.
    implementation("io.getstream:stream-video-webrtc-android:145.9.0")

    // AvaVision on-device live-vision engine (CameraX + MediaPipe Tasks-Vision +
    // TFLite) REMOVED 2026-06-22 to cut ~30–50 MB of native libs from the launch
    // APK. Live vision is a post-launch feature; the native bridge is stubbed
    // (ai/avatok/avavision/AvaVisionPlugin.kt) so Dart binds and degrades
    // gracefully. Restore these deps + the analyzers when vision ships.
}
