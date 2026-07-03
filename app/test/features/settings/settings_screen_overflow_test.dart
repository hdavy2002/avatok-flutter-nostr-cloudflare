// RESPUI-6: overflow regression gate for the Settings screen.
//
// This screen received the same responsive-layout treatment as
// sign_in_screen.dart (SafeArea + resizeToAvoidBottomInset + ZineBreakpoints
// page padding). These tests pin the same two device profiles used for the
// sign-in screen (see sign_in_screen_overflow_test.dart) that previously
// would have triggered a RenderFlex overflow ("A RenderFlex overflowed by
// ... pixels"):
//
//   - 320x568 logical @ textScale 2.0  (small iPhone SE-class width, OS
//     accessibility scale maxed out)
//   - 360x640 logical @ textScale 1.3  (Android "small" width threshold,
//     moderate accessibility scale)
//
// `tester.takeException()` after pumping surfaces any FlutterError thrown
// during layout/paint, including RenderFlex overflow assertions, so this
// fails loudly in CI on a regression without needing golden images.
//
// SettingsScreen's initState() kicks off BrainConsent.pull() and
// _refreshAi() (AvaAiStore.isConnected/googleEmail), both of which only touch
// FlutterSecureStorage (wrapped in try/catch, never throws synchronously) and
// best-effort network calls awaited inside async methods — nothing here can
// throw synchronously during the first build, so this can be pumped directly
// like sign_in_screen_overflow_test.dart, with no mocking.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/auth/clerk_client.dart';
import 'package:avatok_call/features/settings/settings_screen.dart';

Future<void> _pumpSettings(
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
        home: SettingsScreen(
          clerk: ClerkClient(),
          onSignOut: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'settings screen renders without RenderFlex overflow at 320x568 @ textScale 2.0',
    (tester) async {
      await _pumpSettings(
        tester,
        logicalSize: const Size(320, 568),
        textScale: 2.0,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(SettingsScreen), findsOneWidget);
    },
  );

  testWidgets(
    'settings screen renders without RenderFlex overflow at 360x640 @ textScale 1.3',
    (tester) async {
      await _pumpSettings(
        tester,
        logicalSize: const Size(360, 640),
        textScale: 1.3,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(SettingsScreen), findsOneWidget);
    },
  );
}
