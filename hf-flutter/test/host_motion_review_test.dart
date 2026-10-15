// HF-MOTION-D: behaviour tests and review captures for the host side (onboarding incl. part B, dashboard,
// bookings, identity KYC, lanes, Me). Captures are written only in the CI check run
// (--dart-define=EXPORT_DESIGN_REVIEW=true) to test_output/design_review/host-motion-*.png.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/bookings/ui/customer_booking_screen.dart';
import 'package:hf_app/features/bookings/ui/customer_bookings_screen.dart';
import 'package:hf_app/features/host_dashboard/host_dashboard_providers.dart';
import 'package:hf_app/features/host_dashboard/ui/host_dashboard_screen.dart';
import 'package:hf_app/features/host_dashboard/ui/money_count_up.dart';
import 'package:hf_app/features/host_dashboard/ui/presence_card.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_context.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_steps.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/voice_audio.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/done_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/generating_step.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/glow_orb.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/voice_recorder_panel.dart';
import 'package:hf_app/features/host_onboarding/part_b/ui/voice_step.dart';
import 'package:hf_app/features/host_onboarding/ui/host_onboarding_screen.dart';
import 'package:hf_app/features/host_onboarding/ui/steps/onboarding_copy.dart';
import 'package:hf_app/features/host_onboarding/ui/steps/phone_step.dart';
import 'package:hf_app/features/host_onboarding/ui/widgets/beaver_tip.dart';
import 'package:hf_app/features/host_onboarding/ui/widgets/step_page.dart';
import 'package:hf_app/features/host_profile/ui/widgets/net_image.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:hf_app/features/kyc/ui/identity_kyc_screen.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'features/host_dashboard/host_dashboard_support.dart' as dash;
import 'support/app_harness.dart';
import 'support/fake_api_client.dart';
import 'support/kyc_fakes.dart';

const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');
const _captureKey = ValueKey<String>('host-capture');
const _sizes = <Size>[Size(320, 640), Size(425, 916)];

Future<void> _loadFonts() async {
  final icons = FontLoader('MaterialIcons')
    ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
  await icons.load();
  for (final family in ['Nunito', 'Comfortaa']) {
    final loader = FontLoader(family);
    final weights = family == 'Nunito'
        ? ['Regular', 'SemiBold', 'Bold', 'ExtraBold']
        : ['Regular', 'Medium', 'Bold'];
    for (final weight in weights) {
      loader.addFont(rootBundle.load('assets/fonts/$family-$weight.ttf'));
    }
    await loader.load();
  }
}

Future<void> _settle(WidgetTester tester, [int frames = 12]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

String _label(Size size) => '${size.width.toInt()}x${size.height.toInt()}';

Future<void> _capture(WidgetTester tester, String name) async {
  expect(tester.takeException(), isNull, reason: name);
  if (!_export) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_captureKey),
  );
  await tester.runAsync(() async {
    final pixels = await boundary.toImage(pixelRatio: 1);
    try {
      final bytes = await pixels.toByteData(format: ui.ImageByteFormat.png);
      if (bytes == null) throw StateError('PNG capture failed');
      final folder = Directory('test_output/design_review');
      await folder.create(recursive: true);
      await File(
        '${folder.path}/$name.png',
      ).writeAsBytes(bytes.buffer.asUint8List());
    } finally {
      pixels.dispose();
    }
  });
}

void _view(WidgetTester tester, Size size, {double scale = 1, bool reduced = true}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  if (reduced) {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  }
}

Widget _avatarImage(BuildContext context, String url, {BoxFit fit = BoxFit.cover}) =>
    const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [HfColors.lavender, HfColors.blush]),
      ),
      child: Center(
        child: Icon(Icons.face_3_rounded, size: 72, color: HfColors.deepOrange),
      ),
    );

