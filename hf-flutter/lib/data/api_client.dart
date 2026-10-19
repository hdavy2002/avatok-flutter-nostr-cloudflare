import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/brand.dart';
import 'api_exception.dart';
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
  })  : _http = client ?? http.Client(),
        _origin = origin ?? Brand.apiOrigin,
        _reporter = reporter ?? _defaultReporter;

  final TokenProvider? tokens;
  final Future<void> Function()? onSessionLost;
  final Duration timeout;
  final String clientTag;
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
    final sw = Stopwatch()..start();
    final endpoint = path.split('?').first;
    try {
      final provider = auth ? tokens : null;
      var token = provider == null ? null : await provider();
      var resp = await _send(method, path, query, body, headers, token);
      if (resp.statusCode == 401 && provider != null) {
        final fresh = await provider(forceRefresh: true);
        if (fresh != null && fresh != token) {
          token = fresh;
          resp = await _send(method, path, query, body, headers, token);
        }
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

  Future<Map<String, dynamic>> getJson(String path, {Map<String, Object?>? query, bool auth = true}) async =>
      asMap(await request('GET', path, query: query, auth: auth));

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
