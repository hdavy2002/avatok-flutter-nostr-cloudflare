import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/strings.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/kyc_fakes.dart';

const _code = '/api/hosts/kyc/selfie/code';
const _upload = '/api/hosts/kyc/selfie';

void main() {
  late CapturingApi api;
  late FakePermissionService perms;
  late FakeSelfieRecorder recorder;
  late TelemetryLog log;
  int uploaded = 0;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = CapturingApi()..onJson('POST', _code, {'code': '4821'});
    perms = FakePermissionService(granted: {HfPermission.camera, HfPermission.mic});
    recorder = FakeSelfieRecorder();
    log = TelemetryLog()..install();
    uploaded = 0;
  });

  tearDown(() => log.remove());

  Future<void> pump(WidgetTester tester) => pumpWidgetUnderTest(
        tester,
        SelfieVideoWidget(onUploaded: () => uploaded += 1, recordSeconds: 3, countdownSeconds: 0),
        api: api,
        overrides: [
          permissionServiceProvider.overrideWithValue(perms),
          selfieRecorderFactoryProvider.overrideWithValue(() => recorder),
        ],
      ).then((_) {});

  /// consent -> camera -> record (3 s, fake clock) -> review
  Future<void> recordClip(WidgetTester tester) async {
    await tapKey(tester, 'selfie-consent');
    await tapKey(tester, 'selfie-open-camera');
    await tapKey(tester, 'camera-start');
    expect(find.byKey(const ValueKey<String>('camera-recording')), findsOneWidget);
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await settle(tester);
  }

  testWidgets('shows the server code, spaced, and blocks the camera until the person agrees', (tester) async {
    await pump(tester);
    expect(find.text('4821'), findsOneWidget);
    expect(find.textContaining('4 8 2 1'), findsOneWidget);
    final btn = tester.widget<ElevatedButton>(find.descendant(
      of: find.byKey(const ValueKey<String>('selfie-open-camera')),
      matching: find.byWidgetPredicate((w) => w is ElevatedButton),
    ));
    expect(btn.onPressed, isNull);
  });

  testWidgets('happy path: records exactly the set seconds, uploads raw bytes with the code header', (tester) async {
    api.onJson('POST', _upload, {'ok': true});
    await pump(tester);
    await recordClip(tester);

    expect(recorder.starts, 1);
    expect(recorder.stops, 1);
    expect(find.byKey(const ValueKey<String>('selfie-review')), findsOneWidget);

    await tapKey(tester, 'selfie-upload');
    final call = api.callsTo('POST', _upload).single;
    expect(call.body, isA<Uint8List>());
    final idx = api.calls.indexOf(call);
    expect(api.contentTypes[idx], 'video/mp4');
    final header = api.headersSeen[idx]!;
    expect(header['x-selfie-code'], '4821');
    for (final v in header.values) {
      expect(v.codeUnits.every((c) => c < 128), isTrue, reason: 'headers must be ASCII');
    }
    expect(uploaded, 1);
    expect(find.byKey(const ValueKey<String>('selfie-done')), findsOneWidget);
    expect(log.steps(), ['selfie_upload:ok']);
  });

  testWidgets('the recording stops by itself at the end of the countdown, not before', (tester) async {
    await pump(tester);
    await tapKey(tester, 'selfie-consent');
    await tapKey(tester, 'selfie-open-camera');
    await tapKey(tester, 'camera-start');
    await tester.pump(const Duration(seconds: 2));
    expect(recorder.stops, 0);
    await tester.pump(const Duration(seconds: 1));
    await settle(tester);
    expect(recorder.stops, 1);
  });

  testWidgets('Record again goes back and the camera can be used again', (tester) async {
    await pump(tester);
    await recordClip(tester);
    await tapKey(tester, 'selfie-again');
    expect(find.byKey(const ValueKey<String>('selfie-open-camera')), findsOneWidget);
    expect(api.callsTo('POST', _upload), isEmpty);
  });

  group('upload errors', () {
    Future<void> failWith(WidgetTester tester, ApiError e) async {
      api.onError('POST', _upload, e);
      await pump(tester);
      await recordClip(tester);
      await tapKey(tester, 'selfie-upload');
    }

    testWidgets('code_expired: new code is fetched and the person records again', (tester) async {
      await failWith(tester, const ApiError(status: 400, code: 'code_expired', message: 'old'));
      expect(find.text(KycCopy.codeExpired), findsOneWidget);
      expect(api.callsTo('POST', _code), hasLength(2));
      expect(find.byKey(const ValueKey<String>('selfie-open-camera')), findsOneWidget);
      expect(uploaded, 0);
    });

    testWidgets('code_mismatch: new code and the server message', (tester) async {
      await failWith(tester, const ApiError(status: 400, code: 'code_mismatch', message: 'Wrong code in video.'));
      expect(find.text('Wrong code in video.'), findsOneWidget);
      expect(api.callsTo('POST', _code), hasLength(2));
    });

    testWidgets('too_large: message shows and it is back at the start', (tester) async {
      await failWith(tester, const ApiError(status: 413, code: 'too_large', message: 'Video is too big.'));
      expect(find.text('Video is too big.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('selfie-open-camera')), findsOneWidget);
      expect(api.callsTo('POST', _code), hasLength(1));
    });

    testWidgets('unsupported_type: message shows and it is back at the start', (tester) async {
      await failWith(tester, const ApiError(status: 415, code: 'unsupported_type', message: 'Use an mp4.'));
      expect(find.text('Use an mp4.'), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('selfie-open-camera')), findsOneWidget);
    });

    testWidgets('no internet: the video is kept, the person can send it again', (tester) async {
      var n = 0;
      api.on('POST', _upload, (_) {
        if (++n == 1) throw ApiError.network();
        return {'ok': true};
      });
      await pump(tester);
      await recordClip(tester);
      await tapKey(tester, 'selfie-upload');
      expect(find.text(ApiError.network().userMessage), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('selfie-review')), findsOneWidget);
      expect(uploaded, 0);
      await tapKey(tester, 'selfie-upload');
      expect(uploaded, 1);
      expect(recorder.stops, 1, reason: 'no second recording was needed');
    });
  });

  group('local checks before upload', () {
    testWidgets('a video under 20 KB is refused without calling the server', (tester) async {
      recorder = FakeSelfieRecorder(clip: SelfieClip(bytes: Uint8List(1000), mime: 'video/mp4', seconds: 3));
      await pump(tester);
      await recordClip(tester);
      expect(find.text(KycCopy.tooSmallLocal), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('selfie-review')), findsNothing);
      expect(api.callsTo('POST', _upload), isEmpty);
      expect(log.steps(), ['selfie_upload:error']);
    });

    testWidgets('a video over 12 MB is refused without calling the server', (tester) async {
      recorder = FakeSelfieRecorder(clip: SelfieClip(bytes: Uint8List(kSelfieMaxBytes + 1), mime: 'video/mp4', seconds: 3));
      await pump(tester);
      await recordClip(tester);
      expect(find.text(KycCopy.tooLargeLocal), findsOneWidget);
      expect(api.callsTo('POST', _upload), isEmpty);
    });
  });

  group('code and camera problems', () {
    testWidgets('the code could not load: a Try again button loads it', (tester) async {
      var n = 0;
      api.on('POST', _code, (_) {
        if (++n == 1) throw ApiError.network();
        return {'code': '9034'};
      });
      await pump(tester);
      expect(find.byKey(const ValueKey<String>('selfie-code-retry')), findsOneWidget);
      await tapKey(tester, 'selfie-code-retry');
      expect(find.text('9034'), findsOneWidget);
    });

    testWidgets('camera denied: message and Open settings', (tester) async {
      recorder = FakeSelfieRecorder(openError: const SelfieRecorderException('denied'));
      await pump(tester);
      await tapKey(tester, 'selfie-consent');
      await tapKey(tester, 'selfie-open-camera');
      expect(find.byKey(const ValueKey<String>('camera-problem')), findsOneWidget);
      expect(find.text(KycCopy.cameraOff), findsOneWidget);
      await tapKey(tester, 'camera-open-settings');
      expect(perms.settingsOpened, 1);
      expect(log.named('hf_app_permission').single, {'kind': 'camera', 'result': 'denied'});
    });

    testWidgets('no camera on the phone: plain message, no settings button', (tester) async {
      recorder = FakeSelfieRecorder(openError: const SelfieRecorderException('no_camera'));
      await pump(tester);
      await tapKey(tester, 'selfie-consent');
      await tapKey(tester, 'selfie-open-camera');
      expect(find.text(KycCopy.noCamera), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('camera-open-settings')), findsNothing);
      expect(log.named('hf_app_permission').single['result'], 'error');
    });

    testWidgets('Try again reopens the camera', (tester) async {
      recorder = FakeSelfieRecorder(openError: const SelfieRecorderException('camera_failed'));
      await pump(tester);
      await tapKey(tester, 'selfie-consent');
      await tapKey(tester, 'selfie-open-camera');
      await tapKey(tester, 'camera-retry');
      expect(recorder.opens, 2);
    });

    testWidgets('permissions are asked first when not yet allowed: explainer, then camera and mic prompts', (tester) async {
      perms = FakePermissionService();
      await pump(tester);
      await tapKey(tester, 'selfie-consent');
      await tapKey(tester, 'selfie-open-camera');
      expect(find.text(KycCopy.cameraTitle), findsOneWidget);
      expect(perms.requested, isEmpty);
      await tester.tap(find.text(Strings.continueLabel));
      await settle(tester);
      expect(perms.requested, [HfPermission.camera, HfPermission.mic]);
      expect(find.byKey(const ValueKey<String>('camera-start')), findsOneWidget);
    });
  });
}
