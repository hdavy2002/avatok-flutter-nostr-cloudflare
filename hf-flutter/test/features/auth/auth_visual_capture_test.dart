import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/auth/data/identity_api.dart';
import 'package:hf_app/features/auth/ui/complete_profile_screen.dart';
import 'package:hf_app/features/auth/ui/sign_in_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';

const _designSize = Size(425, 916);
const _export =
    bool.fromEnvironment('EXPORT_DESIGN_REVIEW') ||
    String.fromEnvironment('EXPORT_DESIGN_REVIEW') == '1';
const _phoneKey = ValueKey<String>('signin-phone');
const _sendPath = '/api/auth/whatsapp/send';

enum _AuthCaptureState {
  login,
  whatsappLogin,
  secondWhatsapp,
  whatsappOtp,
  email,
  emailOtp,
  name,
  username,
  kyc,
  policies,
}

class _FakeEmailClerk extends FakeClerk implements ClerkEmailApi {
  @override
  Future<EmailChallenge> startEmailCode(String email) async =>
      const EmailChallenge('design-review-email');

  @override
  Future<ClerkStep> verifyEmailCode(
    EmailChallenge challenge,
    String code,
  ) async => ClerkStep.complete(const ClerkUser(id: 'user_test'));
}

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

Future<void> _settle(WidgetTester tester, [int frames = 8]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

Future<void> _pumpScreen(
  WidgetTester tester, {
  required Widget screen,
  required FakeApiClient api,
  required Key boundaryKey,
  ClerkApi? clerk,
  SessionState? session,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      // Each independent screen has its own API/session overrides and state.
      key: boundaryKey,
      overrides: [
        apiClientProvider.overrideWithValue(api),
        clerkProvider.overrideWithValue(clerk ?? _FakeEmailClerk()),
        secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
        if (session != null)
          sessionProvider.overrideWith(() => StubSession(session)),
      ],
      child: MaterialApp(
        theme: buildHfTheme(),
        home: RepaintBoundary(key: boundaryKey, child: screen),
      ),
    ),
  );
  await _settle(tester);
}

Future<void> _tapVisible(WidgetTester tester, Finder finder) async {
  // Finish the text field's pending caret scroll before revealing the action.
  FocusManager.instance.primaryFocus?.unfocus();
  await _settle(tester);
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await _settle(tester);
  expect(finder.hitTestable(), findsOneWidget);
  await tester.tap(finder);
  await _settle(tester);
}

Future<void> _scrollToTop(WidgetTester tester) async {
  final scrollable = find.byType(Scrollable).first;
  tester.state<ScrollableState>(scrollable).position.jumpTo(0);
  await tester.pump();
}

FakeApiClient _signInApi() => FakeApiClient()
  ..onJson('POST', _sendPath, {
    'ok': true,
    'phone_masked': '+91 ******3210',
    'expires_in_s': 600,
    'resend_after_s': 30,
  });

Map<String, Object?> _registrationDraft(int step) {
  final emailCodeSent = step == 3;
  final normalizedStep = emailCodeSent ? 3 : step;
  return {
    'uid': 'user_test',
    'step': normalizedStep,
    'registrationComplete': false,
    'firstName': step >= 5 ? 'Asha' : '',
    'lastName': step >= 5 ? 'Rao' : '',
    'username': step >= 6 ? 'asha.rao' : '',
    'kycNow': step >= 7 ? false : null,
    'policies': {
      for (final name in IdentityApi.policies) name: {'version': '$name-v1'},
    },
    'acceptedPolicyVersions': <String, String>{},
    if (emailCodeSent)
      'emailChallenge': {
        'email': 'asha@example.test',
        'expiresAt': 4102444800000,
      },
  };
}

FakeApiClient _registrationApi(int step) => FakeApiClient()
  ..onJson('GET', '/api/hf/me/registration', _registrationDraft(step));

