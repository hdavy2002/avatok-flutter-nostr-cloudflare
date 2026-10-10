import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/call/data/call_api.dart';
import 'package:hf_app/features/call/ui/call_screen.dart';
import 'package:hf_app/features/review/ui/review_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

/// A page that only says where the app went.
class Marker extends StatelessWidget {
  const Marker(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Text(label)));
}

class CallTestApp {
  CallTestApp(this.container, this.router, this.clock);

  final ProviderContainer container;
  final GoRouter router;
  final TestClock clock;

  String get location => router.routeInformationProvider.value.uri.toString();
}

class TestClock {
  DateTime now = DateTime.utc(2026, 10, 10, 12);
}

/// Sets the in-memory preferences and the active account, so the persisted call id is read and written.
void prepareStorage({String? activeCallId}) {
  AccountScope.id = 'user_test';
  SharedPreferences.setMockInitialValues({
    if (activeCallId != null) 'hf.active_call.v1_user_test': activeCallId,
  });
  addTearDown(() => AccountScope.id = null);
}

/// Pumps the call and review screens inside a small router, so back, Home, Wallet and the review page can
/// be followed without the whole app. Does NOT use pumpAndSettle: a polling screen never settles.
Future<CallTestApp> pumpCallApp(
  WidgetTester tester, {
  required FakeApiClient api,
  String location = '/call/c1',
  SessionState? session,
}) async {
  usePhoneScreen(tester);
  final clock = TestClock();
  final container = ProviderContainer(overrides: [
    sessionProvider.overrideWith(() => StubSession(session ?? signedInState())),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    callClockProvider.overrideWithValue(() => clock.now),
  ]);
  addTearDown(container.dispose);
  final router = GoRouter(initialLocation: location, routes: [
    GoRoute(path: '/', builder: (_, __) => const Marker('HOME PAGE')),
    GoRoute(path: '/call/:id', builder: (_, s) => CallScreen(id: s.pathParameters['id']!)),
    GoRoute(path: '/review/call/:id', builder: (_, s) => ReviewScreen(callId: s.pathParameters['id'])),
    GoRoute(path: '/review/:token', builder: (_, s) => ReviewScreen(token: s.pathParameters['token'])),
    GoRoute(path: '/wallet', builder: (_, __) => const Marker('WALLET PAGE')),
    GoRoute(path: '/explore', builder: (_, __) => const Marker('EXPLORE PAGE')),
    GoRoute(path: '/h/:slug', builder: (_, s) => Marker('PROFILE ${s.pathParameters['slug']}')),
    GoRoute(path: '/sign-in', builder: (_, __) => const Marker('SIGN IN PAGE')),
  ]);
  addTearDown(router.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(theme: buildHfTheme(), routerConfig: router),
  ));
  // Let the first requests answer and the screen rebuild (a review screen loads twice: target, then topics).
  for (var i = 0; i < 4; i++) {
    await tester.pump();
  }
  return CallTestApp(container, router, clock);
}

/// Take the app down so no timer is left running at the end of a test.
Future<void> closeApp(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
}

/// Let one poll interval pass and the answer arrive.
Future<void> pollOnce(WidgetTester tester) async {
  await tester.pump(CallScreen.pollEvery);
  await tester.pump();
}

/// A fake `GET /api/hf/calls/:id` that walks through [steps] and then stays on the last one.
FakeHandler statusSequence(List<Map<String, Object?>> steps) {
  var i = 0;
  return (_) {
    final step = steps[i < steps.length ? i : steps.length - 1];
    if (i < steps.length) i++;
    return step;
  };
}

Map<String, Object?> callJson(
  String status, {
  String id = 'c1',
  Object? connectedAt,
  int billedMinutes = 0,
  num chargedRupees = 0,
  String? endReason,
  bool canReview = false,
  Map<String, Object?> extra = const {},
}) =>
    {
      'id': id,
      'status': status,
      'hostSlug': 'asha',
      'hostName': 'Asha Verma',
      'rate': 12,
      'connectedAt': connectedAt,
      'endedAt': null,
      'billedMinutes': billedMinutes,
      'chargedRupees': chargedRupees,
      'endReason': endReason,
      'canReview': canReview,
      ...extra,
    };
