// HF-MOTION-A review captures: the animated onboarding (splash, intro, sign-in, OTP success, Welcome) in
// its resting state. Reduced motion is on, so every motion-kit widget shows its FINAL frame and the PNGs are
// stable. Files land in test_output/design_review/onboarding-*.png when EXPORT_DESIGN_REVIEW is set (CI).
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/pending_intent.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/auth/ui/auth_visuals.dart';
import 'package:hf_app/features/intro/ui/intro_screen.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';
import 'package:hf_app/features/splash/ui/splash_screen.dart';
import 'package:hf_app/features/welcome/ui/welcome_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_api_client.dart';
import 'support/fake_clerk.dart';

const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');
const _boundary = ValueKey<String>('onboarding-review-boundary');

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

Future<void> _capture(WidgetTester tester, String name) async {
  if (!_export) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_boundary),
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

/// Decodes [assets] for real (outside the fake clock) so the capture shows them.
Future<void> _precache(WidgetTester tester, List<String> assets) async {
  final context = tester.element(find.byKey(_boundary));
  await tester.runAsync(() async {
    for (final asset in assets) {
      await precacheImage(AssetImage(asset), context, onError: (_, _) {});
    }
  });
  await tester.pump();
}

Future<void> _frames(WidgetTester tester, [int n = 10]) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

/// Rest: reduced motion on, phone [size] at 1x.
void _setUp(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

/// A store whose writes never finish, so the sign-in success state stays on screen for its capture.
class _StallingStore extends MemoryKeyValueStore {
  @override
  Future<void> write(String key, String value) => Completer<void>().future;
}

Future<void> _pumpRouted(
  WidgetTester tester,
  GoRouter router, {
  FakeApiClient? api,
  KeyValueStore? pendingStore,
}) async {
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        appRouterProvider.overrideWithValue(router),
        apiClientProvider.overrideWithValue(api ?? FakeApiClient()),
        clerkProvider.overrideWithValue(FakeClerk()),
        secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
        if (pendingStore != null)
          pendingIntentProvider.overrideWithValue(
            PendingIntentStore(pendingStore),
          ),
      ],
      child: MaterialApp.router(
        theme: buildHfTheme(),
        routerConfig: router,
        builder: (context, child) =>
            RepaintBoundary(key: _boundary, child: child),
      ),
    ),
  );
  await _frames(tester);
}

FakeApiClient _signInApi() => FakeApiClient()
  ..onJson('POST', '/api/auth/whatsapp/send', {
    'ok': true,
    'phone_masked': '+91 ******3210',
    'expires_in_s': 600,
    'resend_after_s': 30,
  })
  ..onJson('POST', '/api/auth/whatsapp/verify', {
    'ok': true,
    'status': 'signed_in',
    'ticket': 'tkt-1',
    'isNew': false,
    'needs18Plus': false,
  })
  ..onJson('GET', '/api/hf/me', {
    'uid': 'user_test',
    'ackVersion': '2026-10-10',
    'displayName': 'Asha',
  })
  ..onJson('POST', '/api/hf/me/ack', {'ok': true});

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await _frames(tester, 4);
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      180,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await _frames(tester, 4);
  await tester.tap(finder);
  await _frames(tester);
}

Future<void> _scrollToTop(WidgetTester tester) async {
  final scrollable = find.byType(Scrollable);
  if (scrollable.evaluate().isEmpty) return;
  tester.state<ScrollableState>(scrollable.first).position.jumpTo(0);
  await tester.pump();
}

