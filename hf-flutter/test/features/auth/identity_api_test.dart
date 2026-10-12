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
    await expectLater(IdentityApi(client).register(firstName: 'Asha', lastName: 'Rao', username: 'asha.rao'),
      throwsA(isA<ApiError>()));
    final body = client.callsTo('POST', '/api/hf/me/registration').single.body as Map;
    expect(body['acceptedPolicies'], IdentityApi.policies);
  });

  test('unavailable username response cannot be mistaken for available', () async {
    final client = FakeApiClient()..onJson('GET', '/api/hf/me/username?value=asha', {'ok': true});
    await expectLater(IdentityApi(client).usernameAvailable('asha'), throwsA(isA<ApiError>()));
  });
}
