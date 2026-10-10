import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/features/push/data/push_controller.dart';
import 'package:hf_app/features/push/data/push_gateway.dart';
import 'package:hf_app/features/push/data/push_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import 'push_support.dart';

ProviderContainer makeContainer({
  required FakePushGateway gateway,
  required FakeApiClient api,
  bool signedIn = true,
  bool flagOn = true,
  DateTime Function()? clock,
}) {
  final c = ProviderContainer(
    overrides: pushOverrides(gateway: gateway, api: api, signedIn: signedIn, flagOn: flagOn, clock: clock),
    retry: (_, __) => null,
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  group('register', () {
    test('POST /api/hf/push/register {token, platform android, shell native-...}', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(), api: api);
      await c.read(pushServiceProvider).registerToken();

      final calls = api.callsTo('POST', '/api/hf/push/register');
      expect(calls, hasLength(1));
      final body = calls.single.body as Map;
      expect(body['token'], 'fcm-token-1');
      expect(body['platform'], 'android');
      expect(body['shell'], startsWith('native'));
    });

    test('a refreshed token is registered as given', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(), api: api);
      await c.read(pushServiceProvider).registerToken('fcm-token-2');
      expect((api.callsTo('POST', '/api/hf/push/register').single.body as Map)['token'], 'fcm-token-2');
    });

    test('nothing is sent while signed out', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(), api: api, signedIn: false);
      await c.read(pushServiceProvider).registerToken();
      expect(api.calls, isEmpty);
    });

    test('a worker error never throws', () async {
      final api = FakeApiClient()
        ..onError('POST', '/api/hf/push/register', const ApiError(status: 500, code: 'http_500'));
      final c = makeContainer(gateway: FakePushGateway(), api: api);
      await c.read(pushServiceProvider).registerToken();
      expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
    });

    test('after sign-in: registers quietly when notifications are already allowed', () async {
      final api = pushApi();
      final gw = FakePushGateway(current: PushPermission.granted);
      final c = makeContainer(gateway: gw, api: api);
      await c.read(pushServiceProvider).syncAfterSignIn();
      expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
      expect(gw.promptCount, 0, reason: 'never prompts');
    });

    test('after sign-in: nothing is registered while permission is missing', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(), api: api);
      await c.read(pushServiceProvider).syncAfterSignIn();
      expect(api.calls, isEmpty);
    });

    test('without Firebase: no token, no call', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(isAvailable: false, current: PushPermission.granted), api: api);
      await c.read(pushServiceProvider).syncAfterSignIn();
      expect(api.calls, isEmpty);
    });
  });

  group('unregister', () {
    test('DELETE /api/hf/push/register {token} with the token that was registered', () async {
      final api = pushApi();
      final gw = FakePushGateway(current: PushPermission.granted, tokenValue: 'tok-A');
      final c = makeContainer(gateway: gw, api: api);
      final service = c.read(pushServiceProvider);
      await service.registerToken();
      gw.tokenValue = 'tok-B'; // Firebase moved on; sign-out must still delete the one the worker has
      await service.unregister();

      final del = api.callsTo('DELETE', '/api/hf/push/register');
      expect(del, hasLength(1));
      expect((del.single.body as Map)['token'], 'tok-A');
    });

    test('falls back to the current Firebase token when none was stored', () async {
      final api = pushApi();
      final c = makeContainer(gateway: FakePushGateway(tokenValue: 'tok-C'), api: api);
      await c.read(pushServiceProvider).unregister();
      expect((api.callsTo('DELETE', '/api/hf/push/register').single.body as Map)['token'], 'tok-C');
    });

    test('a failing DELETE never throws (sign-out goes on)', () async {
      final api = FakeApiClient()
        ..onError('DELETE', '/api/hf/push/register', const ApiError(status: 0, code: 'network'));
      final c = makeContainer(gateway: FakePushGateway(), api: api);
      await c.read(pushServiceProvider).unregister();
    });

    test('is a sign-out hook, and runs on sign out', () async {
      final api = pushApi();
      final gw = FakePushGateway(current: PushPermission.granted);
      final c = makeContainer(gateway: gw, api: api);
      c.read(pushControllerProvider); // creating the controller adds the hook
      expect(c.read(signOutHooksProvider), isNotEmpty);
      for (final hook in c.read(signOutHooksProvider)) {
        await hook();
      }
      expect(api.callsTo('DELETE', '/api/hf/push/register'), hasLength(1));
    });
  });

  group('opt-in timing (service)', () {
    final start = DateTime.utc(2026, 10, 10, 12);

    test('shown once after sign-in', () async {
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi());
      expect(await c.read(pushServiceProvider).shouldPrompt(), isTrue);
    });

    test('not shown when signed out', () async {
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi(), signedIn: false);
      expect(await c.read(pushServiceProvider).shouldPrompt(), isFalse);
    });

    test('not shown while the flag is off', () async {
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi(), flagOn: false);
      expect(await c.read(pushServiceProvider).shouldPrompt(), isFalse);
    });

    test('Not now: gone for 14 days, back on day 14', () async {
      var now = start;
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi(), clock: () => now);
      final service = c.read(pushServiceProvider);
      await service.notNow();

      expect(await service.shouldPrompt(), isFalse);
      now = start.add(const Duration(days: 13));
      expect(await service.shouldPrompt(), isFalse);
      now = start.add(const Duration(days: 14));
      expect(await service.shouldPrompt(), isTrue);
    });

    test('Allow + Android yes: registers, never asked again', () async {
      final api = pushApi();
      final gw = FakePushGateway(afterPrompt: PushPermission.granted);
      final c = makeContainer(gateway: gw, api: api);
      final service = c.read(pushServiceProvider);

      expect(await service.allow(), isTrue);
      expect(gw.promptCount, 1);
      expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
      expect(await service.shouldPrompt(), isFalse);
    });

    test('Allow + Android no: nothing registered, asked again after 14 days', () async {
      var now = start;
      final api = pushApi();
      final gw = FakePushGateway(afterPrompt: PushPermission.notGranted);
      final c = makeContainer(gateway: gw, api: api, clock: () => now);
      final service = c.read(pushServiceProvider);

      expect(await service.allow(), isFalse);
      expect(api.calls, isEmpty);
      expect(await service.shouldPrompt(), isFalse);
      now = start.add(const Duration(days: 14));
      expect(await service.shouldPrompt(), isTrue);
    });
  });

  group('taps', () {
    test('open routes by data.path through the link handler, as source push', () async {
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;
      final ok = await c.read(pushServiceProvider).open(workerPush('low_balance', '/wallet'), launch: 'warm');

      expect(ok, isTrue);
      expect(handler.handled, hasLength(1));
      expect(handler.handled.single.input, '/wallet');
      expect(handler.handled.single.source, 'push');
      expect(handler.handled.single.launch, 'warm');
    });

    test('a message that is not ours opens nothing', () async {
      final c = makeContainer(gateway: FakePushGateway(), api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;
      final ok = await c.read(pushServiceProvider).open(
            const PushMessage(title: 'x', data: {'type': 'other_sender', 'path': '/wallet'}),
            launch: 'warm',
          );
      expect(ok, isFalse);
      expect(handler.handled, isEmpty);
    });

    test('cold start: the initial message is opened with launch cold', () async {
      final gw = FakePushGateway(initial: workerPush('host_approved', '/hosts/dashboard'));
      final c = makeContainer(gateway: gw, api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;
      await c.read(pushControllerProvider.notifier).start();

      expect(handler.handled.single.input, '/hosts/dashboard');
      expect(handler.handled.single.launch, 'cold');
      expect(handler.handled.single.source, 'push');
    });

    test('background tap: onMessageOpenedApp opens it with launch warm', () async {
      final gw = FakePushGateway();
      final c = makeContainer(gateway: gw, api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;
      await c.read(pushControllerProvider.notifier).start();
      gw.emitOpened(workerPush('notify_me', '/h/asha'));
      await Future<void>.delayed(Duration.zero);

      expect(handler.handled.single.input, '/h/asha');
      expect(handler.handled.single.launch, 'warm');
    });

    test('token refresh while signed in registers the new token', () async {
      final api = pushApi();
      final gw = FakePushGateway();
      final c = makeContainer(gateway: gw, api: api);
      await c.read(pushControllerProvider.notifier).start();
      gw.emitRefresh('fresh-token');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final posts = api.callsTo('POST', '/api/hf/push/register');
      expect(posts.map((p) => (p.body as Map)['token']), contains('fresh-token'));
    });

    test('foreground message becomes a banner; Open routes it and clears it', () async {
      final gw = FakePushGateway();
      final c = makeContainer(gateway: gw, api: pushApi());
      final handler = c.read(deepLinkHandlerProvider) as RecordingLinkHandler;
      await c.read(pushControllerProvider.notifier).start();
      gw.emitForeground(workerPush('review_request', '/review/tok123', title: 'How was your call?'));
      await Future<void>.delayed(Duration.zero);

      expect(c.read(pushControllerProvider).banner?.title, 'How was your call?');
      await c.read(pushControllerProvider.notifier).openBanner();
      expect(c.read(pushControllerProvider).banner, isNull);
      expect(handler.handled.single.input, '/review/tok123');
    });
  });
}
