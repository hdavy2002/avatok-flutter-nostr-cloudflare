// RESPUI-6: overflow regression gate for the Profile Setup screen.
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
// ProfileSetupScreen's constructor takes a nullable `identity`; its
// initState() explicitly handles the null case (falls back to
// `IdentityStore().load()`, which only touches FlutterSecureStorage wrapped
// in try/catch and never throws synchronously — see identity.dart's
// `IdentityStore.load()`). initState also awaits `ProfileStore().load()` and
// `AvaNumber.me()`, both async/best-effort over FlutterSecureStorage + HTTP,
// never throwing synchronously during the first build. So this can be pumped
// directly (identity: null) like sign_in_screen_overflow_test.dart, with no
// mocking.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/profile/profile_setup_screen.dart';

Future<void> _pumpProfileSetup(
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
        home: ProfileSetupScreen(
          identity: null,
          onDone: () {},
          onSignOut: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'profile setup screen renders without RenderFlex overflow at 320x568 @ textScale 2.0',
    (tester) async {
      await _pumpProfileSetup(
        tester,
        logicalSize: const Size(320, 568),
        textScale: 2.0,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(ProfileSetupScreen), findsOneWidget);
    },
  );

  testWidgets(
    'profile setup screen renders without RenderFlex overflow at 360x640 @ textScale 1.3',
    (tester) async {
      await _pumpProfileSetup(
        tester,
        logicalSize: const Size(360, 640),
        textScale: 1.3,
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(ProfileSetupScreen), findsOneWidget);
    },
  );
}
