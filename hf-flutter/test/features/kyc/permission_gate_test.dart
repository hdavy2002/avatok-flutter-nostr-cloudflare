import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/strings.dart';
import 'package:hf_app/features/kyc/kyc.dart';

import '../../support/kyc_fakes.dart';

void main() {
  late TelemetryLog log;

  setUp(() => log = TelemetryLog()..install());
  tearDown(() => log.remove());

  Future<void> pump(WidgetTester tester, FakePermissionService perms, {List<HfPermission>? which, VoidCallback? onSkip}) =>
      pumpWidgetUnderTest(
        tester,
        PermissionGate(
          permissions: which ?? const [HfPermission.mic],
          icon: Icons.mic_rounded,
          title: 'Microphone',
          body: 'We need your microphone for your voice.',
          onSkip: onSkip,
          child: const Text('inside', key: ValueKey<String>('gate-child')),
        ),
        overrides: [permissionServiceProvider.overrideWithValue(perms)],
      ).then((_) {});

  Future<void> tapText(WidgetTester tester, String text) async {
    await tester.tap(find.text(text));
    await settle(tester);
  }

  testWidgets('already allowed: no explainer, child shows, no prompt, no event', (tester) async {
    final perms = FakePermissionService(granted: {HfPermission.mic});
    await pump(tester, perms);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsOneWidget);
    expect(perms.requested, isEmpty);
    expect(log.events, isEmpty);
  });

  testWidgets('explainer first, the prompt only after Continue, then granted', (tester) async {
    final perms = FakePermissionService();
    await pump(tester, perms);
    expect(find.text('We need your microphone for your voice.'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsNothing);
    expect(perms.requested, isEmpty);

    await tapText(tester, Strings.continueLabel);
    expect(perms.requested, [HfPermission.mic]);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsOneWidget);
    expect(log.named('hf_app_permission').single, {'kind': 'mic', 'result': 'granted'});
  });

  testWidgets('denied: explainer turns into Open settings; settings opens; coming back allowed shows the child', (tester) async {
    final perms = FakePermissionService(requestResults: {HfPermission.mic: HfPermissionResult.permanentlyDenied});
    await pump(tester, perms);
    await tapText(tester, Strings.continueLabel);

    expect(find.text(Strings.openSettings), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsNothing);
    expect(log.named('hf_app_permission').single, {'kind': 'mic', 'result': 'denied'});

    await tapText(tester, Strings.openSettings);
    expect(perms.settingsOpened, 1);

    // The person turned it on in settings, then came back to the app.
    perms.granted.add(HfPermission.mic);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await settle(tester);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsOneWidget);
  });

  testWidgets('coming back from settings still denied: stays on Open settings', (tester) async {
    final perms = FakePermissionService(requestResults: {HfPermission.mic: HfPermissionResult.denied});
    await pump(tester, perms);
    await tapText(tester, Strings.continueLabel);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await settle(tester);
    expect(find.text(Strings.openSettings), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('gate-child')), findsNothing);
  });

  testWidgets('two permissions: camera granted, mic denied stops at the denied screen', (tester) async {
    final perms = FakePermissionService(requestResults: {HfPermission.mic: HfPermissionResult.denied});
    await pump(tester, perms, which: const [HfPermission.camera, HfPermission.mic]);
    await tapText(tester, Strings.continueLabel);
    expect(perms.requested, [HfPermission.camera, HfPermission.mic]);
    expect(log.named('hf_app_permission').map((e) => '${e['kind']}:${e['result']}'), ['camera:granted', 'mic:denied']);
    expect(find.text(Strings.openSettings), findsOneWidget);
  });

  testWidgets('a prompt that fails is logged as error and shown as denied', (tester) async {
    final perms = FakePermissionService(throwOnRequest: true);
    await pump(tester, perms);
    await tapText(tester, Strings.continueLabel);
    expect(log.named('hf_app_permission').single, {'kind': 'mic', 'result': 'error'});
    expect(find.text(Strings.openSettings), findsOneWidget);
  });

  testWidgets('Not now calls onSkip', (tester) async {
    var skipped = 0;
    await pump(tester, FakePermissionService(), onSkip: () => skipped += 1);
    await tapText(tester, Strings.notNow);
    expect(skipped, 1);
  });
}
