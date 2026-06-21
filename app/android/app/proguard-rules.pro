# R8 config. The app shipped un-minified for a long time, so we enable the
# LOW-RISK subset: dead-code + resource SHRINKING (the real size win) while
# leaving OPTIMIZATION and OBFUSCATION off to avoid behavioral surprises and to
# keep crash stack traces (PostHog) readable. The -keep blocks below protect the
# reflection/JNI-loaded native plugin classes that shrinking could otherwise drop.
-dontoptimize
-dontobfuscate

# Keep generic native-method bridges (any plugin that loads a .so via JNI).
-keepclasseswithmembernames class * { native <methods>; }

# Reflection/JNI-heavy native plugins this app depends on — keep their classes so
# R8 shrinking can never remove an entry point the native side resolves by name.
-keep class com.k2fsa.sherpa.onnx.** { *; }
-dontwarn com.k2fsa.sherpa.onnx.**
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
-keep class com.cloudwebrtc.webrtc.** { *; }
-keep class io.livekit.** { *; }
-dontwarn io.livekit.**
-keep class com.stripe.** { *; }
-keep class com.reactnativestripesdk.** { *; }
-dontwarn com.stripe.**

# Flutter's embedding references the Play Core deferred-components / split-install
# API (FlutterPlayStoreSplitApplication, PlayStoreDeferredComponentManager). We
# don't use deferred components and don't depend on Play Core, so these classes
# are absent — this is Flutter's documented R8 rule to silence them.
-dontwarn com.google.android.play.core.**
-keep class com.google.android.play.core.** { *; }
