import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/core/format/money.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';
import 'package:hf_app/features/call/data/call_models.dart';
import 'package:hf_app/features/call/ui/call_live_view.dart';
import 'package:hf_app/features/call/ui/call_summary.dart';
import 'package:hf_app/features/wallet/billing/billing_adapter.dart';

import 'features/call/call_harness.dart';
import 'features/explore/explore_test_support.dart';
import 'features/wallet/wallet_support.dart';
import 'support/fake_billing.dart';
import 'support/fake_api_client.dart';

/// Review captures are opt-in and generated only in the authorized CI runtime.
/// No checked-in bitmap is treated as proof that an unexecuted layout passed.
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
}

FakeApiClient _callReferenceApi() => FakeApiClient()
  ..onJson('GET', '/api/config', {'hfCallsEnabled': true})
  ..onJson('GET', '/api/hosts/public/asha', {
    'slug': 'asha',
    'displayName': 'Asha Verma',
    'topics': ['stress', 'career'],
  })
  ..onJson('GET', '/api/hf/options', {
    'topics': [
      {'slug': 'stress', 'label': 'Tension'},
      {'slug': 'career', 'label': 'Career'},
    ],
  })
  ..onJson('GET', '/api/hf/wallet/estimate', {
    'mode': 'tokens',
    'ratePerMinRupees': 3.99,
    'aboutText': 'about 42 min',
    'affordableSeconds': 2520,
    'canStart': true,
    'hasDebt': false,
    'balance': '168.34',
    'plan': 'standard',
    'priceTiers': [
      {'fromMin': 0, 'toMin': 30, 'paisePerMin': 399},
      {'fromMin': 30, 'toMin': 60, 'paisePerMin': 350},
      {'fromMin': 60, 'paisePerMin': 325},
    ],
  });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final size in [
    const Size(320, 640),
    const Size(425, 916),
  ]) {
    for (final scale in [1.0, 2.0]) {
      final label = '${size.width.toInt()}x${size.height.toInt()}-${scale}x';
      testWidgets('guest marketplace layout $label', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final api = fakeApi()
          ..onJson(
            'GET',
            '/api/hf/hosts',
            pageJson([
              hostJson(
                'neha',
                name: 'Neha',
                intro: 'https://media.example.test/intro.m4a',
              ),
              hostJson('rohan', name: 'Rohan', status: 'busy'),
            ]),
          );
        await pumpScreen(tester, api: api, location: '/', size: size);
        expect(tester.takeException(), isNull);
        await _capture(tester, 'browse-$label');
        if (size == const Size(425, 916) && scale == 1) {
          await tester.scrollUntilVisible(
            find.text('Communities'),
            320,
            scrollable: find.byType(Scrollable).first,
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
          await _capture(tester, 'browse-communities-425x916');
          await tester.scrollUntilVisible(
            find.text('Services for you'),
            240,
            scrollable: find.byType(Scrollable).first,
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
          await _capture(tester, 'browse-services-425x916');
        }
      });
      for (final dark in [false, true]) {
        final walletLabel = dark ? '$label-dark' : label;
        testWidgets('wallet layout $walletLabel', (tester) async {
          tester.platformDispatcher.textScaleFactorTestValue = scale;
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          tester.platformDispatcher.accessibilityFeaturesTestValue =
              const FakeAccessibilityFeatures(disableAnimations: true);
          addTearDown(
            tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
          );
          final api = walletApi()
            ..onJson('GET', '/api/hf/tokens/products', {
              'ok': true,
              'enabled': true,
              'gstBps': 1800,
              'products': [
                {
                  'productId': 'hf_rupees_120',
                  'pricePaise': 12000,
                  'gstPaise': 1831,
                  'walletPaise': 10169,
                  'creditPaise': 10169,
                },
                {
                  'productId': 'hf_rupees_240',
                  'pricePaise': 24000,
                  'gstPaise': 3661,
                  'walletPaise': 20339,
                  'creditPaise': 20339,
                },
                {
                  'productId': 'hf_rupees_360',
                  'pricePaise': 36000,
                  'gstPaise': 5492,
                  'walletPaise': 30508,
                  'creditPaise': 30508,
                },
                {
                  'productId': 'hf_rupees_500',
                  'pricePaise': 50000,
                  'gstPaise': 7627,
                  'walletPaise': 42373,
                  'creditPaise': 42373,
                },
              ],
            });
          await pumpWallet(
            tester,
            api: api,
            dark: dark,
            billing: FakeBillingAdapter(
              products: const {
                'hf_rupees_120': StoreProduct(
                  productId: 'hf_rupees_120',
                  priceText: '₹120.00',
                  currencyCode: 'INR',
                  priceMicros: 120000000,
                ),
                'hf_rupees_240': StoreProduct(
                  productId: 'hf_rupees_240',
                  priceText: '₹240.00',
                  currencyCode: 'INR',
                  priceMicros: 240000000,
                ),
                'hf_rupees_360': StoreProduct(
                  productId: 'hf_rupees_360',
                  priceText: '₹360.00',
                  currencyCode: 'INR',
                  priceMicros: 360000000,
                ),
                'hf_rupees_500': StoreProduct(
                  productId: 'hf_rupees_500',
                  priceText: '₹500.00',
                  currencyCode: 'INR',
                  priceMicros: 500000000,
                ),
              },
            ),
          );
          _setSize(tester, size);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await _capture(tester, 'wallet-$walletLabel');
        });
      }
      for (final kind in HfClusterKind.values) {
        testWidgets('decorative scene ${kind.name} $label', (tester) async {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          await tester.pumpWidget(
            MaterialApp(
              theme: buildHfTheme(),
              home: MediaQuery(
                data: MediaQueryData(
                  size: size,
                  textScaler: TextScaler.linear(scale),
                  disableAnimations: true,
                ),
                child: Scaffold(
                  body: SafeArea(
                    child: ListView(
                      padding: const EdgeInsets.all(20),
                      children: [
                        HfCluster(kind: kind, chipText: '+91 •••• 1727'),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await _capture(tester, 'scene-${kind.name}-$label');
        });
      }
    }
  }

  // HF-MOTION-1: the motion kit's resting state (reduced motion shows the final frame of everything),
  // so the owner can see the beaver guide, bubble, sun hill and brand mark together.
  for (final size in [const Size(320, 640), const Size(425, 916)]) {
    final label = '${size.width.toInt()}x${size.height.toInt()}';
    testWidgets('motion kit scene $label', (tester) async {
      _setSize(tester, size);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: buildHfTheme(),
          home: Scaffold(
            body: SunHill(
              riseTo: 0.36,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(HfSpacing.pageWide),
                  child: Column(
                    children: [
                      const HfBrandMark(size: 72, showWordmark: true),
                      const Spacer(),
                      const BeaverGuide(
                        pose: BeaverPose.wave,
                        size: 190,
                        message:
                            'Namaste! I am your guide. Let me show you around.',
                      ),
                      const SizedBox(height: HfSpacing.section),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                        children: [
                          const DrawnCheck(size: 56),
                          const HfLoader(),
                          const PulseDot(size: 12),
                          CountUpText(
                            value: 5187,
                            formatter: (v) => Money.paise(v.round()),
                            style: HfText.stat,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      final context = tester.element(find.byType(Scaffold));
      await tester.runAsync(() async {
        await precacheImage(AssetImage(BeaverPose.wave.stillAsset), context);
        await precacheImage(const AssetImage(kLogoAsset), context);
      });
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      await _capture(tester, 'motion-kit-$label');
    });
  }

  const referenceSize = Size(425, 916);

  testWidgets('call confirmation reference 425x916', (tester) async {
    prepareStorage();
    _setSize(tester, referenceSize);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await pumpCallApp(
      tester,
      api: _callReferenceApi(),
      location: '/call/new?host=asha',
    );
    _setSize(tester, referenceSize);
    await tester.pump();
    expect(tester.takeException(), isNull);
    await _capture(tester, 'call-confirm-425x916');
    await closeApp(tester);
  });

  testWidgets('connected call reference 425x916', (tester) async {
    _setSize(tester, referenceSize);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(
      tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
    );
    final info = CallInfo.fromJson({
      'id': 'c1',
      'status': 'connected',
      'hostSlug': 'asha',
      'hostName': 'Asha Verma',
      'plan': 'standard',
      'rate': 3.99,
      'rateTiers': [
        {'fromMin': 0, 'toMin': 30, 'paisePerMin': 399},
        {'fromMin': 30, 'toMin': 60, 'paisePerMin': 350},
        {'fromMin': 60, 'paisePerMin': 325},
      ],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: buildHfTheme(),
        home: Scaffold(
          body: SafeArea(
            child: SingleChildScrollView(
              child: CallLiveView(
                info: info,
                elapsedSeconds: 724,
                currentRatePaise: 399,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await _capture(tester, 'call-live-425x916');
  });

  testWidgets('call summary reference 425x916', (tester) async {
    _setSize(tester, referenceSize);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final info = CallInfo.fromJson({
      'id': 'c1',
      'status': 'completed',
      'hostSlug': 'asha',
      'hostName': 'Asha Verma',
      'plan': 'standard',
      'billableSeconds': 724,
      'billedMinutes': 13,
      'chargedPaise': 5187,
      'charged': '₹51.87',
      'canReview': true,
      'tiers': [
        {
          'fromMin': 0,
          'toMin': 30,
          'paisePerMin': 399,
          'seconds': 724,
          'amountPaise': 5187,
        },
      ],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: buildHfTheme(),
        home: Scaffold(
          body: SafeArea(
            child: ListView(
              padding: const EdgeInsets.all(HfSpacing.pageWide),
              children: [
                CallSummary(
                  info: info,
                  cancelledByMe: false,
                  onRate: () {},
                  onDone: () {},
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await _capture(tester, 'call-summary-425x916');
  });

  testWidgets('review form and thanks references 425x916', (tester) async {
    prepareStorage();
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(
      tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
    );
    final api = _callReferenceApi()
      ..onJson('GET', '/api/hf/calls/c1', {
        'id': 'c1',
        'status': 'completed',
        'hostSlug': 'asha',
        'hostName': 'Asha Verma',
        'billableSeconds': 724,
        'billedMinutes': 13,
        'chargedPaise': 5187,
        'canReview': true,
      })
      ..onJson('POST', '/api/hf/calls/c1/review', {'ok': true});
    await pumpCallApp(tester, api: api, location: '/review/call/c1');
    _setSize(tester, referenceSize);
    await tester.pump();
    expect(tester.takeException(), isNull);
    await _capture(tester, 'review-form-425x916');

    await tester.tap(find.byIcon(Icons.star_outline_rounded).at(4));
    await tester.pump();
    await tester.scrollUntilVisible(
      find.text('Send review'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Send review'));
    await tester.pump();
    await tester.pump();
    await tester.ensureVisible(find.text('Your review was sent'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    await _capture(tester, 'review-thanks-425x916');
    await closeApp(tester);
  });
}
