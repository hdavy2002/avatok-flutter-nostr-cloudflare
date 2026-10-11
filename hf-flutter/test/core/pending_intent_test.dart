import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/router/pending_intent.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/core/storage/secure_store.dart';

void main() {
  tearDown(() => AccountScope.id = null);

  test('safe next keeps host and lane through wallet and rejects gate loops', () {
    final call = Routes.callConfirmOf('asha', lane: 'lgbtq');
    final wallet = Routes.walletWithNext(call);
    expect(Uri.parse(wallet).queryParameters['next'], call);
    expect(Routes.isSafeNext(wallet), isTrue);
    expect(Routes.isSafeNext(Routes.lanesOf('women', next: call)), isTrue);
    for (final path in ['/sign-in', '/welcome', '/splash', '//evil.test',
      'https://evil.test', '/admin', '/wallet?next=%2Fwallet',
      '/call/new?host=asha&otp=123456', '/call/new?host=asha&host=other',
      '/h/%2e%2e', '/h/%5cevil', '/me#secret']) {
      expect(Routes.isSafeNext(path), isFalse, reason: path);
    }
  });

  test('a restored intent is bound to its account and never transfers', () async {
    final store = PendingIntentStore(MemoryKeyValueStore());
    AccountScope.id = 'a';
    final call = Routes.callConfirmOf('asha');
    await store.save(call);
    AccountScope.id = 'b';
    expect(await store.read(), isNull);
    AccountScope.id = null;
    expect(await store.read(), isNull);
    AccountScope.id = 'a';
    expect(await store.read(), call);
    await store.clear();
    expect(await store.read(), isNull);
  });

  test('guest auth return survives process restoration without OTP or account data', () async {
    final memory = MemoryKeyValueStore();
    final call = Routes.callConfirmOf('asha');
    await PendingIntentStore(memory).save(call);
    expect(await PendingIntentStore(memory).read(), call);
    AccountScope.id = 'new-user';
    expect(await PendingIntentStore(memory).read(), isNull);
    await PendingIntentStore(memory).clearGuest();
    AccountScope.id = null;
    expect(await PendingIntentStore(memory).read(), isNull);
  });

  test('stale and future-dated intent expires rather than resuming an action', () async {
    AccountScope.id = 'a';
    final memory = MemoryKeyValueStore();
    final now = DateTime.utc(2026, 10, 11);
    await PendingIntentStore(memory, now: () => now).save(Routes.callConfirmOf('asha'));
    expect(await PendingIntentStore(memory, now: () => now.add(const Duration(days: 2))).read(), isNull);
    await PendingIntentStore(memory, now: () => now).save(Routes.me);
    expect(await PendingIntentStore(memory, now: () => now.subtract(const Duration(hours: 1))).read(), isNull);
  });

  test('unknown and credential-bearing destinations are not persisted', () async {
    AccountScope.id = 'a';
    final memory = MemoryKeyValueStore();
    final store = PendingIntentStore(memory);
    await store.save('/call/new?host=asha&identity=document');
    await store.save('/sign-in?otp=123456');
    expect(memory.snapshot, isEmpty);
  });
}
