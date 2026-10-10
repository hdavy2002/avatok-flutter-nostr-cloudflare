import 'package:flutter/material.dart';
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
        GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
        GoRoute(path: '/welcome', builder: (_, __) => const WelcomeScreen()),
        GoRoute(path: '/', builder: (_, __) => const Scaffold(body: Text('HOME PAGE'))),
      ],
    );

FakeApiClient configApi({String? ackVersion = '2026-10-10'}) {
  final api = FakeApiClient();
  if (ackVersion != null) api.onJson('GET', '/api/config', {'hfAckVersion': ackVersion});
  return api;
}

Future<void> runSplash(WidgetTester tester, GoRouter router,
    {required FakeApiClient api, FakeClerk? clerk}) async {
  await pumpRouter(tester, router, api: api, clerk: clerk);
  // Boot, the acceptance check and the route change.
  await settle(tester, 12);
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  tearDown(() => AccountScope.id = null);

  testWidgets('a fresh device goes to Welcome', (tester) async {
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text(WelcomeCopy.title), findsOneWidget);
    expect(find.text('HOME PAGE'), findsNothing);
  });

  testWidgets('a device that accepted the current version goes Home', (tester) async {
    SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text('HOME PAGE'), findsOneWidget);
  });

  testWidgets('a new terms version is asked again', (tester) async {
    SharedPreferences.setMockInitialValues({AckService.storageKey: 'hf-ack-v0'});
    await runSplash(tester, splashRouter(), api: configApi());
    expect(find.text(WelcomeCopy.title), findsOneWidget);
  });

  testWidgets('offline (no config), an earlier acceptance still opens Home', (tester) async {
    SharedPreferences.setMockInitialValues({AckService.storageKey: 'hf-ack-v0'});
    await runSplash(tester, splashRouter(), api: configApi(ackVersion: null));
    expect(find.text('HOME PAGE'), findsOneWidget);
  });

  testWidgets('offline and never accepted: Welcome', (tester) async {
    await runSplash(tester, splashRouter(), api: configApi(ackVersion: null));
    expect(find.text(WelcomeCopy.title), findsOneWidget);
  });

  testWidgets('a signed-in account that accepted on another phone goes Home and fills the device copy',
      (tester) async {
    final api = configApi()..onJson('GET', '/api/hf/me', {'uid': 'user_1', 'ackVersion': '2026-10-10'});
    final clerk = FakeClerk(user: const ClerkUser(id: 'user_1'));
    await runSplash(tester, splashRouter(), api: api, clerk: clerk);
    expect(find.text('HOME PAGE'), findsOneWidget);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(AckService.storageKey), '2026-10-10');
  });

  testWidgets('signed in with a device acceptance the account lacks: Home, and it is sent', (tester) async {
    SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
    final api = configApi()
      ..onJson('GET', '/api/hf/me', {'uid': 'user_1'})
      ..onJson('POST', '/api/hf/me/ack', {'ok': true});
    final clerk = FakeClerk(user: const ClerkUser(id: 'user_1'));
    await runSplash(tester, splashRouter(), api: api, clerk: clerk);
    expect(find.text('HOME PAGE'), findsOneWidget);
    expect(api.callsTo('POST', '/api/hf/me/ack').single.body,
        {'version': '2026-10-10', 'ack18': true, 'client': 'android'});
  });

  testWidgets('a link that arrived during start waits for Welcome, then opens after Continue', (tester) async {
    final router = splashRouter();
    await pumpRouter(tester, router, api: configApi());
    final container = ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));
    container.read(pendingLinkProvider.notifier).set(
          const PendingLinkData(input: '/explore', source: 'link', launch: 'cold'),
        );
    await settle(tester, 12);
    expect(find.text(WelcomeCopy.title), findsOneWidget);
    expect(container.read(bootDoneProvider), isFalse);
    expect(container.read(pendingLinkProvider), isNotNull);
  });

  testWidgets('with nothing to ask the splash marks boot done', (tester) async {
    SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
    final router = splashRouter();
    await runSplash(tester, router, api: configApi());
    final container = ProviderScope.containerOf(tester.element(find.text('HOME PAGE')));
    expect(container.read(bootDoneProvider), isTrue);
  });
}
