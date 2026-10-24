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
const _emailSent = {'ok': true, 'expires_in_s': 600, 'resend_after_s': 60};
const _emailOk = {'ok': true, 'proof': 'proof123'};
Map<String, Object?> _verified({bool needs18 = false, bool isNew = true}) =>
    {'ok': true, 'status': 'signed_in', 'ticket': 'tkt', 'isNew': isNew, 'needs18Plus': needs18};

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

Future<void> _open(WidgetTester tester, AuthRepo repo, void Function() then, {bool login = false}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_host(repo, then));
  await tester.tap(find.text('OPEN'));
  await tester.pumpAndSettle();
  if (login) await _switchMode(tester);
}

Future<void> _switchMode(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('su-switch-mode')));
  await tester.pumpAndSettle();
}

Future<void> _fillWa(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('su-wa')), '98765 43210');
}

Future<void> _fillSignup(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('su-name')), 'Tara Sharma');
  await tester.enterText(find.byKey(const Key('su-email')), 'Tara@Example.com');
  await _fillWa(tester);
}

Future<void> _tap(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

/// Create account: details -> email code -> (WhatsApp code is sent on its own) -> on the WhatsApp code screen.
Future<void> _toWhatsappCode(WidgetTester tester) async {
  await _fillSignup(tester);
  await _tap(tester, 'SEND EMAIL CODE');
  await tester.enterText(find.byKey(const Key('su-email-code')), '654321');
  await _tap(tester, 'VERIFY EMAIL');
}

/// Log in: number -> on the WhatsApp code screen.
Future<void> _loginToCode(WidgetTester tester) async {
  await _fillWa(tester);
  await _tap(tester, 'SEND CODE');
}

Future<void> _details(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('su-name')), 'Tara Sharma');
  await tester.enterText(find.byKey(const Key('su-email')), 'tara@example.com');
  await _tap(tester, 'SAVE DETAILS');
}

