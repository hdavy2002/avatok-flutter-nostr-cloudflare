import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/nav.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/router/pending_intent.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/auth/ui/email_code_form.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('cold auth route finishes after delayed loading-to-signedIn restore', (tester) async {
    final session = _MutableSession(const SessionState.loading());
    final pending = _CountingPendingIntent();
    final router = await _pumpAuth(tester, session, pending,
      initialLocation: Routes.signInTo('/wallet'));
    expect(find.byType(SignInScreen), findsOneWidget);
    session.authenticate();
    await tester.pumpAndSettle();
    expect(router.routeInformationProvider.value.uri.path, Routes.wallet);
    expect(pending.clears, 1);
  });

  testWidgets('signedOut-to-signedIn waits for OTP callback and returns true once', (tester) async {
    final session = _MutableSession();
    final pending = _CountingPendingIntent();
    final router = await _pumpAuth(tester, session, pending);
    final result = router.push<bool>(Routes.signInTo('/wallet'));
    await tester.pumpAndSettle();
    final form = tester.widget<EmailCodeForm>(find.byType(EmailCodeForm));
    session.authenticate();
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsOneWidget,
      reason: 'a session mutation cannot race the successful OTP callback');
    final first = form.onVerified();
    final duplicate = form.onVerified();
    await Future.wait([first, duplicate]);
    await tester.pumpAndSettle();
    expect(await result, isTrue);
    expect(pending.clears, 1);
    expect(router.routeInformationProvider.value.uri.path, Routes.explore);
  });

  testWidgets('late OTP completion after Cancel cannot approve a paid action', (tester) async {
    final session = _MutableSession();
    final router = await _pumpAuth(tester, session, _CountingPendingIntent());
    var paidStarts = 0;
    final result = router.push<bool>(Routes.signInTo('/call/new?host=asha'));
    final gate = result.then((accepted) { if (accepted == true) paidStarts++; });
    await tester.pumpAndSettle();
    final form = tester.widget<EmailCodeForm>(find.byType(EmailCodeForm));
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    session.authenticate();
    await form.onVerified();
    await gate;
    await tester.pumpAndSettle();
    expect(paidStarts, 0);
    expect(router.routeInformationProvider.value.uri.path, Routes.explore);
  });

  test('intro and Explore are public, but intro cannot be an auth next', () {
    for (final path in [Routes.intro, Routes.explore, '/h/asha']) {
      expect(hfRedirect(signedOutState(), Uri.parse(path)), isNull);
    }
    expect(Routes.isSafeNext(Routes.intro), isFalse);
    expect(Routes.signInTo(Routes.intro), Routes.signIn);
    for (final path in ['/call/new?host=asha', Routes.wallet, Routes.me]) {
      final redirected = Uri.parse(hfRedirect(signedOutState(), Uri.parse(path))!);
      expect(redirected.path, Routes.signIn);
      expect(redirected.queryParameters['next'], path);
    }
  });

  test('OTP session refresh does not redirect away before auth completion', () {
    expect(hfRedirect(signedInState(),
      Uri.parse(Routes.signInTo('/call/new?host=asha'))), isNull);
  });

  testWidgets('canceling a pushed auth gate never starts the pending paid action', (tester) async {
    var paidStarts = 0;
    final session = _MutableSession();
    final router = GoRouter(initialLocation: Routes.explore, routes: [
      GoRoute(path: Routes.explore, builder: (_, __) => Consumer(
        builder: (context, ref, _) => Scaffold(body: TextButton(
          child: const Text('Call'),
          onPressed: () async {
            if (await requireSignIn(context, ref)) paidStarts++;
          },
        )),
      )),
      GoRoute(path: Routes.signIn, builder: (context, _) => Scaffold(
        body: TextButton(child: const Text('Cancel OTP'), onPressed: () {
          // Even a late successful session mutation must not turn Cancel into
          // approval for a paid call. requireSignIn requires an explicit true.
          session.authenticate();
          context.pop(false);
        }),
      )),
    ]);
    addTearDown(router.dispose);
    await tester.pumpWidget(ProviderScope(
      overrides: [sessionProvider.overrideWith(() => session)],
      child: MaterialApp.router(routerConfig: router),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Call'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel OTP'));
    await tester.pumpAndSettle();
    expect(paidStarts, 0);
    expect(router.routeInformationProvider.value.uri.path, Routes.explore);
  });
}

class _MutableSession extends StubSession {
  _MutableSession([SessionState? initial]) : super(initial ?? signedOutState());
  void authenticate() => state = signedInState();
}


class _CountingPendingIntent extends PendingIntentStore {
  _CountingPendingIntent() : super(MemoryKeyValueStore());
  int clears = 0;
  @override
  Future<void> clear() async {
    clears++;
    await super.clear();
  }
}

Future<GoRouter> _pumpAuth(
  WidgetTester tester,
  _MutableSession session,
  _CountingPendingIntent pending, {
  String initialLocation = Routes.explore,
}) async {
  final router = GoRouter(initialLocation: initialLocation, routes: [
    GoRoute(path: Routes.signIn, builder: (_, state) => SignInScreen(
      next: Routes.safeNext(state.uri.queryParameters['next']))),
    for (final path in [Routes.explore, Routes.wallet])
      GoRoute(path: path, builder: (_, __) => Scaffold(body: Text(path))),
  ]);
  addTearDown(router.dispose);
  await tester.pumpWidget(ProviderScope(overrides: [
    appRouterProvider.overrideWithValue(router),
    sessionProvider.overrideWith(() => session),
    apiClientProvider.overrideWithValue(FakeApiClient()),
    clerkProvider.overrideWithValue(FakeClerk()),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    pendingIntentProvider.overrideWithValue(pending),
  ], child: MaterialApp.router(theme: buildHfTheme(), routerConfig: router)));
  await tester.pumpAndSettle();
  return router;
}