const _logo = kLogoAsset;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  tearDown(() => AccountScope.id = null);

  for (final size in [const Size(320, 640), const Size(425, 916)]) {
    final label = '${size.width.toInt()}x${size.height.toInt()}';

    testWidgets('onboarding splash $label', (tester) async {
      _setUp(tester, size);
      // Boot never finishes here, so the splash stays up for its picture.
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appBootProvider.overrideWith((ref) => Completer<void>().future),
          ],
          child: MaterialApp(
            theme: buildHfTheme(),
            home: const RepaintBoundary(key: _boundary, child: SplashScreen()),
          ),
        ),
      );
      await _precache(tester, [_logo, BeaverPose.wave.stillAsset]);
      await _frames(tester);
      expect(tester.takeException(), isNull);
      expect(find.byType(BeaverGuide), findsOneWidget);
      await _capture(tester, 'onboarding-splash-$label');
    });

    testWidgets('onboarding intro pages 1 and 3 $label', (tester) async {
      _setUp(tester, size);
      final router = GoRouter(
        initialLocation: Routes.intro,
        routes: [
          GoRoute(path: Routes.intro, builder: (_, _) => const IntroScreen()),
        ],
      );
      await _pumpRouted(tester, router);
      await _precache(tester, [
        'assets/images/intro/find-person.webp',
        'assets/images/intro/explore-freely.webp',
        BeaverPose.wave.stillAsset,
        BeaverPose.thumbs.stillAsset,
      ]);
      expect(tester.takeException(), isNull);
      expect(find.text('Page 1 of 3'), findsOneWidget);
      await _capture(tester, 'onboarding-intro-1-$label');
      for (var i = 0; i < 2; i++) {
        await _tapVisible(tester, find.byKey(const ValueKey('intro-next')));
      }
      await _scrollToTop(tester);
      await _frames(tester);
      expect(tester.takeException(), isNull);
      expect(find.text('Page 3 of 3'), findsOneWidget);
      await _capture(tester, 'onboarding-intro-3-$label');
    });

    testWidgets('onboarding sign-in and OTP success $label', (tester) async {
      _setUp(tester, size);
      final router = GoRouter(
        initialLocation: '/sign-in',
        routes: [
          GoRoute(
            path: '/sign-in',
            builder: (_, _) => const SignInScreen(next: '/me'),
          ),
          GoRoute(
            path: '/me',
            builder: (_, _) => const Scaffold(body: Text('AFTER PAGE')),
          ),
        ],
      );
      await _pumpRouted(
        tester,
        router,
        api: _signInApi(),
        pendingStore: _StallingStore(),
      );
      await _precache(tester, [
        BeaverPose.idle.stillAsset,
        BeaverPose.thumbs.stillAsset,
        'assets/images/auth/whatsapp-otp.webp',
      ]);
      expect(tester.takeException(), isNull);
      expect(find.text('Welcome back.'), findsOneWidget);
      await _capture(tester, 'onboarding-signin-$label');

      await _tapVisible(tester, find.text('WhatsApp'));
      final phone = find.byKey(const ValueKey<String>('signin-phone'));
      await tester.ensureVisible(phone);
      await tester.enterText(phone, '9876543210');
      await _frames(tester, 4);
      await _tapVisible(tester, find.text('Send WhatsApp code'));
      final code = find.byKey(const ValueKey<String>('signin-code'));
      expect(code, findsOneWidget);
      await tester.ensureVisible(code);
      await tester.enterText(code, '123456');
      await _frames(tester, 12);
      expect(find.byKey(AuthSuccessBurst.burstKey), findsOneWidget);
      expect(
        tester.widget<BeaverGuide>(find.byKey(AuthGuide.guideKey)).pose,
        BeaverPose.thumbs,
      );
      await _scrollToTop(tester);
      expect(tester.takeException(), isNull);
      await _capture(tester, 'onboarding-otp-success-$label');
    });

    testWidgets('onboarding welcome all ticked $label', (tester) async {
      _setUp(tester, size);
      final router = GoRouter(
        initialLocation: '/welcome',
        routes: [
          GoRoute(path: '/welcome', builder: (_, _) => const WelcomeScreen()),
        ],
      );
      await _pumpRouted(tester, router);
      await _precache(tester, [
        BeaverPose.namaste.stillAsset,
        BeaverPose.celebrate.stillAsset,
      ]);
      await _tapVisible(
        tester,
        find.byKey(const ValueKey<String>('welcome-tick')),
      );
      await _scrollToTop(tester);
      await _frames(tester);
      expect(tester.takeException(), isNull);
      expect(
        tester
            .widget<BeaverGuide>(
              find.byKey(const ValueKey<String>('welcome-beaver')),
            )
            .pose,
        BeaverPose.celebrate,
      );
      await _capture(tester, 'onboarding-welcome-ticked-$label');
    });
  }
}
