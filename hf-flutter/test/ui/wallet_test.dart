import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/in_app_checkout.dart';
import 'package:hf_app/data/models/wallet.dart';
import 'package:hf_app/data/repos/wallet_repo.dart';
import 'package:hf_app/demo/screens/me.dart' show WalletTicket;
import 'package:hf_app/demo/screens/money.dart';
import 'package:hf_app/demo/state.dart';

typedef Handler = Object? Function(String method, String path, Map<String, Object?>? query, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<Map<String, String>?> sentHeaders = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    sentHeaders.add(headers);
    final out = handler(method, path, query, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _wallet({int balance = 42372, int test = 0, int held = 0, List<Map<String, Object?>> ledger = const [], String? next}) => {
      'balancePaise': balance,
      'testCreditPaise': test,
      'heldPaise': held,
      'ledger': ledger,
      'nextCursor': next,
    };

Map<String, Object?> _row(String id, String label, int amount, {String kind = 'topup'}) =>
    {'id': id, 'kind': kind, 'amountPaise': amount, 'at': DateTime(2026, 10, 19, 16, 5).millisecondsSinceEpoch, 'label': label};

Map<String, Object?> _order(int rupees) => {
      'ok': true,
      'orderId': 'hftop_aaaaaaaaaaaaaaaaaaaaaaaa',
      'topupId': 'hftop_aaaaaaaaaaaaaaaaaaaaaaaa',
      'amountPaise': rupees * 100,
      'creditPaise': (rupees * 100 * 10000) ~/ 11800,
      'gstPaise': rupees * 100 - (rupees * 100 * 10000) ~/ 11800,
      'checkoutUrl': 'https://pay.test/checkout?s=1',
      'paymentSessionId': 'session_1',
      'environment': 'sandbox',
    };

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/payment', builder: (_, s) => Scaffold(body: Text('PAYMENT ${s.uri.query}'))),
      GoRoute(path: '/topup', builder: (_, __) => const Scaffold(body: Text('TOPUP PAGE'))),
      GoRoute(path: '/wallet', builder: (_, __) => const Scaffold(body: Text('WALLET PAGE'))),
      GoRoute(path: '/payout', builder: (_, __) => const Scaffold(body: Text('PAYOUT PAGE'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
}

void main() {
  // The real payment SDK needs a phone: tests never start it, they use a fake or "unavailable" (browser-tab fallback).
  setUp(() => Checkout.inApp = const UnavailableCheckout());
  tearDown(() {
    Checkout.launcher = (u) async => false;
    Checkout.inApp = const UnavailableCheckout();
  });

  // [HF-WIRE-13] Refunds and withdrawals show in the history under the server's own words and the right kind.
  group('Wallet history kinds', () {
    test('refund and payout rows keep their kind and the server label', () {
      final back = LedgerEntry.fromJson({'id': 'a', 'kind': 'refund', 'amountPaise': 4000, 'at': 1760000000000, 'label': 'Withdrawal returned to your wallet'});
      expect(back.kind, LedgerKind.refund);
      expect(back.label, 'Withdrawal returned to your wallet');
      final out = LedgerEntry.fromJson({'id': 'b', 'kind': 'payout', 'amountPaise': -10000, 'at': 1760000000000, 'label': 'Withdrawal to your UPI'});
      expect(out.kind, LedgerKind.payout);
      expect(out.amountPaise, -10000);
    });
  });

  group('WalletRepo', () {
    test('credit maths matches the demo (and the server): paid / 1.18 rounded down', () {
      for (final rupees in [10, 100, 500, 1000, 5000]) {
        expect(WalletRepo.creditPaiseFor(rupees * 100) / 100, DemoState.creditFor(rupees.toDouble()), reason: '₹$rupees');
      }
      expect(WalletRepo.creditPaiseFor(50000), 42372);
    });

    test('createTopup sends whole rupees with an Idempotency-Key and parses the order', () async {
      final api = FakeApiClient((m, p, q, b) => _order(500));
      final order = await WalletRepo(api).createTopup(500);
      expect(api.calls, ['POST /api/hf/wallet/topup']);
      expect(api.bodies.single, {'amount': 500, 'client': 'app'});
      expect(api.sentHeaders.single!['Idempotency-Key'], isNotEmpty);
      expect(order.creditPaise, 42372);
      expect(order.gstPaise, 7628);
      expect(order.checkoutUrl, 'https://pay.test/checkout?s=1');
    });

    test('status maps pending, paid and failed', () async {
      final api = FakeApiClient((m, p, q, b) => {'state': 'paid', 'creditPaise': 42372});
      final st = await WalletRepo(api).status('hftop_x');
      expect(st.state.name, 'paid');
      expect(st.creditPaise, 42372);
    });
  });

  group('WalletScreen', () {
    testWidgets('shows balance, test credits, held money and history; Load more appends', (tester) async {
      final api = FakeApiClient((m, p, q, b) {
        if (q?['cursor'] == '1') return _wallet(ledger: [_row('b', 'Call with Maya', -9900, kind: 'call')]);
        return _wallet(test: 5000, held: 2000, ledger: [_row('a', 'Money added', 42372)], next: '1');
      });
      await _pump(tester, WalletScreen(repo: WalletRepo(api)));
      await tester.pumpAndSettle();
      expect(find.text('₹423.72'), findsOneWidget);
      expect(find.textContaining('Test credits ₹50.00'), findsOneWidget);
      expect(find.textContaining('₹20.00 set aside'), findsOneWidget);
      expect(find.text('Money added'), findsOneWidget);
      await tester.ensureVisible(find.text('LOAD MORE'));
      await tester.tap(find.text('LOAD MORE'));
      await tester.pumpAndSettle();
      expect(find.text('Call with Maya'), findsOneWidget);
      expect(find.text('Money added'), findsOneWidget);
      expect(find.text('LOAD MORE'), findsNothing);
    });

    testWidgets('error shows Try again and retries', (tester) async {
      var fail = true;
      final api = FakeApiClient((m, p, q, b) => fail ? ApiException.offline() : _wallet());
      await _pump(tester, WalletScreen(repo: WalletRepo(api)));
      await tester.pumpAndSettle();
      expect(find.text('You are offline'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('₹423.72'), findsOneWidget);
    });
  });

  group('TopUpScreen', () {
    testWidgets('minimum is ₹10: ₹9 shows a message and calls nothing', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(9));
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.enterText(find.byType(TextField), '9');
      await tester.pump();
      await tester.tap(find.textContaining('PAY ₹9'));
      await tester.pump();
      expect(find.text('Minimum top up is ₹10.'), findsOneWidget);
      expect(api.calls, isEmpty);
    });

    testWidgets('₹1,000 or more asks to confirm; Change does not call, Yes opens the payment page', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(1000));
      Uri? opened;
      Checkout.launcher = (u) async {
        opened = u;
        return true;
      };
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.enterText(find.byType(TextField), '1000');
      await tester.pump();
      await tester.tap(find.textContaining('PAY ₹1,000'));
      await tester.pumpAndSettle();
      expect(find.textContaining('₹1,000 or more'), findsWidgets);
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);

      await tester.tap(find.textContaining('PAY ₹1,000'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, pay'));
      await tester.pumpAndSettle();
      expect(api.calls, ['POST /api/hf/wallet/topup']);
      expect(opened.toString(), 'https://pay.test/checkout?s=1');
      expect(find.textContaining('PAYMENT amount=1000&order=hftop_'), findsOneWidget);
    });

    testWidgets('under ₹1,000 pays without a confirm dialog; the gateway name never appears', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(500));
      Checkout.launcher = (u) async => true;
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      expect(find.textContaining('Secure payment · UPI, cards and netbanking'), findsOneWidget);
      expect(find.textContaining(RegExp('cashfree', caseSensitive: false)), findsNothing);
      expect(find.textContaining('₹423.72'), findsOneWidget);
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(api.calls, ['POST /api/hf/wallet/topup']);
      expect(find.textContaining('PAYMENT'), findsOneWidget);
    });

    testWidgets('a server refusal is shown in plain words and nothing opens', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 503, code: 'topup_unavailable', message: 'Adding money opens soon.'));
      var opened = false;
      Checkout.launcher = (u) async => opened = true;
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(find.text('Adding money opens soon.'), findsOneWidget);
      expect(opened, isFalse);
    });
  });

  group('PaymentScreen', () {
    testWidgets('pending, then paid: shows the server credit and Back to wallet', (tester) async {
      var polls = 0;
      final api = FakeApiClient((m, p, q, b) => ++polls < 3 ? {'state': 'pending'} : {'state': 'paid', 'creditPaise': 42372});
      await _pump(tester, PaymentScreen(amount: 500, orderId: 'hftop_x', repo: WalletRepo(api)));
      expect(find.text('Confirming your payment…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('Confirming your payment…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Paid ₹500'), findsOneWidget);
      expect(find.text('₹423.72 added to your wallet'), findsOneWidget);
      expect(find.text('BACK TO WALLET'), findsOneWidget);
    });

    testWidgets('still pending after a minute: says so and keeps asking, then pays', (tester) async {
      var paid = false;
      final api = FakeApiClient((m, p, q, b) => paid ? {'state': 'paid', 'creditPaise': 100} : {'state': 'pending'});
      await _pump(tester, PaymentScreen(amount: 500, orderId: 'hftop_x', repo: WalletRepo(api), slowAfter: const Duration(seconds: 10)));
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(seconds: 2));
      }
      expect(find.text('We are still confirming your payment.'), findsOneWidget);
      final before = api.calls.length;
      paid = true;
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(api.calls.length, greaterThan(before));
      expect(find.text('Paid ₹500'), findsOneWidget);
    });

    testWidgets('failed: plain message, no money taken, Try again goes back to top up', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'state': 'failed'});
      await _pump(tester, PaymentScreen(amount: 500, orderId: 'hftop_x', repo: WalletRepo(api)));
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Payment did not go through. No money was taken.'), findsOneWidget);
      await tester.tap(find.text('TRY AGAIN'));
      await tester.pumpAndSettle();
      expect(find.text('TOPUP PAGE'), findsOneWidget);
    });

    testWidgets('a network blip while polling does not fail the payment', (tester) async {
      var n = 0;
      final api = FakeApiClient((m, p, q, b) => ++n == 1 ? ApiException.offline() : {'state': 'paid', 'creditPaise': 100});
      await _pump(tester, PaymentScreen(amount: 100, orderId: 'hftop_x', repo: WalletRepo(api)));
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Confirming your payment…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Paid ₹100'), findsOneWidget);
    });
  });

  // [HF-WIRE-20] In-app checkout, return link, honest error states.
  group('In-app checkout', () {
    testWidgets('session present: the payment sheet opens in the app, no browser tab, then the Payment screen', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(500));
      final fake = _FakeCheckout(const PayOutcome(PayResult.completed));
      Checkout.inApp = fake;
      var tab = false;
      Checkout.launcher = (u) async => tab = true;
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(fake.calls, ['hftop_aaaaaaaaaaaaaaaaaaaaaaaa|session_1|true']);
      expect(tab, isFalse);
      expect(find.textContaining('PAYMENT amount=500&order=hftop_'), findsOneWidget);
      expect(find.textContaining('sdk=err'), findsNothing);
    });

    testWidgets('payer backs out / SDK error: still goes to the Payment screen, marked sdk=err so it asks the server once', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(500));
      Checkout.inApp = _FakeCheckout(const PayOutcome(PayResult.failed, 'cancelled'));
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(find.textContaining('sdk=err'), findsOneWidget);
    });

    testWidgets('SDK cannot start: falls back to the browser tab', (tester) async {
      final api = FakeApiClient((m, p, q, b) => _order(500));
      Checkout.inApp = _FakeCheckout(const PayOutcome(PayResult.unavailable));
      Uri? opened;
      Checkout.launcher = (u) async {
        opened = u;
        return true;
      };
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(opened.toString(), 'https://pay.test/checkout?s=1');
      expect(find.textContaining('PAYMENT amount=500&order=hftop_'), findsOneWidget);
    });

    testWidgets('no WhatsApp number on the account: the server message is shown and nothing opens', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(
          kind: ApiFailure.http, status: 409, code: 'whatsapp_required', message: 'Verify your WhatsApp number in Settings before adding money.'));
      final fake = _FakeCheckout(const PayOutcome(PayResult.completed));
      Checkout.inApp = fake;
      await _pump(tester, TopUpScreen(repo: WalletRepo(api)));
      await tester.tap(find.textContaining('PAY ₹500'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Verify your WhatsApp number'), findsOneWidget);
      expect(fake.calls, isEmpty);
    });

    testWidgets('PaymentScreen after an SDK error: server has nothing yet -> "not completed", Try again', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'state': 'pending'});
      await _pump(tester, PaymentScreen(amount: 500, orderId: 'hftop_x', sdkFailed: true, repo: WalletRepo(api)));
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Payment was not completed.'), findsOneWidget);
      expect(find.text('TRY AGAIN'), findsOneWidget);
    });

    testWidgets('PaymentScreen after an SDK error but the server says paid: shows paid', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'state': 'paid', 'creditPaise': 100});
      await _pump(tester, PaymentScreen(amount: 100, orderId: 'hftop_x', sdkFailed: true, repo: WalletRepo(api)));
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Paid ₹100'), findsOneWidget);
    });

    testWidgets('opened from the return link (no amount): the amount comes from the server, and the balance tag is told to refresh', (tester) async {
      final api = FakeApiClient((m, p, q, b) => {'state': 'paid', 'creditPaise': 847, 'paidPaise': 1000});
      final before = WalletTicket.refresh.value;
      await _pump(tester, PaymentScreen(orderId: 'hftop_x', repo: WalletRepo(api)));
      expect(find.text('Confirming your payment…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Paid ₹10'), findsOneWidget);
      expect(find.text('₹8.47 added to your wallet'), findsOneWidget);
      expect(WalletTicket.refresh.value, before + 1);
    });

    test('hellofraands://wallet/topup/<id> opens the Payment screen for that order; junk ids are ignored', () {
      final t = linkTargetFor(Uri.parse('hellofraands://wallet/topup/hftop_aaaaaaaaaaaaaaaaaaaaaaaa'));
      expect(t?.location, '/payment?order=hftop_aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(t?.telemetryPath, '/wallet/topup/:id');
      expect(linkTargetFor(Uri.parse('hellofraands://wallet/topup/..%2Fadmin')), isNull);
      expect(linkTargetFor(Uri.parse('hellofraands://wallet/topup/x')), isNull);
      expect(linkTargetFor(Uri.parse('hellofraands://wallet'))?.location, '/wallet');
    });
  });

  group('Wallet read errors', () {
    test('one automatic second try: a 503 then success returns the wallet', () async {
      var n = 0;
      final api = FakeApiClient((m, p, q, b) => ++n == 1
          ? const ApiException(kind: ApiFailure.http, status: 503, code: 'http_503')
          : _wallet());
      final w = await WalletRepo(api, retryDelay: Duration.zero).fetch();
      expect(w.balancePaise, 42372);
      expect(n, 2);
    });

    test('offline twice -> the offline error reaches the screen after exactly two tries', () async {
      final api = FakeApiClient((m, p, q, b) => ApiException.offline());
      await expectLater(WalletRepo(api, retryDelay: Duration.zero).fetch(), throwsA(isA<ApiException>().having((e) => e.isOffline, 'offline', true)));
      expect(api.calls.length, 2);
    });

    test('a refusal (401 / 404) is not retried', () async {
      final api = FakeApiClient((m, p, q, b) => ApiException.fromResponse(401, '{"error":"unauthorized"}'));
      await expectLater(WalletRepo(api, retryDelay: Duration.zero).fetch(), throwsA(isA<ApiException>()));
      expect(api.calls.length, 1);
    });

    testWidgets('server error: says it is on our side, with Try again', (tester) async {
      final api = FakeApiClient((m, p, q, b) => const ApiException(kind: ApiFailure.http, status: 500, code: 'internal_error', message: 'Something went wrong.'));
      await _pump(tester, WalletScreen(repo: WalletRepo(api, retryDelay: Duration.zero)));
      await tester.pumpAndSettle();
      expect(find.text('Our server had a problem'), findsOneWidget);
      expect(find.textContaining('problem on our side'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });

    testWidgets('signed out: says to sign in again', (tester) async {
      final api = FakeApiClient((m, p, q, b) => ApiException.fromResponse(401, '{"error":"unauthorized"}'));
      await _pump(tester, WalletScreen(repo: WalletRepo(api, retryDelay: Duration.zero)));
      await tester.pumpAndSettle();
      expect(find.text('Please sign in again'), findsOneWidget);
    });

    testWidgets('missing route (404): "not available right now", not a generic failure', (tester) async {
      final api = FakeApiClient((m, p, q, b) => ApiException.fromResponse(404, '{"error":"not_found","message":"Not found."}'));
      await _pump(tester, WalletScreen(repo: WalletRepo(api, retryDelay: Duration.zero)));
      await tester.pumpAndSettle();
      expect(find.text('Not available right now'), findsOneWidget);
    });
  });
}

class _FakeCheckout implements InAppCheckout {
  _FakeCheckout(this.outcome);

  final PayOutcome outcome;
  final List<String> calls = [];

  @override
  Future<PayOutcome> pay({required String orderId, required String paymentSessionId, required bool sandbox}) async {
    calls.add('$orderId|$paymentSessionId|$sandbox');
    return outcome;
  }
}
