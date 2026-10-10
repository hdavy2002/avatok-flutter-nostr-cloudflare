plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Brand name, domain, URL scheme and package id come from the repo's single brand file
// (Specs/brand.json); nothing in this project types them. hf-flutter/android/app -> repo root is three levels up.
val hfBrand = groovy.json.JsonSlurper().parse(file("../../../Specs/brand.json")) as Map<*, *>
val hfName = hfBrand["name"] as String
val hfDomain = hfBrand["domain"] as String
val hfScheme = hfDomain.split(".")[0]
val hfPackageId = hfBrand["hfPlayPackageId"] as String

// Release signing: the CI workflow exports these four variables from GitHub secrets (same upload key as the
// interim Capacitor app, so Play accepts this build as an update). When they are absent the release is left
// UNSIGNED, never debug-signed, so a stray build can never be mistaken for a shippable one.
val hfKeystorePath: String? = System.getenv("HF_UPLOAD_KEYSTORE_PATH")
val hfSigned = hfKeystorePath != null && file(hfKeystorePath).exists()

android {
    namespace = "com.hellofraands.hf_app"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = hfPackageId
        minSdk = 24
        targetSdk = 36
        // CI passes --build-number (2000 + run number) and --build-name (2.0.<run number>) to `flutter build`.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["hfHost"] = hfDomain
        manifestPlaceholders["hfWwwHost"] = "www.$hfDomain"
        manifestPlaceholders["hfScheme"] = hfScheme
        resValue("string", "app_name", hfName)
    }

    signingConfigs {
        create("release") {
            if (hfSigned) {
                storeFile = file(hfKeystorePath!!)
                storePassword = System.getenv("HF_UPLOAD_STORE_PASSWORD")
                keyAlias = System.getenv("HF_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("HF_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (hfSigned) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

flutter {
    source = "../.."
}

// Push (HF-NATIVE-7): the Google services plugin is applied only when CI wrote google-services.json
// (secret HF_GOOGLE_SERVICES_JSON), so the build works without it.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
