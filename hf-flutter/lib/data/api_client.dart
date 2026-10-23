import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/brand.dart';
import 'api_exception.dart';
import 'response_cache.dart';
import 'telemetry.dart';

/// Where the client gets the Clerk session JWT (the Worker's Bearer token). Null means signed out.
/// [forceRefresh] bypasses any cache; it is used once after a 401.
typedef TokenProvider = Future<String?> Function({bool forceRefresh});

/// Called for every failed call (not for a flag-off 404). Defaults to [Telemetry.reportFetchFailure].
typedef FailureReporter = void Function(String method, String endpoint, ApiException error, int ms);

/// The one HTTP client for the worker API: base URL from the brand file, Clerk Bearer JWT, JSON,
/// timeouts, typed errors. Repositories take an [ApiClient]; tests pass a `MockClient`.
///
/// - A 401 forces ONE token refresh and ONE retry. If it is still 401, [onSessionLost] runs and the
///   [ApiException] is thrown.
/// - No answer (no network, dropped connection, timeout) is [ApiFailure.offline].
class ApiClient {
  ApiClient({
    http.Client? client,
    this.tokens,
    this.onSessionLost,
    FailureReporter? reporter,
    String? origin,
    this.timeout = const Duration(seconds: 15),
    this.clientTag = 'hf-android',
    ResponseCache? cache,
    this.accountId,
    this.retryDelay = const Duration(milliseconds: 700),
  })  : cache = cache ?? ResponseCache(),
        _http = client ?? http.Client(),
        _origin = origin ?? Brand.apiOrigin,
        _reporter = reporter ?? _defaultReporter;

  final TokenProvider? tokens;
  final Future<void> Function()? onSessionLost;
  final Duration timeout;
  final String clientTag;

  /// [HF-APP-CACHE-1] The read cache (memory only unless the app passes a persistent one) and the id of the signed-in account that
  /// scopes it. A signed-in read with no account id is never cached.
  final ResponseCache cache;
  final String? Function()? accountId;

  /// Pause before the one automatic second try of a cached-read refresh that failed momentarily ([watchJson]).
  final Duration retryDelay;
  final Map<String, Future<Map<String, dynamic>>> _inflight = {};
  final http.Client _http;
  final String _origin;
  final FailureReporter _reporter;

  static void _defaultReporter(String method, String endpoint, ApiException e, int ms) {
    Telemetry.reportFetchFailure(method: method, endpoint: endpoint, status: e.status, code: e.code, ms: ms);
  }

  Uri _uri(String path, Map<String, Object?>? query) {
    final base = Uri.parse('$_origin$path');
    if (query == null || query.isEmpty) return base;
    final merged = <String, String>{...base.queryParameters};
    query.forEach((k, v) {
      if (v != null) merged[k] = v.toString();
    });
    return base.replace(queryParameters: merged);
  }

