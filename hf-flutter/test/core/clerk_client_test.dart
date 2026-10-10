import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('the FAPI domain comes from the publishable key', () {
    final d = ClerkClient.deriveDomain(Brand.clerkPublishableKey);
    expect(d, startsWith('clerk.'));
    expect(d, isNot(contains(r'$')));
  });

  test('signInWithTicket: client, sign_ins ticket, then the active user; the token is stored', () async {
    final calls = <String>[];
    final bodies = <String, String>{};
    final mock = MockClient((req) async {
      final key = '${req.method} ${req.url.path}';
      calls.add(key);
      if (req.method == 'POST') bodies[req.url.path] = req.body;
      if (req.method == 'POST' && req.url.path.endsWith('/client')) {
        return http.Response('{}', 200, headers: {'authorization': 'client-token-1'});
      }
      if (req.method == 'POST' && req.url.path.endsWith('/client/sign_ins')) {
        return http.Response('{"response":{"status":"complete"}}', 200);
      }
      if (req.method == 'GET' && req.url.path.endsWith('/client')) {
        expect(req.headers['Authorization'], 'client-token-1');
        return http.Response(
            jsonEncode({
              'response': {
                'sessions': [
                  {
                    'id': 'sess_1',
                    'status': 'active',
                    'user': {'id': 'user_1', 'first_name': 'Asha'},
                  }
                ]
              }
            }),
            200);
      }
      return http.Response('{}', 404);
    });
    final store = MemoryKeyValueStore();
    final clerk = ClerkClient(store: store, httpClient: mock, publishableKey: Brand.clerkPublishableKey);

    final step = await clerk.signInWithTicket('  tkt_abc  ');

    expect(step.isComplete, isTrue);
    expect(step.user!.id, 'user_1');
    expect(calls, ['POST /v1/client', 'POST /v1/client/sign_ins', 'GET /v1/client']);
    final form = Uri.splitQueryString(bodies['/v1/client/sign_ins']!);
    expect(form, {'strategy': 'ticket', 'ticket': 'tkt_abc'});
    await Future<void>.delayed(Duration.zero);
    expect(await store.read('clerk_client_token'), 'client-token-1');
  });

  test('a rejected ticket gives a plain message, never throws', () async {
    final mock = MockClient((req) async {
      if (req.method == 'POST' && req.url.path.endsWith('/client/sign_ins')) {
        return http.Response('{"errors":[{"long_message":"That link has expired."}]}', 422);
      }
      if (req.method == 'GET') return http.Response('{"response":{"sessions":[]}}', 200);
      return http.Response('{}', 200, headers: {'authorization': 't'});
    });
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: mock, publishableKey: Brand.clerkPublishableKey);
    final step = await clerk.signInWithTicket('x');
    expect(step.isComplete, isFalse);
    expect(step.error, 'That link has expired.');
  });

  test('an empty ticket makes no network call', () async {
    var hit = false;
    final mock = MockClient((req) async {
      hit = true;
      return http.Response('{}', 200);
    });
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: mock, publishableKey: Brand.clerkPublishableKey);
    final step = await clerk.signInWithTicket('   ');
    expect(step.isComplete, isFalse);
    expect(hit, isFalse);
  });

  test('offline during redeem is an error step', () async {
    final mock = MockClient((req) async => throw http.ClientException('offline'));
    final clerk = ClerkClient(store: MemoryKeyValueStore(), httpClient: mock, publishableKey: Brand.clerkPublishableKey);
    final step = await clerk.signInWithTicket('x');
    expect(step.isComplete, isFalse);
    expect(step.error, isNotEmpty);
  });
}
