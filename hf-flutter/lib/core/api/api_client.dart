import 'dart:async';
import 'dart:convert';
import 'dart:io' show IOException;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../analytics/analytics.dart';
import '../env.dart';
import 'api_error.dart';

/// Where the API client gets the Clerk session JWT (the Worker's Bearer token).
abstract interface class AuthTokens {
  /// A valid session JWT, or null when signed out. [forceRefresh] bypasses the cache (used after a 401).
  Future<String?> sessionToken({bool forceRefresh = false});
}

/// Everything the app needs from the worker API. Screens depend on THIS abstract class, never on
/// the HTTP implementation, so widget tests swap in `FakeApiClient` with one provider override:
///
/// ```dart
/// ProviderScope(overrides: [apiClientProvider.overrideWithValue(FakeApiClient()..on('GET', '/api/x', ...))])
/// ```
///
/// Subclasses implement [request]; the typed helpers below are shared.
abstract class ApiClient {
  const ApiClient();

  /// One HTTP call. Returns the decoded JSON body (a `Map` or a `List`; an empty 2xx body is `{}`).
  /// Throws [ApiError] for every non-2xx answer and every network failure.
  ///
  /// - [query]: values are stringified; nulls are skipped.
  /// - [body]: encoded as JSON. For raw uploads pass [bytes] and a [contentType] instead.
  /// - [auth]: false for public routes (no Bearer header, no 401 handling).
  /// - [idempotencyKey]: sent as `Idempotency-Key` (wallet refunds, withdrawals, account exit).
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    Uint8List? bytes,
    String? contentType,
    Map<String, String>? headers,
    bool auth = true,
    String? idempotencyKey,
    void Function(int sent, int total)? onProgress,
  });

  Future<Map<String, dynamic>> getJson(String path,
      {Map<String, Object?>? query, bool auth = true}) async =>
      asMap(await request('GET', path, query: query, auth: auth));

  Future<List<dynamic>> getList(String path,
      {Map<String, Object?>? query, bool auth = true}) async {
    final v = await request('GET', path, query: query, auth: auth);
    if (v is List) return v;
    throw ApiError.badResponse(200);
  }

  Future<Map<String, dynamic>> postJson(String path,
      {Object? body, Map<String, Object?>? query, bool auth = true, String? idempotencyKey}) async =>
      asMap(await request('POST', path,
          body: body ?? const <String, Object?>{}, query: query, auth: auth, idempotencyKey: idempotencyKey));

  Future<Map<String, dynamic>> putJson(String path,
      {Object? body, bool auth = true, String? idempotencyKey}) async =>
      asMap(await request('PUT', path, body: body ?? const <String, Object?>{}, auth: auth, idempotencyKey: idempotencyKey));

  Future<Map<String, dynamic>> patchJson(String path, {Object? body, bool auth = true}) async =>
      asMap(await request('PATCH', path, body: body ?? const <String, Object?>{}, auth: auth));

  Future<Map<String, dynamic>> deleteJson(String path,
      {Object? body, Map<String, Object?>? query, bool auth = true}) async =>
      asMap(await request('DELETE', path, body: body, query: query, auth: auth));

  /// Raw upload (selfie video, voice intro): [bytes] with a [contentType] and extra [headers]
  /// (`x-selfie-code`, `x-duration-seconds`, ...). 60 s timeout, with progress.
  Future<Map<String, dynamic>> uploadBytes(
    String method,
    String path, {
    required Uint8List bytes,
    required String contentType,
    Map<String, String>? headers,
    void Function(int sent, int total)? onProgress,
  }) async =>
      asMap(await request(method, path,
          bytes: bytes, contentType: contentType, headers: headers, onProgress: onProgress));

  /// Narrow a decoded body to a JSON object, or throw `bad_response`.
  static Map<String, dynamic> asMap(Object? v) {
    if (v is Map<String, dynamic>) return v;
    if (v is Map) return Map<String, dynamic>.from(v);
    throw ApiError.badResponse(200);
  }
}

/// One finished call, for telemetry.
class ApiCallReport {
  const ApiCallReport({required this.endpoint, required this.status, required this.code, required this.ms});
  final String endpoint;
  final int status;
  final String? code;
  final int ms;
}

/// The real client: `http`, a Clerk Bearer token, JSON, timeouts, one retry on 401.
///
/// - Base: `Env.apiOrigin` (https://api.<domain>, from Brand).
/// - Headers: `Authorization: Bearer <jwt>`, `Accept: application/json`, `X-Client: hf-android/<versionCode>`.
/// - Timeouts: 15 s, 60 s for uploads.
/// - A 401 forces ONE token refresh and ONE retry. If that fails, [onSessionLost] runs (sign out) and the
///   [ApiError] is thrown.
/// - Failures are reported through `Analytics.apiError({endpoint, status, code, ms})`. A `404 not_enabled`
///   is NOT reported: it is a normal flag-off state.
class HttpApiClient extends ApiClient {
  HttpApiClient({
    this.tokens,
    http.Client? client,
    this.onSessionLost,
    ApiReporter? reporter,
    String? origin,
  })  : _http = client ?? http.Client(),
        _reporter = reporter ?? _defaultReporter,
        _origin = origin ?? Env.apiOrigin;

