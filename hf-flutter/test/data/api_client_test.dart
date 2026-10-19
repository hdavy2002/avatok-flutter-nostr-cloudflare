import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/me.dart';
import 'package:hf_app/data/repos/config_repo.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Calls {
  final List<ApiException> reported = [];
  int sessionLost = 0;
}

ApiClient _client(MockClient mock, {TokenProvider? tokens, _Calls? calls}) => ApiClient(
      client: mock,
      origin: 'https://api.test',
      tokens: tokens,
      onSessionLost: () async => calls?.sessionLost++,
      reporter: (m, e, err, ms) => calls?.reported.add(err),
    );

void main() {
  test('ok: decodes JSON, sends the Bearer token and the client tag', () async {
    late http.Request seen;
    final api = _client(
      MockClient((req) async {
        seen = req;
        return _json({'uid': 'u1'});
      }),
      tokens: ({bool forceRefresh = false}) async => 'jwt-1',
    );
    final out = await api.getJson('/api/hf/me');
    expect(out['uid'], 'u1');
    expect(seen.url.toString(), 'https://api.test/api/hf/me');
    expect(seen.headers['Authorization'], 'Bearer jwt-1');
    expect(seen.headers['X-Client'], 'hf-android');
  });

  test('public call sends no Authorization header', () async {
    late http.Request seen;
    final api = _client(
      MockClient((req) async {
        seen = req;
        return _json({});
      }),
      tokens: ({bool forceRefresh = false}) async => 'jwt-1',
    );
    await api.getJson('/api/config', auth: false);
    expect(seen.headers.containsKey('Authorization'), isFalse);
  });

  test('401 refreshes the token once and retries', () async {
    var hits = 0;
    final api = _client(
      MockClient((req) async {
        hits++;
        return req.headers['Authorization'] == 'Bearer fresh' ? _json({'ok': true}) : _json({'error': 'unauthorized'}, 401);
      }),
      tokens: ({bool forceRefresh = false}) async => forceRefresh ? 'fresh' : 'stale',
    );
    expect((await api.getJson('/x'))['ok'], true);
    expect(hits, 2);
  });

  test('401 that survives the refresh reports, signs out and throws', () async {
    final calls = _Calls();
    final api = _client(
      MockClient((req) async => _json({'error': 'unauthorized', 'message': 'Sign in again.'}, 401)),
      tokens: ({bool forceRefresh = false}) async => forceRefresh ? 'b' : 'a',
      calls: calls,
    );
    await expectLater(
      api.getJson('/api/hf/me'),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 401).having((e) => e.isUnauthorized, 'isUnauthorized', true)),
    );
    expect(calls.sessionLost, 1);
    expect(calls.reported, hasLength(1));
  });

  test('offline: a connection failure becomes an offline error with the exact text', () async {
    final calls = _Calls();
    final api = _client(MockClient((req) async => throw http.ClientException('no route')), calls: calls);
    try {
      await api.getJson('/api/config', auth: false);
      fail('should have thrown');
    } on ApiException catch (e) {
      expect(e.kind, ApiFailure.offline);
      expect(e.isOffline, isTrue);
      expect(e.userMessage, 'No internet. Check your connection.');
    }
    expect(calls.reported.single.isOffline, isTrue);
  });

  test('timeout is offline too', () async {
    final api = ApiClient(
      client: MockClient((req) async {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        return _json({});
      }),
      origin: 'https://api.test',
      timeout: const Duration(milliseconds: 20),
      reporter: (m, e, err, ms) {},
    );
    await expectLater(api.getJson('/slow', auth: false), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'timeout')));
  });

  test('500 with a JSON error keeps the code and message', () async {
    final calls = _Calls();
    final api = _client(MockClient((req) async => _json({'error': 'call_failed', 'message': 'Try later.', 'retry_after_s': 7}, 500)), calls: calls);
    try {
      await api.getJson('/api/hf/calls/start', auth: false);
      fail('should have thrown');
    } on ApiException catch (e) {
      expect(e.kind, ApiFailure.http);
      expect(e.status, 500);
      expect(e.code, 'call_failed');
      expect(e.userMessage, 'Try later.');
      expect(e.retryAfterSeconds, 7);
    }
    expect(calls.reported, hasLength(1));
  });

  test('500 with a non-JSON body falls back to http_500 and the generic text', () async {
    final api = _client(MockClient((req) async => http.Response('<html>oops</html>', 500)));
    try {
      await api.getJson('/x', auth: false);
      fail('should have thrown');
    } on ApiException catch (e) {
      expect(e.code, 'http_500');
      expect(e.userMessage, ApiException.genericText);
    }
  });

  test('a flag-off 404 not_enabled is thrown but not reported', () async {
    final calls = _Calls();
    final api = _client(MockClient((req) async => _json({'error': 'not_enabled'}, 404)), calls: calls);
    await expectLater(api.getJson('/x', auth: false), throwsA(isA<ApiException>().having((e) => e.isNotEnabled, 'isNotEnabled', true)));
    expect(calls.reported, isEmpty);
  });

  test('2xx with a body that is not JSON is a parse error', () async {
    final api = _client(MockClient((req) async => http.Response('not json', 200)));
    await expectLater(api.getJson('/x', auth: false), throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiFailure.parse)));
  });

  test('POST sends a JSON body', () async {
    late http.Request seen;
    final api = _client(MockClient((req) async {
      seen = req;
      return _json({'ok': true});
    }));
    await api.postJson('/x', body: {'a': 1}, auth: false);
    expect(seen.method, 'POST');
    expect(jsonDecode(seen.body), {'a': 1});
    expect(seen.headers['Content-Type'], contains('application/json'));
  });

  test('Me maps role and name from /api/hf/me', () {
    final fan = Me.fromJson({'uid': 'u1', 'displayName': 'Tara', 'isHost': false, 'host': null});
    expect(fan.role, UserRole.fan);
    expect(fan.name, 'Tara');
    final host = Me.fromJson({'uid': 'u2', 'displayName': ' ', 'isHost': true, 'host': {'status': 'live', 'slug': 'meera'}});
    expect(host.role, UserRole.host);
    expect(host.name, isNull);
    expect(host.hostSlug, 'meera');
    expect(Me.fromJson({'uid': 'u3', 'host': {'status': 'draft'}}).isHost, isTrue);
  });

  test('update status: forced below min, soft below latest, none when unknown', () {
    const cfg = AppConfig(minBuild: 2100, latestBuild: 2200);
    expect(cfg.updateStatusFor(2050), UpdateStatus.forced);
    expect(cfg.updateStatusFor(2150), UpdateStatus.soft);
    expect(cfg.updateStatusFor(2200), UpdateStatus.none);
    expect(cfg.updateStatusFor(0), UpdateStatus.none);
    expect(const AppConfig().updateStatusFor(1), UpdateStatus.none);
    expect(AppConfig.fromJson({'hfAppMinBuild': 5, 'hfAppLatestBuild': '9'}).latestBuild, 9);
  });

  test('deep links: site links and the custom scheme map to screens; others are ignored', () {
    expect(linkTargetFor(Uri.parse('https://${Brand.domain}/h/meera'))?.location, '/profile/meera');
    expect(linkTargetFor(Uri.parse('https://${Brand.wwwHost}/r/abc123'))?.location, '/reels?reel=abc123');
    expect(linkTargetFor(Uri.parse('${Brand.scheme}://h/meera'))?.location, '/profile/meera');
    expect(linkTargetFor(Uri.parse('${Brand.scheme}://r/abc'))?.telemetryPath, '/r/:id');
    expect(linkTargetFor(Uri.parse('https://${Brand.domain}/wallet?topup=1'))?.location, '/wallet');
    expect(linkTargetFor(Uri.parse('https://example.com/h/meera')), isNull);
    expect(linkTargetFor(Uri.parse('https://${Brand.domain}/admin/users')), isNull);
    expect(linkTargetFor(Uri.parse('https://${Brand.domain}/help')), isNull);
  });
}
