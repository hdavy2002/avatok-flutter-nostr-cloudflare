import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/auth/data/remembered_accounts.dart';

void main() {
  test('each account has a separate secure entry and forgetting one retains others', () async {
    final store = MemoryKeyValueStore();
    final accounts = RememberedAccounts(store);
    await accounts.remember(const RememberedAccount(uid: 'one', label: 'Asha', phone: '+919000000001'));
    await accounts.remember(const RememberedAccount(uid: 'two', label: 'Ravi', phone: '+919000000002'));
    expect((await accounts.read()).map((a) => a.uid), ['two', 'one']);
    expect((await accounts.read()).first.masked, '•••• 0002');
    final index = await store.read('hf.device.account-index.v1');
    expect(index, isNot(contains('Ravi')));
    expect(index, isNot(contains('+91')));
    await accounts.forget('one');
    expect(await store.read('hf.account-choice.v1_one'), isNull);
    expect((await accounts.read()).single.uid, 'two');
  });
}
