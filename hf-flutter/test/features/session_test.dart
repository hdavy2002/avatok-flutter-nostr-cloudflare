import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';

import '../support/fake_api_client.dart';
import '../support/fake_clerk.dart';

ProviderContainer containerWith(FakeClerk clerk, FakeApiClient api) {
  final c = ProviderContainer(overrides: [
    clerkProvider.overrideWithValue(clerk),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
  ]);
  addTearDown(c.dispose);
  return c;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));
  tearDown(() => AccountScope.id = null);

  test('restore with no Clerk session is a guest', () async {
    final c = containerWith(FakeClerk(), FakeApiClient());
    await c.read(sessionProvider.notifier).restore();
    expect(c.read(sessionProvider).status, SessionStatus.signedOut);
    expect(AccountScope.id, isNull);
  });

  test('signInWithTicket signs in, scopes storage and loads /api/hf/me with the host', () async {
    final api = FakeApiClient()
      ..onJson('GET', '/api/hf/me', {
        'uid': 'user_test',
        'host': {'status': 'live', 'slug': 'asha'},
      });
    final clerk = FakeClerk();
    final c = containerWith(clerk, api);
    final step = await c.read(sessionProvider.notifier).signInWithTicket('tkt');
    expect(step.isComplete, isTrue);
    expect(clerk.tickets, ['tkt']);
    final s = c.read(sessionProvider);
    expect(s.isSignedIn, isTrue);
    expect(s.hasHostTab, isTrue);
    expect(AccountScope.id, 'user_test');
    expect(scopedKey('x'), isNot('x'));
  });

  test('a failed /api/hf/me keeps the person signed in and records the error', () async {
    final api = FakeApiClient()
      ..onError('GET', '/api/hf/me', const ApiError(status: 500, code: 'http_500'));
    final c = containerWith(FakeClerk(), api);
    await c.read(sessionProvider.notifier).signInWithTicket('t');
    final s = c.read(sessionProvider);
    expect(s.isSignedIn, isTrue);
    expect(s.hasHostTab, isFalse);
    expect(s.meError?.status, 500);
  });

  test('signOut clears the account scope and runs hooks', () async {
    final api = FakeApiClient()..onJson('GET', '/api/hf/me', {'uid': 'user_test'});
    final clerk = FakeClerk();
    final c = containerWith(clerk, api);
    var hook = 0;
    c.read(signOutHooksProvider).add(() async => hook++);
    await c.read(sessionProvider.notifier).signInWithTicket('t');
    await c.read(sessionProvider.notifier).signOut();
    expect(hook, 1);
    expect(c.read(sessionProvider).status, SessionStatus.signedOut);
    expect(clerk.user, isNull);
    expect(AccountScope.id, isNull);
  });

  test('a throwing sign-out hook never blocks sign-out', () async {
    final api = FakeApiClient()..onJson('GET', '/api/hf/me', {'uid': 'user_test'});
    final c = containerWith(FakeClerk(), api);
    c.read(signOutHooksProvider).add(() async => throw StateError('boom'));
    await c.read(sessionProvider.notifier).signInWithTicket('t');
    await c.read(sessionProvider.notifier).signOut();
    expect(c.read(sessionProvider).isSignedIn, isFalse);
  });
}
