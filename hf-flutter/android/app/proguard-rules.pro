# [HF-WIRE-12] R8 / ProGuard rules for the release build. Flutter shrinks release builds by default.
# Most packages ship their own consumer rules; the lines below cover what they do not, so a release never
# loses a class that only code reflection or a platform channel reaches.

# Flutter engine and embedding
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }
-dontwarn io.flutter.embedding.engine.deferredcomponents.**
# Deferred components are not used; the engine still names the Play Core split-install classes.
-dontwarn com.google.android.play.core.**

# webview_flutter + webview_flutter_android (YouTube / Instagram embeds): JavaScript channels are found by reflection
-keep class io.flutter.plugins.webviewflutter.** { *; }
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# google_sign_in ([HF-WIRE-14] Sign in with YouTube; Play Services ships its own consumer rules)
-keep class io.flutter.plugins.googlesignin.** { *; }
-dontwarn com.google.android.gms.**

# share_plus, url_launcher, package_info_plus: plugin classes are created by name from GeneratedPluginRegistrant
-keep class dev.fluttercommunity.plus.share.** { *; }
-keep class dev.fluttercommunity.plus.packageinfo.** { *; }
-keep class io.flutter.plugins.urllauncher.** { *; }

# PostHog (analytics)
-keep class com.posthog.** { *; }
-dontwarn com.posthog.**

# Google Play Billing (in_app_purchase) and Firebase Messaging keep their own consumer rules
-dontwarn com.android.billingclient.**

# Keep line numbers so a crash stack trace is readable after shrinking
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# [HF-WIRE-20] In-app checkout (flutter_cashfree_pg_sdk, Android SDK com.cashfree.pg). The SDK builds its payment sheet, the UPI-app
# intents and its JSON models by name, so R8 must not rename or strip them. Missing optional classes only warn.
-keep class com.cashfree.** { *; }
-dontwarn com.cashfree.**
-keep class com.cashfree.pg.** { *; }
-keepattributes Signature,*Annotation*,InnerClasses,EnclosingMethod