Future<int> _capture(
  WidgetTester tester,
  _AuthCaptureState state,
  Key boundaryKey,
) async {
  final captureBoundary = find.byWidgetPredicate(
    (widget) => widget is RepaintBoundary && widget.key == boundaryKey,
    description: '${state.name} capture boundary',
  );
  expect(captureBoundary, findsOneWidget);
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    captureBoundary,
  );
  // Rasterization and PNG encoding complete on the engine's real async queue.
  // Awaiting them in the widget test's fake clock can hang without another pump.
  final byteCount = await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      expect(image.width, _designSize.width, reason: state.name);
      expect(image.height, _designSize.height, reason: state.name);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      expect(data, isNotNull, reason: state.name);
      final bytes = data!.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      if (_export) {
        final folder = Directory('test_output/design_review');
        await folder.create(recursive: true);
        await File(
          '${folder.path}/auth-${state.name}.png',
        ).writeAsBytes(bytes);
      }
      return bytes.length;
    } finally {
      image.dispose();
    }
  });
  expect(byteCount, isNotNull, reason: '${state.name} rasterization');
  return byteCount!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() => AccountScope.id = null);

  testWidgets('captures every live auth state at the 425x916 design size', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = _designSize;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(
      tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
    );

    final byteCounts = <_AuthCaptureState, int>{};

    Future<void> record(
      _AuthCaptureState state,
      Widget screen,
      FakeApiClient api, {
      SessionState? session,
    }) async {
      final key = ValueKey<String>('auth-live-${state.name}');
      await _pumpScreen(
        tester,
        screen: screen,
        api: api,
        boundaryKey: key,
        session: session,
      );
      await _scrollToTop(tester);
      expect(find.byType(CompleteProfileScreen), findsOneWidget);
      expect(tester.takeException(), isNull, reason: '${state.name} overflowed');
      byteCounts[state] = await _capture(tester, state, key);
    }

    AccountScope.id = null;
    var api = _signInApi();
    var key = const ValueKey<String>('auth-live-login');
    await _pumpScreen(
      tester,
      screen: const SignInScreen(),
      api: api,
      boundaryKey: key,
    );
    expect(find.byType(SignInScreen), findsOneWidget);
    expect(find.text('Welcome back.'), findsOneWidget);
    expect(find.byKey(const ValueKey('identity-email')), findsOneWidget);
    expect(find.byKey(_phoneKey), findsNothing);
    byteCounts[_AuthCaptureState.login] = await _capture(
      tester,
      _AuthCaptureState.login,
      key,
    );

    await _tapVisible(tester, find.text('WhatsApp'));
    await _scrollToTop(tester);
    expect(find.byKey(const ValueKey('identity-email')), findsNothing);
    expect(find.byKey(_phoneKey), findsOneWidget);
    byteCounts[_AuthCaptureState.whatsappLogin] = await _capture(
      tester,
      _AuthCaptureState.whatsappLogin,
      key,
    );

    api = _signInApi();
    key = const ValueKey<String>('auth-live-secondWhatsapp');
    await _pumpScreen(
      tester,
      screen: const SignInScreen(secondNumber: true),
      api: api,
      boundaryKey: key,
    );
    expect(find.text('Add your second WhatsApp number'), findsOneWidget);
    byteCounts[_AuthCaptureState.secondWhatsapp] = await _capture(
      tester,
      _AuthCaptureState.secondWhatsapp,
      key,
    );

    await tester.enterText(find.byKey(_phoneKey), '9876543210');
    await _tapVisible(
      tester,
      find.byKey(const ValueKey<String>('signin-age-tick')),
    );
    await _tapVisible(tester, find.text(SignInCopy.sendCode));
    await _scrollToTop(tester);
    expect(find.text('Verify WhatsApp'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('signin-code')), findsOneWidget);
    byteCounts[_AuthCaptureState.whatsappOtp] = await _capture(
      tester,
      _AuthCaptureState.whatsappOtp,
      key,
    );

    AccountScope.id = 'user_test';
    final signedIn = signedInState();
    await record(
      _AuthCaptureState.email,
      const CompleteProfileScreen(),
      _registrationApi(2),
      session: signedIn,
    );
    expect(find.byKey(const ValueKey('identity-email')), findsOneWidget);

    await record(
      _AuthCaptureState.emailOtp,
      const CompleteProfileScreen(),
      _registrationApi(3),
      session: signedIn,
    );
    expect(find.byKey(const ValueKey('identity-email-code')), findsOneWidget);

    await record(
      _AuthCaptureState.name,
      const CompleteProfileScreen(),
      _registrationApi(4),
      session: signedIn,
    );
    expect(find.byKey(const ValueKey('registration-first-name')), findsOneWidget);

    await record(
      _AuthCaptureState.username,
      const CompleteProfileScreen(),
      _registrationApi(5),
      session: signedIn,
    );
    expect(find.byKey(const ValueKey('registration-username')), findsOneWidget);

    await record(
      _AuthCaptureState.kyc,
      const CompleteProfileScreen(),
      _registrationApi(6),
      session: signedIn,
    );
    expect(find.text('Do KYC now'), findsOneWidget);

    await record(
      _AuthCaptureState.policies,
      const CompleteProfileScreen(),
      _registrationApi(7),
      session: signedIn,
    );
    expect(find.byKey(const ValueKey('registration-create')), findsOneWidget);

    expect(byteCounts.length, _AuthCaptureState.values.length);
    for (final entry in byteCounts.entries) {
      expect(
        entry.value,
        greaterThan(10000),
        reason: '${entry.key.name} capture',
      );
    }

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
