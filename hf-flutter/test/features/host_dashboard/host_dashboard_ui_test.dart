import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_copy.dart';

import 'host_dashboard_support.dart';

void main() {
  group('availability card (Host mockup)', () {
    testWidgets('offline: title, sub line, note and the switch', (
      tester,
    ) async {
      await pumpDashboard(tester, api: hostApi(presence: 'offline'));
      expect(find.text(HostCopy.offlineTitle), findsOneWidget);
      expect(find.text(HostCopy.offlineSub), findsOneWidget);
      expect(find.text(HostCopy.presenceNote), findsOneWidget);
      expect(key('presence-toggle'), findsOneWidget);
      expect(tester.getSize(key('presence-toggle')).width, 64);
      expect(
        tester.getSize(key('presence-toggle')).height,
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets(
      'flipping the switch calls PUT presence and shows a success snackbar',
      (tester) async {
        final api = hostApi(presence: 'offline');
        await pumpDashboard(tester, api: api);
        await tester.tap(key('presence-toggle'));
        await tester.pumpAndSettle();
        expect(api.callsTo('PUT', presencePath).single.body, {'online': true});
        expect(find.text(HostCopy.onlineTitle), findsOneWidget);
        expect(find.text(HostCopy.nowOnline), findsOneWidget);
      },
    );

    testWidgets('the switch flips at once, taps are ignored while in flight', (
      tester,
    ) async {
      final gate = Completer<Object?>();
      final api = hostApi(presence: 'offline')
        ..on('PUT', presencePath, (_) => gate.future);
      await pumpDashboard(tester, api: api);

      await tester.tap(key('presence-toggle'));
      await tester.pump();
      expect(
        find.text(HostCopy.onlineTitle),
        findsOneWidget,
        reason: 'optimistic flip before the answer',
      );
      expect(
        find.byType(CircularProgressIndicator),
        findsOneWidget,
        reason: 'spinner in the thumb',
      );

      await tester.tap(key('presence-toggle'));
      await tester.pump();
      expect(
        api.callsTo('PUT', presencePath).length,
        1,
        reason: 'a second tap is ignored',
      );

      gate.complete({'ok': true, 'presence': 'online'});
      await tester.pumpAndSettle();
      expect(find.text(HostCopy.onlineTitle), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    for (final c in <(String, int, String)>[
      ('not_live', 409, HostCopy.notLive),
      ('not_verified', 403, 'Please sign in again with your WhatsApp number.'),
    ]) {
      testWidgets('${c.$1} puts the switch back and says why in a snackbar', (
        tester,
      ) async {
        final api = hostApi(presence: 'offline')
          ..onError('PUT', presencePath, ApiError(status: c.$2, code: c.$1));
        await pumpDashboard(tester, api: api);
        await tester.tap(key('presence-toggle'));
        await tester.pumpAndSettle();
        expect(
          find.text(HostCopy.offlineTitle),
          findsOneWidget,
          reason: 'reverted',
        );
        expect(find.text(HostCopy.onlineTitle), findsNothing);
        expect(find.text(c.$3), findsOneWidget);
        expect(find.text(HostCopy.nowOnline), findsNothing);
      });
    }

    testWidgets('a revert from online goes back to online', (tester) async {
      final api = hostApi(presence: 'online')
        ..onError(
          'PUT',
          presencePath,
          const ApiError(status: 0, code: 'network'),
        );
      await pumpDashboard(tester, api: api);
      await tester.tap(key('presence-toggle'));
      await tester.pumpAndSettle();
      expect(find.text(HostCopy.onlineTitle), findsOneWidget);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
    });

    testWidgets('busy hides the switch and shows the On a call pill', (
      tester,
    ) async {
      await pumpDashboard(tester, api: hostApi(presence: 'busy'));
      expect(key('presence-toggle'), findsNothing);
      expect(find.text('On a call'), findsOneWidget);
    });
  });

  group('today tiles and call rows', () {
    testWidgets(
      'three tiles show today calls, minutes and rupees with their captions',
      (tester) async {
        final api = hostApi(
          calls: callsAnswer(today: 6, minutes: 74, earned: 1026),
        );
        await pumpDashboard(tester, api: api);
        expect(
          find.descendant(of: key('today-calls'), matching: find.text('6')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('today-calls'),
            matching: find.text(HostCopy.todayCallsCaption),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: key('today-minutes'), matching: find.text('74')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('today-minutes'),
            matching: find.text(HostCopy.todayMinutesCaption),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('today-earned'),
            matching: find.text('₹1,026'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('today-earned'),
            matching: find.text(HostCopy.todayEarnedCaption),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a call from today shows only its time; the handle gets an @; the amount a +',
      (tester) async {
        final api = hostApi(
          calls: callsAnswer(
            calls: [
              callRow(
                't1',
                handle: 'aditya_k',
                minutes: 18,
                earning: 276,
                createdAt: DateTime(
                  2026,
                  10,
                  10,
                  21,
                  42,
                ).millisecondsSinceEpoch,
              ),
            ],
          ),
        );
        await pumpDashboard(tester, api: api);
        expect(find.text('@aditya_k'), findsOneWidget);
        expect(find.text('9:42 pm · 18 min'), findsOneWidget);
        expect(tester.widget<Text>(key('earned-t1')).data, '+₹276');
      },
    );

    testWidgets('no calls: friendly line', (tester) async {
      final api = hostApi(
        calls: callsAnswer(calls: <Object?>[], today: 0, minutes: 0, earned: 0),
      );
      await pumpDashboard(tester, api: api);
      expect(find.text('No calls yet today.'), findsOneWidget);
    });
  });

  group('earnings card', () {
    testWidgets(
      'ready and hold amounts, total, and the withdraw button with the bank digits',
      (tester) async {
        await pumpDashboard(tester, api: hostApi());
        expect(find.text(HostCopy.earningsReady), findsOneWidget);
        expect(find.text(HostCopy.earningsHold(7)), findsOneWidget);
        expect(find.text('Withdraw to bank •• 1234'), findsOneWidget);
      },
    );
  });

  group('setup progress', () {
    testWidgets(
      'a profile still being set up shows a progress card with Continue setup',
      (tester) async {
        await pumpDashboard(
          tester,
          api: hostApi(me: hostMe(status: 'draft')),
        );
        expect(find.text('Step 1 of 4'), findsOneWidget);
        expect(find.text(HostCopy.draftAction), findsOneWidget);
      },
    );
  });
}
