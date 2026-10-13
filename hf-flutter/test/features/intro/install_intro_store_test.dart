import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/storage/account_storage.dart';
import 'package:hf_app/features/intro/data/install_intro_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('hf/install_intro');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late bool marker;

  setUp(() {
    marker = false;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'isCompleted') return marker;
      if (call.method == 'complete') return marker = true;
      throw MissingPluginException();
    });
  });
  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
    AccountScope.id = null;
  });

  test('new install shows intro; new process and account changes retain completion', () async {
    final first = InstallIntroStore();
    expect(await first.isCompleted(), isFalse);
    expect(await first.complete(), isTrue);
    AccountScope.id = 'account-a';
    expect(await InstallIntroStore().isCompleted(), isTrue);
    AccountScope.id = null;
    expect(await InstallIntroStore().isCompleted(), isTrue);
    AccountScope.id = 'account-b';
    expect(await InstallIntroStore().isCompleted(), isTrue);
    // Android deletes noBackupFilesDir on uninstall (and never restores it).
    marker = false;
    expect(await InstallIntroStore().isCompleted(), isFalse);
  });

  test('storage failure allows completion for this process only', () async {
    messenger.setMockMethodCallHandler(channel, (_) async {
      throw PlatformException(code: 'storage_unavailable');
    });
    final store = InstallIntroStore();
    expect(await store.isCompleted(), isFalse);
    expect(await store.complete(), isFalse);
    expect(await store.isCompleted(), isTrue);
    expect(await InstallIntroStore().isCompleted(), isFalse);
  });

  test('a slow read cannot undo a completion tap', () async {
    final reading = Completer<bool>();
    messenger.setMockMethodCallHandler(channel, (call) async =>
      call.method == 'isCompleted' ? reading.future : true);
    final store = InstallIntroStore();
    final pendingRead = store.isCompleted();
    await store.complete();
    reading.complete(false);
    expect(await pendingRead, isTrue);
    expect(await store.isCompleted(), isTrue);
  });
}
