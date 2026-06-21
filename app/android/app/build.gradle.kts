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
        targetSdk = 35
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


dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")

    // AvaVision on-device live-vision engine (CameraX + MediaPipe Tasks-Vision +
    // TFLite) REMOVED 2026-06-22 to cut ~30–50 MB of native libs from the launch
    // APK. Live vision is a post-launch feature; the native bridge is stubbed
    // (ai/avatok/avavision/AvaVisionPlugin.kt) so Dart binds and degrades
    // gracefully. Restore these deps + the analyzers when vision ships.
}
