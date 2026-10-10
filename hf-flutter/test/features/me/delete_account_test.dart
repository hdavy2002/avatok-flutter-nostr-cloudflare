import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/features/me/ui/delete_account_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart' show FakeLinkOpener;
import 'me_test_support.dart';

const _exit = '/api/hf/account/exit';
const _delete = '/api/account/delete';
const _cancelDelete = '/api/account/delete/cancel';

Finder _key(String k) => find.byKey(ValueKey<String>(k));

/// `GET /api/hf/account/exit` for a person with nothing to settle.
Map<String, Object?> deleteDecision({Map<String, Object?>? deletion}) => {
      'gateEnabled': true,
      'decision': 'delete',
      'paidBalance': 0,
      'withdrawable': 0,
      'held': 0,
      'heldReleaseAt': null,
      'refundable': 0,
      'manualRefund': 0,
      'forfeitRupees': 0,
      'bankOk': false,
      'testCredits': 0,
      'testEarnings': 0,
      'exit': null,
      'payout': null,
      'refund': null,
      'deletion': deletion,
    };

/// `GET /api/hf/account/exit` for a person who has money (token mode: tokens refunded through Google, earnings paid out).
Map<String, Object?> exitDecision({
  num refundable = 120,
  num withdrawable = 450,
  num held = 0,
  int? heldReleaseAt,
  num forfeit = 0,
  bool bankOk = true,
  Map<String, Object?>? exit,
  Map<String, Object?>? payout,
  Map<String, Object?>? refund,
}) =>
    {
      ...deleteDecision(),
      'decision': 'exit',
      'mode': 'tokens',
      'paidBalance': refundable + withdrawable,
      'withdrawable': withdrawable,
      'held': held,
      'heldReleaseAt': heldReleaseAt,
      'refundable': refundable,
      'forfeitRupees': forfeit,
      'bankOk': bankOk,
      'testCredits': 5,
      'exit': exit,
      'payout': payout,
      'refund': refund,
    };

