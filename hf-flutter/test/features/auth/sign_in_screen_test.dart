import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/features/auth/data/auth_messages.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/welcome/data/ack_service.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';
import 'auth_harness.dart';

const _phoneKey = ValueKey<String>('signin-phone');
const _codeKey = ValueKey<String>('signin-code');
const _sendPath = '/api/auth/whatsapp/send';
const _verifyPath = '/api/auth/whatsapp/verify';

const _sendOk = {'ok': true, 'phone_masked': '+91 ******3210', 'expires_in_s': 600, 'resend_after_s': 30};
const _verifyOk = {'ok': true, 'status': 'signed_in', 'ticket': 'tkt-1', 'isNew': false, 'needs18Plus': false};

FakeApiClient okApi({Map<String, Object?> me = const {'uid': 'user_test', 'ackVersion': '2026-10-10', 'displayName': 'Asha'}}) => FakeApiClient()
  ..onJson('POST', _sendPath, _sendOk)
  ..onJson('POST', _verifyPath, _verifyOk)
  ..onJson('GET', '/api/hf/me', me)
  ..onJson('POST', '/api/hf/me/ack', {'ok': true});

GoRouter signInRouter() => GoRouter(
      initialLocation: '/sign-in',
      routes: [
        GoRoute(path: '/sign-in', builder: (_, __) => const SignInScreen(next: '/me')),
        GoRoute(path: '/me', builder: (_, __) => const Scaffold(body: Text('AFTER PAGE'))),
        GoRoute(path: '/welcome', builder: (_, __) => const WelcomeScreen()),
        GoRoute(path: '/', builder: (_, __) => const Scaffold(body: Text('HOME PAGE'))),
      ],
    );

Future<void> enterNumber(WidgetTester tester, [String number = '9876543210']) async {
  await tester.enterText(find.byKey(_phoneKey), number);
  await tester.pump();
}

Future<void> tapSend(WidgetTester tester) async {
  await tester.ensureVisible(find.text(SignInCopy.sendCode));
  await tester.tap(find.text(SignInCopy.sendCode));
  await settle(tester);
}

Future<void> toCodeStep(WidgetTester tester) async {
  await enterNumber(tester);
  await tapSend(tester);
}

Future<void> enterCode(WidgetTester tester, [String code = '123456']) async {
  await tester.enterText(find.byKey(_codeKey), code);
  await settle(tester);
}

bool isEnabled(WidgetTester tester, String label) {
  final button = tester.widget<ElevatedButton>(
    find.ancestor(of: find.text(label), matching: find.bySubtype<ElevatedButton>()),
  );
  return button.onPressed != null;
}

