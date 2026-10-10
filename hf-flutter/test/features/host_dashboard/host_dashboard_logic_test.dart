import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/host_dashboard/data/dash_format.dart';
import 'package:hf_app/features/host_dashboard/data/host_dashboard_models.dart';
import 'package:hf_app/features/host_dashboard/data/payout_rules.dart';
import 'package:hf_app/features/host_dashboard/data/presence_heartbeat.dart';

import 'host_dashboard_support.dart';

void main() {
  group('PresenceHeartbeat (online AND foreground only)', () {
    testWidgets('does nothing until the host is online', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      await tester.pump(const Duration(minutes: 30));
      expect(beats, 0);
      expect(h.running, isFalse);
    });

    testWidgets('online and foreground: one beat per interval', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setOnline(true);
      expect(h.running, isTrue);
      await tester.pump(const Duration(minutes: 4, seconds: 59));
      expect(beats, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(beats, 1);
      await tester.pump(const Duration(minutes: 10));
      expect(beats, 3);
    });

    testWidgets('beatNow sends one at once', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setOnline(true, beatNow: true);
      expect(beats, 1);
    });

    testWidgets('background stops it; foreground again beats once and restarts', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setOnline(true);
      h.setForeground(false);
      expect(h.running, isFalse);
      await tester.pump(const Duration(hours: 1));
      expect(beats, 0);
      h.setForeground(true);
      expect(beats, 1);
      await tester.pump(const Duration(minutes: 5));
      expect(beats, 2);
    });

    testWidgets('offline in the foreground never beats, even after a resume', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setForeground(false);
      h.setForeground(true);
      await tester.pump(const Duration(hours: 1));
      expect(beats, 0);
    });

    testWidgets('going offline stops it', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setOnline(true);
      await tester.pump(const Duration(minutes: 5));
      h.setOnline(false);
      await tester.pump(const Duration(hours: 1));
      expect(beats, 1);
      expect(h.running, isFalse);
    });

    testWidgets('setting online twice does not start two timers', (tester) async {
      var beats = 0;
      final h = PresenceHeartbeat(beat: () => beats++);
      addTearDown(h.dispose);
      h.setOnline(true);
      h.setOnline(true);
      await tester.pump(const Duration(minutes: 5));
      expect(beats, 1);
    });
  });

  group('PayoutRules.check', () {
    PayoutCheck c(String s, {int min = 500, int max = 2000}) => PayoutRules.check(s, minRupees: min, withdrawable: max);

    test('a good amount passes, spaces are ignored', () {
      expect(c('500').amount, 500);
      expect(c(' 1250 ').amount, 1250);
      expect(c('2000').amount, 2000);
    });

    test('empty, decimals, letters and zero are refused in simple words', () {
      expect(c('').error, 'Enter how much you want to withdraw.');
      expect(c('12.5').error, 'Enter a whole rupee amount, like 500.');
      expect(c('abc').error, 'Enter a whole rupee amount, like 500.');
      expect(c('0').error, 'Enter a whole rupee amount, like 500.');
      expect(c('-500').error, 'Enter a whole rupee amount, like 500.');
    });

    test('below the minimum and above what is available', () {
      expect(c('499').error, 'The smallest withdrawal is ₹500.');
      expect(c('2001').error, 'You can withdraw up to ₹2,000 right now.');
      expect(c('1000000').error, 'You can withdraw up to ₹2,000 right now.');
    });
  });

  group('PayoutRules.failure', () {
    PayoutFailure f(String code, {int status = 400, String? message}) =>
        PayoutRules.failure(ApiError(status: status, code: code, message: message));

    test('every documented code has simple English and the right action', () {
      expect(f('not_enabled', status: 404).message, 'Withdrawals open soon.');
      expect(f('not_live', status: 403).message, 'Withdrawals open once your profile is live.');
      expect(f('kyc_required', status: 409).action, PayoutAction.finishSetup);
      expect(f('bank_required', status: 409).action, PayoutAction.finishSetup);
      expect(f('invalid_amount').message, 'Enter a whole rupee amount, like 500.');
      expect(f('below_minimum').message, 'The smallest withdrawal is ₹500.');
      expect(f('weekly_limit', status: 429).message, contains('week'));
      expect(f('insufficient_withdrawable', status: 402).action, PayoutAction.none);
      expect(f('wallet_error', status: 502).action, PayoutAction.retry);
    });

    test('below_minimum uses the minimum the server sent', () {
      expect(PayoutRules.failure(const ApiError(status: 400, code: 'below_minimum'), minRupees: 1000).message,
          'The smallest withdrawal is ₹1,000.');
    });

    test('offline and server errors can be retried; the message is the network one', () {
      final off = PayoutRules.failure(ApiError.network());
      expect(off.message, 'No internet. Check your connection.');
      expect(off.action, PayoutAction.retry);
      expect(f('http_500', status: 500).action, PayoutAction.retry);
    });

    test('keepsKey only for a lost answer', () {
      expect(PayoutRules.keepsKey(ApiError.network()), isTrue);
      expect(PayoutRules.keepsKey(ApiError.timeout()), isTrue);
      expect(PayoutRules.keepsKey(const ApiError(status: 502, code: 'wallet_error')), isTrue);
      expect(PayoutRules.keepsKey(const ApiError(status: 402, code: 'insufficient_withdrawable')), isFalse);
      expect(PayoutRules.keepsKey(const ApiError(status: 429, code: 'weekly_limit')), isFalse);
    });
  });

  group('models', () {
    test('HostProfileStatus: no host, and the reviewer note', () {
      expect(HostProfileStatus.fromJson(noHostMe()).hasHost, isFalse);
      final s = HostProfileStatus.fromJson(hostMe(status: 'rejected', note: ' Needs a clearer photo. '));
      expect(s.hasHost, isTrue);
      expect(s.status, 'rejected');
      expect(s.reviewNote, 'Needs a clearer photo.');
      expect(s.showsMoney, isTrue);
      expect(HostProfileStatus.fromJson(hostMe(status: 'draft')).showsMoney, isFalse);
      expect(HostProfileStatus.fromJson(hostMe(status: 'submitted')).isInReview, isTrue);
    });

    test('HostEarnings token shape: paise to rupees, never tokens', () {
      final e = HostEarnings.fromWalletJson(tokenHostWallet())!;
      expect(e.tokenMode, isTrue);
      expect(e.available, '₹1,200.50');
      expect(e.pending, '₹500');
      expect(e.total, '₹4,000');
      expect(e.testEarnings, '₹25');
      expect(e.paidOut, '₹1,500');
      expect(e.byCall['c2']!.isTest, isTrue);
      expect(e.byCall['c1']!.isTest, isFalse);
    });

    test('HostEarnings legacy shape', () {
      final e = HostEarnings.fromWalletJson(legacyHostWallet())!;
      expect(e.tokenMode, isFalse);
      expect(e.available, '₹900');
      expect(e.pending, '₹300');
      expect(e.total, '₹2,500');
      expect(e.testEarnings, isNull);
      expect(e.perCall, isEmpty);
    });

    test('HostEarnings: a wallet answer with no host block is null', () {
      expect(HostEarnings.fromWalletJson(tokenHostWallet(host: false)), isNull);
    });

    test('releases group held money by day, soonest first, and skip money already free', () {
      final now = DateTime(2026, 10, 10, 12);
      int at(int d, int h) => DateTime(2026, 10, d, h).millisecondsSinceEpoch;
      final e = HostEarnings.fromWalletJson({
        'host': {
          'availablePaise': 0,
          'pendingPaise': 9000,
          'perCall': [
            {'callId': 'a', 'paidPaise': 3000, 'testPaise': 0, 'availableAt': at(14, 9)},
            {'callId': 'b', 'paidPaise': 2000, 'testPaise': 0, 'availableAt': at(14, 18)},
            {'callId': 'c', 'paidPaise': 4000, 'testPaise': 0, 'availableAt': at(12, 8)},
            {'callId': 'd', 'paidPaise': 5000, 'testPaise': 0, 'availableAt': at(9, 8)},
            {'callId': 'e', 'paidPaise': 0, 'testPaise': 700, 'availableAt': at(20, 8)},
          ],
        },
      })!;
      final r = e.releases(now);
      expect(r.length, 2);
      expect(r[0].date, DateTime(2026, 10, 12));
      expect(r[0].paise, 4000);
      expect(r[1].date, DateTime(2026, 10, 14));
      expect(r[1].paise, 5000);
    });

    test('PayoutsData: both shapes and the reason a withdrawal is blocked', () {
      final t = PayoutsData.fromJson(payoutsAnswer());
      expect(t.tokenMode, isTrue);
      expect(t.withdrawableDisplay, '₹1,000');
      expect(t.heldDisplay, '₹500');
      expect(t.block, isNull);

      final l = PayoutsData.fromJson(payoutsAnswer(tokenMode: false, withdrawable: 750));
      expect(l.tokenMode, isFalse);
      expect(l.withdrawableDisplay, '₹750');

      expect(PayoutsData.fromJson(payoutsAnswer(hostStatus: 'paused')).block, PayoutBlock.notLive);
      expect(PayoutsData.fromJson(payoutsAnswer(kycOk: false)).block, PayoutBlock.kyc);
      expect(PayoutsData.fromJson(payoutsAnswer(bankOk: false)).block, PayoutBlock.bank);
      expect(PayoutsData.fromJson(payoutsAnswer(withdrawable: 499)).block, PayoutBlock.tooLow);
    });

    test('PayoutRequest: only requested can be cancelled; the UTR and reason ride along', () {
      final paid = PayoutRequest.fromJson(payoutRow('p', 'paid', utr: 'UTR1'));
      expect(paid.canCancel, isFalse);
      expect(paid.utr, 'UTR1');
      expect(PayoutRequest.fromJson(payoutRow('p', 'requested')).canCancel, isTrue);
      expect(PayoutRequest.fromJson(payoutRow('p', 'approved')).canCancel, isFalse);
      expect(PayoutRequest.fromJson(payoutRow('p', 'rejected', reason: 'No.')).reason, 'No.');
    });

    test('HostCallsData tolerates missing keys', () {
      final d = HostCallsData.fromJson(const <String, dynamic>{});
      expect(d.calls, isEmpty);
      expect(d.todayCalls, 0);
    });
  });

  group('DashFormat', () {
    test('day and time', () {
      expect(DashFormat.day(DateTime(2026, 10, 4)), '4 Oct');
      expect(DashFormat.dayTimeOf(DateTime(2026, 10, 9, 16, 30).millisecondsSinceEpoch), '9 Oct, 4:30 pm');
      expect(DashFormat.dayTimeOf(DateTime(2026, 1, 2, 0, 5).millisecondsSinceEpoch), '2 Jan, 12:05 am');
      expect(DashFormat.dayTimeOf(DateTime(2026, 1, 2, 12, 0).millisecondsSinceEpoch), '2 Jan, 12:00 pm');
      expect(DashFormat.dayOf(null), '');
      expect(DashFormat.dayTimeOf(null), '');
    });
  });
}
