import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/features/lanes/data/lanes_api.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart';

const _me = '/api/hf/lanes/me';
const _otp = '/api/hosts/kyc/aadhaar/otp';
const _verify = '/api/hosts/kyc/aadhaar/verify';

Map<String, Object?> laneMe({
  bool aadhaar = false,
  String? gender,
  bool womenEligible = false,
  bool womenGranted = false,
  bool lgbtqGranted = false,
}) =>
    {
      'whatsappVerified': true,
      'aadhaarVerified': aadhaar,
      'gender': gender,
      'lanes': {
        'women': {'eligible': womenEligible, 'granted': womenGranted},
        'lgbtq': {'declared': lgbtqGranted, 'granted': lgbtqGranted},
      },
    };

void main() {
  late FakeApiClient api;
  late TelemetryLog log;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = FakeApiClient();
    log = TelemetryLog()..install();
  });

  tearDown(() => log.remove());

  Future<void> open(WidgetTester tester, {String? lane}) =>
      pumpApp(tester, session: signedInState(), location: Routes.lanesOf(lane), api: api).then((_) {});

  Map<String, Object> lastJoinEvent() => log.named('hf_app_lane_join').last;

  group('chooser', () {
    testWidgets('lists both spaces and opens the one that is tapped', (tester) async {
      api.onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true, womenGranted: true));
      await open(tester);
      expect(find.byKey(const ValueKey<String>('choose-women')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('choose-lgbtq')), findsOneWidget);
      expect(find.text(LaneCopy.youAreIn), findsOneWidget);
      expect(find.text(LaneCopy.tapToJoin), findsOneWidget);
      await tapKey(tester, 'choose-lgbtq');
      expect(find.text(LaneCopy.titleOf(Lane.lgbtq)), findsWidgets);
      expect(find.byKey(const ValueKey<String>('lane-declare')), findsOneWidget);
    });

    testWidgets('a flag that is off shows Coming soon, not an error', (tester) async {
      api.onError('GET', _me, const ApiError(status: 404, code: 'not_enabled'));
      await open(tester, lane: 'women');
      expect(find.text('Coming soon'), findsOneWidget);
    });
  });

  group('women-only space', () {
    testWidgets('Aadhaar already done and female: tick, join, you are in', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true))
        ..onJson('POST', '/api/hf/lanes/women/join', {'ok': true});
      await open(tester, lane: 'women');

      // The join button waits for the 18+ tick.
      expect(find.byKey(const ValueKey<String>('lane-declare')), findsNothing);
      await tapKey(tester, 'lane-join');
      expect(api.callsTo('POST', '/api/hf/lanes/women/join'), isEmpty);

      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-join');
      expect(api.callsTo('POST', '/api/hf/lanes/women/join'), hasLength(1));
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
      expect(lastJoinEvent(), {'lane': 'women', 'result': 'joined'});
    });

    testWidgets("Aadhaar on file says male: the space is shown as not open, with no join button", (tester) async {
      api.onJson('GET', _me, laneMe(aadhaar: true, gender: 'M', womenEligible: false));
      await open(tester, lane: 'women');
      expect(find.byKey(const ValueKey<String>('lane-not-eligible')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('lane-join')), findsNothing);
    });

    testWidgets('the server says not_eligible (403): its message shows and the event says why', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true))
        ..onError('POST', '/api/hf/lanes/women/join',
            const ApiError(status: 403, code: 'not_eligible', message: 'Not open for this Aadhaar.'));
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-join');
      expect(find.byKey(const ValueKey<String>('lane-not-eligible')), findsOneWidget);
      expect(find.text('Not open for this Aadhaar.'), findsOneWidget);
      expect(lastJoinEvent(), {'lane': 'women', 'result': 'not_eligible', 'reason': 'not_eligible', 'status': 403});
    });

    testWidgets('aadhaar_required (409): message shows, join can be tried again', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true))
        ..onError('POST', '/api/hf/lanes/women/join',
            const ApiError(status: 409, code: 'aadhaar_required', message: 'Verify your Aadhaar first.'));
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-join');
      expect(find.text('Verify your Aadhaar first.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('lane-join')), findsOneWidget);
      expect(lastJoinEvent()['result'], 'aadhaar_required');
    });

    testWidgets('a network error while joining is shown and can be retried', (tester) async {
      var n = 0;
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'T', womenEligible: true))
        ..on('POST', '/api/hf/lanes/women/join', (_) {
          if (++n == 1) throw ApiError.network();
          return {'ok': true};
        });
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-join');
      expect(find.text(ApiError.network().userMessage), findsOneWidget);
      expect(lastJoinEvent()['result'], 'error');
      await tapKey(tester, 'lane-join');
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
    });

    testWidgets('no Aadhaar yet: tick, OTP, and the join happens by itself after the check', (tester) async {
      api
        ..onJson('GET', _me, laneMe())
        ..onJson('POST', _otp, {'ok': true, 'expires_in_s': 600})
        ..onJson('POST', _verify, {'ok': true, 'gender': 'F', 'last4': '1234'})
        ..onJson('POST', '/api/hf/lanes/women/join', {'ok': true});
      await open(tester, lane: 'women');

      await tapKey(tester, 'lane-ack18');
      await typeKey(tester, 'aadhaar-number', '123456789012');
      await tapKey(tester, 'aadhaar-consent');
      await tapKey(tester, 'aadhaar-send');
      expect((api.callsTo('POST', _otp).single.body as Map)['role'], 'lane_caller');
      await typeKey(tester, 'otp-code', '123456');
      await tapKey(tester, 'otp-verify');

      expect(api.callsTo('POST', '/api/hf/lanes/women/join'), hasLength(1));
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
    });

    testWidgets('the Aadhaar check says male: no join call, the space is shown as not open', (tester) async {
      api
        ..onJson('GET', _me, laneMe())
        ..onJson('POST', _otp, {'ok': true, 'expires_in_s': 600})
        ..onJson('POST', _verify, {'ok': true, 'gender': 'M', 'last4': '1234'});
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-ack18');
      await typeKey(tester, 'aadhaar-number', '123456789012');
      await tapKey(tester, 'aadhaar-consent');
      await tapKey(tester, 'aadhaar-send');
      await typeKey(tester, 'otp-code', '123456');
      await tapKey(tester, 'otp-verify');

      expect(find.byKey(const ValueKey<String>('lane-not-eligible')), findsOneWidget);
      expect(api.callsTo('POST', '/api/hf/lanes/women/join'), isEmpty);
      expect(lastJoinEvent(), {'lane': 'women', 'result': 'not_eligible', 'reason': 'aadhaar_record'});
    });
  });

  group('LGBTQ+ space', () {
    testWidgets('needs both ticks, then sends declare and ack18', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'M'))
        ..onJson('POST', '/api/hf/lanes/lgbtq/join', {'ok': true});
      await open(tester, lane: 'lgbtq');

      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-join');
      expect(api.callsTo('POST', '/api/hf/lanes/lgbtq/join'), isEmpty, reason: 'declaration not ticked yet');

      await tapKey(tester, 'lane-declare');
      await tapKey(tester, 'lane-join');
      expect(api.callsTo('POST', '/api/hf/lanes/lgbtq/join').single.body, {'declare': true, 'ack18': true});
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
      expect(lastJoinEvent(), {'lane': 'lgbtq', 'result': 'joined'});
    });

    testWidgets('a man can join this space: gender never blocks it', (tester) async {
      api.onJson('GET', _me, laneMe(aadhaar: true, gender: 'M'));
      await open(tester, lane: 'lgbtq');
      expect(find.byKey(const ValueKey<String>('lane-not-eligible')), findsNothing);
    });

    testWidgets('declare_required (400): the message shows', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F'))
        ..onError('POST', '/api/hf/lanes/lgbtq/join',
            const ApiError(status: 400, code: 'declare_required', message: 'Please tick the declaration.'));
      await open(tester, lane: 'lgbtq');
      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-declare');
      await tapKey(tester, 'lane-join');
      expect(find.text('Please tick the declaration.'), findsOneWidget);
      expect(lastJoinEvent(), {'lane': 'lgbtq', 'result': 'error', 'reason': 'declare_required', 'status': 400});
    });

    testWidgets('telemetry never carries the declaration or gender', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'T'))
        ..onJson('POST', '/api/hf/lanes/lgbtq/join', {'ok': true});
      await open(tester, lane: 'lgbtq');
      await tapKey(tester, 'lane-ack18');
      await tapKey(tester, 'lane-declare');
      await tapKey(tester, 'lane-join');
      for (final e in log.events) {
        expect(e.$2.keys.toSet().difference({'lane', 'result', 'reason', 'status'}), isEmpty);
      }
    });
  });

  group('already in, and leaving', () {
    testWidgets('shows You are in with Browse and Leave; leaving asks first', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true, womenGranted: true))
        ..onJson('DELETE', '/api/hf/lanes/women', {'ok': true});
      await open(tester, lane: 'women');
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('lane-browse')), findsOneWidget);

      await tapKey(tester, 'lane-leave');
      expect(find.text(LaneCopy.leaveTitle), findsOneWidget);
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), isEmpty, reason: 'not before the person confirms');

      await tapKey(tester, 'leave-confirm');
      expect(api.callsTo('DELETE', '/api/hf/lanes/women'), hasLength(1));
      expect(find.byKey(const ValueKey<String>('lane-in')), findsNothing);
      expect(find.text(LaneCopy.leftTitle), findsOneWidget);
    });

    testWidgets('Stay closes the question and keeps the person in', (tester) async {
      api.onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true, womenGranted: true));
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-leave');
      await tester.tap(find.text(LaneCopy.stay));
      await settle(tester);
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
    });

    testWidgets('a failed leave shows the error and keeps the person in', (tester) async {
      api
        ..onJson('GET', _me, laneMe(aadhaar: true, gender: 'F', womenEligible: true, womenGranted: true))
        ..onError('DELETE', '/api/hf/lanes/women', ApiError.network());
      await open(tester, lane: 'women');
      await tapKey(tester, 'lane-leave');
      await tapKey(tester, 'leave-confirm');
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
      expect(find.text(ApiError.network().userMessage), findsOneWidget);
    });
  });
}
