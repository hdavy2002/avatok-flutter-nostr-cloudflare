import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_copy.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import 'host_dashboard_support.dart';

Future<void> _lifecycle(WidgetTester tester, AppLifecycleState s) async {
  tester.binding.handleAppLifecycleStateChanged(s);
  await tester.pump();
}

void main() {
  group('presence and heartbeat', () {
    testWidgets('an offline host sends no heartbeat, however long the app stays open', (tester) async {
      final api = hostApi(presence: 'offline');
      await pumpDashboard(tester, api: api);
      expect(find.text(HostCopy.goOnline), findsOneWidget);
      await tester.pump(const Duration(minutes: 30));
      expect(beats(api), 0);
    });

    testWidgets('going online beats every 5 minutes, and going offline stops it', (tester) async {
      final api = hostApi(presence: 'offline');
      await pumpDashboard(tester, api: api);

      await tester.tap(key('presence-toggle'));
      await tester.pumpAndSettle();
      expect(api.callsTo('PUT', presencePath).single.body, {'online': true});
      expect(find.text('Online now'), findsOneWidget);
      expect(find.text(HostCopy.goOffline), findsOneWidget);
      expect(find.text(HostCopy.onlineNote), findsOneWidget);
      expect(beats(api), 0, reason: 'the toggle itself stamps the time on the server');

      await tester.pump(const Duration(minutes: 5));
      expect(beats(api), 1);
      await tester.pump(const Duration(minutes: 5));
      expect(beats(api), 2);

      await tester.tap(key('presence-toggle'));
      await tester.pumpAndSettle();
      expect(api.callsTo('PUT', presencePath).last.body, {'online': false});
      expect(find.text('Offline'), findsOneWidget);
      await tester.pump(const Duration(minutes: 20));
      expect(beats(api), 2);
    });

    testWidgets('the heartbeat stops in the background and sends one beat when the app comes back', (tester) async {
      final api = hostApi(presence: 'online');
      await pumpDashboard(tester, api: api);
      expect(beats(api), 1, reason: 'opening the dashboard on an online host beats once');

      await tester.pump(const Duration(minutes: 5));
      expect(beats(api), 2);

      await _lifecycle(tester, AppLifecycleState.paused);
      await tester.pump(const Duration(minutes: 30));
      expect(beats(api), 2, reason: 'nothing runs in the background');

      await _lifecycle(tester, AppLifecycleState.resumed);
      await tester.pump();
      expect(beats(api), 3, reason: 'one beat at once on resume');
      await tester.pump(const Duration(minutes: 5));
      expect(beats(api), 4);
    });

    testWidgets('an offline host who resumes the app sends nothing', (tester) async {
      final api = hostApi(presence: 'offline');
      await pumpDashboard(tester, api: api);
      await _lifecycle(tester, AppLifecycleState.paused);
      await _lifecycle(tester, AppLifecycleState.resumed);
      await tester.pump(const Duration(minutes: 20));
      expect(beats(api), 0);
    });

    testWidgets('a busy host (on a call) shows On a call and keeps beating', (tester) async {
      final api = hostApi(presence: 'busy');
      await pumpDashboard(tester, api: api);
      expect(find.text('On a call'), findsOneWidget);
      expect(find.text(HostCopy.goOffline), findsOneWidget);
      await tester.pump(const Duration(minutes: 5));
      expect(beats(api), 2);
    });

    testWidgets('a failed beat does not break the screen', (tester) async {
      final api = hostApi(presence: 'online')
        ..onError('POST', beatPath, const ApiError(status: 0, code: 'network'));
      await pumpDashboard(tester, api: api);
      await tester.pump(const Duration(minutes: 5));
      expect(find.text(HostCopy.goOffline), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    for (final c in <(String, int, String?, String)>[
      ('not_live', 409, null, HostCopy.notLive),
      ('not_verified', 403, null, 'Please sign in again with your WhatsApp number.'),
      ('account_closing', 409, null, 'This account is being closed.'),
      ('not_verified', 403, 'Verify your WhatsApp number to take calls.', 'Verify your WhatsApp number to take calls.'),
    ]) {
      testWidgets('going online refused with ${c.$1}${c.$3 == null ? '' : ' (worker message)'} shows a message and sends no beat',
          (tester) async {
        final api = hostApi(presence: 'offline')
          ..onError('PUT', presencePath, ApiError(status: c.$2, code: c.$1, message: c.$3));
        await pumpDashboard(tester, api: api);
        await tester.tap(key('presence-toggle'));
        await tester.pumpAndSettle();
        expect(find.text(c.$4), findsOneWidget);
        expect(find.text(HostCopy.goOnline), findsOneWidget, reason: 'still offline');
        await tester.pump(const Duration(minutes: 20));
        expect(beats(api), 0);
      });
    }

    testWidgets('calls switched off (404 not_enabled) is a calm note, not an error', (tester) async {
      final api = hostApi()..onError('GET', presencePath, const ApiError(status: 404, code: 'not_enabled'));
      await pumpDashboard(tester, api: api);
      expect(find.text('Calls open soon.'), findsWidgets);
      expect(find.text(HostCopy.goOnline), findsNothing);
    });
  });

  group('profile status banners', () {
    Future<void> openWith(WidgetTester tester, Map<String, Object?> me, {FakeApiClient? api}) async {
      await pumpDashboard(tester, api: (api ?? hostApi())..onJson('GET', '/api/hosts/me', me));
    }

    testWidgets('draft: continue setup opens onboarding where the host stopped; no money or online switch yet', (tester) async {
      await openWith(tester, hostMe(status: 'draft'));
      expect(find.text(HostCopy.draftTitle), findsOneWidget);
      expect(key('presence-card'), findsNothing);
      expect(key('earnings-card'), findsNothing);
      await tester.tap(key('status-action'));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=none'), findsOneWidget);
    });

    testWidgets('generating: building your profile, see progress', (tester) async {
      await openWith(tester, hostMe(status: 'generating'));
      expect(find.text(HostCopy.generatingTitle), findsOneWidget);
      expect(find.text(HostCopy.generatingAction), findsOneWidget);
    });

    testWidgets('pending_host: check your profile and send it opens the preview step', (tester) async {
      await openWith(tester, hostMe(status: 'pending_host'));
      expect(find.text(HostCopy.pendingHostTitle), findsOneWidget);
      await tester.tap(key('status-action'));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=preview'), findsOneWidget);
    });

    for (final s in ['pending_review', 'submitted']) {
      testWidgets('$s: sent for review, no button', (tester) async {
        await openWith(tester, hostMe(status: s));
        expect(find.text(HostCopy.reviewTitle), findsOneWidget);
        expect(find.text(HostCopy.reviewBody), findsOneWidget);
        expect(key('status-action'), findsNothing);
        expect(key('presence-card'), findsNothing);
      });
    }

    testWidgets('rejected shows the reviewer reason and Fix and send again opens the preview step', (tester) async {
      await openWith(tester, hostMe(status: 'rejected', note: 'Please record the voice intro again, it was too quiet.'));
      expect(find.text(HostCopy.rejectedTitle), findsOneWidget);
      expect(find.text('Please record the voice intro again, it was too quiet.'), findsOneWidget);
      expect(key('presence-card'), findsNothing);
      await tester.tap(key('status-action'));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=preview'), findsOneWidget);
    });

    testWidgets('rejected with no reason still says what to do', (tester) async {
      await openWith(tester, hostMe(status: 'rejected'));
      expect(find.text(HostCopy.rejectedBody), findsOneWidget);
    });

    testWidgets('paused: banner with reason, earnings and withdrawals still show, online switch does not', (tester) async {
      await openWith(
        tester,
        hostMe(status: 'paused', note: 'Paused while we check a report.'),
        api: hostApi(payouts: payoutsAnswer(hostStatus: 'paused')),
      );
      expect(find.text(HostCopy.pausedTitle), findsOneWidget);
      expect(find.text('Paused while we check a report.'), findsOneWidget);
      expect(key('presence-card'), findsNothing);
      expect(key('earnings-card'), findsOneWidget);
      expect(key('payouts-card'), findsOneWidget);
      expect(key('payout-open'), findsNothing, reason: 'withdrawing needs a live profile');
      expect(find.text(HostCopy.blockNotLive), findsOneWidget);
    });

    testWidgets('live: no banner, everything shows', (tester) async {
      await openWith(tester, hostMe());
      expect(key('status-banner'), findsNothing);
      expect(key('presence-card'), findsOneWidget);
      expect(key('today-card'), findsOneWidget);
      expect(key('calls-card'), findsOneWidget);
      expect(key('earnings-card'), findsOneWidget);
      expect(key('payouts-card'), findsOneWidget);
    });

    testWidgets('no host profile: Become a host', (tester) async {
      await openWith(tester, noHostMe());
      expect(find.text(HostCopy.becomeTitle), findsOneWidget);
      await tester.tap(find.text(HostCopy.becomeAction));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=none'), findsOneWidget);
    });

    testWidgets('host features off (404 not_enabled) is Coming soon', (tester) async {
      final api = hostApi()..onError('GET', '/api/hosts/me', const ApiError(status: 404, code: 'not_enabled'));
      await pumpDashboard(tester, api: api);
      expect(find.text('Coming soon'), findsOneWidget);
    });

    testWidgets('no internet shows a message and Try again loads the dashboard', (tester) async {
      final api2 = hostApi()..onError('GET', '/api/hosts/me', const ApiError(status: 0, code: 'network'));
      await pumpDashboard(tester, api: api2);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      api2.onJson('GET', '/api/hosts/me', hostMe());
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(key('presence-card'), findsOneWidget);
    });

    testWidgets('a signed-out visitor gets a sign-in panel and no host call is made', (tester) async {
      final api = hostApi();
      await pumpDashboard(tester, api: api, session: signedOutState());
      expect(find.text(HostCopy.signInBody), findsOneWidget);
      expect(api.calls, isEmpty);
    });
  });

  group('today and recent calls', () {
    testWidgets('today shows calls, minutes and rupees', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      expect(tester.widget<Text>(key('today-calls')).data, '2');
      expect(tester.widget<Text>(key('today-minutes')).data, '9');
      expect(tester.widget<Text>(key('today-earned')).data, '₹72.50');
    });

    testWidgets('each call shows handle, time, minutes and rupees, tagged Paid or Test', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      expect(find.text('Caller 12'), findsNWidgets(2));
      expect(find.text('9 Oct, 4:30 pm, 5 min'), findsOneWidget);
      expect(tester.widget<Text>(key('earned-c1')).data, '₹40');
      expect(tester.widget<Text>(key('earned-c2')).data, '₹32.50');
      expect(find.descendant(of: key('tag-c1'), matching: find.text(HostCopy.paidCall)), findsOneWidget);
      expect(find.descendant(of: key('tag-c2'), matching: find.text(HostCopy.testCall)), findsOneWidget);
    });

    testWidgets('legacy wallet has no per-call list: rows show rupees and no tag', (tester) async {
      await pumpDashboard(tester, api: hostApi(wallet: legacyHostWallet()));
      expect(tester.widget<Text>(key('earned-c1')).data, '₹40');
      expect(key('tag-c1'), findsNothing);
    });

    testWidgets('missed, declined and under-a-minute calls earn nothing and say why', (tester) async {
      final api = hostApi(
        calls: callsAnswer(calls: [
          callRow('m1', status: 'no_answer', minutes: 0, earning: 0),
          callRow('m2', status: 'host_declined', minutes: 0, earning: 0),
          callRow('m3', minutes: 0, earning: 0),
        ]),
      );
      await pumpDashboard(tester, api: api);
      expect(find.text('You missed this call'), findsOneWidget);
      expect(find.text('You declined this call'), findsOneWidget);
      expect(find.text(HostCopy.underMinute), findsOneWidget);
      expect(key('earned-m1'), findsNothing);
      expect(key('earned-m3'), findsNothing);
    });

    testWidgets('no calls yet: friendly line', (tester) async {
      final api = hostApi(calls: callsAnswer(calls: <Object?>[], today: 0, minutes: 0, earned: 0));
      await pumpDashboard(tester, api: api);
      expect(find.text(HostCopy.callsEmpty), findsOneWidget);
      expect(tester.widget<Text>(key('today-earned')).data, '₹0');
    });

    testWidgets('only the first 10 calls show until Show more', (tester) async {
      final api = hostApi(calls: callsAnswer(calls: [for (var i = 0; i < 14; i++) callRow('x$i')]));
      await pumpDashboard(tester, api: api);
      expect(key('call-x9'), findsOneWidget);
      expect(key('call-x10'), findsNothing);
      await tester.tap(key('calls-more'));
      await tester.pumpAndSettle();
      expect(key('call-x13'), findsOneWidget);
    });

    testWidgets('a failing calls list keeps the rest of the dashboard and can be retried', (tester) async {
      final api = hostApi()..onError('GET', '/api/hosts/me/calls', const ApiError(status: 502, code: 'http_502'));
      await pumpDashboard(tester, api: api);
      expect(key('earnings-card'), findsOneWidget);
      expect(key('presence-card'), findsOneWidget);
      expect(find.text('Try again'), findsWidgets);
    });
  });

  group('earnings in rupees', () {
    testWidgets('token mode: paise become rupees, nothing says tokens, hold dates show', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      expect(tester.widget<Text>(key('earn-available')).data, '₹1,200.50');
      expect(tester.widget<Text>(key('earn-pending')).data, '₹500');
      expect(tester.widget<Text>(key('earn-total')).data, '₹4,000');
      expect(tester.widget<Text>(key('earn-paidout')).data, '₹1,500');
      expect(tester.widget<Text>(key('earn-test')).data, '₹25');
      expect(find.text('₹40 unlocks on 16 Oct'), findsOneWidget);
      expect(find.text(HostCopy.holdNote(7)), findsOneWidget);
      expect(find.textContaining(RegExp('token', caseSensitive: false)), findsNothing);
    });

    testWidgets('legacy shape: rupees from heldRupees / availableRupees / lifetimePaidEarnings', (tester) async {
      await pumpDashboard(tester, api: hostApi(wallet: legacyHostWallet()));
      expect(tester.widget<Text>(key('earn-available')).data, '₹900');
      expect(tester.widget<Text>(key('earn-pending')).data, '₹300');
      expect(tester.widget<Text>(key('earn-total')).data, '₹2,500');
      expect(key('earn-test'), findsNothing);
      expect(key('earn-paidout'), findsNothing);
      expect(find.textContaining(RegExp('token', caseSensitive: false)), findsNothing);
    });

    testWidgets('when the wallet cannot be read, the withdrawals numbers fill in', (tester) async {
      final api = hostApi()..onError('GET', '/api/hf/wallet', const ApiError(status: 502, code: 'http_502'));
      await pumpDashboard(tester, api: api);
      expect(tester.widget<Text>(key('earn-available')).data, '₹1,000');
      expect(tester.widget<Text>(key('earn-pending')).data, '₹500');
      expect(key('earn-total'), findsNothing);
    });
  });
}
