import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/features/splash/ui/splash_screen.dart';
import 'package:hf_app/features/welcome/data/ack_service.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';
import '../auth/auth_harness.dart';

GoRouter splashRouter() => GoRouter(
  initialLocation: '/splash',
  routes: [
    GoRoute(path: '/intro', builder: (_, __) => const Scaffold(body: Text('INTRO PAGE'))),
    GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
    GoRoute(path: '/welcome', builder: (_, __) => const WelcomeScreen()),
    GoRoute(
      path: '/explore',
      builder: (_, __) => const Scaffold(body: Text('EXPLORE PAGE')),
    ),
  ],
);

FakeApiClient configApi({String? ackVersion = '2026-10-10'}) {
  final api = FakeApiClient();
  if (ackVersion != null) {
    api.onJson('GET', '/api/config', {'hfAckVersion': ackVersion});
  }
  return api;
}

Future<void> runSplash(
  WidgetTester tester,
  GoRouter router, {
  required FakeApiClient api,
  FakeClerk? clerk,
}) async {
  await pumpRouter(tester, router, api: api, clerk: clerk);
  // Boot, the acceptance check and the route change.
  await settle(tester, 12);
}

void main() {
  const introChannel = MethodChannel('hf/install_intro');
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(introChannel, (_) async => true);
  });
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
    .setMockMethodCallHandler(introChannel, null));
  tearDown(() => AccountScope.id = null);

  testWidgets('a fresh installation opens intro before browsing', (
    tester,
  ) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(introChannel, (_) async => false);
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text(WelcomeCopy.title), findsNothing);
    expect(find.text('INTRO PAGE'), findsOneWidget);
    final c = ProviderScope.containerOf(tester.element(find.text('INTRO PAGE')));
    expect(c.read(bootDoneProvider), isFalse);
  });

  testWidgets('a device that accepted the current version goes to Explore', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      AckService.storageKey: '2026-10-10',
    });
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text('EXPLORE PAGE'), findsOneWidget);
  });

  testWidgets('new safety terms do not gate public browsing', (tester) async {
    SharedPreferences.setMockInitialValues({
      AckService.storageKey: 'hf-ack-v0',
    });
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text(WelcomeCopy.title), findsNothing);
  });

  testWidgets('offline (no config), an earlier acceptance still opens Explore', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      AckService.storageKey: 'hf-ack-v0',
    });
    await runSplash(tester, splashRouter(), api: configApi(ackVersion: null));
    expect(find.text('EXPLORE PAGE'), findsOneWidget);
  });

  testWidgets('offline and never accepted: browse', (tester) async {
    await runSplash(tester, splashRouter(), api: configApi(ackVersion: null));
    expect(find.text(WelcomeCopy.title), findsNothing);
  });

  testWidgets(
    'a signed-in account that accepted on another phone goes to Explore and fills the device copy',
    (tester) async {
      final api = configApi()
        ..onJson('GET', '/api/hf/me', {
          'uid': 'user_1',
          'ackVersion': '2026-10-10',
        });
      final clerk = FakeClerk(user: const ClerkUser(id: 'user_1'));
      await runSplash(tester, splashRouter(), api: api, clerk: clerk);
      expect(find.text('EXPLORE PAGE'), findsOneWidget);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(AckService.storageKey), isNull);
    },
  );

  testWidgets(
    'legacy device consent never silently posts for another account',
    (tester) async {
      SharedPreferences.setMockInitialValues({
        AckService.storageKey: '2026-10-10',
      });
      final api = configApi()
        ..onJson('GET', '/api/hf/me', {'uid': 'user_1'})
        ..onJson('POST', '/api/hf/me/ack', {'ok': true});
      final clerk = FakeClerk(user: const ClerkUser(id: 'user_1'));
      await runSplash(tester, splashRouter(), api: api, clerk: clerk);
      expect(find.text('EXPLORE PAGE'), findsOneWidget);
      expect(api.callsTo('POST', '/api/hf/me/ack'), isEmpty);
    },
  );

  testWidgets('with nothing to ask the splash marks boot done', (tester) async {
    SharedPreferences.setMockInitialValues({
      AckService.storageKey: '2026-10-10',
    });
    final router = splashRouter();
    await runSplash(tester, router, api: configApi());
    final container = ProviderScope.containerOf(
      tester.element(find.text('EXPLORE PAGE')),
    );
    expect(container.read(bootDoneProvider), isTrue);
  });
}
