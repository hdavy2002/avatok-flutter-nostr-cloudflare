import 'dart:async';
import 'dart:typed_data';

import 'package:hf_app/core/api/api_client.dart';
import 'package:hf_app/core/api/api_error.dart';

/// One call the code under test made.
class RecordedCall {
  RecordedCall(this.method, this.path, this.query, this.body, this.auth, this.idempotencyKey);
  final String method;
  final String path;
  final Map<String, Object?>? query;
  final Object? body;
  final bool auth;
  final String? idempotencyKey;

  @override
  String toString() => '$method $path';
}

typedef FakeHandler = FutureOr<Object?> Function(RecordedCall call);

/// An [ApiClient] that never touches the network. Stub routes, run the screen, assert the calls.
///
/// ```dart
/// final api = FakeApiClient()
///   ..onJson('GET', '/api/hf/hosts', {'hosts': []})
///   ..onError('POST', '/api/hf/calls', const ApiError(status: 402, code: 'low_balance'));
/// // overrides: [apiClientProvider.overrideWithValue(api)]
/// expect(api.calls.map((c) => c.toString()), contains('GET /api/hf/hosts'));
/// ```
/// A call with no stub throws a clear [StateError], so a missing stub never hides as a silent empty list.
class FakeApiClient extends ApiClient {
  FakeApiClient();

  final List<RecordedCall> calls = <RecordedCall>[];
  final Map<String, FakeHandler> _routes = <String, FakeHandler>{};

  /// Answer `method path` (path without query string) with [handler].
  void on(String method, String path, FakeHandler handler) => _routes['${method.toUpperCase()} $path'] = handler;

  /// Answer with a JSON value (a Map or a List).
  void onJson(String method, String path, Object? json) => on(method, path, (_) => json);

  /// Answer with an [ApiError].
  void onError(String method, String path, ApiError error) => on(method, path, (_) => throw error);

  /// Calls to `method path` so far.
  List<RecordedCall> callsTo(String method, String path) =>
      calls.where((c) => c.method == method.toUpperCase() && c.path == path).toList();

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
    final call = RecordedCall(method.toUpperCase(), path, query, body ?? bytes, auth, idempotencyKey);
    calls.add(call);
    final handler = _routes['${call.method} $path'];
    if (handler == null) {
      throw StateError('FakeApiClient: no stub for ${call.method} $path. Add api.onJson(...) to the test.');
    }
    return await handler(call);
  }
}