String codeText(WidgetTester tester) => tester.widget<TextField>(find.byKey(_codeKey)).controller!.text;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{AckService.storageKey: '2026-10-10'}));
  tearDown(() => AccountScope.id = null);

  group('number step', () {
    testWidgets('shows +91, the hint and a Send button that waits for 10 digits', (tester) async {
      await pumpRouter(tester, signInRouter(), api: okApi());
      expect(find.text(SignInCopy.prefix), findsOneWidget);
      expect(find.text(SignInCopy.numberHint), findsOneWidget);
      expect(isEnabled(tester, SignInCopy.sendCode), isFalse);
      await enterNumber(tester, '98765');
      expect(isEnabled(tester, SignInCopy.sendCode), isFalse);
      await enterNumber(tester, '9876543210');
      expect(isEnabled(tester, SignInCopy.sendCode), isTrue);
      expectNoTinyText(tester);
    });

    testWidgets('a pasted +91 number keeps just the 10 digits', (tester) async {
      await pumpRouter(tester, signInRouter(), api: okApi());
      await enterNumber(tester, '+91 98765 43210');
      expect(tester.widget<TextField>(find.byKey(_phoneKey)).controller!.text, '9876543210');
    });

    testWidgets('a number that cannot be a mobile number is refused on the phone, nothing is sent', (tester) async {
      final api = okApi();
      await pumpRouter(tester, signInRouter(), api: api);
      await enterNumber(tester, '5123456789');
      await tapSend(tester);
      expect(find.text(AuthCopy.invalidPhone), findsOneWidget);
      expect(api.callsTo('POST', _sendPath), isEmpty);
    });

    testWidgets('send code goes to the code step with the masked number and a 30 s timer', (tester) async {
      final api = okApi();
      await pumpRouter(tester, signInRouter(), api: api);
      await toCodeStep(tester);
      expect(find.text(SignInCopy.sentTo('+91 ******3210')), findsOneWidget);
      expect(find.text(SignInCopy.resendIn(30)), findsOneWidget);
      final call = api.callsTo('POST', _sendPath).single;
      expect(call.body, {'phone': '+919876543210', 'client': 'android'});
      expect(call.auth, isFalse);
      expectNoTinyText(tester);
    });

    final sendErrors = <String, (ApiError, String)>{
      'invalid_phone': (const ApiError(status: 400, code: 'invalid_phone', field: 'phone'), AuthCopy.invalidPhone),
      'not_on_whatsapp': (const ApiError(status: 400, code: 'not_on_whatsapp'), AuthCopy.notOnWhatsapp),
      'rate_limited (hourly, server words)': (
        const ApiError(
            status: 429,
            code: 'rate_limited',
            message: 'Too many codes requested for this number. Please try again in an hour.'),
        'Too many codes requested for this number. Please try again in an hour.'
      ),
      'rate_limited (hourly, no words)': (const ApiError(status: 429, code: 'rate_limited'), AuthCopy.rateHourly),
      'otp_unavailable': (const ApiError(status: 503, code: 'otp_unavailable'), AuthCopy.unavailable),
      'provider_error': (const ApiError(status: 502, code: 'provider_error'), AuthCopy.sendFailed),
      'network': (ApiError.network(), 'No internet. Check your connection.'),
      'timeout': (ApiError.timeout(), 'That took too long. Please try again.'),
    };
    sendErrors.forEach((name, c) {
      testWidgets('send error $name shows a friendly line and stays on the number step', (tester) async {
        final api = okApi()..onError('POST', _sendPath, c.$1);
        await pumpRouter(tester, signInRouter(), api: api);
        await toCodeStep(tester);
        expect(find.text(c.$2), findsOneWidget);
        expect(find.text(SignInCopy.sendCode), findsOneWidget);
        expect(find.byKey(_codeKey), findsNothing);
      });
    });

    testWidgets('the 30 s gap answer moves to the code step and counts down the wait', (tester) async {
      final api = okApi()
        ..onError('POST', _sendPath,
            const ApiError(status: 429, code: 'rate_limited', extra: {'retry_after_s': 22}));
      await pumpRouter(tester, signInRouter(), api: api);
      await toCodeStep(tester);
      expect(find.byKey(_codeKey), findsOneWidget);
      expect(find.text(AuthCopy.waitSeconds(22)), findsOneWidget);
      expect(find.text(SignInCopy.resendIn(22)), findsOneWidget);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text(SignInCopy.resendIn(21)), findsOneWidget);
    });

    testWidgets('Create account asks for fresh consent before requesting a code', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final api = okApi();
      await pumpRouter(tester, signInRouter(), api: api);
      await tester.tap(find.text('Create account'));
      await tester.pump();
      expect(find.text(SignInCopy.ageTick), findsOneWidget);
      await enterNumber(tester);
      expect(isEnabled(tester, SignInCopy.sendCode), isFalse);
      await tester.ensureVisible(find.byKey(const ValueKey<String>('signin-age-tick')));
      await tester.tap(find.byKey(const ValueKey<String>('signin-age-tick')));
      await tester.pump();
      expect(isEnabled(tester, SignInCopy.sendCode), isTrue);
    });

    testWidgets('existing login is short and does not inherit device consent', (tester) async {
      await pumpRouter(tester, signInRouter(), api: okApi());
      expect(find.text(SignInCopy.ageTick), findsNothing);
    });
  });

  group('code step', () {
    testWidgets('a good code redeems the ticket, tells the server and goes to next', (tester) async {
      final api = okApi();
      final clerk = FakeClerk();
      final router = signInRouter();
      await pumpRouter(tester, router, api: api, clerk: clerk);
      await toCodeStep(tester);
      await enterCode(tester);
      final verify = api.callsTo('POST', _verifyPath).single;
      expect(verify.body, {
        'phone': '+919876543210',
        'code': '123456',
        'client': 'android',
      });
      expect(verify.auth, isFalse);
      expect(clerk.tickets, ['tkt-1']);
      expect(locationOf(router), '/me');
      expect(find.text('AFTER PAGE'), findsOneWidget);
      expect(AccountScope.id, 'user_test');
      // The account had no acceptance: the device acceptance is sent.
      expect(api.callsTo('POST', '/api/hf/me/ack'), isEmpty);
    });

    testWidgets('an account that already accepted is not asked again', (tester) async {
      final api = okApi(me: const {'uid': 'user_test', 'ackVersion': '2026-10-10'});
      await pumpRouter(tester, signInRouter(), api: api);
      await toCodeStep(tester);
      await enterCode(tester);
      expect(api.callsTo('POST', '/api/hf/me/ack'), isEmpty);
    });

    testWidgets('a failing acceptance call never undoes a good sign-in', (tester) async {
      final api = okApi()..onError('POST', '/api/hf/me/ack', const ApiError(status: 503, code: 'ack_failed'));
      final router = signInRouter();
      await pumpRouter(tester, router, api: api);
      await toCodeStep(tester);
      await enterCode(tester);
      expect(locationOf(router), '/me');
    });

    testWidgets('the tick made on this screen is kept and sent', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final api = okApi();
      final router = signInRouter();
      await pumpRouter(tester, router, api: api);
      await tester.tap(find.text('Create account'));
      await tester.pump();
      await enterNumber(tester);
      await tester.ensureVisible(find.byKey(const ValueKey<String>('signin-age-tick')));
      await tester.tap(find.byKey(const ValueKey<String>('signin-age-tick')));
      await tester.pump();
      await tapSend(tester);
      await enterCode(tester);
      expect(api.callsTo('POST', _verifyPath).single.body, containsPair('age_confirmed', true));
      expect(locationOf(router), '/me');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('${AckService.storageKey}_user_test'), kFallbackAckVersion);
      expect(api.callsTo('POST', '/api/hf/me/ack').single.body, containsPair('version', kFallbackAckVersion));
    });

    final verifyErrors = <String, (ApiError, String)>{
      'wrong_code with 2 tries left': (
        const ApiError(status: 400, code: 'wrong_code', field: 'code', extra: {'attempts_left': 2}),
        'That code is not right. 2 tries left.'
      ),
      'wrong_code with 1 try left': (
        const ApiError(status: 400, code: 'wrong_code', field: 'code', extra: {'attempts_left': 1}),
        'That code is not right. 1 try left.'
      ),
      'wrong_code with none left': (
        const ApiError(status: 400, code: 'wrong_code', field: 'code', extra: {'attempts_left': 0}),
        'That code is not right. Please ask for a new code.'
      ),
      'wrong_code without a count': (
        const ApiError(status: 400, code: 'wrong_code'),
        AuthCopy.wrongCode
      ),
      'invalid_code': (const ApiError(status: 400, code: 'invalid_code', field: 'code'), AuthCopy.enterCode),
      'no_code': (const ApiError(status: 400, code: 'no_code', field: 'code'), AuthCopy.sendFirst),
      'code_expired': (const ApiError(status: 410, code: 'code_expired', field: 'code'), AuthCopy.codeExpired),
      'too_many_attempts': (
        const ApiError(status: 429, code: 'too_many_attempts', field: 'code'),
        AuthCopy.tooManyAttempts
      ),
      'verify_failed': (const ApiError(status: 502, code: 'verify_failed', field: 'code'), AuthCopy.verifyFailed),
      'signin_failed': (const ApiError(status: 502, code: 'signin_failed'), AuthCopy.signInFailed),
      'signup_failed': (const ApiError(status: 502, code: 'signup_failed'), AuthCopy.signUpFailed),
      'signup_in_progress': (
        const ApiError(status: 409, code: 'signup_in_progress', extra: {'retry_after_s': 3}),
        AuthCopy.creating
      ),
      'banned': (const ApiError(status: 403, code: 'banned'), AuthCopy.banned),
      'network': (ApiError.network(), 'No internet. Check your connection.'),
      'timeout': (ApiError.timeout(), 'That took too long. Please try again.'),
    };
    verifyErrors.forEach((name, c) {
      testWidgets('verify error $name shows a friendly line, clears the boxes and signs nobody in', (tester) async {
        final api = okApi()..onError('POST', _verifyPath, c.$1);
        final clerk = FakeClerk();
        final router = signInRouter();
        await pumpRouter(tester, router, api: api, clerk: clerk);
        await toCodeStep(tester);
        await enterCode(tester);
        expect(find.text(c.$2), findsOneWidget);
        expect(codeText(tester), isEmpty);
        expect(clerk.tickets, isEmpty);
        expect(locationOf(router), '/sign-in');
        expectNoTinyText(tester);
      });
    });

    testWidgets('a dead code lets the person ask for a new one at once', (tester) async {
      final api = okApi()..onError('POST', _verifyPath, const ApiError(status: 410, code: 'code_expired'));
      await pumpRouter(tester, signInRouter(), api: api);
      await toCodeStep(tester);
      expect(find.text(SignInCopy.resend), findsNothing);
      await enterCode(tester);
      expect(find.text(SignInCopy.resend), findsOneWidget);
    });

    testWidgets('needs_email (phone sign-up not open) shows a message and never redeems anything', (tester) async {
      final api = okApi()
        ..onJson('POST', _verifyPath, {'ok': true, 'status': 'needs_email', 'proof': 'p', 'phone_masked': 'x'});
      final clerk = FakeClerk();
      await pumpRouter(tester, signInRouter(), api: api, clerk: clerk);
      await toCodeStep(tester);
      await enterCode(tester);
      expect(find.text(AuthCopy.needsEmail), findsOneWidget);
      expect(clerk.tickets, isEmpty);
    });

    testWidgets('a ticket Clerk refuses shows a friendly line, not Clerk words', (tester) async {
      final clerk = FakeClerk()..ticketResult = ClerkStep.error('Sign-in token is invalid or already used.');
      final router = signInRouter();
      await pumpRouter(tester, router, api: okApi(), clerk: clerk);
      await toCodeStep(tester);
      await enterCode(tester);
      expect(find.text(AuthCopy.ticketFailed), findsOneWidget);
      expect(find.textContaining('token'), findsNothing);
      expect(locationOf(router), '/sign-in');
    });

    testWidgets('the resend timer counts down, then Send a new code asks again', (tester) async {
      final api = okApi();
      await pumpRouter(tester, signInRouter(), api: api);
      await toCodeStep(tester);
      expect(find.text(SignInCopy.resend), findsNothing);
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(find.text(SignInCopy.resend), findsOneWidget);
      await tester.tap(find.text(SignInCopy.resend));
      await settle(tester);
      expect(api.callsTo('POST', _sendPath), hasLength(2));
      expect(find.text(SignInCopy.resendIn(30)), findsOneWidget);
    });

    testWidgets('Change number goes back and keeps the digits', (tester) async {
      await pumpRouter(tester, signInRouter(), api: okApi());
      await toCodeStep(tester);
      await tester.tap(find.text(SignInCopy.changeNumber));
      await settle(tester);
      expect(find.text(SignInCopy.sendCode), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(_phoneKey)).controller!.text, '9876543210');
    });

    testWidgets('the back arrow on the code step returns to the number step', (tester) async {
      final router = signInRouter();
      await pumpRouter(tester, router, api: okApi());
      await toCodeStep(tester);
      await tester.tap(find.byTooltip('Back'));
      await settle(tester);
      expect(find.text(SignInCopy.sendCode), findsOneWidget);
      expect(locationOf(router), '/sign-in');
    });

    testWidgets('code boxes are full width with 48 dp or bigger targets', (tester) async {
      await pumpRouter(tester, signInRouter(), api: okApi());
      await toCodeStep(tester);
      final size = tester.getSize(find.byKey(_codeKey));
      expect(size.height, greaterThanOrEqualTo(48));
      expect(size.width, greaterThan(300));
    });
  });

  testWidgets('opened by requireSignIn (pushed), a good sign-in closes with true', (tester) async {
    final router = GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(path: '/', builder: (_, __) => const _Opener()),
        GoRoute(path: '/sign-in', builder: (_, __) => const SignInScreen()),
      ],
    );
    await pumpRouter(tester, router, api: okApi());
    await tester.tap(find.text('open'));
    await settle(tester);
    await toCodeStep(tester);
    await enterCode(tester);
    expect(find.text('result: true'), findsOneWidget);
  });

  testWidgets('closed without signing in, the caller gets nothing', (tester) async {
    final router = GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(path: '/', builder: (_, __) => const _Opener()),
        GoRoute(path: '/sign-in', builder: (_, __) => const SignInScreen()),
      ],
    );
    await pumpRouter(tester, router, api: okApi());
    await tester.tap(find.text('open'));
    await settle(tester);
    await tester.tap(find.byTooltip('Back'));
    await settle(tester);
    expect(find.text('result: null'), findsOneWidget);
  });
}

class _Opener extends StatefulWidget {
  const _Opener();

  @override
  State<_Opener> createState() => _OpenerState();
}

class _OpenerState extends State<_Opener> {
  String result = 'none';

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Column(children: [
          Text('result: $result'),
          TextButton(
            onPressed: () async {
              final r = await GoRouter.of(context).push<bool>('/sign-in');
              if (mounted) setState(() => result = '$r');
            },
            child: const Text('open'),
          ),
        ]),
      );
}
