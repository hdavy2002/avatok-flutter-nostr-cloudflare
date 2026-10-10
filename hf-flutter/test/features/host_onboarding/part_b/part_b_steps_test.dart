import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/explore/data/host_options.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_context.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_steps.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/part_b_telemetry.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/voice_audio.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/about_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/done_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/generating_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/part_b_copy.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/preview_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/voice_step.dart';
import 'package:hf_app/features/host_profile/ui/widgets/net_image.dart';
import 'package:hf_app/features/kyc/kyc.dart';

import '../../../support/app_harness.dart';
import '../../../support/fake_api_client.dart';
import '../../../support/kyc_fakes.dart';

const _me = '/api/hosts/me';

/// What the step under test did through its context.
class CtxLog {
  CtxLog(Map<String, Object?> host, {List<Object?> media = const <Object?>[]})
      : state = OnboardingServerState.fromJson(<String, dynamic>{'host': host, 'kyc': <String, Object?>{}, 'media': media, 'job': null});

  OnboardingServerState state;
  int nexts = 0;
  final List<String> goTos = <String>[];

  OnboardingStepContext get ctx => OnboardingStepContext(
        state: state,
        next: () async => nexts++,
        goTo: goTos.add,
        refresh: () async => state,
      );
}

/// A microphone that returns a clip of [seconds] whatever the real time was.
class FakeVoiceRecorder implements VoiceRecorder {
  FakeVoiceRecorder(this.seconds);
  final int seconds;

  @override
  Stream<double> get levels => const Stream<double>.empty();

  @override
  Future<void> start() async {}

  @override
  Future<VoiceClip> stop() async =>
      VoiceClip(bytes: Uint8List(2048), path: '/tmp/hf_fake_intro.m4a', mime: 'audio/mp4', seconds: seconds);

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}

