import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/auth/data/identity_api.dart';
import '../../support/fake_api_client.dart';

void main() {
  test('email verification uses the existing authenticated identity authority', () async {
    final client = FakeApiClient()
      ..onJson('POST', '/api/id/email/start', {'ok': true})
      ..onJson('POST', '/api/id/email/verify', {'ok': true, 'verified': true});
    final identity = IdentityApi(client);
    expect(await identity.sendEmail('person@example.test'), 30);
    await identity.verifyEmail('person@example.test', '123456');
    expect(client.callsTo('POST', '/api/id/email/verify').single.auth, isTrue);
  });

  test('email HTTP success without verified proof is not success', () async {
    final client = FakeApiClient()..onJson('POST', '/api/id/email/verify', {'ok': true});
    await expectLater(IdentityApi(client).verifyEmail('person@example.test', '123456'),
      throwsA(isA<ApiError>()));
  });

  test('registration requires the exact reserved username and completion receipt', () async {
    final client = FakeApiClient()..onJson('POST', '/api/hf/me/registration', {'ok': true});
    await expectLater(IdentityApi(client).register(firstName: 'Asha', lastName: 'Rao', username: 'asha.rao',
      acceptedPolicyVersions: {'terms': 'terms-v1'}),
      throwsA(isA<ApiError>()));
    final body = client.callsTo('POST', '/api/hf/me/registration').single.body as Map;
    expect(body['acceptedPolicies'], IdentityApi.policies);
    expect(body['acceptedPolicyVersions'], {'terms': 'terms-v1'});
  });

  test('unavailable username response cannot be mistaken for available', () async {
    final client = FakeApiClient()..onJson('GET', '/api/hf/me/username?value=asha', {'ok': true});
    await expectLater(IdentityApi(client).usernameAvailable('asha'), throwsA(isA<ApiError>()));
  });

  test('server progress includes current versions and discards stale consent', () async {
    final client = FakeApiClient()..onJson('GET', '/api/hf/me/registration', {
      'uid': 'account-a', 'step': 7, 'registrationComplete': false,
      'firstName': 'Asha', 'lastName': 'Rao', 'username': 'asha', 'kycNow': false,
      'policies': {for (final name in IdentityApi.policies) name: {'version': '$name-v2'}},
      'acceptedPolicyVersions': {'terms': 'terms-v1', 'privacy': 'privacy-v2'},
    });
    final draft = await IdentityApi(client).registration();
    expect(draft.uid, 'account-a');
    expect(draft.step, 7);
    expect(draft.acceptedPolicyVersions, {'privacy': 'privacy-v2'});
    expect(client.callsTo('GET', '/api/hf/me/registration').single.auth, isTrue);
  });
}
