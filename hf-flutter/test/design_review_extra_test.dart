// Extra review captures: dark mode and the demo host card/profile/booking sheet.
// Opt-in like design_review_test.dart (EXPORT_DESIGN_REVIEW).
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'features/explore/explore_test_support.dart';

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
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byType(RepaintBoundary).first,
  );
  await tester.runAsync(() async {
    final pixels = await boundary.toImage(pixelRatio: 1);
    try {
      final bytes = await pixels.toByteData(format: ui.ImageByteFormat.png);
      final folder = Directory('test_output/design_review');
      await folder.create(recursive: true);
      await File(
        '${folder.path}/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      pixels.dispose();
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final label = mode.name;
    testWidgets('demo discover $label', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(
        tester,
        api: api,
        location: '/',
        size: const Size(412, 1400),
        demoHosts: true,
        themeMode: mode,
      );
      expect(tester.takeException(), isNull);
      await _capture(tester, 'demo-discover-$label');
    });
    testWidgets('demo profile $label', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(
        tester,
        api: api,
        location: '/h/demo-neha',
        size: const Size(412, 2400),
        demoHosts: true,
        themeMode: mode,
        settle: false,
      );
      expect(tester.takeException(), isNull);
      await _capture(tester, 'demo-profile-$label');
    });
    testWidgets('demo call sheet $label', (tester) async {
      final api = fakeApi()..onJson('GET', '/api/hf/hosts', pageJson([]));
      await pumpScreen(
        tester,
        api: api,
        location: '/h/demo-neha',
        size: const Size(412, 915),
        demoHosts: true,
        themeMode: mode,
        settle: false,
      );
      final call = find.textContaining('Call Neha');
      if (call.evaluate().isNotEmpty) {
        await tester.tap(call.first);
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 300));
        }
      }
      expect(tester.takeException(), isNull);
      await _capture(tester, 'demo-callsheet-$label');
    });
  }
}
