// Phase 7 — AvaLive + AvaConsult delivery API + the session room WebSocket.
//
// One multiplexed WS per room (perf budget: no second realtime channel): the
// server batches low-value events (reactions / flying messages / stickers /
// viewer ticks / donation banners) into ≥250 ms frames; RoomChannel unpacks the
// batch and fans events to one listener.
import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'api_auth.dart';
import 'config.dart';

class SessionApi {
  static String get _base => kApiBase;

  static Future<Map<String, dynamic>> _get(String url) async {
    final r = await ApiAuth.getSigned(url);
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode >= 300) throw SessionApiError(r.statusCode, j['error']?.toString() ?? 'HTTP ${r.statusCode}', j);
    return j;
  }

  static Future<Map<String, dynamic>> _post(String url, [Map<String, dynamic> body = const {}]) async {
    final r = await ApiAuth.postJson(url, body);
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode >= 300) throw SessionApiError(r.statusCode, j['error']?.toString() ?? 'HTTP ${r.statusCode}', j);
    return j;
  }

  // ---- AvaLive -------------------------------------------------------------
  static Future<Map<String, dynamic>> liveStart(String listingId) => _post('$_base/live/$listingId/start');
  static Future<Map<String, dynamic>> liveStop(String listingId) => _post('$_base/live/$listingId/stop');
  static Future<Map<String, dynamic>> liveJoin(String listingId) => _get('$_base/live/$listingId/join');
  static Future<Map<String, dynamic>> liveState(String listingId) => _get('$_base/live/$listingId/state');
  static Future<Map<String, dynamic>> donate(String listingId, int amount) =>
      _post('$_base/live/$listingId/donate', {'amount': amount});
  static Future<void> mod(String listingId, String action, {String? target, int? sec, String? text}) =>
      _post('$_base/live/$listingId/mod', {'action': action, if (target != null) 'target': target, if (sec != null) 'sec': sec, if (text != null) 'text': text});

  static Uri liveRoomWs(String listingId, String token) =>
      Uri.parse('wss://$kSignalingHost/api/live/$listingId/room?token=$token');

  // ---- AvaConsult ----------------------------------------------------------
  static Future<Map<String, dynamic>> consultJoin(String bookingId) => _get('$_base/consult/$bookingId/join');
  static Future<Map<String, dynamic>> consultComplete(String bookingId) => _post('$_base/consult/$bookingId/complete');
  static Future<Map<String, dynamic>> consultCancel(String bookingId) => _post('$_base/consult/$bookingId/cancel');
  static Future<Map<String, dynamic>> consultExtend(String bookingId) => _post('$_base/consult/$bookingId/extend');

  static Uri consultRoomWs(String bookingId, String token) =>
      Uri.parse('wss://$kSignalingHost/api/consult/$bookingId/room?token=$token');

  /// Cloudflare Realtime SFU (group consults) — authed proxy on the Worker.
  static Future<Map<String, dynamic>> sfu(String bookingId, String token, String path,
      {Map<String, dynamic>? body, String method = 'POST'}) async {
    final url = '$_base/consult/$bookingId/sfu$path';
    // Always POST to the Worker; x-sfu-method carries the real upstream verb
    // (the proxy rewrites it — keeps NIP-98 signing on one code path).
    final r = await ApiAuth.postJsonH(url, body ?? {}, {
      'x-session-token': token,
      if (method != 'POST') 'x-sfu-method': method,
    });
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode >= 300) throw SessionApiError(r.statusCode, j['errorDescription']?.toString() ?? 'SFU ${r.statusCode}', j);
    return j;
  }

  // ---- Pre-call network probe (A3) ----------------------------------------
  /// RTT to the worker + a ~2 s bandwidth estimate → green/yellow/red verdict.
  static Future<NetProbe> probe() async {
    final sw = Stopwatch()..start();
    await ApiAuth.getSigned('$_base/consult/probe');
    final rtt = sw.elapsedMilliseconds;
    sw.reset();
    int bytes = 0;
    try {
      final r = await ApiAuth.getBytes('$_base/consult/probe/blob').timeout(const Duration(seconds: 4));
      bytes = r.bodyBytes.length;
    } catch (_) {/* slow network: verdict from rtt alone */}
    final ms = sw.elapsedMilliseconds.clamp(1, 1 << 30);
    final kbps = bytes > 0 ? (bytes * 8 / ms).round() : 0; // kbit/s
    return NetProbe(rttMs: rtt, kbps: kbps);
  }
}

class SessionApiError implements Exception {
  final int status;
  final String message;
  final Map<String, dynamic> body;
  SessionApiError(this.status, this.message, this.body);
  @override
  String toString() => message;
}

class NetProbe {
  final int rttMs;
  final int kbps;
  NetProbe({required this.rttMs, required this.kbps});

  /// green / yellow / red with a plain-language tip.
  String get verdict {
    if (rttMs < 150 && kbps > 1500) return 'green';
    if (rttMs < 400 && kbps > 500) return 'yellow';
    return 'red';
  }

  String get tip => switch (verdict) {
        'green' => 'Connection looks great.',
        'yellow' => 'Connection is okay — move closer to Wi-Fi for best quality.',
        _ => 'Weak connection. Move closer to Wi-Fi or switch networks before joining.',
      };
}

/// The session room WS: unpacks server batches, auto-reconnects (rejoin within
/// the entitlement is always allowed — same identity, A3).
class RoomChannel {
  final Uri uri;
  final void Function(Map<String, dynamic> event) onEvent;
  final void Function(bool connected)? onState;
  WebSocketChannel? _ch;
  bool _closed = false;
  int _backoff = 1;

  RoomChannel(this.uri, this.onEvent, {this.onState}) {
    _connect();
  }

  void _connect() {
    if (_closed) return;
    try {
      final ch = WebSocketChannel.connect(uri);
      _ch = ch;
      ch.stream.listen((raw) {
        _backoff = 1;
        onState?.call(true);
        try {
          final m = jsonDecode(raw as String) as Map<String, dynamic>;
          if (m['type'] == 'batch') {
            for (final e in (m['events'] as List? ?? const [])) {
              if (e is Map<String, dynamic>) onEvent(e);
            }
          } else {
            onEvent(m);
          }
        } catch (_) {/* ignore malformed */}
      }, onDone: _retry, onError: (_) => _retry());
    } catch (_) {
      _retry();
    }
  }

  void _retry() {
    onState?.call(false);
    if (_closed) return;
    Future.delayed(Duration(seconds: _backoff), _connect);
    _backoff = (_backoff * 2).clamp(1, 15);
  }

  void send(Map<String, dynamic> msg) {
    try { _ch?.sink.add(jsonEncode(msg)); } catch (_) {/* reconnect path */}
  }

  void close() {
    _closed = true;
    try { _ch?.sink.close(); } catch (_) {}
  }
}
