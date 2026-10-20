import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/response_cache.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// [HF-APP-CACHE-1] stale-while-revalidate, per-account scoping, write invalidation.

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  late DateTime clock;
  late String? account;
  late List<String> hits;
  late Object Function(http.Request) answer;
  late ApiClient api;

  setUp(() {
    clock = DateTime(2026, 10, 20, 12);
    account = 'user_a';
    hits = [];
    answer = (_) => {'balancePaise': 100};
    api = ApiClient(
      client: MockClient((req) async {
        hits.add('${req.method} ${req.url.path}');
        final out = answer(req);
        return out is http.Response ? out : _json(out);
      }),
      origin: 'https://api.test',
      tokens: ({bool forceRefresh = false}) async => 'jwt',
      cache: ResponseCache(now: () => clock),
      accountId: () => account,
      retryDelay: Duration.zero,
      reporter: (m, e, err, ms) {},
    );
  });

  Future<List<Map<String, dynamic>>> watch(String path, {CachePolicy policy = CachePolicy.live, bool auth = true}) =>
      api.watchJson(path, policy: policy, auth: auth).toList();

  test('first read is a miss: one network call, one emission, and it is stored', () async {
    final out = await watch('/api/hf/app/wallet');
    expect(out, [
      {'balancePaise': 100}
    ]);
    expect(hits, ['GET /api/hf/app/wallet']);
    expect(await api.peekJson('/api/hf/app/wallet'), {'balancePaise': 100});
  });

  test('second read paints the saved answer first, then the changed server answer', () async {
    await watch('/api/hf/app/wallet');
    answer = (_) => {'balancePaise': 250};
    final out = await watch('/api/hf/app/wallet');
    expect(out.map((e) => e['balancePaise']), [100, 250]);
    expect(hits.length, 2); // live policy: always asks the server
  });

  test('an unchanged server answer is not emitted twice', () async {
    await watch('/api/hf/app/wallet');
    final out = await watch('/api/hf/app/wallet');
    expect(out.length, 1);
  });

  test('inside the fresh window the cache alone answers (no network)', () async {
    const policy = CachePolicy(fresh: Duration(minutes: 5), maxAge: Duration(days: 1));
    await watch('/api/hf/hosts/maya/slots', policy: policy, auth: false);
    clock = clock.add(const Duration(minutes: 1));
    final out = await watch('/api/hf/hosts/maya/slots', policy: policy, auth: false);
    expect(out.length, 1);
    expect(hits.length, 1);
    clock = clock.add(const Duration(minutes: 10));
    await watch('/api/hf/hosts/maya/slots', policy: policy, auth: false);
    expect(hits.length, 2);
  });

  test('older than maxAge the cache is ignored', () async {
    await watch('/api/hf/app/wallet');
    clock = clock.add(const Duration(days: 2));
    answer = (_) => {'balancePaise': 7};
    final out = await watch('/api/hf/app/wallet');
    expect(out.map((e) => e['balancePaise']), [7]);
  });

  test('network down after a saved answer: the person keeps it, no error', () async {
    await watch('/api/hf/app/wallet');
    answer = (_) => _json({'code': 'boom'}, 503);
    final out = await watch('/api/hf/app/wallet');
    expect(out.map((e) => e['balancePaise']), [100]);
  });

  test('network down with nothing saved: the error is thrown', () async {
    answer = (_) => _json({'code': 'boom'}, 503);
    await expectLater(watch('/api/hf/app/wallet'), throwsA(isA<ApiException>()));
  });

  test('a momentary failure is retried once', () async {
    var n = 0;
    answer = (_) => ++n == 1 ? _json({'code': 'boom'}, 503) : {'balancePaise': 5};
    final out = await watch('/api/hf/app/wallet');
    expect(out.single['balancePaise'], 5);
    expect(hits.length, 2);
  });

  test('per-account scoping: another account never sees the first one\'s answer', () async {
    await watch('/api/hf/app/wallet');
    account = 'user_b';
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
    account = null; // signed in but no id yet: never cached
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
  });

  test('public reads are shared (scope pub) and survive a write; signed-in ones do not', () async {
    await watch('/api/hf/options', policy: CachePolicy.stable, auth: false);
    await watch('/api/hf/app/wallet');
    await api.request('POST', '/api/hf/bookings', body: {'hostSlug': 'maya'});
    expect(await api.peekJson('/api/hf/options', auth: false), isNotNull);
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
  });

  test('a successful write throws away slots and the wallet; a failed write does not', () async {
    await watch('/api/hf/app/wallet');
    await watch('/api/hf/hosts/maya/slots', policy: CachePolicy.slots, auth: false);
    final before = answer;
    answer = (_) => _json({'code': 'low_balance'}, 402);
    await expectLater(api.request('POST', '/api/hf/bookings', body: {}), throwsA(isA<ApiException>()));
    expect(await api.peekJson('/api/hf/app/wallet'), isNotNull);
    answer = before;
    await api.request('DELETE', '/api/hf/bookings/b1');
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
    expect(await api.peekJson('/api/hf/hosts/maya/slots', auth: false), isNull);
  });

  test('a read that started before a write is not stored after it', () async {
    final slow = api.getJson('/api/hf/app/wallet', store: true);
    await api.request('POST', '/api/hf/wallet/topup', body: {'amount': 100});
    await slow;
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
  });

  test('clearAccount wipes one account only', () async {
    await watch('/api/hf/app/wallet');
    await api.cache.clearAccount('user_a');
    expect(await api.peekJson('/api/hf/app/wallet'), isNull);
  });

  test('counting a reel view does not wipe the cache', () async {
    await watch('/api/hf/app/wallet');
    await api.request('POST', '/api/hf/reels/r1/view', auth: false);
    expect(await api.peekJson('/api/hf/app/wallet'), isNotNull);
  });

  test('two watchers of one URL share one request', () async {
    final both = await Future.wait([watch('/api/hf/app/wallet'), watch('/api/hf/app/wallet')]);
    expect(both.length, 2);
    expect(hits.length, 1);
  });
}
