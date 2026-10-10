import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart';

const _otp = '/api/hosts/kyc/aadhaar/otp';
const _verify = '/api/hosts/kyc/aadhaar/verify';
const _dlStart = '/api/hosts/kyc/digilocker/start';
const _dlComplete = '/api/hosts/kyc/digilocker/complete';
const _status = '/api/hosts/kyc/status';

ApiError fallbackError(int status, String code) => ApiError(
      status: status,
      code: code,
      message: 'Message for $code.',
      extra: const <String, Object?>{'fallback': 'digilocker'},
    );

const _verifiedJson = <String, Object?>{'ok': true, 'gender': 'F', 'ageOk': true, 'last4': '4321', 'firstName': 'Asha'};
const _pendingJson = <String, Object?>{'ok': false, 'pending': true, 'error': 'pending', 'message': 'Not yet.'};

void main() {
  late FakeApiClient api;
  late FakeLinkOpener links;
  late TelemetryLog log;
  AadhaarResult? result;
  int verifiedCalls = 0;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = FakeApiClient();
    links = FakeLinkOpener();
    LinkOpener.instance = links;
    log = TelemetryLog()..install();
    result = null;
    verifiedCalls = 0;
  });

  tearDown(() {
    LinkOpener.instance = const LinkOpener();
    log.remove();
  });

  Future<void> pump(WidgetTester tester, {KycRole role = KycRole.host, bool resumeNow = false, String? lane}) =>
      pumpWidgetUnderTest(
        tester,
        AadhaarVerifyWidget(
          role: role,
          lane: lane,
          resumeNow: resumeNow,
          onVerified: (r) {
            result = r;
            verifiedCalls += 1;
          },
        ),
        api: api,
      ).then((_) {});

  Future<void> sendOtp(WidgetTester tester, {String number = '123456789012'}) async {
    await typeKey(tester, 'aadhaar-number', number);
    await tapKey(tester, 'aadhaar-consent');
    await tapKey(tester, 'aadhaar-send');
  }

  group('OTP', () {
    testWidgets('number, consent, code, verify: onVerified gets the record', (tester) async {
      api
        ..onJson('POST', _otp, {'ok': true, 'expires_in_s': 600})
        ..onJson('POST', _verify, _verifiedJson);
      await pump(tester);

      // The send button waits for 12 digits and the consent box.
      expect(find.text('Send OTP'), findsOneWidget);
      await typeKey(tester, 'aadhaar-number', '1234');
      await tapKey(tester, 'aadhaar-send');
      expect(api.callsTo('POST', _otp), isEmpty);

      await sendOtp(tester);
      final sent = api.callsTo('POST', _otp).single.body as Map;
      expect(sent, {'aadhaar': '123456789012', 'consent': true, 'role': 'host'});
      expect(find.byKey(const ValueKey<String>('otp-code')), findsOneWidget);

      await typeKey(tester, 'otp-code', '654321');
      await tapKey(tester, 'otp-verify');
      expect(api.callsTo('POST', _verify).single.body, {'otp': '654321'});
      expect(verifiedCalls, 1);
      expect(result?.gender, 'F');
      expect(result?.last4, '4321');
      expect(log.steps(), ['aadhaar_otp:sent', 'aadhaar_verify:ok']);
    });

    testWidgets('the number is shown in groups of four and never sent to telemetry', (tester) async {
      api.onJson('POST', _otp, {'ok': true, 'expires_in_s': 600});
      await pump(tester);
      await typeKey(tester, 'aadhaar-number', '123456789012');
      expect(find.text('1234 5678 9012'), findsOneWidget);
      await tapKey(tester, 'aadhaar-consent');
      await tapKey(tester, 'aadhaar-send');
      for (final e in log.events) {
        expect(e.$2.values.map((v) => '$v').join(' '), isNot(contains('123456789012')));
      }
    });

    testWidgets('already verified: onVerified runs without a code', (tester) async {
      api.onJson('POST', _otp, {'ok': true, 'already_verified': true, 'gender': 'T', 'last4': '9999'});
      await pump(tester, role: KycRole.laneCaller);
      await sendOtp(tester);
      expect(api.callsTo('POST', _otp).single.body, containsPair('role', 'lane_caller'));
      expect(verifiedCalls, 1);
      expect(result?.alreadyVerified, isTrue);
      expect(result?.isFemaleOrTransgender, isTrue);
    });

    testWidgets('a typo is shown under the field and does NOT switch to DigiLocker', (tester) async {
      api.onError('POST', _otp,
          const ApiError(status: 422, code: 'invalid_aadhaar', message: 'Check the number.', field: 'aadhaar'));
      await pump(tester);
      await sendOtp(tester);
      expect(find.text('Check the number.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-consent-screen')), findsNothing);
    });

    testWidgets('wrong code: stays on the code screen and counts the tries left', (tester) async {
      api
        ..onJson('POST', _otp, {'ok': true, 'expires_in_s': 600})
        ..onError('POST', _verify,
            const ApiError(status: 422, code: 'invalid_otp', message: 'Wrong code.', extra: {'attemptsLeft': 2}));
      await pump(tester);
      await sendOtp(tester);
      await typeKey(tester, 'otp-code', '111111');
      await tapKey(tester, 'otp-verify');
      expect(find.text('Wrong code.'), findsOneWidget);
      expect(find.text('2 tries left.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-consent-screen')), findsNothing);
      expect(verifiedCalls, 0);
    });

    testWidgets('kyc_unavailable has no DigiLocker fallback: the message shows', (tester) async {
      api.onError('POST', _otp, const ApiError(status: 503, code: 'kyc_unavailable', message: 'Not available.'));
      await pump(tester);
      await sendOtp(tester);
      expect(find.text('Not available.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-consent-screen')), findsNothing);
    });

    testWidgets('the person can choose DigiLocker instead, and come back to OTP', (tester) async {
      await pump(tester);
      await tapKey(tester, 'use-digilocker');
      expect(find.byKey(const ValueKey<String>('dl-consent')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-fallback-note')), findsNothing);
      await tapKey(tester, 'dl-back-to-otp');
      expect(find.byKey(const ValueKey<String>('aadhaar-number')), findsOneWidget);
    });
  });

  group('every fallback code switches to DigiLocker', () {
    final cases = <(int, String)>[
      (503, 'otp_unavailable'),
      (422, 'otp_no_mobile'),
      (429, 'too_many'),
      (429, 'otp_attempts_exhausted'),
    ];
    for (final (status, code) in cases) {
      testWidgets('sending the OTP: $status $code', (tester) async {
        api.onError('POST', _otp, fallbackError(status, code));
        await pump(tester);
        await sendOtp(tester);
        expect(find.byKey(const ValueKey<String>('dl-consent-screen')), findsOneWidget);
        expect(find.text('Message for $code.'), findsOneWidget);
        expect(find.byKey(const ValueKey<String>('dl-consent')), findsOneWidget);
        expect(log.steps(), ['aadhaar_otp:fallback']);
        expect(log.named('hf_app_kyc_step').single['reason'], code);
      });

      testWidgets('checking the OTP: $status $code', (tester) async {
        api
          ..onJson('POST', _otp, {'ok': true, 'expires_in_s': 600})
          ..onError('POST', _verify, fallbackError(status, code));
        await pump(tester);
        await sendOtp(tester);
        await typeKey(tester, 'otp-code', '222222');
        await tapKey(tester, 'otp-verify');
        expect(find.byKey(const ValueKey<String>('dl-consent-screen')), findsOneWidget);
        expect(find.text('Message for $code.'), findsOneWidget);
      });
    }

    testWidgets('after a fallback the Aadhaar number is gone from the screen', (tester) async {
      api.onError('POST', _otp, fallbackError(503, 'otp_unavailable'));
      await pump(tester);
      await sendOtp(tester);
      await tapKey(tester, 'dl-back-to-otp');
      expect(find.text('1234 5678 9012'), findsNothing);
    });
  });

  group('DigiLocker', () {
    Future<void> startDigiLocker(WidgetTester tester) async {
      await tapKey(tester, 'use-digilocker');
      await tapKey(tester, 'dl-consent');
      await tapKey(tester, 'dl-start');
    }

    testWidgets('start opens the link in a Custom Tab with the app return path and remembers the attempt', (tester) async {
      api.onJson('POST', _dlStart, {'ok': true, 'url': 'https://digilocker.example/auth?x=1'});
      await pump(tester, role: KycRole.laneCaller, lane: 'women');
      await startDigiLocker(tester);

      final body = api.callsTo('POST', _dlStart).single.body as Map;
      expect(body, {'consent': true, 'role': 'lane_caller', 'returnPath': '/hosts/kyc/return?app=1'});
      expect(links.tabs.single.toString(), 'https://digilocker.example/auth?x=1');
      expect(find.byKey(const ValueKey<String>('dl-waiting')), findsOneWidget);
      final saved = await const DigiLockerPendingStore().read();
      expect(saved?.role, KycRole.laneCaller);
      expect(saved?.lane, 'women');
    });

    testWidgets('coming back (app resume) runs digilocker/complete once and finishes', (tester) async {
      api
        ..onJson('POST', _dlStart, {'ok': true, 'url': 'https://digilocker.example/auth'})
        ..onJson('POST', _dlComplete, _verifiedJson);
      await pump(tester);
      await startDigiLocker(tester);
      expect(api.callsTo('POST', _dlComplete), isEmpty);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await settle(tester);

      expect(api.callsTo('POST', _dlComplete), hasLength(1));
      expect(verifiedCalls, 1);
      expect(result?.viaDigiLocker, isTrue);
      expect(await const DigiLockerPendingStore().read(), isNull);
      expect(log.steps(), contains('digilocker_complete:ok'));
    });

    testWidgets('the return link (resumeNow) finishes a check even with nothing saved', (tester) async {
      api.onJson('POST', _dlComplete, _verifiedJson);
      await pump(tester, resumeNow: true);
      expect(api.callsTo('POST', _dlComplete), hasLength(1));
      expect(verifiedCalls, 1);
    });

    testWidgets('a saved attempt is finished when the screen opens again (app was restarted)', (tester) async {
      await const DigiLockerPendingStore()
          .save(DigiLockerPending(role: KycRole.host, at: DateTime.now().subtract(const Duration(minutes: 3))));
      api.onJson('POST', _dlComplete, _verifiedJson);
      await pump(tester);
      expect(api.callsTo('POST', _dlComplete), hasLength(1));
      expect(verifiedCalls, 1);
    });

    testWidgets('an attempt older than 30 minutes is forgotten', (tester) async {
      await const DigiLockerPendingStore()
          .save(DigiLockerPending(role: KycRole.host, at: DateTime.now().subtract(const Duration(minutes: 45))));
      await pump(tester);
      expect(api.callsTo('POST', _dlComplete), isEmpty);
      expect(find.byKey(const ValueKey<String>('aadhaar-number')), findsOneWidget);
    });

    testWidgets("another role's attempt is left alone", (tester) async {
      await const DigiLockerPendingStore().save(DigiLockerPending(role: KycRole.laneCaller, at: DateTime.now(), lane: 'lgbtq'));
      await pump(tester, role: KycRole.host);
      expect(api.callsTo('POST', _dlComplete), isEmpty);
    });

    testWidgets('202 pending is polled every 3 seconds until it answers', (tester) async {
      var n = 0;
      api.on('POST', _dlComplete, (_) => ++n < 3 ? _pendingJson : _verifiedJson);
      await pump(tester, resumeNow: true);
      expect(api.callsTo('POST', _dlComplete), hasLength(1));
      expect(find.byKey(const ValueKey<String>('dl-waiting')), findsOneWidget);

      await tester.pump(const Duration(seconds: 2));
      expect(api.callsTo('POST', _dlComplete), hasLength(1), reason: 'not before 3 s');
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);
      expect(api.callsTo('POST', _dlComplete), hasLength(2));
      expect(verifiedCalls, 0);

      await tester.pump(const Duration(seconds: 3));
      await settle(tester);
      expect(api.callsTo('POST', _dlComplete), hasLength(3));
      expect(verifiedCalls, 1);
      expect(log.steps().where((s) => s == 'digilocker_complete:pending'), hasLength(2));
    });

    testWidgets('polling stops after 10 tries and shows Check again', (tester) async {
      api.onJson('POST', _dlComplete, _pendingJson);
      await pump(tester, resumeNow: true);
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(seconds: 3));
        await settle(tester);
      }
      expect(api.callsTo('POST', _dlComplete), hasLength(kDigiLockerMaxPolls));
      expect(find.text('Not yet.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-check')), findsOneWidget);

      await tapKey(tester, 'dl-check');
      expect(api.callsTo('POST', _dlComplete), hasLength(kDigiLockerMaxPolls + 1));
    });

    testWidgets('no session (the first call already finished): the status call recovers', (tester) async {
      api
        ..onError('POST', _dlComplete, const ApiError(status: 400, code: 'no_session', message: 'Start again.'))
        ..onJson('GET', _status, {
          'aadhaar': {'done': true, 'gender': 'M', 'last4': '1111', 'role': 'host'},
          'selfie': {'status': 'none'},
          'payout': {'done': false},
        });
      await pump(tester, resumeNow: true);
      expect(verifiedCalls, 1);
      expect(result?.last4, '1111');
      expect(result?.alreadyVerified, isTrue);
    });

    testWidgets('a cancelled DigiLocker shows the message and offers to start again', (tester) async {
      await const DigiLockerPendingStore().save(DigiLockerPending(role: KycRole.host, at: DateTime.now()));
      api.onError('POST', _dlComplete, const ApiError(status: 409, code: 'consent_denied', message: 'It was cancelled.'));
      await pump(tester);
      expect(find.byKey(const ValueKey<String>('dl-failed')), findsOneWidget);
      expect(find.text('It was cancelled.'), findsOneWidget);
      expect(await const DigiLockerPendingStore().read(), isNull);
      await tapKey(tester, 'dl-restart');
      expect(find.byKey(const ValueKey<String>('dl-consent')), findsOneWidget);
    });

    testWidgets('no internet while checking keeps the attempt so Check again works later', (tester) async {
      await const DigiLockerPendingStore().save(DigiLockerPending(role: KycRole.host, at: DateTime.now()));
      var calls = 0;
      api.on('POST', _dlComplete, (_) {
        if (++calls == 1) throw ApiError.network();
        return _verifiedJson;
      });
      await pump(tester);
      expect(find.byKey(const ValueKey<String>('dl-waiting')), findsOneWidget);
      expect(find.text(ApiError.network().userMessage), findsOneWidget);
      expect(await const DigiLockerPendingStore().read(), isNotNull);
      await tapKey(tester, 'dl-check');
      expect(verifiedCalls, 1);
    });

    testWidgets('when the Custom Tab cannot open, the attempt is dropped and the message shows', (tester) async {
      links = FakeLinkOpener(result: false);
      LinkOpener.instance = links;
      api.onJson('POST', _dlStart, {'ok': true, 'url': 'https://digilocker.example/auth'});
      await pump(tester);
      await startDigiLocker(tester);
      expect(find.text(KycCopy.digiLockerNotOpened), findsOneWidget);
      expect(await const DigiLockerPendingStore().read(), isNull);
    });

    testWidgets('digilocker/start already verified finishes at once', (tester) async {
      api.onJson('POST', _dlStart, {'ok': true, 'already_verified': true, 'gender': 'F', 'last4': '7777'});
      await pump(tester);
      await startDigiLocker(tester);
      expect(verifiedCalls, 1);
      expect(links.tabs, isEmpty);
    });

    testWidgets('a start error (rate limit) shows its message and stays on the consent screen', (tester) async {
      api.onError('POST', _dlStart,
          const ApiError(status: 429, code: 'too_many', message: 'Try in an hour.', extra: {'retry_after_s': 3600}));
      await pump(tester);
      await startDigiLocker(tester);
      expect(find.text('Try in an hour.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('dl-start')), findsOneWidget);
    });
  });
}
