import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/cashfree_checkout.dart';
import 'package:hf_app/data/in_app_checkout.dart';
import 'package:hf_app/data/repos/wallet_repo.dart';
import 'package:hf_app/demo/screens/checkout_flow.dart';

import 'fake_checkout.dart';

/// [HF-WIRE-21] The in-app checkout on our own screens, driven with a fake payment SDK. No browser, no provider page.

typedef _Handler = Object? Function(String method, String path, Object? body);

class _Api extends ApiClient {
  _Api(this.handler) : super(origin: 'https://api.test');

  _Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }

  int count(String prefix) => calls.where((c) => c.startsWith(prefix)).length;
}

const _orderId = 'hftop_aaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, Object?> _order(int rupees, {String mode = 'native', String? session = 'session_1'}) => {
      'ok': true,
      'orderId': _orderId,
      'topupId': _orderId,
      'amountPaise': rupees * 100,
      'creditPaise': (rupees * 100 * 10000) ~/ 11800,
      'gstPaise': rupees * 100 - (rupees * 100 * 10000) ~/ 11800,
      'checkoutUrl': mode == 'web' ? 'https://pay.test/checkout?s=1' : null,
      'paymentSessionId': session,
      'environment': 'sandbox',
      'checkoutMode': mode,
    };

_Api _api({Object? Function(String status)? status, Object? Function()? order}) => _Api((m, p, b) {
      if (m == 'POST' && p == '/api/hf/wallet/topup') return order != null ? order() : _order(500);
      if (m == 'GET' && p.startsWith('/api/hf/wallet/topup/')) return status != null ? status('') : {'state': 'pending'};
      if (m == 'PATCH' && p == '/api/hf/me') return {'ok': true};
      return <String, Object?>{};
    });

const _full = CheckoutProfile(name: 'Asha Rao', email: 'asha@example.com', phoneVerified: true, phoneMasked: '******3210');
const _apps = [
  UpiApp(id: 'com.phonepe.app', name: 'PhonePe'),
  UpiApp(id: 'com.google.android.apps.nbu.paisa.user', name: 'Google Pay'),
];

class _Harness {
  final List<String> finished = [];
  bool closed = false;
  int saved = 0;
}

Future<_Harness> _pump(
  WidgetTester tester, {
  required _Api api,
  required FakeCheckout checkout,
  CheckoutProfile profile = _full,
  int rupees = 500,
  Duration collectWindow = const Duration(minutes: 5),
}) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final h = _Harness();
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: SafeArea(
        child: CheckoutFlow(
          rupees: rupees,
          repo: WalletRepo(api),
          checkout: checkout,
          profile: profile,
          collectWindow: collectWindow,
          onFinish: h.finished.add,
          onClose: () => h.closed = true,
          onProfileSaved: () => h.saved++,
        ),
      ),
    ),
  ));
  await tester.pumpAndSettle();
  return h;
}

/// The flow's spinners animate forever, so `pumpAndSettle` would never return; give it a moment instead.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

String _next(int rupees) => '/payment?amount=$rupees&order=$_orderId&credit=${(rupees * 100 * 10000) ~/ 11800}';

