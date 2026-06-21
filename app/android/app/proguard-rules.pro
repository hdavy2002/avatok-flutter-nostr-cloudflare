# AvaVision (Phase 3) added MediaPipe Tasks-Vision + TFLite, which is the first
# dependency set that pulls R8 into the release build. This app has ALWAYS
# shipped un-minified (no keep rules anywhere), so run R8 as a pass-through —
# no shrinking / optimization / obfuscation — to preserve that exact behavior
# and avoid stripping JNI/reflection-loaded vision classes at runtime.
-dontshrink
-dontoptimize
-dontobfuscate

# Flutter's embedding references the Play Core deferred-components / split-install
# API (FlutterPlayStoreSplitApplication, PlayStoreDeferredComponentManager). We
# don't use deferred components and don't depend on Play Core, so these classes
# are absent — this is Flutter's documented R8 rule to silence them.
-dontwarn com.google.android.play.core.**
-keep class com.google.android.play.core.** { *; }
