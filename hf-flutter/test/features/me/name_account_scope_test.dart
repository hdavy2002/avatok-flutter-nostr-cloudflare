import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/features/me/data/me_api.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/fake_clerk.dart';

class SwitchingNameSession extends StubSession {
  SwitchingNameSession() : super(const SessionState(status: SessionStatus.signedIn,
    me: HfMe(uid: 'first')));
  void switchAccount() => state = const SessionState(status: SessionStatus.signedIn,
    me: HfMe(uid: 'second'));
}

class DelayedNameClerk extends FakeClerk {
  DelayedNameClerk(this.token);
  final Completer<String?> token;
  @override
  Future<String?> sessionToken({bool forceRefresh = false}) => token.future;
}

void main() {
  test('switching accounts during token acquisition prevents name dispatch', () async {
    final token = Completer<String?>();
    final session = SwitchingNameSession();
    final api = FakeApiClient();
    final container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      apiClientProvider.overrideWithValue(api),
      clerkProvider.overrideWithValue(DelayedNameClerk(token)),
    ]);
    addTearDown(container.dispose);
    final saving = container.read(meApiProvider).updateName('Asha', expectedUid: 'first');
    final rejected = expectLater(saving, throwsA(isA<ApiError>().having((e) => e.code, 'code', 'account_changed')));
    session.switchAccount();
    token.complete(await FakeClerk(user: const ClerkUser(id: 'first')).sessionToken());
    await rejected;
    expect(api.calls, isEmpty);
  });

  test('a late name response cannot report success for a different account', () async {
    final response = Completer<Object?>();
    final dispatched = Completer<void>();
    final session = SwitchingNameSession();
    final api = FakeApiClient()..on('PATCH', '/api/hf/me', (_) {
      dispatched.complete();
      return response.future;
    });
    final container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => session),
      apiClientProvider.overrideWithValue(api),
      clerkProvider.overrideWithValue(FakeClerk(user: const ClerkUser(id: 'first'))),
    ]);
    addTearDown(container.dispose);
    final saving = container.read(meApiProvider).updateName('Asha', expectedUid: 'first');
    final rejected = expectLater(saving, throwsA(isA<ApiError>().having((e) => e.code, 'code', 'account_changed')));
    await dispatched.future;
    session.switchAccount();
    response.complete({'displayName': 'Asha'});
    await rejected;
    expect(api.callsTo('PATCH', '/api/hf/me'), hasLength(1));
    expect(api.calls.single.auth, isFalse, reason: 'The pinned credential must not use automatic token refresh/retry.');
  });
}
