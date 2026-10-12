import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/auth/ui/auth_visuals.dart';

void main() {
  testWidgets('captures every exact auth state at the 425x916 design size', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    await tester.binding.setSurfaceSize(const Size(425, 916));
    addTearDown(() async {
      await tester.binding.setSurfaceSize(null);
      tester.view.resetDevicePixelRatio();
    });

    final byteCounts = <AuthVisualState, int>{};
    for (final state in AuthVisualState.values) {
      final boundaryKey = ValueKey<String>('capture-boundary-${state.name}');
      await tester.pumpWidget(
        MaterialApp(
          theme: buildHfTheme(),
          home: RepaintBoundary(
            key: boundaryKey,
            child: AuthVisualCaptureFrame(state: state),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(ValueKey('auth-capture-${state.name}')), findsOneWidget);
      expect(tester.takeException(), isNull, reason: '${state.name} overflowed');

      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(boundaryKey),
      );
      final image = await boundary.toImage(pixelRatio: 1);
      expect(image.width, 425, reason: state.name);
      expect(image.height, 916, reason: state.name);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      expect(png, isNotNull, reason: state.name);
      byteCounts[state] = png!.lengthInBytes;
      image.dispose();
    }

    expect(byteCounts.length, AuthVisualState.values.length);
    for (final entry in byteCounts.entries) {
      expect(entry.value, greaterThan(10000), reason: '${entry.key.name} capture');
    }
  });
}
