import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_copy.dart';

import '../../support/fake_api_client.dart';
import 'host_dashboard_support.dart';

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(key('payout-open'));
  await tester.pumpAndSettle();
}

Future<void> _enter(WidgetTester tester, String amount) async {
  await tester.enterText(key('payout-amount'), amount);
  await tester.pump();
}

Future<void> _submit(WidgetTester tester) async {
  await tester.tap(key('payout-submit'));
  await tester.pumpAndSettle();
}

String? _errorText(WidgetTester tester) {
  final f = key('payout-error');
  return f.evaluate().isEmpty ? null : tester.widget<Text>(f).data;
}

void main() {
  group('withdrawal request', () {
    testWidgets('shows what can be withdrawn, the rules and the bank account, all in rupees', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      expect(tester.widget<Text>(key('payout-upto')).data, HostCopy.upTo('₹1,000'));
      expect(find.text('Smallest withdrawal ₹500. Up to 2 requests a week.'), findsOneWidget);
      expect(tester.widget<Text>(key('payout-bank')).data, 'Paid to the bank account ending 1234 (HDFC0001234).');
      expect(find.textContaining(RegExp('token', caseSensitive: false)), findsNothing);
    });

    testWidgets('a valid amount posts whole rupees with an Idempotency-Key, closes the sheet and reloads', (tester) async {
      final api = hostApi();
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);
      await _enter(tester, '700');
      await _submit(tester);
      final call = api.callsTo('POST', payoutsPath).single;
      expect(call.body, {'amount': 700});
      expect(call.idempotencyKey, isNotNull);
      expect(call.idempotencyKey, isNotEmpty);
      expect(key('payout-amount'), findsNothing, reason: 'the sheet closed');
      expect(find.text(HostCopy.requested), findsOneWidget);
      expect(api.callsTo('GET', payoutsPath).length, greaterThanOrEqualTo(2), reason: 'the list reloaded');
    });

    testWidgets('the amount is checked on the phone first: nothing is sent for a bad amount', (tester) async {
      final api = hostApi();
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);

      await _submit(tester);
      expect(_errorText(tester), 'Enter how much you want to withdraw.');

      await _enter(tester, '300');
      await _submit(tester);
      expect(_errorText(tester), 'The smallest withdrawal is ₹500.');

      await _enter(tester, '1500');
      await _submit(tester);
      expect(_errorText(tester), 'You can withdraw up to ₹1,000 right now.');

      expect(api.callsTo('POST', payoutsPath), isEmpty);
    });

    testWidgets('only digits can be typed (no decimals, no minus)', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      await _openSheet(tester);
      await _enter(tester, '5a0.0-0');
      expect(tester.widget<TextField>(key('payout-amount')).controller!.text, '5000');
    });

    // The documented error codes of POST /api/hosts/me/payouts, with no worker message, so the app's own words show.
    for (final c in <(String, int, String)>[
      ('not_enabled', 404, 'Withdrawals open soon.'),
      ('not_live', 403, 'Withdrawals open once your profile is live.'),
      ('invalid_amount', 400, 'Enter a whole rupee amount, like 500.'),
      ('below_minimum', 400, 'The smallest withdrawal is ₹500.'),
      ('weekly_limit', 429, "You've reached this week's withdrawal limit. Please try again next week."),
      ('insufficient_withdrawable', 402, 'That amount is not available yet. Earnings are held for 7 days.'),
      ('wallet_error', 502, "We couldn't set that money aside. Please try again."),
    ]) {
      testWidgets('error ${c.$1} shows simple English under the amount', (tester) async {
        final api = hostApi()..onError('POST', payoutsPath, ApiError(status: c.$2, code: c.$1));
        await pumpDashboard(tester, api: api);
        await _openSheet(tester);
        await _enter(tester, '500');
        await _submit(tester);
        expect(_errorText(tester), c.$3);
        expect(key('payout-amount'), findsOneWidget, reason: 'the sheet stays open so the host can fix it');
      });
    }

    testWidgets("the worker's own message wins when it sends one", (tester) async {
      final api = hostApi()
        ..onError('POST', payoutsPath, const ApiError(status: 402, code: 'insufficient_withdrawable', message: 'You can withdraw up to ₹800 right now.'));
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);
      await _enter(tester, '900');
      await _submit(tester);
      expect(_errorText(tester), 'You can withdraw up to ₹800 right now.');
    });

    for (final code in ['kyc_required', 'bank_required']) {
      testWidgets('error $code offers Finish setup, which opens the right onboarding step', (tester) async {
        final api = hostApi()..onError('POST', payoutsPath, ApiError(status: 409, code: code));
        await pumpDashboard(tester, api: api);
        await _openSheet(tester);
        await _enter(tester, '500');
        await _submit(tester);
        expect(_errorText(tester), isNotNull);
        expect(key('payout-submit'), findsNothing);
        await tester.tap(key('payout-sheet-finish'));
        await tester.pumpAndSettle();
        // identity is done in this fixture, so the missing piece is the bank step
        expect(find.text('ONBOARDING step=payout'), findsOneWidget);
      });
    }

    testWidgets('no internet: the same Idempotency-Key is reused on the retry (never two reserves)', (tester) async {
      final api = hostApi()..onError('POST', payoutsPath, const ApiError(status: 0, code: 'network'));
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);
      await _enter(tester, '500');
      await _submit(tester);
      expect(_errorText(tester), 'No internet. Check your connection.');
      expect(find.text('Try again'), findsOneWidget);

      api.onJson('POST', payoutsPath, {'ok': true, 'id': 'n', 'status': 'requested', 'amount': 500});
      await _submit(tester);
      final calls = api.callsTo('POST', payoutsPath);
      expect(calls.length, 2);
      expect(calls[1].idempotencyKey, calls[0].idempotencyKey);
    });

    testWidgets('a definite refusal gets a fresh Idempotency-Key on the next try', (tester) async {
      final api = hostApi()..onError('POST', payoutsPath, const ApiError(status: 429, code: 'weekly_limit'));
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);
      await _enter(tester, '500');
      await _submit(tester);
      await _submit(tester);
      final calls = api.callsTo('POST', payoutsPath);
      expect(calls.length, 2);
      expect(calls[1].idempotencyKey, isNot(calls[0].idempotencyKey));
    });

    testWidgets('a different amount gets a fresh Idempotency-Key', (tester) async {
      final api = hostApi()..onError('POST', payoutsPath, const ApiError(status: 0, code: 'network'));
      await pumpDashboard(tester, api: api);
      await _openSheet(tester);
      await _enter(tester, '500');
      await _submit(tester);
      await _enter(tester, '600');
      await _submit(tester);
      final calls = api.callsTo('POST', payoutsPath);
      expect(calls[1].idempotencyKey, isNot(calls[0].idempotencyKey));
    });
  });

  group('when withdrawing is not possible yet', () {
    testWidgets('below the minimum: says when it opens, no Withdraw button', (tester) async {
      await pumpDashboard(tester, api: hostApi(payouts: payoutsAnswer(withdrawable: 320)));
      expect(key('payout-open'), findsNothing);
      expect(find.text(HostCopy.blockTooLow('₹500')), findsOneWidget);
    });

    testWidgets('identity check not done: Finish setup opens the Aadhaar step', (tester) async {
      await pumpDashboard(tester, api: hostApi(payouts: payoutsAnswer(kycOk: false, bankOk: false)));
      expect(key('payout-open'), findsNothing);
      expect(find.text(HostCopy.blockKyc), findsOneWidget);
      await tester.tap(key('payout-finish'));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=aadhaar'), findsOneWidget);
    });

    testWidgets('bank not added: Finish setup opens the payout step', (tester) async {
      await pumpDashboard(tester, api: hostApi(payouts: payoutsAnswer(bankOk: false)));
      expect(find.text(HostCopy.blockBank), findsOneWidget);
      await tester.tap(key('payout-finish'));
      await tester.pumpAndSettle();
      expect(find.text('ONBOARDING step=payout'), findsOneWidget);
    });

    testWidgets('withdrawals switched off: calm note', (tester) async {
      await pumpDashboard(tester, api: hostApi(payouts: payoutsAnswer(enabled: false)));
      expect(key('payouts-soon'), findsOneWidget);
      expect(key('payout-open'), findsNothing);
    });

    testWidgets('404 not_enabled from the withdrawals route is the same calm note', (tester) async {
      final api = hostApi()..onError('GET', payoutsPath, const ApiError(status: 404, code: 'not_enabled'));
      await pumpDashboard(tester, api: api);
      expect(find.text(HostCopy.payoutsSoon), findsOneWidget);
    });

    testWidgets('legacy shape (whole rupees, no paise) renders the same', (tester) async {
      await pumpDashboard(tester, api: hostApi(payouts: payoutsAnswer(tokenMode: false, withdrawable: 750)));
      expect(tester.widget<Text>(key('payout-upto')).data, HostCopy.upTo('₹750'));
    });
  });

  group('withdrawal history', () {
    testWidgets('each request shows amount, status, the UTR once paid and the reason when not paid', (tester) async {
      final api = hostApi(
        payouts: payoutsAnswer(requests: [
          payoutRow('p-req', 'requested', amount: 500),
          payoutRow('p-app', 'approved', amount: 600),
          payoutRow('p-paid', 'paid', amount: 700, utr: 'UTR123456789'),
          payoutRow('p-rej', 'rejected', amount: 800, reason: 'Bank details did not match.'),
          payoutRow('p-can', 'cancelled', amount: 900),
        ]),
      );
      await pumpDashboard(tester, api: api);
      String status(String id) => tester.widget<Text>(key('payout-status-$id')).data!;
      expect(status('p-req'), 'Requested');
      expect(status('p-app'), 'Approved, paying soon');
      expect(status('p-paid'), 'Paid');
      expect(status('p-rej'), 'Not paid');
      expect(status('p-can'), 'Cancelled');
      expect(tester.widget<Text>(key('payout-utr-p-paid')).data, 'Bank reference (UTR): UTR123456789');
      expect(key('payout-utr-p-req'), findsNothing);
      expect(tester.widget<Text>(key('payout-reason-p-rej')).data, 'Bank details did not match.');
      expect(find.text('₹700'), findsOneWidget);
    });

    testWidgets('no requests yet: friendly line', (tester) async {
      await pumpDashboard(tester, api: hostApi());
      expect(key('payout-history-empty'), findsOneWidget);
    });

    testWidgets('only a requested withdrawal can be cancelled', (tester) async {
      final api = hostApi(
        payouts: payoutsAnswer(requests: [
          payoutRow('p-req', 'requested'),
          payoutRow('p-app', 'approved'),
          payoutRow('p-paid', 'paid', utr: 'UTR1234567'),
        ]),
      );
      await pumpDashboard(tester, api: api);
      expect(key('cancel-p-req'), findsOneWidget);
      expect(key('cancel-p-app'), findsNothing);
      expect(key('cancel-p-paid'), findsNothing);
    });

    testWidgets('cancel asks first; Yes posts the cancel and reloads, Keep it does nothing', (tester) async {
      final api = hostApi(payouts: payoutsAnswer(requests: [payoutRow('p-req', 'requested')]))
        ..onJson('POST', '$payoutsPath/p-req/cancel', {'ok': true, 'status': 'cancelled'});
      await pumpDashboard(tester, api: api);

      await tester.tap(key('cancel-p-req'));
      await tester.pumpAndSettle();
      expect(find.text(HostCopy.cancelTitle), findsOneWidget);
      await tester.tap(key('cancel-no'));
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '$payoutsPath/p-req/cancel'), isEmpty);

      final before = api.callsTo('GET', payoutsPath).length;
      await tester.tap(key('cancel-p-req'));
      await tester.pumpAndSettle();
      await tester.tap(key('cancel-yes'));
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', '$payoutsPath/p-req/cancel').length, 1);
      expect(api.callsTo('GET', payoutsPath).length, greaterThan(before));
      expect(find.text(HostCopy.cancelled), findsOneWidget);
    });

    testWidgets('cancelling a request that was just approved says so and reloads', (tester) async {
      final api = hostApi(payouts: payoutsAnswer(requests: [payoutRow('p-req', 'requested')]))
        ..onError('POST', '$payoutsPath/p-req/cancel', const ApiError(status: 409, code: 'not_cancellable'));
      await pumpDashboard(tester, api: api);
      await tester.tap(key('cancel-p-req'));
      await tester.pumpAndSettle();
      await tester.tap(key('cancel-yes'));
      await tester.pumpAndSettle();
      expect(find.text('This request can no longer be cancelled.'), findsOneWidget);
    });
  });
}