/// Pumps [screen] in the app theme inside the capture boundary, signed in, with a fake API.
Future<void> _pump(
  WidgetTester tester,
  Widget screen, {
  FakeApiClient? api,
  List<Override> overrides = const <Override>[],
  SessionState? session,
}) async {
  final s = session ?? signedInState(host: true);
  AccountScope.id = s.me?.uid ?? s.user?.id;
  await tester.pumpWidget(
    ProviderScope(
      key: UniqueKey(),
      overrides: <Override>[
        sessionProvider.overrideWith(() => StubSession(s)),
        apiClientProvider.overrideWithValue(api ?? FakeApiClient()),
        secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
        hostImageBuilderProvider.overrideWithValue(_avatarImage),
        ...overrides,
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildHfTheme(),
        home: RepaintBoundary(key: _captureKey, child: screen),
      ),
    ),
  );
  await _settle(tester);
}

/// Decodes the beaver poses (still or animated) so captures show the mascot.
Future<void> _precacheBeaver(WidgetTester tester, {bool animated = false}) async {
  final context = tester.element(find.byKey(_captureKey));
  if (!animated) {
    await tester.runAsync(() async {
      for (final pose in BeaverPose.values) {
        await precacheImage(AssetImage(pose.stillAsset), context);
      }
    });
    await tester.pump();
    return;
  }
  // An animated image hands out its first frame from a scheduler frame callback, so awaiting it inside
  // runAsync (where no frames are pumped) never completes. Start the decodes, then alternate real-time
  // waits with frames, bounded so a missing asset can never hang the test.
  var pending = BeaverPose.values.length;
  await tester.runAsync(() async {
    for (final pose in BeaverPose.values) {
      unawaited(
        precacheImage(
          AssetImage(pose.animatedAsset),
          context,
        ).whenComplete(() => pending--),
      );
    }
  });
  for (var i = 0; i < 60 && pending > 0; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  await tester.pump();
}

/// Unmounts the screen so poll and heartbeat timers stop before the test ends.
Future<void> _leave(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 50));
}

OnboardingStepContext _ctx(
  Map<String, Object?>? host, {
  Map<String, Object?>? phone,
}) {
  final state = OnboardingServerState.fromJson(
    <String, dynamic>{
      'host': host,
      'kyc': <String, Object?>{},
      'media': <Object?>[],
      'job': null,
    },
    phone: phone == null ? null : Map<String, dynamic>.from(phone),
  );
  return OnboardingStepContext(
    state: state,
    next: () async {},
    goTo: (_) {},
    refresh: () async => state,
  );
}

class _SilentRecorder implements VoiceRecorder {
  @override
  Stream<double> get levels => const Stream<double>.empty();
  @override
  Future<void> start() async {}
  @override
  Future<VoiceClip> stop() async => VoiceClip(
    bytes: Uint8List(2048),
    path: '/tmp/hf_motion_intro.m4a',
    mime: 'audio/mp4',
    seconds: 40,
  );
  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
}

List<Override> get _mic => <Override>[
  permissionServiceProvider.overrideWithValue(
    FakePermissionService(granted: {HfPermission.mic}),
  ),
  voiceRecorderFactoryProvider.overrideWithValue(_SilentRecorder.new),
];

Map<String, Object?> _kycStatus({bool aadhaar = true, String selfie = 'none'}) => {
  'aadhaar': {
    'done': aadhaar,
    if (aadhaar) 'last4': '4321',
    if (aadhaar) 'gender': 'F',
  },
  'selfie': {'status': selfie},
  'payout': const {'done': false},
};

Map<String, Object?> _laneIn() => {
  'whatsappVerified': true,
  'aadhaarVerified': true,
  'gender': 'F',
  'lanes': {
    'women': {'eligible': true, 'granted': true},
    'lgbtq': {'declared': false, 'granted': false, 'selfieStatus': 'none'},
  },
};

FakeApiClient _generatingApi() => FakeApiClient()
  ..onJson('GET', '/api/hosts/generate/status', {
    'status': 'running',
    'stages': {'text': 'done', 'images': 'working', 'safety': 'waiting'},
  });

Future<void> _pumpDashboard(WidgetTester tester) async {
  final api = dash.hostApi(presence: 'online');
  final container = ProviderContainer(
    retry: (_, __) => null,
    overrides: [
      sessionProvider.overrideWith(() => StubSession(signedInState(host: true))),
      apiClientProvider.overrideWithValue(api),
      flagsProvider.overrideWith(
        (_) => HfFlags.fromJson({
          'hfStdPlan': {'enabled': true},
        }),
      ),
      presenceBeatIntervalProvider.overrideWithValue(const Duration(minutes: 5)),
      dashboardClockProvider.overrideWithValue(() => dash.pinnedNow),
    ],
  );
  addTearDown(container.dispose);
  final router = GoRouter(
    routes: [GoRoute(path: '/', builder: (_, __) => const HostDashboardScreen())],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: buildHfTheme(),
        routerConfig: router,
        builder: (context, child) =>
            RepaintBoundary(key: _captureKey, child: child),
      ),
    ),
  );
  await _settle(tester, 20);
}