void main() {
  late FakeApiClient api;
  late MeEvents events;
  late FakeLinkOpener links;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = FakeApiClient();
    events = MeEvents()..install();
    links = FakeLinkOpener();
  });

  tearDown(() => events.remove());

  Future<void> open(WidgetTester tester) =>
      pumpMe(tester, session: meSession(), api: api, location: Routes.meDelete, links: links).then((_) {});

  Future<void> tick(WidgetTester tester, String key) => tapKeyed(tester, key, ms: 200);

  group('decision: delete', () {
    testWidgets('explains the 30-day wait and DPDP, and waits for the tick before Delete works', (tester) async {
      api.onJson('GET', _exit, deleteDecision());
      await open(tester);

      expect(_key('delete-path'), findsOneWidget);
      expect(find.text(DeleteCopy.waitTime), findsOneWidget);
      expect(find.text(DeleteCopy.dataDeleted), findsOneWidget);
      expect(_key('exit-path'), findsNothing);

      // Delete is off until the box is ticked.
      await tapKeyed(tester, 'delete-confirm', ms: 200);
      expect(api.callsTo('POST', _delete), isEmpty);
      expect(tester.widget<ElevatedButton>(find.descendant(of: _key('delete-confirm'), matching: find.byType(ElevatedButton))).onPressed, isNull);

      await tick(tester, 'delete-ack');
      expect(tester.widget<ElevatedButton>(find.descendant(of: _key('delete-confirm'), matching: find.byType(ElevatedButton))).onPressed, isNotNull);
    });

    testWidgets('confirm schedules the deletion and shows the date with Keep my account', (tester) async {
      final end = DateTime(2026, 11, 9, 12).millisecondsSinceEpoch;
      api
        ..onJson('GET', _exit, deleteDecision())
        ..onJson('POST', _delete, {'scheduled': true, 'grace_ends_at': end, 'cancellable': true});
      await open(tester);

      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'delete-confirm', ms: 600);

      expect(api.callsTo('POST', _delete), hasLength(1));
      expect(_key('deletion-date'), findsOneWidget);
      expect(find.textContaining(formatDay(end)), findsOneWidget);
      expect(find.textContaining('9 Nov 2026'), findsOneWidget);
      expect(events.named('hf_app_account_delete_started'), [
        {'decision': 'delete'},
      ]);
      expect(events.named('hf_app_account_delete_result'), [
        {'decision': 'delete', 'outcome': 'ok'},
      ]);
    });

    testWidgets('Keep my account cancels the deletion and goes back to the start', (tester) async {
      final end = DateTime(2026, 11, 9, 12).millisecondsSinceEpoch;
      var pending = true;
      api
        ..on('GET', _exit, (_) => deleteDecision(deletion: pending ? {'status': 'pending', 'scheduledAt': end} : null))
        ..on('POST', _cancelDelete, (_) {
          pending = false;
          return {'cancelled': true};
        });
      await open(tester);

      // The account is already scheduled: the screen opens on the date.
      expect(_key('deletion-date'), findsOneWidget);
      await tapKeyed(tester, 'deletion-keep', ms: 800);

      expect(api.callsTo('POST', _cancelDelete), hasLength(1));
      expect(_key('deletion-date'), findsNothing);
      expect(_key('delete-path'), findsOneWidget);
    });

    testWidgets('a refusal from the worker is shown and nothing is scheduled', (tester) async {
      api
        ..onJson('GET', _exit, deleteDecision())
        ..onError('POST', _delete,
            const ApiError(status: 503, code: 'try_again', message: 'We could not check your wallet. Please try again in a moment.'));
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'delete-confirm', ms: 600);

      expect(find.text('We could not check your wallet. Please try again in a moment.'), findsOneWidget);
      expect(_key('deletion-date'), findsNothing);
      expect(events.named('hf_app_account_delete_result'), [
        {'decision': 'delete', 'outcome': 'failed', 'reason': 'try_again', 'status': 503},
      ]);
    });

    testWidgets('409 deferred switches to the settle path', (tester) async {
      var decision = 'delete';
      api
        ..on('GET', _exit, (_) => decision == 'delete' ? deleteDecision() : exitDecision())
        ..on('POST', _delete, (_) {
          decision = 'exit';
          throw const ApiError(
            status: 409,
            code: 'http_409',
            extra: {'scheduled': false, 'deferred': true, 'reason': 'settle_money_first', 'exit_url': '/account/close'},
          );
        });
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'delete-confirm', ms: 800);

      expect(_key('exit-path'), findsOneWidget);
      expect(_key('delete-path'), findsNothing);
      expect(find.text(DeleteCopy.settleFirst), findsOneWidget);
      expect(events.named('hf_app_account_delete_result'), [
        {'decision': 'delete', 'outcome': 'deferred', 'status': 409},
      ]);
      // The tick is asked for again on the new path.
      expect(tester.widget<Checkbox>(_key('delete-ack')).value, isFalse);
    });

    testWidgets('even when the worker still says delete, a deferred answer shows the settle path', (tester) async {
      api
        ..onJson('GET', _exit, deleteDecision())
        ..onError('POST', _delete, const ApiError(status: 409, code: 'http_409', extra: {'deferred': true}));
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'delete-confirm', ms: 800);
      expect(_key('exit-path'), findsOneWidget);
    });
  });

  group('decision: exit', () {
    testWidgets('shows what is refunded through Google and paid out first, and holds the button until ticked', (tester) async {
      final release = DateTime(2026, 10, 20, 12).millisecondsSinceEpoch;
      api.onJson('GET', _exit, exitDecision(held: 80, heldReleaseAt: release));
      await open(tester);

      expect(_key('exit-path'), findsOneWidget);
      expect(_key('delete-path'), findsNothing);
      expect(find.textContaining('refunded through Google Play'), findsOneWidget);
      expect(find.textContaining('₹120'), findsWidgets);
      expect(find.textContaining('paid to your verified bank account first'), findsOneWidget);
      expect(find.textContaining('₹450'), findsWidgets);
      expect(find.textContaining('on hold until 20 Oct 2026'), findsOneWidget);
      expect(find.text(DeleteCopy.testDropped), findsOneWidget);
      expect(find.text(DeleteCopy.dataDeleted), findsOneWidget);
      expect(_key('exit-forfeit-card'), findsNothing);

      await tapKeyed(tester, 'exit-confirm', ms: 200);
      expect(api.callsTo('POST', _exit), isEmpty);
    });

    testWidgets('confirm starts the closing with an Idempotency-Key, then shows the status', (tester) async {
      var started = false;
      api
        ..on('GET', _exit, (_) {
          if (!started) return exitDecision();
          return exitDecision(
            exit: {'status': 'waiting_payouts', 'payoutId': 'p1', 'refundId': 'r1', 'note': null, 'requestedAt': 1},
            payout: {'id': 'p1', 'amount': 450, 'status': 'requested', 'reason': null, 'utr': null},
            refund: {'id': 'r1', 'amount': 120, 'status': 'requested', 'reason': null, 'utr': null},
          );
        })
        ..on('POST', _exit, (_) {
          started = true;
          return {'ok': true, 'status': 'waiting_payouts', 'payoutId': 'p1', 'refundId': 'r1'};
        });
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 800);

      final post = api.callsTo('POST', _exit).single;
      expect((post.body as Map)['forfeit'], false);
      expect(post.idempotencyKey, isNotNull);
      expect(post.idempotencyKey, startsWith('hfexit-'));
      expect(events.named('hf_app_account_delete_started'), [
        {'decision': 'exit'},
      ]);
      expect(events.named('hf_app_account_delete_result'), [
        {'decision': 'exit', 'outcome': 'ok'},
      ]);

      // Now the status view.
      expect(find.text(DeleteCopy.statusTitle), findsOneWidget);
      expect(find.text(DeleteCopy.statusPayouts), findsOneWidget);
      expect(find.text('Waiting for approval'), findsOneWidget);
      expect(find.text('Refund requested from Google Play'), findsOneWidget);
      expect(_key('exit-path'), findsNothing);
    });

    testWidgets('money that cannot be paid out needs a tick to give it up, and the tick is sent', (tester) async {
      api
        ..onJson('GET', _exit, exitDecision(refundable: 0, withdrawable: 0, forfeit: 300, bankOk: false))
        ..onJson('POST', _exit, {'ok': true, 'status': 'waiting_payouts', 'payoutId': null, 'refundId': null});
      await open(tester);

      expect(_key('exit-forfeit-card'), findsOneWidget);
      expect(find.text(DeleteCopy.forfeitNoBank), findsOneWidget);
      expect(_key('exit-add-bank'), findsOneWidget);

      // The main tick alone is not enough.
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 200);
      expect(api.callsTo('POST', _exit), isEmpty);

      await tick(tester, 'exit-forfeit');
      await tapKeyed(tester, 'exit-confirm', ms: 600);
      final post = api.callsTo('POST', _exit);
      expect(post, hasLength(1));
      expect((post.single.body as Map)['forfeit'], true);
    });

    testWidgets('forfeit_required from the worker shows the amount and asks for the tick', (tester) async {
      api
        ..onJson('GET', _exit, exitDecision())
        ..onError(
          'POST',
          _exit,
          const ApiError(
            status: 409,
            code: 'forfeit_required',
            message: 'Some money cannot be paid out.',
            extra: {'forfeitRupees': 300},
          ),
        );
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 600);

      expect(find.text('Some money cannot be paid out.'), findsWidgets);
      expect(_key('exit-forfeit-card'), findsOneWidget);
      expect(find.text(DeleteCopy.forfeitLabel('₹300')), findsOneWidget);
    });

    testWidgets('409 active_call shows the worker message and nothing changes', (tester) async {
      api
        ..onJson('GET', _exit, exitDecision())
        ..onError(
          'POST',
          _exit,
          const ApiError(
            status: 409,
            code: 'active_call',
            message: 'You have a call in progress. Please finish it before closing your account.',
          ),
        );
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 600);

      expect(find.text('You have a call in progress. Please finish it before closing your account.'), findsOneWidget);
      expect(_key('exit-path'), findsOneWidget);
      expect(find.text(DeleteCopy.statusTitle), findsNothing);
      expect(events.named('hf_app_account_delete_result'), [
        {'decision': 'exit', 'outcome': 'failed', 'reason': 'active_call', 'status': 409},
      ]);
    });

    testWidgets('409 bank_required shows the message and the Add my bank account button', (tester) async {
      api
        ..onJson('GET', _exit, exitDecision(bankOk: false, forfeit: 450, withdrawable: 450, refundable: 0))
        ..onError(
          'POST',
          _exit,
          const ApiError(status: 409, code: 'bank_required', message: 'Add and verify your bank account first, or choose to give up your earnings.'),
        );
      await open(tester);
      await tick(tester, 'delete-ack');
      await tick(tester, 'exit-forfeit');
      await tapKeyed(tester, 'exit-confirm', ms: 600);

      expect(find.text('Add and verify your bank account first, or choose to give up your earnings.'), findsOneWidget);
      expect(_key('exit-add-bank'), findsOneWidget);
    });

    testWidgets('409 nothing_to_settle falls back to the delete path', (tester) async {
      var decision = 'exit';
      api
        ..on('GET', _exit, (_) => decision == 'exit' ? exitDecision() : deleteDecision())
        ..on('POST', _exit, (_) {
          decision = 'delete';
          throw const ApiError(
            status: 409,
            code: 'nothing_to_settle',
            message: 'You have no money to settle. You can close your account now.',
          );
        });
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 800);

      expect(_key('delete-path'), findsOneWidget);
      expect(_key('exit-path'), findsNothing);
      expect(find.text('You have no money to settle. You can close your account now.'), findsOneWidget);
    });

    testWidgets('with no internet the retry reuses the same Idempotency-Key', (tester) async {
      var attempts = 0;
      api
        ..onJson('GET', _exit, exitDecision())
        ..on('POST', _exit, (_) {
          attempts += 1;
          if (attempts == 1) throw ApiError.network();
          return {'ok': true, 'status': 'waiting_payouts', 'payoutId': null, 'refundId': null};
        });
      await open(tester);
      await tick(tester, 'delete-ack');
      await tapKeyed(tester, 'exit-confirm', ms: 600);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);

      await tapKeyed(tester, 'exit-confirm', ms: 600);
      final posts = api.callsTo('POST', _exit);
      expect(posts, hasLength(2));
      expect(posts[0].idempotencyKey, isNotNull);
      expect(posts[1].idempotencyKey, posts[0].idempotencyKey);
    });
  });

  group('closing in progress', () {
    testWidgets('shows the hold date, the payout and the refund status, and can be cancelled', (tester) async {
      final release = DateTime(2026, 10, 20, 12).millisecondsSinceEpoch;
      var cancelled = false;
      api
        ..on('GET', _exit, (_) {
          if (cancelled) return exitDecision();
          return exitDecision(
            held: 80,
            heldReleaseAt: release,
            exit: {'status': 'waiting_hold', 'payoutId': null, 'refundId': 'r1', 'note': null, 'requestedAt': 1},
            refund: {'id': 'r1', 'amount': 120, 'status': 'processing', 'reason': null, 'utr': null},
          );
        })
        ..on('DELETE', _exit, (_) {
          cancelled = true;
          return {'ok': true};
        });
      await open(tester);

      expect(find.text(DeleteCopy.statusHold), findsOneWidget);
      expect(find.text('Released on 20 Oct 2026'), findsOneWidget);
      expect(find.text('Refund in progress'), findsOneWidget);

      await tapKeyed(tester, 'exit-cancel', ms: 800);
      expect(api.callsTo('DELETE', _exit), hasLength(1));
      expect(find.text(DeleteCopy.statusTitle), findsNothing);
      expect(_key('exit-path'), findsOneWidget);
    });

    testWidgets('a paid payout shows the bank reference, a rejected one the reason', (tester) async {
      api.onJson(
        'GET',
        _exit,
        exitDecision(
          exit: {'status': 'waiting_payouts', 'payoutId': 'p1', 'refundId': 'r1', 'note': null, 'requestedAt': 1},
          payout: {'id': 'p1', 'amount': 450, 'status': 'paid', 'reason': null, 'utr': 'UTR12345'},
          refund: {'id': 'r1', 'amount': 120, 'status': 'rejected', 'reason': 'Google could not refund this order.', 'utr': null},
        ),
      );
      await open(tester);
      expect(find.text('Paid'), findsOneWidget);
      expect(find.text('Bank reference UTR12345'), findsOneWidget);
      expect(find.text('Not refunded'), findsOneWidget);
      expect(find.text('Google could not refund this order.'), findsOneWidget);
    });

    testWidgets('cancel after the money is moving shows the worker message', (tester) async {
      api
        ..onJson(
          'GET',
          _exit,
          exitDecision(exit: {'status': 'waiting_payouts', 'payoutId': 'p1', 'refundId': null, 'note': null, 'requestedAt': 1}),
        )
        ..onError(
          'DELETE',
          _exit,
          const ApiError(
            status: 409,
            code: 'cannot_cancel',
            message: 'Your money is already being paid out, so this can no longer be cancelled.',
          ),
        );
      await open(tester);
      await tapKeyed(tester, 'exit-cancel', ms: 600);
      expect(find.text('Your money is already being paid out, so this can no longer be cancelled.'), findsOneWidget);
      expect(find.text(DeleteCopy.statusTitle), findsOneWidget);
    });
  });

  group('loading and errors', () {
    testWidgets('a failed read shows Try again, and it works', (tester) async {
      var fail = true;
      api.on('GET', _exit, (_) {
        if (fail) throw ApiError.network();
        return deleteDecision();
      });
      await open(tester);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);

      fail = false;
      await tester.tap(find.text('Try again'));
      await pumpFor(tester, 400);
      expect(_key('delete-path'), findsOneWidget);
    });

    testWidgets('Read about data deletion opens the site page', (tester) async {
      api.onJson('GET', _exit, deleteDecision());
      await open(tester);
      await tapKeyed(tester, 'delete-read-more', ms: 100);
      expect(links.sitePaths, ['/data-deletion']);
    });
  });
}
