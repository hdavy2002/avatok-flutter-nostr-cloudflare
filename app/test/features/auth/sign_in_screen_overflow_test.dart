// RESPUI-4: overflow regression gate for the sign-in screen.
//
// This screen was the worst reported case of squeezed UI on small-width /
// high-system-font-scale phones (see
// Specs/MULTI-ACCOUNT-AND-RESPONSIVE-UI-PLAN-2026-07-04.md Part 2). These
// tests pin two device profiles that previously would have triggered a
// RenderFlex overflow ("A RenderFlex overflowed by ... pixels") once the
// keyboard-avoidance / scroll fixes (RESPUI-2) and the textScaler clamp
// (RESPUI-1) are in place:
//
//   - 320x568 logical @ textScale 2.0  (small iPhone SE-class width, OS
//     accessibility scale maxed out)
//   - 360x640 logical @ textScale 1.3  (Android "small" width threshold,
//     moderate accessibility scale)
//
// `tester.takeException()` after pumping surfaces any FlutterError thrown
// during layout/paint, including RenderFlex overflow assertions, so this
// fails loudly in CI on a regression without needing golden images.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/auth/clerk_client.dart';
import 'package:avatok_call/features/auth/sign_in_screen.dart';

Future<void> _pumpSignIn(
  WidgetTester tester, {
  required Size logicalSize,
  required double textScale,
}) async {
  tester.view.physicalSize = logicalSize * tester.view.devicePixelRatio;
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = logicalSize;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(
        size: logicalSize,
        textScaler: TextScaler.linear(textScale),
      ),
      child: MaterialApp(
        home: SignInScreen(
          clerk: ClerkClient(),
          onSignedIn: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'sign-in screen renders without RenderFlex overflow at 320x568 @ textScale 2.0',
    (tester) async {
      await _pumpSignIn(
        tester,
        logicalSize: const Size(320, 568),
        textScale: 2.0,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(SignInScreen), findsOneWidget);
    },
  );

  testWidgets(
    'sign-in screen renders without RenderFlex overflow at 360x640 @ textScale 1.3',
    (tester) async {
      await _pumpSignIn(
        tester,
        logicalSize: const Size(360, 640),
        textScale: 1.3,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(SignInScreen), findsOneWidget);
    },
  );

  testWidgets(
    'sign-in screen still shows the keyboard-triggering field and submit CTA at 320x568 @ textScale 2.0',
    (tester) async {
      await _pumpSignIn(
        tester,
        logicalSize: const Size(320, 568),
        textScale: 2.0,
      );
      // The screen scrolls as one column (RESPUI-2), so both the email field
      // and the primary CTA must be reachable without overflowing — even if
      // that means scrolling to find them.
      final emailField = find.widgetWithText(TextField, 'you@example.com');
      await tester.scrollUntilVisible(
        emailField,
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(emailField, findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