void main() {
  late FakeApiClient api;
  late List<(String, Map<String, Object>)> events;

  setUp(() {
    api = FakeApiClient();
    events = <(String, Map<String, Object>)>[];
    OnboardingTelemetry.sink = (event, props) async => events.add((event, props));
  });

  tearDown(OnboardingTelemetry.resetSink);

  Future<void> pumpStep(WidgetTester tester, Widget step, {List<Override> overrides = const <Override>[]}) async {
    usePhoneScreen(tester);
    final container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(api),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      hostOptionsProvider.overrideWith((ref) async => const HostOptions(
            topics: [HostTopic(slug: 'loneliness', label: 'Loneliness', group: 'Tension')],
            moodGroups: <MoodGroup>[],
            languages: <HostLanguage>[],
            priceMin: 5,
            priceMax: 100,
          )),
      hostImageBuilderProvider.overrideWithValue((context, url, {BoxFit fit = BoxFit.cover}) => const SizedBox(width: 40, height: 40)),
      ...overrides,
    ]);
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp(theme: buildHfTheme(), home: Scaffold(body: step)),
    ));
    await settle(tester);
  }

  /// Takes the step off the screen so its timers are cancelled before the test ends.
  Future<void> leave(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  }

  bool has(String key) => find.byKey(ValueKey<String>(key)).evaluate().isNotEmpty;

  const draftHost = <String, Object?>{'status': 'draft', 'displayName': '', 'about': ''};

  group('field errors sit under the field', () {
    testWidgets('the phone checks the name and the text before anything is sent', (tester) async {
      final log = CtxLog(draftHost);
      await pumpStep(tester, AboutStep(ctx: log.ctx));

      await typeKey(tester, 'about-name', 'Neha99');
      expect(find.text(PartBCopy.nameFormat), findsOneWidget);

      await typeKey(tester, 'about-text', 'You can call me on 98765 43210 any evening, I am free');
      expect(find.text('Please remove phone numbers.'), findsOneWidget);
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('about-continue'))).onPressed, isNull);
      expect(api.callsTo('PUT', _me), isEmpty);
      await leave(tester);
    });

    testWidgets('a message from the worker shows under the field it names, and Continue stays off', (tester) async {
      api.on('PUT', _me, (call) {
        final body = call.body as Map;
        if (body.containsKey('about')) {
          throw const ApiError(status: 400, code: 'invalid_field', field: 'about', message: 'Please keep contact details out of your text.');
        }
        return <String, Object?>{'host': <String, Object?>{}};
      });
      final log = CtxLog(draftHost);
      await pumpStep(tester, AboutStep(ctx: log.ctx));

      await typeKey(tester, 'about-name', 'Neha');
      await typeKey(tester, 'about-text', 'I am a good listener and I love old songs and evening chai with anyone.');
      // Nothing is sent while typing; 800 ms after the last key it is.
      expect(api.callsTo('PUT', _me), isEmpty);
      await tester.pump(const Duration(milliseconds: 900));
      await settle(tester);

      expect(api.callsTo('PUT', _me).map((c) => (c.body as Map).keys.single).toSet(), {'displayName', 'about'});
      expect(find.text('Please keep contact details out of your text.'), findsOneWidget);
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('about-continue'))).onPressed, isNull);
      expect(log.nexts, 0);
      await leave(tester);
    });

    testWidgets('a good form saves and Continue opens the next step', (tester) async {
      api.onJson('PUT', _me, <String, Object?>{'host': <String, Object?>{}});
      final log = CtxLog(draftHost);
      await pumpStep(tester, AboutStep(ctx: log.ctx));
      await typeKey(tester, 'about-name', 'Neha');
      await typeKey(tester, 'about-text', 'I am a good listener and I love old songs and evening chai with anyone.');
      await tapKey(tester, 'about-continue');
      expect(log.nexts, 1);
      expect(api.callsTo('PUT', _me).length, 2);
      expect(events.map((e) => '${e.$1}:${e.$2['step']}:${e.$2['result']}'), contains('hf_app_onboarding_step:about:ok'));
      await leave(tester);
    });
  });

  group('voice introduction', () {
    List<Override> mic(int seconds) => [
          permissionServiceProvider.overrideWithValue(FakePermissionService(granted: {HfPermission.mic})),
          voiceRecorderFactoryProvider.overrideWithValue(() => FakeVoiceRecorder(seconds)),
        ];

    Future<void> record(WidgetTester tester) async {
      await tapKey(tester, 'voice-record');
      expect(has('voice-timer'), isTrue);
      await tester.pump(const Duration(seconds: 31));
      await settle(tester);
    }

    testWidgets('Stop is off until 30 seconds have been recorded', (tester) async {
      final log = CtxLog(const <String, Object?>{'status': 'draft'});
      await pumpStep(tester, VoiceStep(ctx: log.ctx), overrides: mic(45));
      await tapKey(tester, 'voice-record');
      await tester.pump(const Duration(seconds: 5));
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('voice-stop'))).onPressed, isNull);
      await tester.pump(const Duration(seconds: 26));
      await settle(tester);
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('voice-stop'))).onPressed, isNotNull);
      await leave(tester);
    });

    testWidgets('a clip under 30 seconds is refused on the phone and never uploaded', (tester) async {
      final log = CtxLog(const <String, Object?>{'status': 'draft'});
      await pumpStep(tester, VoiceStep(ctx: log.ctx), overrides: mic(12));
      await record(tester);
      await tapKey(tester, 'voice-stop');
      expect(find.text(PartBCopy.voiceTooShort(12)), findsOneWidget);
      expect(has('voice-save'), isFalse);
      expect(api.calls, isEmpty);
      expect(events.map((e) => '${e.$2['result']}:${e.$2['reason']}'), contains('blocked:too_short'));
      await leave(tester);
    });

    testWidgets('a clip over 5 minutes is refused on the phone and never uploaded', (tester) async {
      final log = CtxLog(const <String, Object?>{'status': 'draft'});
      await pumpStep(tester, VoiceStep(ctx: log.ctx), overrides: mic(400));
      await record(tester);
      await tapKey(tester, 'voice-stop');
      expect(find.text(PartBCopy.voiceTooLong), findsOneWidget);
      expect(has('voice-save'), isFalse);
      expect(api.calls, isEmpty);
      expect(events.map((e) => '${e.$2['result']}:${e.$2['reason']}'), contains('blocked:too_long'));
      await leave(tester);
    });

    testWidgets('a good clip needs the consent tick, then uploads with the headers the worker wants', (tester) async {
      final capture = CapturingApi()
        ..onJson('PUT', '/api/hosts/me/voice', <String, Object?>{
          'voice': <String, Object?>{'status': 'pending', 'seconds': 45},
        });
      api = capture;
      final log = CtxLog(const <String, Object?>{'status': 'draft'});
      await pumpStep(tester, VoiceStep(ctx: log.ctx), overrides: mic(45));
      await record(tester);
      await tapKey(tester, 'voice-stop');

      expect(has('voice-review-title'), isTrue);
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('voice-save'))).onPressed, isNull);
      expect(find.text(PartBCopy.voiceNeedConsent), findsOneWidget);

      await tapKey(tester, 'voice-consent');
      await tapKey(tester, 'voice-save');

      expect(capture.callsTo('PUT', '/api/hosts/me/voice'), hasLength(1));
      expect(capture.contentTypes.single, 'audio/mp4');
      expect(capture.headersSeen.single, {'x-duration-seconds': '45', 'x-voice-consent': '1'});
      expect(events.where((e) => e.$1 == 'hf_app_voice_recorded').single.$2, {'seconds': 45});
      await leave(tester);
    });

    testWidgets('a rejected recording says so kindly and asks to record again', (tester) async {
      final log = CtxLog(const <String, Object?>{
        'status': 'draft',
        'voice': <String, Object?>{'seconds': 50, 'status': 'rejected'},
      });
      await pumpStep(tester, VoiceStep(ctx: log.ctx), overrides: mic(45));
      expect(find.text(PartBCopy.voiceStatusRejected), findsOneWidget);
      expect(tester.widget<HfButton>(find.byKey(const ValueKey<String>('voice-continue'))).onPressed, isNull);
      await leave(tester);
    });
  });

  group('making the profile', () {
    Map<String, Object?> st(String text, String images, String safety, {String status = 'running'}) =>
        {'status': status, 'stages': {'text': text, 'images': images, 'safety': safety}};

    testWidgets('starts the job, follows the three stages every 3 seconds, then opens the next step', (tester) async {
      final answers = <Map<String, Object?>>[
        st('working', 'waiting', 'waiting'),
        st('done', 'working', 'waiting'),
        st('done', 'done', 'done', status: 'done'),
      ];
      api
        ..onJson('POST', '/api/hosts/generate', {'jobId': 'j1'})
        ..on('GET', '/api/hosts/generate/status', (_) => answers.length > 1 ? answers.removeAt(0) : answers.first);
      final log = CtxLog(const <String, Object?>{'status': 'draft', 'genAttempts': 0});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));

      expect(api.callsTo('POST', '/api/hosts/generate'), hasLength(1));
      expect(has('gen-stage-text-working'), isTrue);
      expect(has('gen-stage-images-waiting'), isTrue);
      expect(has('gen-stage-safety-waiting'), isTrue);

      await tester.pump(const Duration(seconds: 3));
      await settle(tester);
      expect(has('gen-stage-text-done'), isTrue);
      expect(has('gen-stage-images-working'), isTrue);
      expect(log.nexts, 0);

      await tester.pump(const Duration(seconds: 3));
      await settle(tester);
      expect(log.nexts, 1);
      expect(events.map((e) => '${e.$2['step']}:${e.$2['result']}'), containsAll(['generating:started', 'generating:done']));
      await leave(tester);
    });

    testWidgets('a job already running is only followed, never started again', (tester) async {
      api.onJson('GET', '/api/hosts/generate/status', st('working', 'waiting', 'waiting'));
      final log = CtxLog(const <String, Object?>{'status': 'generating', 'genAttempts': 1});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));
      expect(api.callsTo('POST', '/api/hosts/generate'), isEmpty);
      expect(has('gen-stage-text-working'), isTrue);
      await leave(tester);
    });

    testWidgets('a failed stage shows a kind message and Try again starts a new job', (tester) async {
      var starts = 0;
      api
        ..on('POST', '/api/hosts/generate', (_) => {'jobId': 'j${++starts}'})
        ..onJson('GET', '/api/hosts/generate/status', st('done', 'failed', 'waiting', status: 'failed'));
      final log = CtxLog(const <String, Object?>{'status': 'draft', 'genAttempts': 1});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));
      expect(find.text(PartBCopy.generatingFailed), findsOneWidget);
      expect(has('gen-stage-images-failed'), isTrue);

      await tapKey(tester, 'gen-retry');
      expect(starts, 2);
      await leave(tester);
    });

    testWidgets('missing steps are listed with a button that opens each', (tester) async {
      api.onError('POST', '/api/hosts/generate', const ApiError(status: 409, code: 'profile_incomplete', extra: {'missing': ['avatar']}));
      final log = CtxLog(const <String, Object?>{'status': 'draft'});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));
      expect(find.text(PartBCopy.generatingMissing), findsOneWidget);
      await tapKey(tester, 'gen-fix-avatar');
      expect(log.goTos, ['avatar']);
      await leave(tester);
    });

    testWidgets('three tries used: says so and offers no retry', (tester) async {
      api.onError('POST', '/api/hosts/generate', const ApiError(status: 429, code: 'attempts_exhausted'));
      final log = CtxLog(const <String, Object?>{'status': 'draft', 'genAttempts': 3});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));
      expect(find.text(PartBCopy.generatingExhausted), findsOneWidget);
      expect(has('gen-retry'), isFalse);
      await leave(tester);
    });

    testWidgets('a profile that is already made shows Ready and does not start a job', (tester) async {
      final log = CtxLog(const <String, Object?>{'status': 'pending_host', 'genAttempts': 1});
      await pumpStep(tester, GeneratingStep(ctx: log.ctx));
      expect(api.calls, isEmpty);
      await tapKey(tester, 'gen-see');
      expect(log.goTos, ['preview']);
      expect(has('gen-again'), isTrue);
      await leave(tester);
    });
  });

  group('preview, locked states and submit', () {
    const ready = <String, Object?>{
      'status': 'pending_host',
      'displayName': 'Neha',
      'tagline': 'A warm ear for your evening',
      'quote': 'Every story matters.',
      'about': 'raw about',
      'aboutPolished': 'I love listening, old songs and chai.',
      'topics': ['loneliness'],
      'pricePerMin': 20,
      'avatarUrl': 'https://img.test/a.webp',
      'voice': {'seconds': 45, 'status': 'pending'},
    };
    const media = <Object?>[
      {'kind': 'profile', 'url': 'https://img.test/p.webp', 'sort': 0},
      {'kind': 'gallery', 'url': 'https://img.test/g1.webp', 'caption': 'Evening chai', 'sort': 1},
      {'kind': 'gallery', 'url': 'https://img.test/g2.webp', 'caption': 'Old songs', 'sort': 2},
    ];

    testWidgets('Send for review calls submit, reports it and moves on', (tester) async {
      api.onJson('POST', '/api/hosts/submit', {'ok': true});
      final log = CtxLog(ready, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));
      expect(find.byKey(const ValueKey<String>('preview-name')), findsOneWidget);
      expect(find.text('I love listening, old songs and chai.'), findsOneWidget);

      await tapKey(tester, 'preview-submit');
      expect(api.callsTo('POST', '/api/hosts/submit'), hasLength(1));
      expect(log.nexts, 1);
      expect(events.map((e) => e.$1), contains('hf_app_host_submitted'));
      await leave(tester);
    });

    testWidgets('a server that says something is missing lists the step to fix', (tester) async {
      api.onError('POST', '/api/hosts/submit', const ApiError(status: 422, code: 'incomplete', message: 'A few steps are still missing.', extra: {'missing': ['voice']}));
      final log = CtxLog(ready, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));
      await tapKey(tester, 'preview-submit');
      expect(find.text('A few steps are still missing.'), findsOneWidget);
      expect(log.nexts, 0);
      await tapKey(tester, 'preview-fix-voice');
      expect(log.goTos, ['voice']);
      await leave(tester);
    });

    testWidgets('editing the tagline saves it; a refusal shows under the field', (tester) async {
      var refuse = true;
      api.on('PUT', '/api/hosts/me/generated', (_) {
        if (refuse) {
          throw const ApiError(status: 422, code: 'invalid_field', field: 'tagline', message: 'Please do not put contact details here.');
        }
        return <String, Object?>{'host': <String, Object?>{}};
      });
      final log = CtxLog(ready, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));

      await tapKey(tester, 'preview-edit-tagline');
      await typeKey(tester, 'preview-field-tagline', 'Your evening friend');
      await tapKey(tester, 'preview-save');
      expect(find.text('Please do not put contact details here.'), findsOneWidget);
      expect(has('preview-field-tagline'), isTrue);

      refuse = false;
      await tapKey(tester, 'preview-save');
      expect(api.callsTo('PUT', '/api/hosts/me/generated').last.body, {'tagline': 'Your evening friend'});
      expect(has('preview-field-tagline'), isFalse);
      await leave(tester);
    });

    testWidgets('Change something goes back to the review step', (tester) async {
      final log = CtxLog(ready, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));
      await tapKey(tester, 'preview-change');
      expect(log.goTos, ['review']);
      await leave(tester);
    });

    testWidgets('with our team the preview is read-only: a note, no edit links, no submit', (tester) async {
      final log = CtxLog({...ready, 'status': 'pending_review'}, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));
      expect(find.text(PartBCopy.previewLockedPending), findsOneWidget);
      expect(has('preview-submit'), isFalse);
      expect(has('preview-edit-tagline'), isFalse);
      expect(has('preview-edit-aboutPolished'), isFalse);
      expect(api.calls, isEmpty);
      await leave(tester);
    });

    testWidgets('a rejected profile shows the team note and can be sent again', (tester) async {
      final log = CtxLog({...ready, 'status': 'rejected', 'reviewNote': 'Please make the about text simpler.'}, media: media);
      await pumpStep(tester, PreviewStep(ctx: log.ctx));
      expect(find.text(PartBCopy.previewChangesTitle), findsOneWidget);
      expect(find.text('Please make the about text simpler.'), findsOneWidget);
      expect(has('preview-submit'), isTrue);
      await leave(tester);
    });

    testWidgets('the About step cannot be edited while the profile is with our team', (tester) async {
      final log = CtxLog({'status': 'pending_review', 'displayName': 'Neha', 'about': 'I am a good listener and I love old songs.'});
      await pumpStep(tester, AboutStep(ctx: log.ctx));
      expect(has('lock-banner'), isTrue);
      expect(tester.widget<TextField>(find.byKey(const ValueKey<String>('about-name'))).enabled, isFalse);
      expect(tester.widget<TextField>(find.byKey(const ValueKey<String>('about-text'))).enabled, isFalse);
      await leave(tester);
    });

    testWidgets('the Sent for review page', (tester) async {
      final log = CtxLog({...ready, 'status': 'pending_review'});
      await pumpStep(tester, DoneStep(ctx: log.ctx));
      expect(find.text(PartBCopy.doneTitle), findsOneWidget);
      expect(find.text(PartBCopy.nextOnline), findsOneWidget);
      expect(has('done-dashboard'), isTrue);

      final live = CtxLog({...ready, 'status': 'live'});
      await pumpStep(tester, DoneStep(ctx: live.ctx));
      expect(find.text(PartBCopy.liveTitle), findsOneWidget);
    });
  });
}
