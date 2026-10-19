import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/repos/payouts_repo.dart';
import 'package:hf_app/demo/screens/money.dart';

typedef Handler = Object? Function(String method, String path, Object? body);

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
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _summary({
  int ready = 150000,
  int hold = 30000,
  Map<String, Object?>? upi = const {'vpa': 'asha@okhdfc', 'nameMatched': null},
  String kyc = 'none',
  List<Map<String, Object?>> history = const [],
}) =>
    {'readyPaise': ready, 'onHoldPaise': hold, 'minPaise': 50000, 'upi': upi, 'kycStatus': kyc, 'history': history};

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: '/start', routes: [GoRoute(path: '/start', builder: (_, __) => home)]);
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pumpAndSettle();
}

void main() {
  group('PayoutsRepo', () {
    test('parses the summary: paise, upi, kyc status and history', () {
      final s = PayoutSummary.fromJson(_summary(kyc: 'pending', history: [
        {'id': 'a', 'at': 1760000000000, 'amountPaise': 60000, 'status': 'paid', 'utr': '412345678901'},
        {'id': 'b', 'at': 1760000000000, 'amountPaise': 50000, 'status': 'checking'},
        {'id': 'c', 'at': 1760000000000, 'amountPaise': 50000, 'status': 'rejected'},
      ]));
      expect(s.readyRupees, 1500);
      expect(s.onHoldPaise, 30000);
      expect(s.upi!.vpa, 'asha@okhdfc');
      expect(s.upi!.nameMatched, isNull);
      expect(s.kycStatus, KycStatus.pending);
      expect(s.history.map((h) => h.status), [PayoutStatus.paid, PayoutStatus.checking, PayoutStatus.rejected]);
      expect(s.history.first.utr, '412345678901');
    });

    test('request sends paise with an Idempotency-Key', () async {
      final api = FakeApiClient((m, p, b) => {'ok': true});
      await PayoutsRepo(api).request(60000, key: 'k-1');
      expect(api.calls, ['POST /api/hf/payouts']);
      expect(api.bodies.single, {'amountPaise': 60000});
      expect(api.sentHeaders.single, {'Idempotency-Key': 'k-1'});
    });

    test('kycStep reads nextStep from a kyc_required error and ignores other errors', () {
      final e = ApiException.fromResponse(
          409, '{"error":"kyc_required","message":"We check your ID once, before your first payout.","nextStep":{"type":"kyc","url":"https://x.test/hosts/kyc"}}');
      final step = PayoutsRepo.kycStep(e)!;
      expect(step.url, 'https://x.test/hosts/kyc');
      expect(step.title, startsWith('We check your ID once'));
      expect(PayoutsRepo.kycStep(ApiException.fromResponse(409, '{"error":"upi_required"}')), isNull);
    });

    test('UPI format check', () {
      expect(PayoutsRepo.validUpi('Asha@OkHDFC'), isTrue);
      expect(PayoutsRepo.validUpi('nope'), isFalse);
    });
  });

  group('PayoutScreen', () {
    testWidgets('shows ready and hold from the server, the UPI, and past payouts', (tester) async {
      final api = FakeApiClient((m, p, b) => _summary(history: [
            {'id': 'a', 'at': DateTime(2026, 10, 12).millisecondsSinceEpoch, 'amountPaise': 60000, 'status': 'paid', 'utr': '4521'},
          ]));
      await _pump(tester, PayoutScreen(repo: PayoutsRepo(api)));
      expect(find.text('₹1,500'), findsOneWidget);
      expect(find.text('₹300'), findsOneWidget);
      expect(find.text('asha@okhdfc'), findsOneWidget);
      expect(find.text('PAID · UTR 4521'), findsOneWidget);
      expect(find.text('We check your ID once, before your first payout.'), findsOneWidget);
    });

    testWidgets('REQUEST PAYOUT sends the amount in paise; below the minimum calls nothing', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'GET' ? _summary() : {'ok': true, 'id': 'x'});
      await _pump(tester, PayoutScreen(repo: PayoutsRepo(api)));
      await tester.enterText(find.byType(TextField), '400');
      await tester.tap(find.text('REQUEST PAYOUT'));
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c.startsWith('POST')), isEmpty);
      expect(find.textContaining('Minimum payout is ₹500'), findsOneWidget);

      await tester.tap(find.text('ALL'));
      await tester.tap(find.text('REQUEST PAYOUT'));
      await tester.pumpAndSettle();
      final i = api.calls.indexOf('POST /api/hf/payouts');
      expect(i, greaterThan(-1));
      expect(api.bodies[i], {'amountPaise': 150000});
      expect(api.sentHeaders[i]!['Idempotency-Key'], isNotEmpty);
    });

    testWidgets('kyc_required opens the ID-check screen with the once-only wording', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'GET'
          ? _summary()
          : ApiException.fromResponse(409,
              '{"error":"kyc_required","message":"We check your ID once, before your first payout.","nextStep":{"type":"kyc","url":"https://x.test/hosts/kyc"}}'));
      await _pump(tester, PayoutScreen(repo: PayoutsRepo(api)));
      await tester.tap(find.text('ALL'));
      await tester.tap(find.text('REQUEST PAYOUT'));
      await tester.pumpAndSettle();
      expect(find.text('CHECK MY ID'), findsOneWidget);
      expect(find.text('We check your ID once, before your first payout.'), findsWidgets);
    });

    testWidgets('no UPI: the card says Add and the main button asks for the UPI', (tester) async {
      final api = FakeApiClient((m, p, b) => _summary(upi: null));
      await _pump(tester, PayoutScreen(repo: PayoutsRepo(api)));
      expect(find.text('No UPI added yet'), findsOneWidget);
      expect(find.text('Add'), findsOneWidget);
      expect(find.text('ADD UPI TO START'), findsOneWidget);
    });

    testWidgets('a fan sees the server message and Try again', (tester) async {
      final api = FakeApiClient((m, p, b) => ApiException.fromResponse(403,
          '{"error":"influencers_only","message":"Only influencers can withdraw. Your money comes back to your original payment if a refund is due."}'));
      await _pump(tester, PayoutScreen(repo: PayoutsRepo(api)));
      expect(find.textContaining('Only influencers can withdraw'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });
}
