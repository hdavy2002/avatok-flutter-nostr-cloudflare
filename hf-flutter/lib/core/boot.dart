import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics/analytics.dart';
import 'auth/session.dart';
import 'config/flags.dart';

/// Started when the process starts; read by `hf_app_open {cold_ms}`.
final Stopwatch coldStartClock = Stopwatch()..start();

/// Cold-start work behind the splash screen (spec 2.1): restore the Clerk session (then `GET /api/hf/me`
/// inside it) and read `/api/config`, in parallel. Never throws, and never waits longer than 6 seconds:
/// offline, the app opens with what it has (a guest, the cached flags).
final appBootProvider = FutureProvider<void>((ref) async {
  final session = ref.read(sessionProvider.notifier);
  try {
    await Future.wait<void>([
      session.restore(),
      ref.read(flagsProvider.future).then((_) {}),
    ]).timeout(const Duration(seconds: 6), onTimeout: () => <void>[]);
  } catch (_) {
    // boot is best effort
  }
  await Analytics.capture('hf_app_open', {
    'cold_ms': coldStartClock.elapsedMilliseconds,
    'signed_in': ref.read(sessionProvider).isSignedIn,
  });
});

/// Where the app starts. Tests override it with `Routes.home` to skip the splash.
final initialLocationProvider = Provider<String>((ref) => '/splash');
