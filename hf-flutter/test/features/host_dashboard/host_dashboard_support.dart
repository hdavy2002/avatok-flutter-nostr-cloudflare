import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/host_dashboard/host_dashboard_providers.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

const String presencePath = '/api/hosts/me/presence';
const String beatPath = '/api/hosts/me/presence/beat';
const String payoutsPath = '/api/hosts/me/payouts';

/// The pinned "now" of the dashboard tests: 10 Oct 2026, noon.
final DateTime pinnedNow = DateTime(2026, 10, 10, 12);

/// `GET /api/hosts/me`, shaped like worker/src/routes/hf_hosts.ts getMe.
Map<String, Object?> hostMe({String status = 'live', String? note}) => {
      'host': {'status': status, 'reviewNote': note},
      'kyc': <String, Object?>{},
      'media': <Object?>[],
      'job': null,
    };

Map<String, Object?> noHostMe() => {'host': null, 'kyc': <String, Object?>{}, 'media': <Object?>[], 'job': null};

Map<String, Object?> callRow(
  String id, {
  String status = 'completed',
  String handle = 'Caller 12',
  int minutes = 5,
  num earning = 40,
  int? createdAt,
}) =>
    {
      'id': id,
      'status': status,
      'callerHandle': handle,
      'createdAt': createdAt ?? DateTime(2026, 10, 9, 16, 30).millisecondsSinceEpoch,
      'connectedAt': null,
      'endedAt': null,
      'billedMinutes': minutes,
      'earningRupees': earning,
      'endReason': null,
    };

Map<String, Object?> callsAnswer({List<Object?>? calls, int today = 2, int minutes = 9, num earned = 72.5}) => {
      'ok': true,
      'calls': calls ?? [callRow('c1'), callRow('c2', earning: 32.5, minutes: 4)],
      'today': {'calls': today, 'minutes': minutes, 'earningRupees': earned},
    };

/// Token-mode `GET /api/hf/wallet`: the host block comes from the INR ledger (paise).
Map<String, Object?> tokenHostWallet({List<Object?>? perCall, bool host = true}) => {
      'mode': 'tokens',
      'tokens': {'balance': '0.00', 'balanceMicro': 0},
      'history': <Object?>[],
      if (host)
        'host': {
          'currency': 'INR',
          'pendingPaise': 50000,
          'availablePaise': 120050,
          'totalEarnedPaise': 400000,
          'testEarningsPaise': 2500,
          'openPayoutPaise': 0,
          'paidOutPaise': 150000,
          'pendingRupees': 500,
          'availableRupees': 1200.5,
          'totalEarnedRupees': 4000,
          'testEarningsRupees': 25,
          'perCall': perCall ??
              [
                {
                  'callId': 'c1',
                  'at': DateTime(2026, 10, 9, 16, 30).millisecondsSinceEpoch,
                  'earnedPaise': 4000,
                  'paidPaise': 4000,
                  'testPaise': 0,
                  'availableAt': DateTime(2026, 10, 16, 16, 30).millisecondsSinceEpoch,
                },
                {
                  'callId': 'c2',
                  'at': DateTime(2026, 10, 9, 17, 0).millisecondsSinceEpoch,
                  'earnedPaise': 3250,
                  'paidPaise': 0,
                  'testPaise': 3250,
                  'availableAt': null,
                },
              ],
          'payouts': <Object?>[],
        },
    };

/// Legacy `GET /api/hf/wallet`: rupees, no per-call list.
Map<String, Object?> legacyHostWallet() => {
      'balanceRupees': 900,
      'paidBalance': 900,
      'testBalance': 0,
      'spendable': 900,
      'history': <Object?>[],
      'host': {'heldRupees': 300, 'availableRupees': 900, 'testEarningsRupees': 0, 'lifetimePaidEarnings': 2500},
    };

