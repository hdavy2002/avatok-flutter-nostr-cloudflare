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
            // The AvaVision MediaPipe/TFLite deps drag R8 into the release build
            // (this app shipped un-minified before). Run R8 deterministically as a
            // pass-through via proguard-rules.pro (-dontshrink/-optimize/-obfuscate
            // + -dontwarn for the phantom javax.lang.model.* classes) so the build
            // succeeds without changing the shipped artifact's behavior.
            isMinifyEnabled = true
            isShrinkResources = false
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

    // AvaVision live session (Phase 3): native CameraX preview + on-device vision.
    // CameraX (preview + image analysis) — VisionCameraView
    implementation("androidx.camera:camera-core:1.4.0")
    implementation("androidx.camera:camera-camera2:1.4.0")
    implementation("androidx.camera:camera-lifecycle:1.4.0")
    implementation("androidx.camera:camera-view:1.4.0")
    // MediaPipe Tasks Vision (pose33 / hand / face / object / segmentation)
    implementation("com.google.mediapipe:tasks-vision:0.10.14")
    // TFLite (MoveNet single-pose Lightning — default pose engine, iOS-parity)
    implementation("org.tensorflow:tensorflow-lite:2.16.1")
    implementation("org.tensorflow:tensorflow-lite-support:0.4.4")
}
