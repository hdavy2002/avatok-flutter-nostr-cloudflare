import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/auth/clerk_client.dart';
import 'package:hf_app/data/repos/auth_repo.dart';
import 'package:hf_app/demo/state.dart';
import 'package:hf_app/demo/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Answers by "METHOD path" and records every call. A value that is an ApiException is thrown.
class FakeApiClient extends ApiClient {
  FakeApiClient(this.routes) : super(origin: 'https://api.test');

  final Map<String, Object?> routes;
  final List<String> calls = [];
  final List<Object?> bodies = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    final v = routes['$method $path'];
    if (v is ApiException) throw v;
    if (v is Function) return v();
    if (v == null) throw ApiException.fromResponse(404, '{"error":"not_found"}');
    return v;
  }
}

class FakeClerk implements ClerkApi {
  FakeClerk({this.fail = false});
  final bool fail;
  String? ticket;

  @override
  Future<ClerkStep> signInWithTicket(String t) async {
    ticket = t;
    return fail ? ClerkStep.error('We could not finish signing you in. Please try again.') : ClerkStep.complete(const ClerkUser(id: 'user_1'));
  }

  @override
  Future<ClerkUser?> currentUser() async => null;
  @override
  Future<String?> sessionToken({bool forceRefresh = false}) async => null;
  @override
  Future<void> signOut() async {}
}

ApiException _err(int s, String code, String msg, [Map<String, Object?> extra = const {}]) =>
    ApiException.fromResponse(s, '{"error":"$code","message":"$msg"${extra.entries.map((e) => ',"${e.key}":${e.value}').join()}}');

const _sent = {'ok': true, 'phone_masked': '******3210', 'expires_in_s': 600, 'resend_after_s': 30};
Map<String, Object?> _verified({bool needs18 = false}) => {'ok': true, 'status': 'signed_in', 'ticket': 'tkt', 'isNew': true, 'needs18Plus': needs18};

Widget _host(AuthRepo repo, void Function() then) => MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => requireAccount(context, then, reason: 'to call', repo: repo),
              child: const Text('OPEN'),
            ),
          ),
        ),
      ),
    );

Future<void> _fillForm(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('su-wa')), '98765 43210');
}

Future<void> _open(WidgetTester tester, AuthRepo repo, void Function() then) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_host(repo, then));
  await tester.tap(find.text('OPEN'));
  await tester.pumpAndSettle();
}