  /// One call. Returns the decoded JSON (`Map` or `List`; an empty 2xx body is `{}`).
  /// Throws [ApiException] for every failure.
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    bool auth = true,
    Map<String, String>? headers,
  }) async {
    final account = accountId?.call();
    final epoch = cache.accountGeneration;
    void checkAccount() {
      if (auth && (account != accountId?.call() || epoch != cache.accountGeneration)) {
        throw const ApiException(kind: ApiFailure.http, code: 'stale_session');
      }
    }
    final sw = Stopwatch()..start();
    final endpoint = path.split('?').first;
    try {
      final provider = auth ? tokens : null;
      var token = provider == null ? null : await provider();
      checkAccount();
      var resp = await _send(method, path, query, body, headers, token);
      checkAccount();
      if (resp.statusCode == 401 && provider != null) {
        final fresh = await provider(forceRefresh: true);
        checkAccount();
        if (fresh != null && fresh != token) {
          token = fresh;
          resp = await _send(method, path, query, body, headers, token);
        }
        checkAccount();
        if (resp.statusCode == 401) {
          final err = ApiException.fromResponse(401, utf8.decode(resp.bodyBytes, allowMalformed: true));
          _report(method, endpoint, err, sw);
          try {
            await onSessionLost?.call();
          } catch (_) {
            // a failing hook never hides the 401
          }
          throw err;
        }
      }
      final text = utf8.decode(resp.bodyBytes, allowMalformed: true);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final err = ApiException.fromResponse(resp.statusCode, text);
        if (!err.isNotEnabled) _report(method, endpoint, err, sw);
        throw err;
      }
      _afterOk(method, endpoint);
      if (text.trim().isEmpty) return <String, dynamic>{};
      try {
        return jsonDecode(text);
      } catch (_) {
        final err = ApiException.parse(resp.statusCode);
        _report(method, endpoint, err, sw);
        throw err;
      }
    } on ApiException {
      rethrow;
    } on TimeoutException {
      final err = ApiException.offline(timeout: true);
      _report(method, endpoint, err, sw);
      throw err;
    } on Exception {
      // http.ClientException, socket and TLS failures: there was no usable answer.
      final err = ApiException.offline();
      _report(method, endpoint, err, sw);
      throw err;
    }
  }

  /// [HF-APP-CACHE-1] A write call went through: forget cached reads (wallet, bookings, me, availability, slots...) so no screen
  /// shows a number from before it. Counting a reel view is not a change anyone sees.
  void _afterOk(String method, String endpoint) {
    if (method == 'GET' || method == 'HEAD' || endpoint.endsWith('/view')) return;
    unawaited(cache.invalidateAfterWrite());
  }

  void _report(String method, String endpoint, ApiException err, Stopwatch sw) {
    try {
      _reporter(method, endpoint, err, sw.elapsedMilliseconds);
    } catch (_) {
      // telemetry never throws into a request
    }
  }

  Future<http.Response> _send(
    String method,
    String path,
    Map<String, Object?>? query,
    Object? body,
    Map<String, String>? extraHeaders,
    String? token,
  ) async {
    final req = http.Request(method, _uri(path, query));
    req.headers.addAll({
      'Accept': 'application/json',
      'X-Client': clientTag,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      ...?extraHeaders,
    });
    if (body != null) {
      req.headers['Content-Type'] = 'application/json; charset=utf-8';
      req.body = jsonEncode(body);
    }
    final streamed = await _http.send(req).timeout(timeout);
    return http.Response.fromStream(streamed).timeout(timeout);
  }

  /// [store] true keeps the answer in the read cache for [peekJson] / [watchJson] (write-through). Default off, so existing
  /// callers behave exactly as before.
  Future<Map<String, dynamic>> getJson(String path, {Map<String, Object?>? query, bool auth = true, bool store = false}) async {
    final key = store ? _keyOf(path, query, auth) : null;
    final account = accountId?.call();
    final epoch = cache.accountGeneration;
    final gen = cache.generation;
    final j = asMap(await request('GET', path, query: query, auth: auth));
    if (auth && (account != accountId?.call() || epoch != cache.accountGeneration)) {
      throw const ApiException(kind: ApiFailure.http, code: 'stale_session');
    }
    if (key != null && gen == cache.generation) await cache.write(key, j);
    if (auth && (account != accountId?.call() || epoch != cache.accountGeneration)) {
      throw const ApiException(kind: ApiFailure.http, code: 'stale_session');
    }
    return j;
  }

  String? _keyOf(String path, Map<String, Object?>? query, bool auth) {
    String? scope;
    if (!auth) {
      scope = 'pub';
    } else {
      final id = accountId?.call();
      if (id != null && id.isNotEmpty) scope = 'u:$id';
    }
    return scope == null ? null : cache.keyFor(scope, path, query);
  }

  /// The last stored answer for this GET (any age up to [maxAge]), or null. Never touches the network.
  Future<Map<String, dynamic>?> peekJson(String path,
      {Map<String, Object?>? query, bool auth = true, Duration maxAge = const Duration(days: 3)}) async {
    final key = _keyOf(path, query, auth);
    if (key == null) return null;
    final epoch = cache.accountGeneration;
    final hit = await cache.read(key, maxAge);
    if (auth && (key != _keyOf(path, query, auth) || epoch != cache.accountGeneration)) return null;
    final j = hit?.json;
    return j is Map ? Map<String, dynamic>.from(j) : null;
  }

  /// [HF-APP-CACHE-1] Stale-while-revalidate read. Emits the cached answer first (when there is one inside [policy].maxAge), then the
  /// fresh one if it differs. A cached answer younger than [policy].fresh is the only emission. If the network fails after a cached
  /// answer was shown, the error is swallowed (the person keeps what they see); with nothing shown, it is thrown like [getJson].
  /// One automatic retry on a momentary failure when [retry]. Concurrent watchers of the same URL share one request.
  Stream<Map<String, dynamic>> watchJson(
    String path, {
    Map<String, Object?>? query,
    bool auth = true,
    CachePolicy policy = CachePolicy.list,
    bool retry = true,
  }) async* {
    final key = _keyOf(path, query, auth);
    final account = accountId?.call();
    final epoch = cache.accountGeneration;
    bool current() => !auth || (account == accountId?.call() && epoch == cache.accountGeneration);
    CacheHit? hit;
    String? shown;
    if (key != null) {
      final h = await cache.read(key, policy.maxAge);
      if (!current()) return;
      if (h != null && h.json is Map) {
        hit = h;
        shown = jsonEncode(h.json);
        yield Map<String, dynamic>.from(h.json as Map);
        if (cache.now().difference(h.at) < policy.fresh) {
          Telemetry.cacheOutcome(path, 'hit_fresh', ageSeconds: cache.now().difference(h.at).inSeconds);
          return;
        }
      }
    }
    try {
      if (!current()) return;
      final fresh = await _fetchShared(path, query, auth, key, retry);
      if (!current()) return;
      Telemetry.cacheOutcome(path, hit == null ? 'miss' : 'revalidated',
          ageSeconds: hit == null ? null : cache.now().difference(hit.at).inSeconds);
      if (hit == null || jsonEncode(fresh) != shown) yield fresh;
    } on ApiException {
      if (!current()) return;
      if (hit == null) rethrow;
      Telemetry.cacheOutcome(path, 'stale_on_error');
    }
  }

  Future<Map<String, dynamic>> _fetchShared(String path, Map<String, Object?>? query, bool auth, String? key, bool retry) async {
    if (key == null) return _fetchOnce(path, query, auth, null, retry);
    final inflightKey = '$key|${cache.accountGeneration}';
    final running = _inflight[inflightKey];
    if (running != null) return running;
    final f = _fetchOnce(path, query, auth, key, retry);
    _inflight[inflightKey] = f;
    try {
      return await f;
    } finally {
      if (identical(_inflight[inflightKey], f)) _inflight.remove(inflightKey);
    }
  }

  Future<Map<String, dynamic>> _fetchOnce(String path, Map<String, Object?>? query, bool auth, String? key, bool retry) async {
    final gen = cache.generation;
    final account = accountId?.call();
    final epoch = cache.accountGeneration;
    Future<Map<String, dynamic>> go() async {
      if (auth && (account != accountId?.call() || epoch != cache.accountGeneration)) {
        throw const ApiException(kind: ApiFailure.http, code: 'stale_session');
      }
      return asMap(await request('GET', path, query: query, auth: auth));
    }
    Map<String, dynamic> j;
    try {
      j = await go();
    } on ApiException catch (e) {
      if (!retry || !e.isTransient) rethrow;
      await Future<void>.delayed(retryDelay);
      j = await go();
    }
    if (auth && (account != accountId?.call() || epoch != cache.accountGeneration)) {
      throw const ApiException(kind: ApiFailure.http, code: 'stale_session');
    }
    if (key != null && gen == cache.generation) await cache.write(key, j);
    return j;
  }

  /// [HF-MERCH-APP-1] One raw upload (art, print file, mockup): the body is the file's own bytes, [contentType] says what they are, and
  /// the answer is the usual JSON object. Same sign-in, one refresh on a 401, typed errors and failure report as [request]; a longer
  /// timeout because a photo is bigger than a JSON body. Throws [ApiException].
  Future<Map<String, dynamic>> postBytes(
    String path,
    List<int> bytes, {
    required String contentType,
    Map<String, String>? headers,
    Duration uploadTimeout = const Duration(seconds: 90),
  }) async {
    final sw = Stopwatch()..start();
    final endpoint = path.split('?').first;
    try {
      final provider = tokens;
      var token = provider == null ? null : await provider();
      var resp = await _sendBytes(path, bytes, contentType, headers, token, uploadTimeout);
      if (resp.statusCode == 401 && provider != null) {
        final fresh = await provider(forceRefresh: true);
        if (fresh != null && fresh != token) {
          token = fresh;
          resp = await _sendBytes(path, bytes, contentType, headers, token, uploadTimeout);
        }
        if (resp.statusCode == 401) {
          final err = ApiException.fromResponse(401, utf8.decode(resp.bodyBytes, allowMalformed: true));
          _report('POST', endpoint, err, sw);
          try {
            await onSessionLost?.call();
          } catch (_) {
            // a failing hook never hides the 401
          }
          throw err;
        }
      }
      final text = utf8.decode(resp.bodyBytes, allowMalformed: true);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final err = ApiException.fromResponse(resp.statusCode, text);
        if (!err.isNotEnabled) _report('POST', endpoint, err, sw);
        throw err;
      }
      unawaited(cache.invalidateAfterWrite());
      Object? decoded;
      try {
        decoded = text.trim().isEmpty ? <String, dynamic>{} : jsonDecode(text);
      } catch (_) {
        final err = ApiException.parse(resp.statusCode);
        _report('POST', endpoint, err, sw);
        throw err;
      }
      return asMap(decoded);
    } on ApiException {
      rethrow;
    } on TimeoutException {
      final err = ApiException.offline(timeout: true);
      _report('POST', endpoint, err, sw);
      throw err;
    } on Exception {
      final err = ApiException.offline();
      _report('POST', endpoint, err, sw);
      throw err;
    }
  }

  Future<http.Response> _sendBytes(
    String path,
    List<int> bytes,
    String contentType,
    Map<String, String>? extraHeaders,
    String? token,
    Duration limit,
  ) async {
    final req = http.Request('POST', _uri(path, null));
    req.headers.addAll({
      'Accept': 'application/json',
      'X-Client': clientTag,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      ...?extraHeaders,
      'Content-Type': contentType,
    });
    req.bodyBytes = bytes;
    final streamed = await _http.send(req).timeout(limit);
    return http.Response.fromStream(streamed).timeout(limit);
  }

  /// [HF-CHANNEL-APP-1] One raw PUT upload (the influencer's profile photo): the body is the file's own bytes and [contentType] says
  /// what they are. Same sign-in, one refresh on a 401, typed errors and failure report as [postBytes]. Throws [ApiException].
  Future<Map<String, dynamic>> putBytes(
    String path,
    List<int> bytes, {
    required String contentType,
    Duration uploadTimeout = const Duration(seconds: 90),
  }) async {
    final sw = Stopwatch()..start();
    final endpoint = path.split('?').first;
    try {
      final provider = tokens;
      var token = provider == null ? null : await provider();
      var resp = await _sendBytesAs('PUT', path, bytes, contentType, token, uploadTimeout);
      if (resp.statusCode == 401 && provider != null) {
        final fresh = await provider(forceRefresh: true);
        if (fresh != null && fresh != token) {
          token = fresh;
          resp = await _sendBytesAs('PUT', path, bytes, contentType, token, uploadTimeout);
        }
        if (resp.statusCode == 401) {
          final err = ApiException.fromResponse(401, utf8.decode(resp.bodyBytes, allowMalformed: true));
          _report('PUT', endpoint, err, sw);
          try {
            await onSessionLost?.call();
          } catch (_) {
            // a failing hook never hides the 401
          }
          throw err;
        }
      }
      final text = utf8.decode(resp.bodyBytes, allowMalformed: true);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final err = ApiException.fromResponse(resp.statusCode, text);
        if (!err.isNotEnabled) _report('PUT', endpoint, err, sw);
        throw err;
      }
      unawaited(cache.invalidateAfterWrite());
      Object? decoded;
      try {
        decoded = text.trim().isEmpty ? <String, dynamic>{} : jsonDecode(text);
      } catch (_) {
        final err = ApiException.parse(resp.statusCode);
        _report('PUT', endpoint, err, sw);
        throw err;
      }
      return asMap(decoded);
    } on ApiException {
      rethrow;
    } on TimeoutException {
      final err = ApiException.offline(timeout: true);
      _report('PUT', endpoint, err, sw);
      throw err;
    } on Exception {
      final err = ApiException.offline();
      _report('PUT', endpoint, err, sw);
      throw err;
    }
  }

  Future<http.Response> _sendBytesAs(String method, String path, List<int> bytes, String contentType, String? token, Duration limit) async {
    final req = http.Request(method, _uri(path, null));
    req.headers.addAll({
      'Accept': 'application/json',
      'X-Client': clientTag,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      'Content-Type': contentType,
    });
    req.bodyBytes = bytes;
    final streamed = await _http.send(req).timeout(limit);
    return http.Response.fromStream(streamed).timeout(limit);
  }

  Future<List<dynamic>> getList(String path, {Map<String, Object?>? query, bool auth = true}) async {
    final v = await request('GET', path, query: query, auth: auth);
    if (v is List) return v;
    throw ApiException.parse(200);
  }

  Future<Map<String, dynamic>> postJson(String path, {Object? body, bool auth = true}) async =>
      asMap(await request('POST', path, body: body ?? const <String, Object?>{}, auth: auth));

  Future<Map<String, dynamic>> patchJson(String path, {Object? body, bool auth = true}) async =>
      asMap(await request('PATCH', path, body: body ?? const <String, Object?>{}, auth: auth));

  Future<Map<String, dynamic>> putJson(String path, {Object? body, bool auth = true}) async =>
      asMap(await request('PUT', path, body: body ?? const <String, Object?>{}, auth: auth));

  Future<Map<String, dynamic>> deleteJson(String path, {Object? body, bool auth = true}) async =>
      asMap(await request('DELETE', path, body: body, auth: auth));

  /// Narrow a decoded body to a JSON object, or throw a parse error.
  static Map<String, dynamic> asMap(Object? v) {
    if (v is Map<String, dynamic>) return v;
    if (v is Map) return Map<String, dynamic>.from(v);
    throw ApiException.parse(200);
  }
}