Map<String, Object?> payoutRow(
  String id,
  String status, {
  int amount = 500,
  String? utr,
  String? reason,
}) =>
    {
      'id': id,
      'amount': amount,
      'status': status,
      'accountLast4': '1234',
      'ifsc': 'HDFC0001234',
      'utr': utr,
      'reason': reason,
      'createdAt': DateTime(2026, 10, 8, 10).millisecondsSinceEpoch,
      'updatedAt': DateTime(2026, 10, 8, 10).millisecondsSinceEpoch,
      'paidAt': status == 'paid' ? DateTime(2026, 10, 9, 10).millisecondsSinceEpoch : null,
      'exit': false,
    };

Map<String, Object?> payoutsAnswer({
  bool enabled = true,
  int withdrawable = 1000,
  bool kycOk = true,
  bool bankOk = true,
  String hostStatus = 'live',
  List<Object?>? requests,
  bool tokenMode = true,
}) =>
    {
      'enabled': enabled,
      'minRupees': 500,
      'maxPerWeek': 2,
      'holdDays': 7,
      'hostStatus': hostStatus,
      'kycOk': kycOk,
      'bankOk': bankOk,
      'bank': bankOk ? {'accountLast4': '1234', 'ifsc': 'HDFC0001234'} : null,
      'withdrawable': withdrawable,
      'held': 500,
      'testEarnings': 25,
      if (tokenMode) ...{'withdrawablePaise': withdrawable * 100, 'pendingPaise': 50000, 'testEarningsPaise': 2500, 'totalEarnedPaise': 400000},
      'requests': requests ?? <Object?>[],
    };

/// A FakeApiClient with every dashboard route answered. Override a route with `api.onJson(...)` afterwards.
FakeApiClient hostApi({
  Map<String, Object?>? me,
  String presence = 'offline',
  Map<String, Object?>? calls,
  Map<String, Object?>? wallet,
  Map<String, Object?>? payouts,
}) {
  return FakeApiClient()
    ..onJson('GET', '/api/hosts/me', me ?? hostMe())
    ..onJson('GET', presencePath, {'ok': true, 'presence': presence})
    ..on('PUT', presencePath, (c) => {'ok': true, 'presence': (c.body as Map)['online'] == true ? 'online' : 'offline'})
    ..onJson('POST', beatPath, {'ok': true, 'presence': 'online'})
    ..onJson('GET', '/api/hosts/me/calls', calls ?? callsAnswer())
    ..onJson('GET', '/api/hf/wallet', wallet ?? tokenHostWallet())
    ..onJson('GET', payoutsPath, payouts ?? payoutsAnswer())
    ..onJson('POST', payoutsPath, {'ok': true, 'id': 'new-1', 'status': 'requested', 'amount': 500});
}

/// Pumps the Host dashboard alone (inside a tiny router so onboarding links can be followed), signed in as a
/// host, with a fake API. Animations are off (the online pill pulses forever otherwise) and failed providers
/// do not retry.
Future<ProviderContainer> pumpDashboard(
  WidgetTester tester, {
  required FakeApiClient api,
  SessionState? session,
  Duration beatInterval = const Duration(minutes: 5),
}) async {
  tester.view.physicalSize = const Size(1080, 9000);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final container = ProviderContainer(
    retry: (_, __) => null,
    overrides: [
      sessionProvider.overrideWith(() => StubSession(session ?? signedInState(host: true))),
      apiClientProvider.overrideWithValue(api),
      presenceBeatIntervalProvider.overrideWithValue(beatInterval),
      dashboardClockProvider.overrideWithValue(() => pinnedNow),
    ],
  );
  addTearDown(container.dispose);
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HostDashboardScreen()),
      GoRoute(
        path: Routes.hostOnboarding,
        builder: (_, state) => Scaffold(body: Text('ONBOARDING step=${state.uri.queryParameters['step'] ?? 'none'}')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      theme: buildHfTheme(),
      routerConfig: router,
      builder: (context, child) =>
          MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: true), child: child!),
    ),
  ));
  await tester.pumpAndSettle();
  return container;
}

int beats(FakeApiClient api) => api.callsTo('POST', beatPath).length;

Finder key(String k) => find.byKey(ValueKey<String>(k));
