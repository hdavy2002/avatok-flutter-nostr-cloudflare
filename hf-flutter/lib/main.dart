import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import 'app.dart';
import 'core/analytics/analytics.dart';
import 'core/boot.dart';

Future<void> main() async {
  coldStartClock.start();
  await runZonedGuarded<Future<void>>(() async {
    WidgetsFlutterBinding.ensureInitialized();

    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      Analytics.captureException(details.exception, details.stack, handled: false);
    };
    PlatformDispatcher.instance.onError = (error, stack) {
      Analytics.captureException(error, stack, handled: false);
      return true;
    };

    await Analytics.init();
    try {
      // Needs google-services.json; a build without it still runs (push is added in HF-NATIVE-7).
      await Firebase.initializeApp();
    } catch (e) {
      debugPrint('Firebase not initialised: $e');
    }

    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      systemNavigationBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarIconBrightness: Brightness.dark,
    ));
    await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

    runApp(
      PostHogWidget(
        child: ProviderScope(
          retry: (_, __) => null,
          child: const HfApp(),
        ),
      ),
    );
  }, (error, stack) {
    Analytics.captureException(error, stack, handled: false);
  });
}