  final AuthTokens? tokens;
  final Future<void> Function()? onSessionLost;
  final http.Client _http;
  final ApiReporter _reporter;
  final String _origin;

  static const Duration _timeout = Duration(seconds: 15);
  static const Duration _uploadTimeout = Duration(seconds: 60);

  static void _defaultReporter(ApiCallReport r) {
    Analytics.apiError(endpoint: r.endpoint, status: r.status, code: r.code, ms: r.ms);
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

  /// `X-Client` value: `hf-android/<versionCode>` (versionCode is -1 until resolved).
  String get _xClient => 'hf-android/${Analytics.appBuild}';

  @override
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    Uint8List? bytes,
    String? contentType,
    Map<String, String>? headers,
    bool auth = true,
    String? idempotencyKey,
    void Function(int sent, int total)? onProgress,
  }) async {
    final sw = Stopwatch()..start();
    // Endpoint for telemetry: the path without the query (no ids are stripped here; the worker's
    // own paths carry slugs and call ids, which are not secrets).
    final endpoint = '$method ${path.split('?').first}';
    try {
      var token = auth ? await tokens?.sessionToken() : null;
      var resp = await _send(method, path, query, body, bytes, contentType, headers, token, idempotencyKey, onProgress);
      if (resp.statusCode == 401 && auth && tokens != null) {
        final fresh = await tokens!.sessionToken(forceRefresh: true);
        if (fresh != null && fresh != token) {
          token = fresh;
          resp = await _send(method, path, query, body, bytes, contentType, headers, token, idempotencyKey, onProgress);
        }
        if (resp.statusCode == 401) {
          final err = ApiError.fromResponse(401, utf8.decode(resp.bodyBytes, allowMalformed: true));
          _report(endpoint, err, sw);
          await onSessionLost?.call();
          throw err;
        }
      }
      final text = utf8.decode(resp.bodyBytes, allowMalformed: true);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final err = ApiError.fromResponse(resp.statusCode, text);
        if (!err.isNotEnabled) _report(endpoint, err, sw);
        throw err;
      }
      if (text.trim().isEmpty) return <String, dynamic>{};
      try {
        return jsonDecode(text);
      } catch (_) {
        final err = ApiError.badResponse(resp.statusCode);
        _report(endpoint, err, sw);
        throw err;
      }
    } on ApiError {
      rethrow;
    } on TimeoutException {
      final err = ApiError.timeout();
      _report(endpoint, err, sw);
      throw err;
    } on IOException {
      final err = ApiError.network();
      _report(endpoint, err, sw);
      throw err;
    } on http.ClientException {
      final err = ApiError.network();
      _report(endpoint, err, sw);
      throw err;
    }
  }

  void _report(String endpoint, ApiError err, Stopwatch sw) {
    try {
      _reporter(ApiCallReport(endpoint: endpoint, status: err.status, code: err.code, ms: sw.elapsedMilliseconds));
    } catch (_) {
      // telemetry never throws into a request
    }
  }

  Future<http.Response> _send(
    String method,
    String path,
    Map<String, Object?>? query,
    Object? body,
    Uint8List? bytes,
    String? contentType,
    Map<String, String>? extraHeaders,
    String? token,
    String? idempotencyKey,
    void Function(int sent, int total)? onProgress,
  ) async {
    final uri = _uri(path, query);
    final headers = <String, String>{
      'Accept': 'application/json',
      'X-Client': _xClient,
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
      ...?extraHeaders,
    };
    if (bytes != null) {
      headers['Content-Type'] = contentType ?? 'application/octet-stream';
      // StreamedRequest, so an upload can report progress.
      final req = http.StreamedRequest(method, uri)..headers.addAll(headers);
      req.contentLength = bytes.length;
      final total = bytes.length;
      unawaited(() async {
        const chunk = 64 * 1024;
        var sent = 0;
        while (sent < total) {
          final end = (sent + chunk) > total ? total : sent + chunk;
          req.sink.add(bytes.sublist(sent, end));
          sent = end;
          onProgress?.call(sent, total);
          await Future<void>.delayed(Duration.zero);
        }
        await req.sink.close();
      }());
      final streamed = await _http.send(req).timeout(_uploadTimeout);
      return http.Response.fromStream(streamed).timeout(_uploadTimeout);
    }
    final req = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) {
      req.headers['Content-Type'] = 'application/json; charset=utf-8';
      req.body = jsonEncode(body);
    }
    final streamed = await _http.send(req).timeout(_timeout);
    return http.Response.fromStream(streamed).timeout(_timeout);
  }
}

typedef ApiReporter = void Function(ApiCallReport report);
