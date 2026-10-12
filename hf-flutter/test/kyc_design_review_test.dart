import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:hf_app/features/kyc/ui/identity_kyc_screen.dart';
import 'package:hf_app/features/kyc/ui/selfie_review_player.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/app_harness.dart';
import 'support/fake_api_client.dart';
import 'support/kyc_fakes.dart';

const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');
const _statusPath = '/api/hosts/kyc/status';
const _otpPath = '/api/hosts/kyc/aadhaar/otp';
const _verifyPath = '/api/hosts/kyc/aadhaar/verify';
const _dlStartPath = '/api/hosts/kyc/digilocker/start';
const _dlCompletePath = '/api/hosts/kyc/digilocker/complete';
const _lanesPath = '/api/hf/lanes/me';

Future<void> _settle(WidgetTester tester, [int frames = 12]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

Future<void> _capture(WidgetTester tester, String name) async {
  expect(tester.takeException(), isNull, reason: name);
  if (!_export) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey<String>('kyc-capture')),
  );
  await tester.runAsync(() async {
    final pixels = await boundary.toImage(pixelRatio: 1);
    try {
      final data = await pixels.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) throw StateError('PNG capture failed');
      final folder = Directory('test_output/design_review/kyc');
      await folder.create(recursive: true);
      await File('${folder.path}/$name-425x916.png')
          .writeAsBytes(data.buffer.asUint8List());
    } finally {
      pixels.dispose();
    }
  });
}

Map<String, Object?> _kycStatus({
  bool aadhaar = false,
  String selfie = 'none',
  String? reason,
}) => <String, Object?>{
  'aadhaar': <String, Object?>{
    'done': aadhaar,
    if (aadhaar) 'last4': '4321',
    if (aadhaar) 'gender': 'F',
  },
  'selfie': <String, Object?>{'status': selfie, if (reason != null) 'reason': reason},
  'payout': const <String, Object?>{'done': false},
};

Map<String, Object?> _laneStatus({
  String gender = 'F',
  bool eligible = true,
  bool declared = false,
  bool granted = false,
  String selfie = 'none',
  String? reason,
}) => <String, Object?>{
  'whatsappVerified': true,
  'aadhaarVerified': true,
  'gender': gender,
  'lanes': <String, Object?>{
    'women': <String, Object?>{'eligible': eligible, 'granted': false},
    'lgbtq': <String, Object?>{
      'declared': declared,
      'granted': granted,
      'selfieStatus': selfie,
      if (reason != null) 'selfieReason': reason,
    },
  },
};

Future<ProviderContainer> _pumpProduction(
  WidgetTester tester,
  Widget screen,
  FakeApiClient api, {
  List<Override> overrides = const <Override>[],
}) async {
  final session = signedInState();
  AccountScope.id = session.me!.uid;
  final container = ProviderContainer(overrides: <Override>[
    sessionProvider.overrideWith(() => StubSession(session)),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    ...overrides,
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: buildHfTheme(),
      home: RepaintBoundary(
        key: const ValueKey<String>('kyc-capture'),
        child: screen,
      ),
    ),
  ));
  await _settle(tester);
  return container;
}

