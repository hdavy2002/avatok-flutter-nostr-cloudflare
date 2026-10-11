import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/widgets/widgets.dart';

import 'features/explore/explore_test_support.dart';
import 'features/wallet/wallet_support.dart';
import 'support/fake_billing.dart';

/// Review captures are opt-in and generated only in the authorized CI runtime.
/// No checked-in bitmap is treated as proof that an unexecuted layout passed.
const _export = bool.fromEnvironment('EXPORT_DESIGN_REVIEW');

Future<void> _loadFonts() async {
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
  final pixels = await boundary.toImage(pixelRatio: 1);
  try {
    final bytes = await pixels.toByteData(format: ui.ImageByteFormat.png);
    if (bytes == null) throw StateError('PNG capture failed');
    final folder = Directory('test_output/design_review');
    await folder.create(recursive: true);
    await File('${folder.path}/$name.png').writeAsBytes(bytes.buffer.asUint8List());
  } finally {
    pixels.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final size in [const Size(320, 640), const Size(412, 915)]) {
    for (final scale in [1.0, 2.0]) {
      final label = '${size.width.toInt()}x${size.height.toInt()}-${scale}x';
      testWidgets('guest marketplace layout $label', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final api = fakeApi()
          ..onJson('GET', '/api/hf/hosts', pageJson([
            hostJson('neha', name: 'Neha', intro: 'https://media.example.test/intro.m4a'),
            hostJson('rohan', name: 'Rohan', status: 'busy'),
          ]));
        await pumpScreen(tester, api: api, location: '/', size: size);
        expect(tester.takeException(), isNull);
        await _capture(tester, 'browse-$label');
      });
      testWidgets('wallet layout $label', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
        addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
        await pumpWallet(tester, api: walletApi(), billing: FakeBillingAdapter());
        tester.view.physicalSize = Size(size.width * 3, size.height * 3);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await _capture(tester, 'wallet-$label');
      });
      for (final kind in HfSceneKind.values) {
        testWidgets('decorative scene ${kind.name} $label', (tester) async {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          await tester.pumpWidget(MaterialApp(
            theme: buildHfTheme(),
            home: MediaQuery(
              data: MediaQueryData(size: size, textScaler: TextScaler.linear(scale), disableAnimations: true),
              child: Scaffold(body: SafeArea(child: ListView(
                padding: const EdgeInsets.all(20),
                children: [HfScene(kind: kind, animated: true)],
              ))),
            ),
          ));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await _capture(tester, 'scene-${kind.name}-$label');
        });
      }
    }
  }
}
