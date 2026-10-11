import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/features/welcome/data/ack_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';

Future<ProviderContainer> containerWith({
  FakeApiClient? api,
  SessionState? session,
  String? current = '2026-10-10',
}) async {
  final c = ProviderContainer(overrides: [
    clerkProvider.overrideWithValue(FakeClerk(user: session?.isSignedIn == true ? const ClerkUser(id: 'user_test') : null)),
    apiClientProvider.overrideWithValue(api ?? FakeApiClient()),
    sessionProvider.overrideWith(() => StubSession(session ?? signedOutState())),
    flagsProvider.overrideWith((ref) => HfFlags.fromJson({if (current != null) 'hfAckVersion': current})),
  ]);
  addTearDown(c.dispose);
  await c.read(flagsProvider.future);
  return c;
}

SessionState signedInWithAck(String? ackVersion) => SessionState(
      status: SessionStatus.signedIn,
      me: HfMe(uid: 'user_test', ackVersion: ackVersion),
    );

class SwitchingSession extends StubSession {
  SwitchingSession(super.initial);
  void switchTo(SessionState value) => state = value;
}

class DelayedReadAck extends AckService {
  DelayedReadAck(Ref ref, this.result) : super(ref);
  final Completer<String?> result;
  @override
  Future<String?> readLocal() => result.future;
}