Future<void> _pumpIdentity(
  WidgetTester tester,
  FakeApiClient api, {
  List<Override> overrides = const <Override>[],
}) => _pumpProduction(
  tester,
  const IdentityKycScreen(),
  api,
  overrides: overrides,
).then((_) {});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    LinkOpener.instance = FakeLinkOpener();
  });

  tearDown(() {
    AccountScope.id = null;
    LinkOpener.instance = const LinkOpener();
  });

  testWidgets('exports live KYC and DigiLocker pages at 425x916', (tester) async {
    tester.view.physicalSize = const Size(425, 916);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = FakeApiClient()
      ..onJson('GET', _statusPath, _kycStatus())
      ..onJson('POST', _otpPath, const <String, Object?>{'ok': true, 'expires_in_s': 600})
      ..onJson('POST', _verifyPath, const <String, Object?>{
        'ok': true,
        'ageOk': true,
        'last4': '4321',
        'gender': 'F',
      });
    await _pumpIdentity(tester, api);
    await _capture(tester, '01-start-live-page');

    await tapKey(tester, 'kyc-start');
    await _capture(tester, '02-aadhaar-live-page');
    await typeKey(tester, 'aadhaar-number', '123456789012');
    await tapKey(tester, 'aadhaar-consent');
    await tapKey(tester, 'aadhaar-send');
    await _capture(tester, '03-otp-live-page');

    final verifiedApi = FakeApiClient()
      ..onJson('GET', _statusPath, _kycStatus(aadhaar: true));
    await _pumpIdentity(tester, verifiedApi);
    await _capture(tester, '04-aadhaar-done-live-page');

    for (final entry in <(String, String, String?)>[
      ('08-review-pending-live-page', 'pending', null),
      ('09-kyc-complete-live-page', 'approved', null),
      ('10-review-rejected-live-page', 'rejected', 'Use brighter light and keep your face in frame.'),
    ]) {
      final stateApi = FakeApiClient()
        ..onJson('GET', _statusPath,
          _kycStatus(aadhaar: true, selfie: entry.$2, reason: entry.$3));
      await _pumpIdentity(tester, stateApi);
      await _capture(tester, entry.$1);
    }

    final startCompleter = Completer<Object?>();
    final completeCompleter = Completer<Object?>();
    final digiApi = FakeApiClient()
      ..onJson('GET', _statusPath, _kycStatus())
      ..on('POST', _dlStartPath, (_) => startCompleter.future)
      ..on('POST', _dlCompletePath, (_) => completeCompleter.future);
    await _pumpIdentity(tester, digiApi);
    await tapKey(tester, 'kyc-start');
    await tapKey(tester, 'use-digilocker');
    await _capture(tester, '11-digilocker-consent-live-page');
    await tapKey(tester, 'dl-consent');
    await tapKey(tester, 'dl-start');
    await _capture(tester, '12-digilocker-handoff-live-page');
    startCompleter.complete(const <String, Object?>{
      'ok': true,
      'url': 'https://digilocker.example/auth',
    });
    await _settle(tester);
    await _capture(tester, '13-digilocker-waiting-live-page');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await _settle(tester);
    await _capture(tester, '14-digilocker-checking-live-page');
    completeCompleter.complete(const <String, Object?>{
      'ok': false,
      'pending': true,
      'error': 'pending',
      'message': 'Still checking.',
    });
    await _settle(tester);
  });

  testWidgets('exports real selfie widget with camera-only fakes at 425x916', (tester) async {
    tester.view.physicalSize = const Size(425, 916);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = FakeApiClient()
      ..onJson('POST', '/api/hosts/kyc/selfie/code', const <String, Object?>{'code': '482913'});
    final recorder = FakeSelfieRecorder(clip: SelfieClip(
      bytes: Uint8List(64 * 1024),
      mime: 'video/mp4',
      seconds: kSelfieSeconds,
    ));
    await _pumpProduction(
      tester,
      Scaffold(body: SafeArea(child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 32),
        children: [SelfieVideoWidget(onUploaded: () {}, countdownSeconds: 0)],
      ))),
      api,
      overrides: <Override>[
        permissionServiceProvider.overrideWithValue(FakePermissionService(
          granted: <HfPermission>{HfPermission.camera, HfPermission.mic},
        )),
        selfieRecorderFactoryProvider.overrideWithValue(() => recorder),
        selfieReviewBuilderProvider.overrideWithValue((_) => const KycPhoto(
          asset: KycVisualAsset.selfieReview,
          height: 310,
        )),
      ],
    );
    await _capture(tester, '05-selfie-permission-live-widget');
    await tapKey(tester, 'selfie-consent');
    await tapKey(tester, 'selfie-open-camera');
    await _capture(tester, '06-selfie-camera-fake-preview');
    await tapKey(tester, 'camera-start');
    await _capture(tester, '06b-selfie-recording-fake-preview');
    for (var second = 0; second < kSelfieSeconds; second++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await _settle(tester);
    await _capture(tester, '07-selfie-review-live-widget-fake-clip');
  });

  testWidgets('exports live protected-lane outcomes at 425x916', (tester) async {
    tester.view.physicalSize = const Size(425, 916);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final states = <(String, String, Map<String, Object?>)>[
      ('15-lgbtq-declaration-live-page', 'lgbtq', _laneStatus()),
      ('16-lane-review-pending-live-page', 'lgbtq',
        _laneStatus(declared: true, selfie: 'pending')),
      ('17-lane-record-again-live-page', 'lgbtq', _laneStatus(
        declared: true,
        selfie: 'rejected',
        reason: 'Your face was not clear enough.',
      )),
      ('18-lane-approved-live-page', 'lgbtq',
        _laneStatus(declared: true, granted: true, selfie: 'approved')),
      ('19-lane-unavailable-live-page', 'women',
        _laneStatus(gender: 'M', eligible: false)),
    ];
    for (final state in states) {
      final api = FakeApiClient()..onJson('GET', _lanesPath, state.$3);
      await _pumpProduction(tester, LanesScreen(lane: state.$2), api);
      await _capture(tester, state.$1);
    }
  });

  for (final size in <Size>[const Size(320, 640), const Size(768, 1024)]) {
    testWidgets('live KYC start and lane page remain scrollable at $size', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final kycApi = FakeApiClient()..onJson('GET', _statusPath, _kycStatus());
      await _pumpIdentity(tester, kycApi);
      expect(tester.takeException(), isNull);
      final laneApi = FakeApiClient()
        ..onJson('GET', _lanesPath, _laneStatus(declared: true, selfie: 'pending'));
      await _pumpProduction(tester, const LanesScreen(lane: 'lgbtq'), laneApi);
      expect(tester.takeException(), isNull);
    });
  }
}
