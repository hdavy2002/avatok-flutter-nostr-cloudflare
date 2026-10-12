import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('native email login prepares and verifies a real Clerk email factor', () async {
    final paths = <String>[];
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: MockClient((request) async {
      paths.add(request.url.path);
      if (request.method == 'GET') return http.Response(jsonEncode({'response': {'sessions': [
        {'id': 'sess_email', 'status': 'active', 'user': {'id': 'user_email'}},
      ]}}), 200);
      if (request.url.path.endsWith('/client')) return http.Response('{}', 200, headers: {'authorization': 'new-client'});
      if (request.url.path.endsWith('/sign_ins')) return http.Response(jsonEncode({'response': {
        'id': 'sign_in_1', 'supported_first_factors': [{'strategy': 'email_code', 'email_address_id': 'email_1'}],
      }}), 200);
      if (request.url.path.endsWith('/prepare_first_factor')) {
        expect(Uri.splitQueryString(request.body), {'strategy': 'email_code', 'email_address_id': 'email_1'});
        return http.Response('{"response":{"id":"sign_in_1"}}', 200);
      }
      expect(Uri.splitQueryString(request.body), {'strategy': 'email_code', 'code': '123456'});
      return http.Response('{"response":{"status":"complete"}}', 200);
    }));
    final challenge = await clerk.startEmailCode('person@example.test');
    final result = await clerk.verifyEmailCode(challenge, '123456');
    expect(result.user?.id, 'user_email');
    expect(paths, contains('/v1/client/sign_ins/sign_in_1/attempt_first_factor'));
  });

  test('a malformed prepare response never claims that a code was sent', () async {
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: MockClient((request) async {
      if (request.url.path.endsWith('/sign_ins')) return http.Response(jsonEncode({'response': {
        'id': 'sign_in_1', 'supported_first_factors': [{'strategy': 'email_code'}],
      }}), 200);
      return http.Response('{}', 200);
    }));
    await expectLater(clerk.startEmailCode('person@example.test'), throwsStateError);
  });

  test('incomplete verification never adopts an unrelated existing session', () async {
    var readSession = false;
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: MockClient((request) async {
      if (request.method == 'GET') readSession = true;
      return http.Response('{"response":{"status":"needs_first_factor"}}', 200);
    }));
    final result = await clerk.verifyEmailCode(const EmailChallenge('sign_in_1'), '000000');
    expect(result.isComplete, isFalse);
    expect(readSession, isFalse);
  });
}
