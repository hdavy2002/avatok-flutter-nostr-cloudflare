import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/auth/data/registration_progress.dart';

import '../../support/app_harness.dart';

void main() {
  ProviderContainer account(String uid, MemoryKeyValueStore store) {
    final container = ProviderContainer(overrides: [
      secureStoreProvider.overrideWithValue(store),
      sessionProvider.overrideWith(() => StubSession(SessionState(
        status: SessionStatus.signedIn, me: HfMe(uid: uid)))),
    ]);
    addTearDown(container.dispose);
    return container;
  }

  test('cancelled new-account name step remains required after process restore', () async {
    final store = MemoryKeyValueStore();
    final first = account('new', store).read(registrationProgressProvider);
    await first.markNewAccount();
    expect(await first.needsName(), isTrue);
    // Cancellation intentionally does not clear registration completion state.
    final restored = account('new', store).read(registrationProgressProvider);
    expect(await restored.needsName(), isTrue);
    await restored.complete();
    expect(await account('new', store).read(registrationProgressProvider).needsName(), isFalse);
  });

  test('completion from another UID cannot clear the current registration marker', () async {
    final store = MemoryKeyValueStore();
    final progress = account('second', store).read(registrationProgressProvider);
    await progress.markNewAccount();
    await progress.complete(expectedUid: 'first');
    expect(await progress.needsName(), isTrue);
  });

  test('existing blank-name accounts and other accounts are not forced through signup', () async {
    final store = MemoryKeyValueStore();
    await account('new', store).read(registrationProgressProvider).markNewAccount();
    expect(await account('existing', store).read(registrationProgressProvider).needsName(), isFalse);
    expect(await account('new', store).read(registrationProgressProvider).needsName(), isTrue);
  });
}