class DelayedTokenClerk extends FakeClerk {
  DelayedTokenClerk(this.result) : super(user: const ClerkUser(id: 'user_test'));
  final Completer<String?> result;
  @override
  Future<String?> sessionToken({bool forceRefresh = false}) => result.future;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('an account switch while reading local consent cannot grant or sync it', () async {
    final result = Completer<String?>();
    final session = SwitchingSession(signedInWithAck(null));
    final api = FakeApiClient();
    final c = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      apiClientProvider.overrideWithValue(api),
      ackServiceProvider.overrideWith((ref) => DelayedReadAck(ref, result)),
    ]);
    addTearDown(c.dispose);
    final decision = c.read(ackServiceProvider).needsWelcomeNow();
    session.switchTo(const SessionState(status: SessionStatus.signedIn, me: HfMe(uid: 'other')));
    result.complete('hf-ack-v1');
    expect(await decision, isTrue);
    expect(api.calls, isEmpty);
  });

  test('an account switch while obtaining the bearer prevents acknowledgement dispatch', () async {
    final token = Completer<String?>();
    final clerk = DelayedTokenClerk(token);
    final session = SwitchingSession(signedInWithAck(null));
    final api = FakeApiClient();
    final c = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      clerkProvider.overrideWithValue(clerk),
      apiClientProvider.overrideWithValue(api),
    ]);
    addTearDown(c.dispose);
    final posting = c.read(ackServiceProvider).postAck('hf-ack-v1');
    session.switchTo(const SessionState(status: SessionStatus.signedIn, me: HfMe(uid: 'other')));
    token.complete(await FakeClerk(user: const ClerkUser(id: 'user_test')).sessionToken());
    expect(await posting, isFalse);
    expect(api.calls, isEmpty);
  });

  group('needsWelcome (pure)', () {
    test('nothing accepted anywhere shows Welcome', () {
      expect(needsWelcome(current: '2026-10-10'), isTrue);
      expect(needsWelcome(), isTrue);
    });
    test('the current version on the device or on the account skips Welcome', () {
      expect(needsWelcome(local: '2026-10-10', current: '2026-10-10'), isFalse);
      expect(needsWelcome(server: '2026-10-10', current: '2026-10-10'), isFalse);
    });
    test('an old version is asked again', () {
      expect(needsWelcome(local: 'old', server: 'older', current: '2026-10-10'), isTrue);
    });
    test('when the current version is unknown (offline), any acceptance counts', () {
      expect(needsWelcome(local: 'anything'), isFalse);
      expect(needsWelcome(server: 'anything'), isFalse);
    });
  });

  group('AckService', () {
    test('current version comes from /api/config, else the fallback', () async {
      final known = await containerWith();
      expect(known.read(ackServiceProvider).currentVersion(), '2026-10-10');
      expect(known.read(ackServiceProvider).versionToSend(), '2026-10-10');
      final unknown = await containerWith(current: null);
      expect(unknown.read(ackServiceProvider).currentVersion(), isNull);
      expect(unknown.read(ackServiceProvider).versionToSend(), kFallbackAckVersion);
    });

    test('a guest with nothing stored needs Welcome', () async {
      final c = await containerWith();
      expect(await c.read(ackServiceProvider).needsWelcomeNow(), isTrue);
    });

    test('legacy global device consent is ignored', () async {
      SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
      final c = await containerWith();
      expect(await c.read(ackServiceProvider).needsWelcomeNow(), isTrue);
    });

    test('an old device copy is asked again', () async {
      SharedPreferences.setMockInitialValues({AckService.storageKey: 'hf-ack-v0'});
      final c = await containerWith();
      expect(await c.read(ackServiceProvider).needsWelcomeNow(), isTrue);
    });

    test('an account that accepted on another phone fills the device copy', () async {
      final c = await containerWith(session: signedInWithAck('2026-10-10'));
      final service = c.read(ackServiceProvider);
      expect(await service.needsWelcomeNow(), isFalse);
      expect(await service.readLocal(), '2026-10-10');
    });

    test('legacy device consent is never copied to a newly authenticated account', () async {
      SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
      final api = FakeApiClient()..onJson('POST', '/api/hf/me/ack', {'ok': true});
      final c = await containerWith(api: api, session: signedInWithAck(null));
      expect(await c.read(ackServiceProvider).needsWelcomeNow(), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(api.callsTo('POST', '/api/hf/me/ack'), isEmpty);
    });

    test('nothing is sent when the account already has it, or when signed out', () async {
      SharedPreferences.setMockInitialValues({AckService.storageKey: '2026-10-10'});
      final api = FakeApiClient()..onJson('POST', '/api/hf/me/ack', {'ok': true});
      final has = await containerWith(api: api, session: signedInWithAck('2026-10-10'));
      await has.read(ackServiceProvider).syncToServer();
      final out = await containerWith(api: api);
      await out.read(ackServiceProvider).syncToServer();
      expect(api.calls, isEmpty);
    });

    test('accept keeps the version on the device and sends it only when signed in', () async {
      final api = FakeApiClient()..onJson('POST', '/api/hf/me/ack', {'ok': true});
      final guest = await containerWith(api: api);
      expect(await guest.read(ackServiceProvider).accept(), '2026-10-10');
      expect(await guest.read(ackServiceProvider).readLocal(), isNull);
      expect(api.calls, isEmpty);
      final signedIn = await containerWith(api: api, session: signedInWithAck(null));
      await signedIn.read(ackServiceProvider).accept();
      expect(api.callsTo('POST', '/api/hf/me/ack'), hasLength(1));
    });

    test('scoped consent for one account cannot consent for another', () async {
      SharedPreferences.setMockInitialValues({'${AckService.storageKey}_other': '2026-10-10'});
      final c = await containerWith(session: signedInWithAck(null));
      expect(await c.read(ackServiceProvider).needsWelcomeNow(), isTrue);
      await c.read(ackServiceProvider).accept();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('${AckService.storageKey}_user_test'), '2026-10-10');
      expect(prefs.getString(AckService.storageKey), isNull);
    });

    test('a failing server call is reported as false and never throws', () async {
      final api = FakeApiClient()..onError('POST', '/api/hf/me/ack', const ApiError(status: 503, code: 'ack_failed'));
      final c = await containerWith(api: api);
      expect(await c.read(ackServiceProvider).postAck('v'), isFalse);
    });

    test('the device key survives the cache clear on sign-out', () {
      expect(AckService.storageKey.startsWith('hf.cache.'), isFalse);
      expect(AckService.storageKey.endsWith('_guest'), isFalse);
    });
  });
}