Future<void> _profile(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('su-name')), 'Tara Sharma');
  await tester.enterText(find.byKey(const Key('su-email')), 'tara@example.com');
  await tester.ensureVisible(find.text('SAVE DETAILS'));
  await tester.tap(find.text('SAVE DETAILS'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() { SharedPreferences.setMockInitialValues({}); demo.signOut(); });
  test('number, email and name checks', () {
    expect(AuthRepo.e164('98765 43210'), '+919876543210');
    expect(AuthRepo.e164('+91 98765-43210'), '+919876543210');
    expect(AuthRepo.e164('12345'), isNull);
    expect(AuthRepo.e164('5876543210'), isNull);
    expect(AuthRepo.validEmail('a@b.in'), isTrue);
    expect(AuthRepo.validEmail('nope'), isFalse);
    expect(AuthRepo.nameProblem('Tara'), isNull);
    expect(AuthRepo.nameProblem('T'), isNotNull);
    expect(AuthRepo.nameProblem('Tara 2'), isNotNull);
  });

  testWidgets('send code, right code, success resumes the action and saves name + email', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(),
      'PATCH /api/hf/me': {'ok': true},
    });
    final clerk = FakeClerk();
    var refreshed = 0;
    ClerkUser? signedIn;
    final repo = AuthRepo(api: api, clerk: clerk, onSignedIn: (u) => signedIn = u, refreshMe: () async => refreshed++);
    var resumed = 0;
    await _open(tester, repo, () => resumed++);

    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    expect(api.bodies.first, {'phone': '+919876543210', 'client': 'android'});
    expect(find.byKey(const Key('su-code')), findsOneWidget);
    expect(find.textContaining('Send a new code in'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();

    await _profile(tester);
    expect(clerk.ticket, 'tkt');
    expect(signedIn?.id, 'user_1');
    expect(api.calls, ['POST /api/auth/whatsapp/send', 'POST /api/auth/whatsapp/verify', 'PATCH /api/hf/me']);
    expect(api.bodies.last, {'displayName': 'Tara Sharma', 'email': 'tara@example.com'});
    expect(refreshed, 1);
    expect(resumed, 1);
    expect(find.byKey(const Key('su-code')), findsNothing);
  });

  testWidgets('wrong code and expired code show plain messages and keep the sheet open', (tester) async {
    var verifies = 0;
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': () {
        verifies++;
        throw verifies == 1
            ? _err(400, 'wrong_code', 'That code isn’t right. 4 tries left.', {'attempts_left': 4})
            : _err(410, 'code_expired', 'That code has expired. Ask for a new one.');
      },
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('su-code')), '000000');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.text('That code isn’t right. 4 tries left.'), findsOneWidget);

    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.textContaining('has expired'), findsOneWidget);
    expect(find.text('Send a new code'), findsOneWidget); // resend is open straight away after an expired code
    expect(resumed, 0);
  });

  testWidgets('too-short code is caught before any call', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.text('Type the 6-digit code from WhatsApp.'), findsOneWidget);
    expect(api.calls, ['POST /api/auth/whatsapp/send']);
  });

  testWidgets('offline on send says so and does not move on', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': ApiException.offline()});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    expect(find.byKey(const Key('su-code')), findsNothing);
  });

  testWidgets('phone is checked before sending; profile is only requested after verification', (tester) async {
    final api = FakeApiClient({});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    expect(find.byKey(const Key('su-name')), findsNothing);
    expect(find.byKey(const Key('su-email')), findsNothing);
    await tester.tap(find.text('SEND CODE'));
    await tester.pump();
    expect(find.text('WhatsApp number should be 10 digits.'), findsOneWidget);
    expect(api.calls, isEmpty);
  });

  testWidgets('returning WhatsApp user logs in without profile fields or writes', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': {..._verified(), 'isNew': false},
      'GET /api/hf/me': {'uid': 'user_1', 'displayName': 'Tara Sharma', 'email': 'tara@example.com'},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(api.calls, ['POST /api/auth/whatsapp/send', 'POST /api/auth/whatsapp/verify', 'GET /api/hf/me']);
    expect(resumed, 1);
  });

  testWidgets('interrupted new account resumes profile and age after a later login', (tester) async {
    var profileReads = 0;
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(needs18: true),
      'GET /api/hf/me': () {
        if (profileReads++ == 0) throw ApiException.offline();
        return {'uid': 'user_1', 'displayName': null, 'email': null};
      },
      'PATCH /api/hf/me': {'ok': true},
      'GET /api/config': {'hfAckVersion': '2026-10-10'},
      'POST /api/hf/me/ack': {'ok': true},
    });
    var resumed = 0;
    final repo = AuthRepo(api: api, clerk: FakeClerk());
    await _open(tester, repo, () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('su-name')), findsOneWidget);
    Navigator.of(tester.element(find.byKey(const Key('su-name')))).pop();
    await tester.pumpAndSettle();
    api.routes['POST /api/auth/whatsapp/verify'] = {..._verified(needs18: true), 'isNew': false};
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    await tester.tap(find.text('TRY AGAIN'));
    await tester.pumpAndSettle();
    expect(api.calls.where((c) => c == 'POST /api/auth/whatsapp/verify'), hasLength(2));
    expect(find.byKey(const Key('su-name')), findsOneWidget);
    await _profile(tester);
    expect(find.byKey(const Key('su-18')), findsOneWidget);
    await tester.tap(find.byKey(const Key('su-18')));
    await tester.tap(find.text('FINISH'));
    await tester.pumpAndSettle();
    expect(resumed, 1);
    expect(api.calls.where((c) => c == 'PATCH /api/hf/me'), hasLength(1));
  });

  testWidgets('auth sheet scrolls with keyboard on a short screen', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent, 'POST /api/auth/whatsapp/verify': _verified()});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    tester.view.physicalSize = const Size(360, 600);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byKey(const Key('su-wa')));
    await _fillForm(tester);
    await tester.ensureVisible(find.text('SEND CODE'));
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byKey(const Key('su-code')));
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.ensureVisible(find.text('VERIFY'));
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('SAVE DETAILS'));
    expect(tester.getBottomRight(find.text('SAVE DETAILS')).dy, lessThanOrEqualTo(320));
  });

  testWidgets('new account: 18+ tick is asked, ack is posted, then the action resumes', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(needs18: true),
      'PATCH /api/hf/me': {'ok': true},
      'GET /api/config': {'hfAckVersion': '2026-10-10'},
      'POST /api/hf/me/ack': {'ok': true},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    await _profile(tester);
    expect(find.byKey(const Key('su-18')), findsOneWidget);
    expect(resumed, 0);

    await tester.tap(find.text('FINISH'));
    await tester.pumpAndSettle();
    expect(find.text('Please tick the box to continue.'), findsOneWidget);

    await tester.tap(find.byKey(const Key('su-18')));
    await tester.pump();
    await tester.tap(find.text('FINISH'));
    await tester.pumpAndSettle();
    expect(api.calls.last, 'POST /api/hf/me/ack');
    expect(api.bodies.last, {'version': '2026-10-10', 'ack18': true, 'client': 'android'});
    expect(resumed, 1);
  });

  testWidgets('email switch still off on the server: name is saved alone and sign-up still completes', (tester) async {
    var patches = 0;
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(),
      'PATCH /api/hf/me': () {
        patches++;
        if (patches == 1) throw _err(403, 'feature_off', 'This isn’t available yet.');
        return {'ok': true};
      },
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    await _profile(tester);
    expect(api.bodies.last, {'displayName': 'Tara Sharma'});
    expect(resumed, 1);
  });

  testWidgets('a failed details save keeps the sheet open and TRY AGAIN does not verify twice', (tester) async {
    var patches = 0;
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(),
      'PATCH /api/hf/me': () {
        patches++;
        if (patches == 1) throw ApiException.offline();
        return {'ok': true};
      },
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    await _profile(tester);
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    expect(resumed, 0);

    await tester.tap(find.text('TRY AGAIN'));
    await tester.pumpAndSettle();
    expect(api.calls.where((c) => c == 'POST /api/auth/whatsapp/verify').length, 1);
    expect(resumed, 1);
  });

  testWidgets('Clerk refusing the ticket shows a plain message and does not resume', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent, 'POST /api/auth/whatsapp/verify': _verified()});
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk(fail: true)), () => resumed++);
    await _fillForm(tester);
    await tester.tap(find.text('SEND CODE'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await tester.tap(find.text('VERIFY'));
    await tester.pumpAndSettle();
    expect(find.textContaining('could not finish signing you in'), findsOneWidget);
    expect(resumed, 0);
  });

  test('applyAccount feeds the Me header and Settings; signOut clears it', () {
    demo.applyAccount(name: 'Tara Sharma', email: 'tara@example.com', whatsapp: '******3210');
    expect(demo.signedIn, isTrue);
    expect(demo.name, 'Tara Sharma');
    expect(demo.whatsappDisplay, '******3210');
    demo.signOut();
    expect(demo.signedIn, isFalse);
    expect(demo.name, '');
    expect(demo.email, '');
  });
}