void main() {
  setUp(() { SharedPreferences.setMockInitialValues({}); demo.signOut(); });

  testWidgets('create account asks name, email and WhatsApp; log in asks only WhatsApp; the number is kept when switching', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    expect(find.byKey(const Key('su-name')), findsOneWidget);
    expect(find.byKey(const Key('su-email')), findsOneWidget);
    expect(find.byKey(const Key('su-wa')), findsOneWidget);
    expect(find.text('SEND EMAIL CODE'), findsOneWidget);
    // No Google and no email log-in anywhere on the sheet.
    expect(find.textContaining('Google'), findsNothing);
    await _fillWa(tester);
    await _switchMode(tester);
    expect(find.byKey(const Key('su-name')), findsNothing);
    expect(find.byKey(const Key('su-email')), findsNothing);
    expect(find.text('SEND CODE'), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('su-wa'))).controller!.text, '98765 43210');
    expect(api.calls, isEmpty);
    await _tap(tester, 'SEND CODE');
    expect(find.byKey(const Key('su-code')), findsOneWidget);
    expect(find.byKey(const Key('su-switch-mode')), findsNothing);
    expect(api.calls, ['POST /api/auth/whatsapp/send']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

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

  testWidgets('create account: email code, then WhatsApp code, then the account is made and the action resumes', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _emailSent,
      'POST /api/auth/signup/email/verify': _emailOk,
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(),
    });
    final clerk = FakeClerk();
    var refreshed = 0;
    ClerkUser? signedIn;
    final repo = AuthRepo(api: api, clerk: clerk, onSignedIn: (u) => signedIn = u, refreshMe: () async => refreshed++);
    var resumed = 0;
    await _open(tester, repo, () => resumed++);

    await _fillSignup(tester);
    await _tap(tester, 'SEND EMAIL CODE');
    expect(api.calls, ['POST /api/auth/signup/email/send']);
    expect(api.bodies.first, {'email': 'tara@example.com'});
    expect(find.byKey(const Key('su-email-code')), findsOneWidget);
    expect(find.textContaining('Send a new code in'), findsOneWidget); // 60 s wait

    await tester.enterText(find.byKey(const Key('su-email-code')), '654321');
    await _tap(tester, 'VERIFY EMAIL');
    expect(api.bodies[1], {'email': 'tara@example.com', 'code': '654321'});
    // The WhatsApp code goes out on its own once the email is proven.
    expect(api.calls[2], 'POST /api/auth/whatsapp/send');
    expect(api.bodies[2], {'phone': '+919876543210', 'client': 'android'});
    expect(find.byKey(const Key('su-code')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(api.bodies[3], {
      'phone': '+919876543210',
      'code': '123456',
      'client': 'android',
      'signup': {'name': 'Tara Sharma', 'email_proof': 'proof123'},
    });
    expect(clerk.ticket, 'tkt');
    expect(signedIn?.id, 'user_1');
    // Name and email were stored by the server when it made the account: no details screen, no PATCH.
    expect(api.calls.where((c) => c.startsWith('PATCH')), isEmpty);
    expect(find.byKey(const Key('su-name')), findsNothing);
    expect(refreshed, 1);
    expect(resumed, 1);
  });

  testWidgets('create account: details are checked before any call', (tester) async {
    final api = FakeApiClient({});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _tap(tester, 'SEND EMAIL CODE');
    expect(find.textContaining('your name'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('su-name')), 'Tara Sharma');
    await _tap(tester, 'SEND EMAIL CODE');
    expect(find.text('Please type a real email.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('su-email')), 'tara@example.com');
    await _tap(tester, 'SEND EMAIL CODE');
    expect(find.text('WhatsApp number should be 10 digits.'), findsOneWidget);
    expect(api.calls, isEmpty);
  });

  testWidgets('email already has an account: plain message, stays on the details, nothing else is called', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _err(409, 'email_taken', 'This email already has an account. Sign in with your WhatsApp number instead.'),
    });
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _fillSignup(tester);
    await _tap(tester, 'SEND EMAIL CODE');
    expect(find.textContaining('already has an account'), findsOneWidget);
    expect(find.byKey(const Key('su-email-code')), findsNothing);
    expect(api.calls, ['POST /api/auth/signup/email/send']);
  });

  testWidgets('email code: wrong, expired and too many tries show plain messages and keep the sheet open', (tester) async {
    var verifies = 0;
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _emailSent,
      'POST /api/auth/signup/email/verify': () {
        verifies++;
        if (verifies == 1) throw _err(400, 'wrong_code', 'That code isn’t right. 4 tries left.', {'attempts_left': 4});
        if (verifies == 2) throw _err(410, 'code_expired', 'That code has expired. Ask for a new one.');
        throw _err(429, 'too_many_attempts', 'Too many wrong tries. Ask for a new code.');
      },
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _fillSignup(tester);
    await _tap(tester, 'SEND EMAIL CODE');
    await tester.enterText(find.byKey(const Key('su-email-code')), '000000');
    await _tap(tester, 'VERIFY EMAIL');
    expect(find.text('That code isn’t right. 4 tries left.'), findsOneWidget);
    await _tap(tester, 'VERIFY EMAIL');
    expect(find.textContaining('has expired'), findsOneWidget);
    expect(find.text('Send a new code'), findsOneWidget); // resend opens straight away after an expired code
    await _tap(tester, 'VERIFY EMAIL');
    expect(find.textContaining('Too many wrong tries'), findsOneWidget);
    expect(find.byKey(const Key('su-code')), findsNothing);
    expect(resumed, 0);
  });

  testWidgets('email code: a too-short code is caught before any call; resend asks the server again', (tester) async {
    final api = FakeApiClient({'POST /api/auth/signup/email/send': _emailSent});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _fillSignup(tester);
    await _tap(tester, 'SEND EMAIL CODE');
    await tester.enterText(find.byKey(const Key('su-email-code')), '123');
    await _tap(tester, 'VERIFY EMAIL');
    expect(find.text('Type the 6-digit code from your email.'), findsOneWidget);
    expect(api.calls, ['POST /api/auth/signup/email/send']);
    // Resend is closed for the first 60 seconds.
    expect(tester.widget<TextButton>(find.byKey(const Key('su-email-resend'))).onPressed, isNull);
    await tester.pump(const Duration(seconds: 61));
    expect(tester.widget<TextButton>(find.byKey(const Key('su-email-resend'))).onPressed, isNotNull);
    await tester.tap(find.byKey(const Key('su-email-resend')));
    await tester.pumpAndSettle();
    expect(api.calls, ['POST /api/auth/signup/email/send', 'POST /api/auth/signup/email/send']);
  });

  testWidgets('offline: the email step and the log-in step say so and do not move on', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': ApiException.offline(),
      'POST /api/auth/whatsapp/send': ApiException.offline(),
    });
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _fillSignup(tester);
    await _tap(tester, 'SEND EMAIL CODE');
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    expect(find.byKey(const Key('su-email-code')), findsNothing);
    await _switchMode(tester);
    await _tap(tester, 'SEND CODE');
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    expect(find.byKey(const Key('su-code')), findsNothing);
  });

  testWidgets('WhatsApp code send fails after the email is proven: the person stays and SEND CODE tries again without a new email code', (tester) async {
    var sends = 0;
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _emailSent,
      'POST /api/auth/signup/email/verify': _emailOk,
      'POST /api/auth/whatsapp/send': () {
        sends++;
        if (sends == 1) throw _err(400, 'not_on_whatsapp', 'This number isn’t on WhatsApp.');
        return _sent;
      },
    });
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    await _toWhatsappCode(tester);
    expect(find.textContaining('isn’t on WhatsApp'), findsOneWidget);
    expect(find.byKey(const Key('su-code')), findsNothing);
    await _tap(tester, 'SEND CODE');
    expect(find.byKey(const Key('su-code')), findsOneWidget);
    expect(api.calls.where((c) => c == 'POST /api/auth/signup/email/send'), hasLength(1));
    expect(api.calls.where((c) => c == 'POST /api/auth/signup/email/verify'), hasLength(1));
  });

  testWidgets('log in: wrong and expired WhatsApp codes show plain messages and keep the sheet open', (tester) async {
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
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '000000');
    await _tap(tester, 'VERIFY');
    expect(find.text('That code isn’t right. 4 tries left.'), findsOneWidget);
    await _tap(tester, 'VERIFY');
    expect(find.textContaining('has expired'), findsOneWidget);
    expect(find.text('Send a new code'), findsOneWidget);
    expect(resumed, 0);
  });

  testWidgets('log in: a too-short WhatsApp code is caught before any call', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {}, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123');
    await _tap(tester, 'VERIFY');
    expect(find.text('Type the 6-digit code from WhatsApp.'), findsOneWidget);
    expect(api.calls, ['POST /api/auth/whatsapp/send']);
  });

  testWidgets('log in: the number is checked before sending', (tester) async {
    final api = FakeApiClient({});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {}, login: true);
    await _tap(tester, 'SEND CODE');
    expect(find.text('WhatsApp number should be 10 digits.'), findsOneWidget);
    expect(api.calls, isEmpty);
  });

  testWidgets('returning user (made before email was asked) logs in with WhatsApp only: no sign-up payload, no details screen', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(isNew: false),
      'GET /api/hf/me': {'uid': 'user_1', 'displayName': 'Tara Sharma', 'email': null},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(api.calls, ['POST /api/auth/whatsapp/send', 'POST /api/auth/whatsapp/verify', 'GET /api/hf/me']);
    expect(api.bodies[1], {'phone': '+919876543210', 'code': '123456', 'client': 'android'});
    expect(resumed, 1);
  });

  testWidgets('log in with a number that has no account: message + Create an account, nothing is signed in', (tester) async {
    final clerk = FakeClerk();
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': {'ok': true, 'status': 'no_account', 'phone_masked': '******3210'},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: clerk), () => resumed++, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(find.byKey(const Key('su-no-account')), findsOneWidget);
    expect(find.text('CREATE AN ACCOUNT'), findsOneWidget);
    expect(clerk.ticket, isNull);
    expect(resumed, 0);
    await _tap(tester, 'CREATE AN ACCOUNT');
    expect(find.byKey(const Key('su-name')), findsOneWidget);
    expect(find.byKey(const Key('su-email')), findsOneWidget);
    expect(find.text('SEND EMAIL CODE'), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('su-wa'))).controller!.text, '98765 43210');
  });

  testWidgets('older account with no name yet: log-in then asks for the details, saves them, then the 18+ tick', (tester) async {
    var profileReads = 0;
    final api = FakeApiClient({
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(needs18: true, isNew: false),
      'GET /api/hf/me': () {
        if (profileReads++ == 0) throw ApiException.offline();
        return {'uid': 'user_1', 'displayName': null, 'email': null};
      },
      'PATCH /api/hf/me': {'ok': true},
      'GET /api/config': {'hfAckVersion': '2026-10-10'},
      'POST /api/hf/me/ack': {'ok': true},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(find.text('No internet. Check your connection.'), findsOneWidget);
    await _tap(tester, 'TRY AGAIN');
    expect(api.calls.where((c) => c == 'POST /api/auth/whatsapp/verify'), hasLength(1));
    expect(find.byKey(const Key('su-name')), findsOneWidget);
    await _details(tester);
    expect(find.byKey(const Key('su-18')), findsOneWidget);
    await tester.tap(find.byKey(const Key('su-18')));
    await tester.pump();
    await _tap(tester, 'FINISH');
    expect(resumed, 1);
    expect(api.calls.where((c) => c == 'PATCH /api/hf/me'), hasLength(1));
  });

  testWidgets('new account: the 18+ tick is asked, the ack is posted, then the action resumes', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _emailSent,
      'POST /api/auth/signup/email/verify': _emailOk,
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _verified(needs18: true),
      'GET /api/config': {'hfAckVersion': '2026-10-10'},
      'POST /api/hf/me/ack': {'ok': true},
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _toWhatsappCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(find.byKey(const Key('su-18')), findsOneWidget);
    expect(resumed, 0);
    await _tap(tester, 'FINISH');
    expect(find.text('Please tick the box to continue.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('su-18')));
    await tester.pump();
    await _tap(tester, 'FINISH');
    expect(api.calls.last, 'POST /api/hf/me/ack');
    expect(api.bodies.last, {'version': '2026-10-10', 'ack18': true, 'client': 'android'});
    expect(resumed, 1);
  });

  testWidgets('email check expired by the time the WhatsApp code is checked: back to the details with a plain message', (tester) async {
    final api = FakeApiClient({
      'POST /api/auth/signup/email/send': _emailSent,
      'POST /api/auth/signup/email/verify': _emailOk,
      'POST /api/auth/whatsapp/send': _sent,
      'POST /api/auth/whatsapp/verify': _err(400, 'email_proof_invalid', 'Your email check has expired. Please verify your email again.'),
    });
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () => resumed++);
    await _toWhatsappCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
    expect(find.textContaining('email check has expired'), findsOneWidget);
    expect(find.text('SEND EMAIL CODE'), findsOneWidget);
    expect(resumed, 0);
  });

  testWidgets('auth sheet scrolls with the keyboard open on a short screen', (tester) async {
    final api = FakeApiClient({'POST /api/auth/signup/email/send': _emailSent});
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk()), () {});
    tester.view.physicalSize = const Size(360, 600);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byKey(const Key('su-wa')));
    await _fillSignup(tester);
    await tester.ensureVisible(find.text('SEND EMAIL CODE'));
    await tester.pumpAndSettle(); // [HF-HEADER-EVERYWHERE-1] let the scroll land before tapping (the tap hit the old position)
    await tester.tap(find.text('SEND EMAIL CODE'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byKey(const Key('su-email-code')));
    expect(find.byKey(const Key('su-email-code')), findsOneWidget);
  });

  testWidgets('Clerk refusing the ticket shows a plain message and does not resume', (tester) async {
    final api = FakeApiClient({'POST /api/auth/whatsapp/send': _sent, 'POST /api/auth/whatsapp/verify': _verified(isNew: false)});
    var resumed = 0;
    await _open(tester, AuthRepo(api: api, clerk: FakeClerk(fail: true)), () => resumed++, login: true);
    await _loginToCode(tester);
    await tester.enterText(find.byKey(const Key('su-code')), '123456');
    await _tap(tester, 'VERIFY');
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
