import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/host_profile/ui/widgets/net_image.dart';
import 'package:hf_app/features/notifications/ui/notifications_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'features/explore/explore_test_support.dart';
import 'support/app_harness.dart';
import 'support/fake_api_client.dart';

/// HF-MOTION-B review captures (browse, host profile, notifications, state panels). Opt-in: PNGs are written
/// only with `--dart-define=EXPORT_DESIGN_REVIEW=true` (the CI check run uploads them). Animations are off
/// (reduced motion) so every capture shows the resting, final frame.
const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');

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
  final candidates = find.byType(RepaintBoundary);
  final boundary = tester.renderObject<RenderRepaintBoundary>(candidates.first);
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

void _setSize(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void _reduceMotion(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

void _textScale(WidgetTester tester, double scale) {
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

/// Decodes the still beaver poses so the capture is not blank where the mascot sits.
Future<void> _precacheBeavers(WidgetTester tester, Finder within) async {
  final context = tester.element(within);
  await tester.runAsync(() async {
    for (final pose in [BeaverPose.sleepy, BeaverPose.oops]) {
      await precacheImage(AssetImage(pose.stillAsset), context);
    }
  });
  await tester.pump();
}

Map<String, Object?> _profile() => {
  'slug': 'asha',
  'protectedLane': null,
  'displayName': 'Asha',
  'tagline': 'A warm listener',
  'avatarUrl': null,
  'imageProvenance': 'ai',
  'languages': ['Hindi', 'English'],
  'style': 'calm',
  'topics': ['naye-dost', 'tension'],
  'pricePerMin': 12,
  'rating': 4.6,
  'reviewCount': 5,
  'ratingBreakdown': {'5': 3, '4': 2, '3': 0, '2': 0, '1': 0},
  'talkedTo': 40,
  'regulars': 6,
  'lgbtqFriendly': false,
  'womenOnly': false,
  'introAudioUrl': 'https://media.example.test/intro.m4a',
  'introSeconds': 20,
  'status': 'online',
  'aboutPolished': 'I like a calm chat about everyday life.',
  'quote': 'Baat se baat banti hai.',
  'gallery': <Object?>[],
  'reviews': <Object?>[],
};

Future<void> _pumpProfile(WidgetTester tester, Size size) async {
  final api = FakeApiClient()
    ..onJson('GET', '/api/hosts/public/asha', _profile())
    ..onJson('GET', '/api/hf/options', {
      'topics': [
        {'slug': 'naye-dost', 'label': 'Naye dost', 'group': 'naye-dost'},
        {'slug': 'tension', 'label': 'Tension', 'group': 'tension'},
      ],
    })
    ..onJson('GET', '/api/hf/hosts/asha/notify', {'subscribed': false});
  final container = ProviderContainer(
    overrides: [
      sessionProvider.overrideWith(() => StubSession(signedOutState())),
      apiClientProvider.overrideWithValue(api),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      initialLocationProvider.overrideWithValue('/h/asha'),
      hostImageBuilderProvider.overrideWithValue(
        (context, url, {BoxFit fit = BoxFit.cover}) => const SizedBox(),
      ),
    ],
  );
  addTearDown(container.dispose);
  _setSize(tester, size);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const HfApp(listenForLinks: false),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pumpAlone(WidgetTester tester, Size size, Widget child) async {
  _setSize(tester, size);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sessionProvider.overrideWith(() => StubSession(signedInState())),
        apiClientProvider.overrideWithValue(
          FakeApiClient()
            ..onJson('GET', '/api/notifications', {'items': <Object?>[]})
            ..onJson('GET', '/api/notifications/unread', {'unread': 0}),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildHfTheme(),
        home: child,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final size in const [Size(320, 640), Size(425, 916)]) {
    for (final scale in const [1.0, 2.0]) {
      final label = '${size.width.toInt()}x${size.height.toInt()}';
      final tag = scale == 1 ? label : '$label-2x';
      final shoot = scale == 1;

      testWidgets('explore list $tag', (tester) async {
        _textScale(tester, scale);
        final api = fakeApi()
          ..onJson(
            'GET',
            '/api/hf/hosts',
            pageJson([
              hostJson('neha', name: 'Neha'),
              hostJson('rohan', name: 'Rohan', status: 'busy'),
              hostJson('meera', name: 'Meera'),
            ]),
          );
        await pumpScreen(
          tester,
          api: api,
          location: '/',
          size: size,
          liveSections: true,
        );
        expect(tester.takeException(), isNull);
        if (shoot) await _capture(tester, 'browse-motion-explore-$label');
      });

      testWidgets('host profile $tag', (tester) async {
        _reduceMotion(tester);
        _textScale(tester, scale);
        await _pumpProfile(tester, size);
        expect(tester.takeException(), isNull);
        expect(find.text('Call Asha'), findsOneWidget);
        if (shoot) await _capture(tester, 'browse-motion-profile-$label');
      });

      testWidgets('notifications empty $tag', (tester) async {
        _reduceMotion(tester);
        _textScale(tester, scale);
        await _pumpAlone(tester, size, const NotificationsScreen());
        await _precacheBeavers(tester, find.byType(NotificationsScreen));
        expect(find.byKey(kStatePanelBeaverKey), findsOneWidget);
        expect(tester.takeException(), isNull);
        if (shoot) {
          await _capture(tester, 'browse-motion-notifications-empty-$label');
        }
      });

      for (final (name, panel) in <(String, Widget)>[
        ('loading', const LoadingPanel(message: 'Finding people…')),
        (
          'empty',
          EmptyPanel(
            message: 'No hosts match these filters. Try fewer filters.',
            actionLabel: 'Clear filters',
            onAction: () {},
          ),
        ),
        (
          'error',
          ErrorPanel(
            error: const ApiError(status: 500, code: 'http_500'),
            onRetry: () {},
          ),
        ),
      ]) {
        testWidgets('state panel $name $tag', (tester) async {
          _reduceMotion(tester);
          _textScale(tester, scale);
          await _pumpAlone(
            tester,
            size,
            Scaffold(backgroundColor: HfColors.page, body: panel),
          );
          await _precacheBeavers(tester, find.byType(Scaffold));
          expect(tester.takeException(), isNull);
          if (shoot) await _capture(tester, 'browse-motion-panel-$name-$label');
        });
      }
    }
  }
}