void main() {
  group('input checks', () {
    test('UPI ID', () {
      expect(isValidUpiId('asha@okhdfcbank'), isTrue);
      expect(isValidUpiId(' 9876543210@ybl '), isTrue);
      expect(isValidUpiId('asha.rao-1@paytm'), isTrue);
      expect(isValidUpiId('asha'), isFalse);
      expect(isValidUpiId('asha@'), isFalse);
      expect(isValidUpiId('@bank'), isFalse);
      expect(isValidUpiId('a sha@bank'), isFalse);
    });

    test('card expiry must be a real month that has not passed', () {
      final now = DateTime(2026, 10, 19);
      expect(parseCardExpiry('12/30', now: now)?.mm, '12');
      expect(parseCardExpiry('1230', now: now)?.yy, '30');
      expect(parseCardExpiry('10/26', now: now), isNotNull);
      expect(parseCardExpiry('09/26', now: now), isNull);
      expect(parseCardExpiry('13/30', now: now), isNull);
      expect(parseCardExpiry('00/30', now: now), isNull);
      expect(parseCardExpiry('12/9', now: now), isNull);
    });

    test('cvv, name and email', () {
      expect(isValidCvv('123'), isTrue);
      expect(isValidCvv('1234'), isTrue);
      expect(isValidCvv('12'), isFalse);
      expect(isValidCvv('12a'), isFalse);
      expect(isValidPersonName('Asha Rao'), isTrue);
      expect(isValidPersonName('A'), isFalse);
      expect(isValidPersonName('Asha 2'), isFalse);
      expect(isValidPersonName('asha@x.com'), isFalse);
      expect(isValidEmail('asha@example.com'), isTrue);
      expect(isValidEmail('asha@example'), isFalse);
      expect(isValidEmail('asha @example.com'), isFalse);
    });

    test('an SDK error that says the way of paying is not switched on is recognised', () {
      expect(CashfreeInAppCheckout.looksNotEnabled('Card payments are not enabled for this merchant', null), isTrue);
      expect(CashfreeInAppCheckout.looksNotEnabled('UPI intent is not allowed', 'x'), isTrue);
      expect(CashfreeInAppCheckout.looksNotEnabled('Your card was declined by the bank', 'payment_declined'), isFalse);
      expect(CashfreeInAppCheckout.looksNotEnabled(null, null), isFalse);
    });
  });

  group('details step', () {
    testWidgets('name and email missing: asked on our screen, saved, then the methods; the order carries them', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps);
      final h = await _pump(tester, api: api, checkout: fake, profile: const CheckoutProfile(phoneVerified: true, phoneMasked: '******3210'));
      expect(find.byKey(const Key('details-name')), findsOneWidget);
      expect(find.text('WhatsApp number ******3210'), findsOneWidget);
      // Continue is off until both look right.
      await tester.tap(find.byKey(const Key('details-continue')));
      await tester.pump();
      expect(api.calls, isEmpty);
      await tester.enterText(find.byKey(const Key('details-name')), 'Asha Rao');
      await tester.enterText(find.byKey(const Key('details-email')), 'not an email');
      await tester.pump();
      await tester.tap(find.byKey(const Key('details-continue')));
      await tester.pump();
      expect(api.calls, isEmpty);
      await tester.enterText(find.byKey(const Key('details-email')), 'Asha@Example.com');
      await tester.pump();
      await tester.tap(find.byKey(const Key('details-continue')));
      await _settle(tester);
      expect(api.calls, ['PATCH /api/hf/me', 'PATCH /api/hf/me']);
      expect(api.bodies, [
        {'displayName': 'Asha Rao'},
        {'email': 'asha@example.com'},
      ]);
      expect(h.saved, 1);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);

      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      final create = api.bodies[api.calls.indexOf('POST /api/hf/wallet/topup')] as Map;
      expect(create['customer_name'], 'Asha Rao');
      expect(create['customer_email'], 'asha@example.com');
      expect(create['client'], 'app');
    });

    testWidgets('a refused profile save (email saving off) never blocks paying', (tester) async {
      final api = _Api((m, p, b) {
        if (m == 'PATCH') return const ApiException(kind: ApiFailure.http, status: 403, code: 'feature_off', message: 'This isn’t available yet.');
        return {'state': 'pending'};
      });
      await _pump(tester, api: api, checkout: FakeCheckout(apps: _apps), profile: const CheckoutProfile());
      await tester.enterText(find.byKey(const Key('details-name')), 'Asha Rao');
      await tester.enterText(find.byKey(const Key('details-email')), 'asha@example.com');
      await tester.pump();
      await tester.tap(find.byKey(const Key('details-continue')));
      await _settle(tester);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
    });

    testWidgets('WhatsApp number not verified: says so, cannot continue', (tester) async {
      var verify = 0;
      tester.view.physicalSize = const Size(900, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CheckoutFlow(
            rupees: 500,
            repo: WalletRepo(_api()),
            checkout: FakeCheckout(),
            profile: const CheckoutProfile(name: 'Asha Rao', email: 'asha@example.com', phoneVerified: false),
            onFinish: (_) {},
            onClose: () {},
            onVerifyPhone: () => verify++,
          ),
        ),
      ));
      await _settle(tester);
      expect(find.textContaining('not verified yet'), findsOneWidget);
      await tester.tap(find.byKey(const Key('details-continue')));
      await tester.pump();
      expect(find.byKey(const Key('pay-amount')), findsNothing);
      await tester.tap(find.byKey(const Key('verify-phone')));
      expect(verify, 1);
    });

    testWidgets('everything known: straight to the methods, no order yet, no provider name anywhere', (tester) async {
      final api = _api();
      await _pump(tester, api: api, checkout: FakeCheckout(apps: _apps));
      expect(find.byKey(const Key('details-name')), findsNothing);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
      expect(find.text('₹500'), findsOneWidget);
      expect(api.calls, isEmpty);
      expect(find.textContaining(RegExp('cashfree', caseSensitive: false)), findsNothing);
    });
  });

  group('UPI app', () {
    testWidgets('shows the installed UPI apps; tapping one pays with that app and ends on the Payment screen', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps);
      final h = await _pump(tester, api: api, checkout: fake);
      expect(find.text('PhonePe'), findsOneWidget);
      expect(find.text('Google Pay'), findsOneWidget);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(api.calls, ['POST /api/hf/wallet/topup']);
      expect(fake.calls, ['upi_app|$_orderId|session_1|true|com.phonepe.app']);
      expect(h.finished, [_next(500)]);
      expect(find.byKey(const Key('processing')), findsOneWidget);
    });

    testWidgets('no UPI app on the phone: says so and the other ways are still there', (tester) async {
      await _pump(tester, api: _api(), checkout: FakeCheckout());
      expect(find.byKey(const Key('no-upi-apps')), findsOneWidget);
      expect(find.byKey(const Key('upi-id-field')), findsOneWidget);
      expect(find.byKey(const Key('pay-card-tile')), findsOneWidget);
    });

    testWidgets('payer comes back without paying: plain message and a way to check; no money claim', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps, upiAppOutcome: const PayOutcome(PayResult.failed, 'cancelled'));
      final h = await _pump(tester, api: api, checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(find.byKey(const Key('checkout-error')), findsOneWidget);
      expect(find.textContaining('not completed'), findsOneWidget);
      expect(h.finished, isEmpty);
      await tester.tap(find.byKey(const Key('check-payment')));
      await _settle(tester);
      expect(h.finished, ['${_next(500)}&sdk=err']);
    });

    testWidgets('a retry reuses the same order (one order per visit)', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps, upiAppOutcome: const PayOutcome(PayResult.failed));
      await _pump(tester, api: api, checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('upi-app-com.google.android.apps.nbu.paisa.user')));
      await _settle(tester);
      expect(api.count('POST'), 1);
      expect(fake.calls.length, 2);
    });

    testWidgets('not switched on for the merchant: "not available right now", nothing else', (tester) async {
      final fake = FakeCheckout(apps: _apps, upiAppOutcome: const PayOutcome(PayResult.notEnabled, 'UPI intent is not enabled'));
      final h = await _pump(tester, api: _api(), checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(find.textContaining('This payment method is not available right now'), findsOneWidget);
      expect(find.byKey(const Key('check-payment')), findsNothing);
      expect(find.textContaining('not enabled'), findsNothing);
      expect(h.finished, isEmpty);
    });
  });

  group('UPI ID', () {
    testWidgets('a bad UPI ID is refused on the spot; nothing is created', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps);
      await _pump(tester, api: api, checkout: fake);
      await tester.enterText(find.byKey(const Key('upi-id-field')), 'asha');
      await tester.tap(find.byKey(const Key('send-request')));
      await tester.pump();
      expect(find.text('Enter a UPI ID like name@bank.'), findsOneWidget);
      expect(api.calls, isEmpty);
      expect(fake.calls, isEmpty);
    });

    testWidgets('request sent: waiting screen with countdown; approving (server says paid) ends on the Payment screen', (tester) async {
      var paid = false;
      final api = _api(status: (_) => paid ? {'state': 'paid', 'creditPaise': 42372} : {'state': 'pending'});
      final fake = FakeCheckout(apps: _apps)..upiIdWait = Completer<PayOutcome>();
      final h = await _pump(tester, api: api, checkout: fake);
      await tester.enterText(find.byKey(const Key('upi-id-field')), 'asha@okhdfcbank');
      await tester.tap(find.byKey(const Key('send-request')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('wait-title')), findsOneWidget);
      expect(find.text('Approve the request in your UPI app'), findsOneWidget);
      expect(find.textContaining('asha@okhdfcbank'), findsOneWidget);
      expect(find.text('Time left 5:00'), findsOneWidget);
      expect(fake.calls, ['upi_id|$_orderId|session_1|true|asha@okhdfcbank']);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Time left 4:59'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2)); // a poll: still pending
      expect(h.finished, isEmpty);

      paid = true;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      await tester.pump();
      expect(h.finished, [_next(500)]);
    });

    testWidgets('never approved: the countdown ends, "expired", no money claimed; Send again makes a fresh request', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps)..upiIdWait = Completer<PayOutcome>();
      final h = await _pump(tester, api: api, checkout: fake, collectWindow: const Duration(seconds: 4));
      await tester.enterText(find.byKey(const Key('upi-id-field')), 'asha@okhdfcbank');
      await tester.tap(find.byKey(const Key('send-request')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('wait-title')), findsOneWidget);
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(find.byKey(const Key('wait-expired')), findsOneWidget);
      expect(find.textContaining('No money was taken'), findsOneWidget);
      expect(h.finished, isEmpty);

      fake.upiIdWait = Completer<PayOutcome>();
      await tester.tap(find.byKey(const Key('wait-again')));
      await tester.pump();
      await tester.pump();
      expect(api.count('POST'), 2);
      expect(fake.calls.where((c) => c.startsWith('upi_id')).length, 2);
      expect(find.byKey(const Key('wait-title')), findsOneWidget);

      await tester.tap(find.byKey(const Key('wait-cancel')));
      await tester.pump();
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
    });

    testWidgets('request declined / not sent: back to the methods with a plain message', (tester) async {
      final fake = FakeCheckout(apps: _apps)..upiIdOutcome = const PayOutcome(PayResult.failed, 'declined');
      final h = await _pump(tester, api: _api(), checkout: fake);
      await tester.enterText(find.byKey(const Key('upi-id-field')), 'asha@okhdfcbank');
      await tester.tap(find.byKey(const Key('send-request')));
      await _settle(tester);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
      expect(find.textContaining('declined or could not be sent'), findsOneWidget);
      expect(h.finished, isEmpty);
    });

    testWidgets('server says the payment failed while waiting: stops waiting, no money taken', (tester) async {
      final api = _api(status: (_) => {'state': 'failed'});
      final fake = FakeCheckout(apps: _apps)..upiIdWait = Completer<PayOutcome>();
      await _pump(tester, api: api, checkout: fake);
      await tester.enterText(find.byKey(const Key('upi-id-field')), 'asha@okhdfcbank');
      await tester.tap(find.byKey(const Key('send-request')));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(find.text('The payment did not go through. No money was taken.'), findsOneWidget);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
    });
  });

  group('card', () {
    Future<void> openCard(WidgetTester tester) async {
      await tester.tap(find.byKey(const Key('pay-card-tile')));
      await _settle(tester);
    }

    Future<void> fill(WidgetTester tester, {String number = '4111111111111111', String exp = '1230', String cvv = '123', String? holder}) async {
      await tester.enterText(find.byKey(const Key('fake-card-number')), number);
      await tester.enterText(find.byKey(const Key('card-expiry')), exp);
      await tester.enterText(find.byKey(const Key('card-cvv')), cvv);
      if (holder != null) await tester.enterText(find.byKey(const Key('card-holder')), holder);
      await tester.pump();
    }

    testWidgets('card form on our screen: Pay stays off until it is complete; success ends on the Payment screen', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps);
      final h = await _pump(tester, api: api, checkout: fake);
      await openCard(tester);
      expect(api.calls, ['POST /api/hf/wallet/topup']);
      expect(find.byKey(const Key('fake-card-number')), findsOneWidget);
      expect(find.text('Asha Rao'), findsOneWidget); // name on card is pre-filled from the profile

      await tester.tap(find.byKey(const Key('card-pay')));
      await tester.pump();
      expect(fake.calls.where((c) => c.startsWith('card_pay')), isEmpty);

      await fill(tester);
      expect(find.text('12/30'), findsOneWidget); // typed "1230"
      await tester.tap(find.byKey(const Key('card-pay')));
      await _settle(tester);
      expect(fake.calls.last, 'card_pay|Asha Rao|12|30|cvv3');
      expect(h.finished, [_next(500)]);
    });

    testWidgets('an expired card or a short CVV keeps Pay off', (tester) async {
      final fake = FakeCheckout(apps: _apps);
      await _pump(tester, api: _api(), checkout: fake);
      await openCard(tester);
      await fill(tester, exp: '0120');
      await tester.tap(find.byKey(const Key('card-pay')));
      await tester.pump();
      await fill(tester, exp: '1230', cvv: '12');
      await tester.tap(find.byKey(const Key('card-pay')));
      await tester.pump();
      expect(fake.calls.where((c) => c.startsWith('card_pay')), isEmpty);
    });

    testWidgets('declined card: message on the form, CVV cleared, can try again; nothing else leaves the screen', (tester) async {
      final fake = FakeCheckout(apps: _apps, cardOutcome: const PayOutcome(PayResult.failed, 'declined'));
      final h = await _pump(tester, api: _api(), checkout: fake);
      await openCard(tester);
      await fill(tester);
      await tester.tap(find.byKey(const Key('card-pay')));
      await _settle(tester);
      expect(find.textContaining('Your card was not accepted'), findsOneWidget);
      expect(find.byKey(const Key('card-expiry')), findsOneWidget);
      expect(h.finished, isEmpty);
      final cvv = tester.widget<TextField>(find.byKey(const Key('card-cvv')));
      expect(cvv.controller!.text, isEmpty);
      // second try works
      fake.cardOutcome = const PayOutcome(PayResult.completed);
      await tester.enterText(find.byKey(const Key('card-cvv')), '456');
      await tester.pump();
      await tester.tap(find.byKey(const Key('card-pay')));
      await _settle(tester);
      expect(h.finished, [_next(500)]);
    });

    testWidgets('cards not enabled for the merchant: "not available right now" and back to the methods', (tester) async {
      final fake = FakeCheckout(apps: _apps, cardOutcome: const PayOutcome(PayResult.notEnabled, 'Card payments are not enabled'));
      await _pump(tester, api: _api(), checkout: fake);
      await openCard(tester);
      await fill(tester);
      await tester.tap(find.byKey(const Key('card-pay')));
      await _settle(tester);
      expect(find.textContaining('This payment method is not available right now'), findsOneWidget);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
    });

    testWidgets('no card form on this phone: "not available right now"', (tester) async {
      final fake = FakeCheckout(apps: _apps, cardsAvailable: false);
      await _pump(tester, api: _api(), checkout: fake);
      await openCard(tester);
      expect(find.textContaining('This payment method is not available right now'), findsOneWidget);
      expect(find.byKey(const Key('fake-card-number')), findsNothing);
    });

    testWidgets('card data never reaches our server: the only calls are the order and nothing carries card words', (tester) async {
      final api = _api();
      final fake = FakeCheckout(apps: _apps);
      await _pump(tester, api: api, checkout: fake);
      await openCard(tester);
      await fill(tester);
      await tester.tap(find.byKey(const Key('card-pay')));
      await _settle(tester);
      final sent = api.bodies.map((b) => '$b').join(' ');
      expect(sent.contains('4111'), isFalse);
      expect(sent.contains('cvv'), isFalse);
      expect(api.calls.every((c) => c == 'POST /api/hf/wallet/topup'), isTrue);
    });
  });

  group('server answers', () {
    testWidgets('a refusal creating the order is shown in plain words and nothing opens', (tester) async {
      final api = _Api((m, p, b) => const ApiException(
          kind: ApiFailure.http, status: 409, code: 'whatsapp_required', message: 'Verify your WhatsApp number in Settings before adding money.'));
      final fake = FakeCheckout(apps: _apps);
      await _pump(tester, api: api, checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(find.text('Verify your WhatsApp number in Settings before adding money.'), findsOneWidget);
      expect(fake.calls, isEmpty);
    });

    testWidgets('an order with no payment session: "not available right now"', (tester) async {
      final api = _api(order: () => _order(500, session: null));
      final fake = FakeCheckout(apps: _apps);
      await _pump(tester, api: api, checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(find.textContaining('This payment method is not available right now'), findsOneWidget);
      expect(fake.calls, isEmpty);
    });

    testWidgets('server flag hfCheckoutMode=web: the old hosted checkout is used, and only then', (tester) async {
      final api = _api(order: () => _order(500, mode: 'web'));
      final fake = FakeCheckout(apps: _apps);
      final h = await _pump(tester, api: api, checkout: fake);
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(fake.calls, ['hosted|$_orderId|session_1|true']);
      expect(h.finished, [_next(500)]);
    });

    testWidgets('native mode never opens a browser tab', (tester) async {
      var tab = false;
      Checkout.launcher = (u) async => tab = true;
      addTearDown(() => Checkout.launcher = (u) async => false);
      final h = await _pump(tester, api: _api(), checkout: FakeCheckout(apps: _apps));
      await tester.tap(find.byKey(const Key('upi-app-com.phonepe.app')));
      await _settle(tester);
      expect(tab, isFalse);
      expect(h.finished, hasLength(1));
    });
  });

  group('back', () {
    testWidgets('back from the methods goes to the amount screen; back from the card form goes to the methods', (tester) async {
      final h = await _pump(tester, api: _api(), checkout: FakeCheckout(apps: _apps));
      await tester.tap(find.byKey(const Key('pay-card-tile')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('checkout-back')));
      await _settle(tester);
      expect(find.byKey(const Key('pay-amount')), findsOneWidget);
      expect(h.closed, isFalse);
      await tester.tap(find.byKey(const Key('checkout-back')));
      await _settle(tester);
      expect(h.closed, isTrue);
    });
  });
}