Future<void> _pumpCalendar(WidgetTester tester) async {
  final api = FakeApiClient()..onJson('GET', '/api/hf/bookings', {'bookings': []});
  await _pump(
    tester,
    const CustomerBookingsScreen(),
    api: api,
    session: const SessionState(
      status: SessionStatus.signedIn,
      user: ClerkUser(id: 'calendar-user'),
    ),
    overrides: <Override>[
      flagsProvider.overrideWith(
        (ref) async => HfFlags.fromJson({'hfBookingsEnabled': true}),
      ),
    ],
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    LinkOpener.instance = FakeLinkOpener();
  });
  tearDown(() {
    AccountScope.id = null;
    LinkOpener.instance = const LinkOpener();
  });

  group('onboarding', () {
    test('the beaver tip is the first sentence of the step lead', () {
      expect(
        tipFromLead('Say hello in your own voice. About a minute is perfect.'),
        'Say hello in your own voice.',
      );
      expect(tipFromLead('One line only'), 'One line only');
      expect(tipFromLead(null), isNull);
      expect(tipFromLead('   '), isNull);
    });

    testWidgets('one beaver points with the tip, gives a brief thumbs up when the step is done', (
      tester,
    ) async {
      _view(tester, const Size(425, 916));
      Widget page(bool done) => OnboardingStepPage(
        title: 'Title',
        lead: OnboardingCopy.payoutLead,
        celebrate: done,
        children: const [SizedBox(height: 40)],
      );
      await _pump(tester, Scaffold(body: page(false)));
      expect(find.byType(BeaverGuide), findsOneWidget);
      BeaverPose pose() => tester.widget<BeaverGuide>(find.byType(BeaverGuide)).pose;
      expect(pose(), BeaverPose.point);
      expect(
        tester.widget<BeaverGuide>(find.byType(BeaverGuide)).message,
        'We check the account is in your own name.',
      );
      expect(find.byType(HfCluster), findsNothing);

      await _pump(tester, Scaffold(body: page(true)));
      expect(pose(), BeaverPose.thumbs);
      await tester.pump(OnboardingBeaverTip.thumbsFor);
      await tester.pump();
      expect(pose(), BeaverPose.point);
      await _leave(tester);
    });

    testWidgets('the progress ribbon grows with the step', (tester) async {
      _view(tester, const Size(320, 640));
      await _pump(
        tester,
        const Scaffold(
          body: Padding(
            padding: EdgeInsets.all(16),
            child: ProgressRibbon(value: 0.4, track: HfColors.segmentTrack),
          ),
        ),
      );
      final bar = tester.widget<FractionallySizedBox>(
        find.descendant(
          of: find.byKey(const ValueKey<String>('onboarding-ribbon')),
          matching: find.byType(FractionallySizedBox),
        ),
      );
      expect(bar.widthFactor, closeTo(0.4, 1e-9));
    });

    testWidgets('a new step slides and fades in; reduced motion shows it at once', (
      tester,
    ) async {
      _view(tester, const Size(425, 916), reduced: false);
      await tester.pumpWidget(
        const MaterialApp(home: StepEntrance(forward: true, child: Text('step'))),
      );
      double opacity() => tester
          .widget<FadeTransition>(
            find.descendant(
              of: find.byType(StepEntrance),
              matching: find.byType(FadeTransition),
            ),
          )
          .opacity
          .value;
      expect(opacity(), lessThan(0.5));
      await tester.pump(const Duration(milliseconds: 400));
      expect(opacity(), 1);
    });

    testWidgets('voice bars follow the recorder level', (tester) async {
      _view(tester, const Size(425, 916));
      await _pump(tester, const Scaffold(body: Center(child: VoiceBars(level: 0))));
      final bars = find.descendant(
        of: find.byKey(const ValueKey<String>('voice-bars')),
        matching: find.byType(AnimatedContainer),
      );
      expect(bars, findsNWidgets(9));
      expect(tester.getSize(bars.at(4)).height, 8);
      await _pump(tester, const Scaffold(body: Center(child: VoiceBars(level: 1))));
      expect(tester.getSize(bars.at(4)).height, 56);
      expect(tester.getSize(bars.at(0)).height, lessThan(56));
    });

    testWidgets('the glow orb swirls while working and resolves into the avatar', (
      tester,
    ) async {
      _view(tester, const Size(425, 916), reduced: false);
      await _pump(tester, const Scaffold(body: Center(child: GlowOrb())));
      double t() => (tester
              .widget<CustomPaint>(
                find.descendant(
                  of: find.byKey(const ValueKey<String>('gen-orb')),
                  matching: find.byType(CustomPaint),
                ),
              )
              .painter! as OrbPainter)
          .t;
      final first = t();
      await tester.pump(const Duration(milliseconds: 500));
      expect(t(), isNot(first));
      expect(find.byKey(const ValueKey<String>('gen-orb-avatar')), findsNothing);
      await _leave(tester);

      _view(tester, const Size(425, 916));
      await _pump(
        tester,
        const Scaffold(
          body: Center(child: GlowOrb(resolved: true, child: SizedBox.expand())),
        ),
      );
      expect(find.byKey(const ValueKey<String>('gen-orb-avatar')), findsOneWidget);
      expect(find.byType(HfLottie), findsNothing, reason: 'no sparkle with reduced motion');
    });

    testWidgets('generating follows the job with the orb; the ready state shows the avatar and a happy beaver', (
      tester,
    ) async {
      _view(tester, const Size(425, 916));
      await _pump(
        tester,
        Scaffold(body: GeneratingStep(ctx: _ctx({'status': 'generating', 'genAttempts': 1}))),
        api: _generatingApi(),
      );
      expect(find.byKey(const ValueKey<String>('gen-orb')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('gen-stage-images-working')), findsOneWidget);
      await _leave(tester);

      await _pump(
        tester,
        Scaffold(
          body: GeneratingStep(
            ctx: _ctx({
              'status': 'pending_host',
              'genAttempts': 1,
              'avatarUrl': 'https://media.example.test/a.webp',
            }),
          ),
        ),
      );
      expect(find.byKey(const ValueKey<String>('gen-orb-avatar')), findsOneWidget);
      expect(
        tester.widget<BeaverGuide>(find.byType(BeaverGuide)).pose,
        BeaverPose.happy,
      );
      await _leave(tester);
    });

    testWidgets('the done step is the warm moment: yellow page, celebrating beaver, confetti', (
      tester,
    ) async {
      _view(tester, const Size(425, 916), reduced: false);
      await _pump(
        tester,
        Scaffold(body: DoneStep(ctx: _ctx({'status': 'pending_review'}))),
      );
      expect(find.byKey(const ValueKey<String>('onboarding-warm')), findsOneWidget);
      expect(find.byType(BeaverGuide), findsOneWidget);
      expect(
        tester.widget<BeaverGuide>(find.byType(BeaverGuide)).pose,
        BeaverPose.celebrate,
      );
      expect(find.byType(ConfettiBurst), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 2000));
      await _leave(tester);
    });
  });

  group('dashboard', () {
    test('money count-up reads back only exact server amounts', () {
      expect(MoneyCountUp.paiseOf('₹1,200.50'), 120050);
      expect(MoneyCountUp.paiseOf('₹0.00'), 0);
      expect(MoneyCountUp.paiseOf('about ₹12'), isNull);
      expect(MoneyCountUp.paiseOf(''), isNull);
    });

    testWidgets('money counts up and lands on the server text', (tester) async {
      _view(tester, const Size(425, 916), reduced: false);
      const amount = ValueKey<String>('amount');
      await _pump(
        tester,
        const Scaffold(body: Center(child: MoneyCountUp('₹1,200.50', textKey: amount))),
      );
      expect(tester.widget<Text>(find.byKey(amount)).data, isNot('₹1,200.50'));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('₹1,200.50'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(amount)).data, '₹1,200.50');
      await _pump(tester, const Scaffold(body: Center(child: MoneyCountUp('soon'))));
      expect(find.text('soon'), findsOneWidget);
    });

    testWidgets('online is a sunrise; offline a sunset', (tester) async {
      _view(tester, const Size(425, 916));
      double sun() => tester
          .widget<AnimatedOpacity>(find.byKey(const ValueKey<String>('presence-sun')))
          .opacity;
      await _pump(tester, const SunriseSurface(risen: true, child: Text('x')));
      expect(sun(), 1);
      await _pump(tester, const SunriseSurface(risen: false, child: Text('x')));
      expect(sun(), 0);
    });

    testWidgets('an online host sees the heartbeat dot; the heartbeat still beats', (
      tester,
    ) async {
      final api = dash.hostApi(presence: 'online');
      await dash.pumpDashboard(tester, api: api);
      expect(dash.key('presence-pulse'), findsOneWidget);
      expect(dash.beats(api), greaterThanOrEqualTo(1));
    });
  });

  group('bookings', () {
    testWidgets('the selected-day indicator slides to the tapped day', (tester) async {
      _view(tester, const Size(425, 916));
      await _pumpCalendar(tester);
      final indicator = find.byKey(const ValueKey<String>('calendar-selected-indicator'));
      expect(indicator, findsOneWidget);
      final today = DateTime.now().day;
      final other = today == 15 ? 16 : 15;
      await tester.ensureVisible(find.text('$other').first);
      await tester.pump();
      final moved = tester.getTopLeft(indicator);
      await tester.tap(find.text('$other').first);
      await _settle(tester);
      expect(tester.getTopLeft(indicator), isNot(moved));
    });

    testWidgets('a confirmed booking gets a drawn tick with confetti', (tester) async {
      _view(tester, const Size(425, 916), reduced: false);
      await _pump(tester, const Scaffold(body: Center(child: BookingConfirmedMark())));
      expect(find.byType(DrawnCheck), findsOneWidget);
      expect(find.byType(ConfettiBurst), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
    });
  });

  group('identity and lanes', () {
    testWidgets('the step line never fills the approval segment before the server approves', (
      tester,
    ) async {
      _view(tester, const Size(425, 916));
      await _pump(
        tester,
        const IdentityKycScreen(),
        api: FakeApiClient()
          ..onJson('GET', '/api/hosts/kyc/status', _kycStatus(selfie: 'pending')),
      );
      expect(find.byKey(const ValueKey<String>('kyc-node-0-done')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-node-1-done')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-node-2-todo')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-review-wait')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-approved-badge')), findsNothing);
      await _leave(tester);

      await _pump(
        tester,
        const IdentityKycScreen(),
        api: FakeApiClient()
          ..onJson('GET', '/api/hosts/kyc/status', _kycStatus(selfie: 'rejected')),
      );
      expect(find.byKey(const ValueKey<String>('kyc-node-1-todo')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-node-2-todo')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-approved-badge')), findsNothing);
      await _leave(tester);

      await _pump(
        tester,
        const IdentityKycScreen(),
        api: FakeApiClient()
          ..onJson('GET', '/api/hosts/kyc/status', _kycStatus(selfie: 'approved')),
      );
      expect(find.byKey(const ValueKey<String>('kyc-node-2-done')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-approved-badge')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('kyc-review-wait')), findsNothing);
      await _leave(tester);
    });

    testWidgets("you're in: a calm glow and a pop, no confetti, no beaver", (tester) async {
      _view(tester, const Size(425, 916), reduced: false);
      await _pump(
        tester,
        const LanesScreen(lane: 'women'),
        api: FakeApiClient()..onJson('GET', '/api/hf/lanes/me', _laneIn()),
      );
      await _settle(tester, 20);
      expect(find.byKey(const ValueKey<String>('lane-in')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('lane-in-glow')), findsOneWidget);
      expect(find.byType(ConfettiBurst), findsNothing);
      expect(find.byType(BeaverGuide), findsNothing);
      // The glow is finite: two breaths, then it rests.
      await tester.pump(const Duration(seconds: 5));
      await _leave(tester);
    });
  });

  // Review captures (and 2x text layout checks) for each screen at 320x640 and 425x916.
  for (final size in _sizes) {
    for (final scale in const [1.0, 2.0]) {
      final label = _label(size);
      final suffix = scale == 1 ? label : '$label-2x';
      final shoot = scale == 1;

      testWidgets('onboarding step $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          Scaffold(
            body: SafeArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: ProgressRibbon(value: 3 / 15, track: HfColors.segmentTrack),
                  ),
                  Expanded(
                    child: PhoneStep(
                      ctx: _ctx(
                        {'status': 'draft'},
                        phone: {'verified': true, 'phone': '+91 98765 41234'},
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
        await _precacheBeaver(tester);
        if (shoot) await _capture(tester, 'host-motion-onboarding-step-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('voice step $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          Scaffold(body: VoiceStep(ctx: _ctx({'status': 'draft'}))),
          overrides: _mic,
        );
        await _precacheBeaver(tester);
        if (shoot) await _capture(tester, 'host-motion-voice-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('avatar generating $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          Scaffold(body: GeneratingStep(ctx: _ctx({'status': 'generating', 'genAttempts': 1}))),
          api: _generatingApi(),
        );
        await _precacheBeaver(tester);
        if (shoot) await _capture(tester, 'host-motion-generating-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
        await _pump(
          tester,
          Scaffold(
            body: GeneratingStep(
              ctx: _ctx({
                'status': 'pending_host',
                'genAttempts': 1,
                'avatarUrl': 'https://media.example.test/a.webp',
              }),
            ),
          ),
        );
        await _precacheBeaver(tester);
        if (shoot) await _capture(tester, 'host-motion-avatar-ready-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('done $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          Scaffold(body: DoneStep(ctx: _ctx({'status': 'pending_review'}))),
        );
        await _precacheBeaver(tester);
        if (shoot) await _capture(tester, 'host-motion-done-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('dashboard online $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pumpDashboard(tester);
        expect(find.byKey(const ValueKey<String>('presence-pulse')), findsOneWidget);
        if (shoot) await _capture(tester, 'host-motion-dashboard-online-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('bookings $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pumpCalendar(tester);
        if (shoot) await _capture(tester, 'host-motion-bookings-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets('identity KYC $suffix', (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          const IdentityKycScreen(),
          api: FakeApiClient()
            ..onJson('GET', '/api/hosts/kyc/status', _kycStatus(selfie: 'pending')),
        );
        if (shoot) await _capture(tester, 'host-motion-kyc-review-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
        await _pump(
          tester,
          const IdentityKycScreen(),
          api: FakeApiClient()
            ..onJson('GET', '/api/hosts/kyc/status', _kycStatus(selfie: 'approved')),
        );
        if (shoot) await _capture(tester, 'host-motion-kyc-approved-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });

      testWidgets("lanes you're in $suffix", (tester) async {
        _view(tester, size, scale: scale);
        await _pump(
          tester,
          const LanesScreen(lane: 'women'),
          api: FakeApiClient()..onJson('GET', '/api/hf/lanes/me', _laneIn()),
        );
        if (shoot) await _capture(tester, 'host-motion-lanes-in-$label');
        expect(tester.takeException(), isNull);
        await _leave(tester);
      });
    }
  }

  // Two "live" frames with animation on: the swirling orb and the confetti on the done step.
  testWidgets('live frames 425x916', (tester) async {
    _view(tester, const Size(425, 916), reduced: false);
    await _pump(
      tester,
      Scaffold(body: GeneratingStep(ctx: _ctx({'status': 'generating', 'genAttempts': 1}))),
      api: _generatingApi(),
    );
    await _precacheBeaver(tester, animated: true);
    await tester.pump(const Duration(milliseconds: 900));
    await _capture(tester, 'host-motion-generating-live-425x916');
    await _leave(tester);

    await _pump(
      tester,
      Scaffold(body: DoneStep(ctx: _ctx({'status': 'pending_review'}))),
    );
    await _precacheBeaver(tester, animated: true);
    await _capture(tester, 'host-motion-done-live-425x916');
    await tester.pump(const Duration(seconds: 2));
    await _leave(tester);
    imageCache.clear();
    imageCache.clearLiveImages();
  });
}
