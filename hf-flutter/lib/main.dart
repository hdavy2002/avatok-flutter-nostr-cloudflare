import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'core/brand.dart';
import 'core/deep_links.dart';
import 'data/photos_gate.dart'; // [HF-PHOTO-CROP-APP]
import 'data/push.dart';
import 'data/telemetry.dart';
import 'demo/router.dart';
import 'demo/screens/policy_update.dart'; // [HF-APP-PARITY-PROFILE]
import 'demo/theme.dart';

/// The Hello Fraands app. With `--dart-define=HF_DEMO=true` (the default) every screen shows dummy data; the
/// release workflow passes `HF_DEMO=false` to go live (see .github/workflows/hf-flutter.yml).
///
/// Crashes: everything runs inside one guarded zone, and [Telemetry.installCrashHandlers] covers Flutter
/// framework errors and uncaught platform errors. All three report the catalog event `app_crash`.
Future<void> main() async {
  await runZonedGuarded<Future<void>>(() async {
    WidgetsFlutterBinding.ensureInitialized();
    await Telemetry.init(); // PostHog when HF_POSTHOG_KEY is set, else the debug console
    Telemetry.installCrashHandlers();
    await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Color(0x00000000),
        systemNavigationBarColor: Color(0x00000000),
      ),
    );
    await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    runApp(const HfDemoApp());
    // Cold-start and running links (hellofraands:// and https app links). A link that lands during the
    // splash waits until the splash hands over (DeepLinks.markReady).
    unawaited(DeepLinks.start(router));
    // [HF-BOOK-APPROVE-PUSH] Firebase + notification taps (cold start, background, foreground banner). A tap that
    // lands during the splash waits for DeepLinks.markReady like a link does.
    unawaited(PushNotifications.init());
    PhotosGate.instance.start(); // [HF-PHOTO-CROP-APP] photos-required gate: refreshed on sign-in and app resume
  }, Telemetry.zoneError);
}

class HfDemoApp extends StatelessWidget {
  const HfDemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: Brand.name,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      scaffoldMessengerKey: hfMessengerKey,
      routerConfig: router,
      builder: (context, child) => PolicyGate(child: child), // [HF-APP-PARITY-PROFILE] blocking "rules changed" prompt for signed-in people
    );
  }
}
