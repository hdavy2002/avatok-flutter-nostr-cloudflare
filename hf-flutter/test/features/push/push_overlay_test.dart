import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/features/push/data/push_gateway.dart';
import 'package:hf_app/features/push/data/push_service.dart';
import 'package:hf_app/features/push/ui/push_overlay.dart';
import 'package:hf_app/features/push/ui/push_strings.dart';
import 'package:hf_app/features/push/ui/push_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import 'push_support.dart';

/// The app on a screen with no network calls (the not-found page), so nothing else is loading.
Future<ProviderContainer> pumpPushApp(
  WidgetTester tester, {
  required FakePushGateway gateway,
  required FakeApiClient api,
  bool signedIn = true,
  bool flagOn = true,
  DateTime Function()? clock,
}) async {
  usePhoneScreen(tester);
  final container = ProviderContainer(
    overrides: [
      ...pushOverrides(gateway: gateway, api: api, signedIn: signedIn, flagOn: flagOn, clock: clock),
      initialLocationProvider.overrideWithValue('/somewhere-with-no-screen'),
    ],
    retry: (_, __) => null,
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const HfApp(listenForLinks: false),
  ));
  await settle(tester);
  return container;
}

/// Pump a few frames (no pumpAndSettle: nothing here may spin forever).
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  group('opt-in sheet', () {
    testWidgets('shows once after sign-in with the caller copy and two big buttons', (tester) async {
      final gw = FakePushGateway();
      await pumpPushApp(tester, gateway: gw, api: pushApi());

      expect(find.text(PushStrings.callerTitle), findsOneWidget);
      expect(find.text(PushStrings.allow), findsOneWidget);
      expect(find.text(PushStrings.notNow), findsOneWidget);
      expect(gw.promptCount, 0, reason: 'the Android prompt waits for Allow');
      for (final label in [PushStrings.allow, PushStrings.notNow]) {
        final size = tester.getSize(find.ancestor(of: find.text(label), matching: find.byType(ButtonStyleButton)).first);
        expect(size.height, greaterThanOrEqualTo(48), reason: label);
      }
    });

    testWidgets('a host hears about approval instead', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PushOptInSheet(host: true))));
      expect(find.text(PushStrings.hostTitle), findsOneWidget);
      expect(find.text(PushStrings.callerTitle), findsNothing);
    });

    testWidgets('Not now closes it, never shows the Android prompt, and is remembered', (tester) async {
      final gw = FakePushGateway();
      final c = await pumpPushApp(tester, gateway: gw, api: pushApi());

      await tester.tap(find.text(PushStrings.notNow));
      await settle(tester);

      expect(find.text(PushStrings.callerTitle), findsNothing);
      expect(gw.promptCount, 0);
      final rec = await c.read(pushServiceProvider).readRecord();
      expect(rec, isNotNull);
      expect(rec!.answer.name, 'later');
      expect(await c.read(pushServiceProvider).shouldPrompt(), isFalse);
    });

    testWidgets('Allow runs the Android prompt and registers the token', (tester) async {
      final gw = FakePushGateway();
      final api = pushApi();
      await pumpPushApp(tester, gateway: gw, api: api);

      await tester.tap(find.text(PushStrings.allow));
      await settle(tester);

      expect(gw.promptCount, 1);
      expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
      expect(find.text(PushStrings.callerTitle), findsNothing);
    });

    testWidgets('not shown when signed out', (tester) async {
      await pumpPushApp(tester, gateway: FakePushGateway(), api: pushApi(), signedIn: false);
      expect(find.text(PushStrings.callerTitle), findsNothing);
    });

    testWidgets('not shown while hfPushEnabled is off', (tester) async {
      await pumpPushApp(tester, gateway: FakePushGateway(), api: pushApi(), flagOn: false);
      expect(find.text(PushStrings.callerTitle), findsNothing);
    });

    testWidgets('not shown when notifications are already allowed; the token is registered quietly', (tester) async {
      final api = pushApi();
      final gw = FakePushGateway(current: PushPermission.granted);
      await pumpPushApp(tester, gateway: gw, api: api);

      expect(find.text(PushStrings.callerTitle), findsNothing);
      expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
      expect(gw.promptCount, 0);
    });

    testWidgets('not shown without Firebase (a build with no google-services.json)', (tester) async {
      final api = pushApi();
      await pumpPushApp(tester, gateway: FakePushGateway(isAvailable: false), api: api);
      expect(find.text(PushStrings.callerTitle), findsNothing);
      expect(api.calls, isEmpty);
    });

    testWidgets('after Not now it stays hidden, and comes back after 14 days', (tester) async {
      var now = DateTime.utc(2026, 10, 10);
      final gw = FakePushGateway();
      final c = await pumpPushApp(tester, gateway: gw, api: pushApi(), clock: () => now);
      await tester.tap(find.text(PushStrings.notNow));
      await settle(tester);

      final service = c.read(pushServiceProvider);
      expect(await service.shouldPrompt(), isFalse);
      now = DateTime.utc(2026, 10, 25);
      expect(await service.shouldPrompt(), isTrue);
    });
  });

  group('foreground banner', () {
    testWidgets('a message while the app is open shows a banner; Open routes it', (tester) async {
      final gw = FakePushGateway(current: PushPermission.granted);
      final c = await pumpPushApp(tester, gateway: gw, api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;

      gw.emitForeground(workerPush('notify_me', '/h/asha', title: 'Asha is online', body: 'Say hello'));
      await settle(tester);

      expect(find.byType(PushBanner), findsOneWidget);
      expect(find.text('Asha is online'), findsOneWidget);
      expect(find.text('Say hello'), findsOneWidget);
      final openSize = tester.getSize(find.ancestor(of: find.text(PushStrings.bannerOpen), matching: find.byType(TextButton)).first);
      expect(openSize.height, greaterThanOrEqualTo(48));

      await tester.tap(find.text(PushStrings.bannerOpen));
      await settle(tester);

      expect(find.byType(PushBanner), findsNothing);
      expect(handler.handled.single.input, '/h/asha');
      expect(handler.handled.single.source, 'push');
    });

    testWidgets('the close button hides it without opening anything', (tester) async {
      final gw = FakePushGateway(current: PushPermission.granted);
      final c = await pumpPushApp(tester, gateway: gw, api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;

      gw.emitForeground(workerPush('low_balance', '/wallet', title: 'Balance is low'));
      await settle(tester);
      expect(find.byType(PushBanner), findsOneWidget);

      await tester.tap(find.byIcon(Icons.close_rounded));
      await settle(tester);
      expect(find.byType(PushBanner), findsNothing);
      expect(handler.handled, isEmpty);
    });

    testWidgets('it hides itself after a few seconds', (tester) async {
      final gw = FakePushGateway(current: PushPermission.granted);
      await pumpPushApp(tester, gateway: gw, api: pushApi());

      gw.emitForeground(workerPush('low_balance', '/wallet', title: 'Balance is low'));
      await settle(tester);
      expect(find.byType(PushBanner), findsOneWidget);

      await tester.pump(PushOverlay.bannerTime + const Duration(seconds: 1));
      await settle(tester);
      expect(find.byType(PushBanner), findsNothing);
    });
  });

  testWidgets('a banner link that arrives before boot waits for the splash (pending link)', (tester) async {
    // The real handler, not the recorder: a cold-start push is held until bootDone.
    final api = pushApi();
    final gw = FakePushGateway(current: PushPermission.granted, initial: workerPush('low_balance', '/wallet'));
    usePhoneScreen(tester);
    final c = ProviderContainer(
      overrides: [
        ...pushOverrides(gateway: gw, api: api, recordLinks: false),
        initialLocationProvider.overrideWithValue('/somewhere-with-no-screen'),
      ],
      retry: (_, __) => null,
    );
    addTearDown(c.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(container: c, child: const HfApp(listenForLinks: false)));
    await settle(tester);

    final pending = c.read(pendingLinkProvider);
    expect(pending, isNotNull);
    expect(pending!.input, '/wallet');
    expect(pending.source, 'push');
    expect(pending.launch, 'cold');
  });
}
