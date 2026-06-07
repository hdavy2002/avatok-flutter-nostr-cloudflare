// Firebase configuration for AvaTOK (project avatok-e19ef).
//
// Hand-authored from firebase/google-services.json so Firebase initializes from
// EXPLICIT options rather than relying on the google-services Gradle plugin
// generating Android resources at build time. The implicit path was failing in
// CI ("[core/no-app] No Firebase App '[DEFAULT]' has been created"), which broke
// phone OTP. Passing options directly is the canonical, build-independent fix.
//
// Only the Android app is registered in this Firebase project today. iOS/web
// throw a clear error until their apps are added (run `flutterfire configure`).
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('Firebase web is not configured for AvaTOK.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        throw UnsupportedError(
            'No iOS Firebase app registered — run `flutterfire configure` to add one.');
      default:
        throw UnsupportedError(
            'Firebase is only configured for Android on AvaTOK.');
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyD2wFlqW1U602YI_VLe8efN1CxYKzuUhm4',
    appId: '1:1098288797441:android:8e77c35d2df04506126d00',
    messagingSenderId: '1098288797441',
    projectId: 'avatok-e19ef',
    storageBucket: 'avatok-e19ef.firebasestorage.app',
  );
}
