pluginManagement {
    val flutterSdkPath = run {
        val properties = java.util.Properties()
        file("local.properties").inputStream().use { properties.load(it) }
        val flutterSdkPath = properties.getProperty("flutter.sdk")
        require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
        flutterSdkPath
    }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.7.0" apply false
    // [CALL-RTK-5] 2.1.10 -> 2.2.20: realtimekit_core_android 0.1.6 ships native
    // libs (RtkClient / shared-api.jar) built with Kotlin 2.3.0 metadata. A 2.1
    // compiler reads metadata only up to 2.2.0 and the CI aab build failed on
    // exactly that. A 2.2.x compiler reads up to 2.3.0 — the minimal safe bump
    // (2.3.x would work too but moves every other plugin subproject further).
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}

include(":app")
