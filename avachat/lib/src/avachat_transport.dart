// AvaChat transport adapter (Phase: identity).
//
// Two auth surfaces in the AvaTalk backend:
//   1. Relay websocket -> NIP-42 AUTH (handled inside 0xchat's Connect).
//   2. HTTP control plane -> EVERY mutation carries a NIP-98 (kind-27235) signed
//      event in the `X-Nostr-Auth` header (base64(JSON(event))), exactly matching
//      the existing app's ApiAuth contract. A Clerk JWT is attached as
//      `Authorization: Bearer <jwt>` when available (optional).
//
// Header name is `X-Nostr-Auth` (NOT `Authorization: Nostr`) — that is what the
// avatok-api Worker reads.

import 'dart:convert';
import 'dart:math';

import 'package:bip340/bip340.dart' as bip340;
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'avachat_config.dart';
import 'avachat_identity.dart';
import 'avachat_secure_scope.dart';

class AvaChatTransport {
  AvaChatTransport._();
  static final AvaChatTransport instance = AvaChatTransport._();

  /// Signed POST with a JSON body. Returns the raw response.
  static Future<http.Response> postJson(String url, Object body,
      {Duration timeout = const Duration(seconds: 12)}) async {
    final bodyStr = jsonEncode(body);
    final bytes = utf8.encode(bodyStr);
    final headers = await _headers('POST', url,
        body: bytes, base: {'Content-Type': 'application/json'});
    return http.post(Uri.parse(url), headers: headers, body: bodyStr).timeout(timeout);
  }

  /// Signed GET.
  static Future<http.Response> getSigned(String url,
      {Duration timeout = const Duration(seconds: 12)}) async {
    final headers = await _headers('GET', url);
    return http.get(Uri.parse(url), headers: headers).timeout(timeout);
  }

  static Future<Map<String, String>> _headers(String method, String url,
      {List<int>? body, Map<String, String>? base}) async {
    final h = <String, String>{...?base};
    final n = _nip98(method, url, body: body);
    if (n != null) h['X-Nostr-Auth'] = n;
    final jwt = await _clerkJwt();
    if (jwt != null && jwt.isNotEmpty) h['Authorization'] = 'Bearer $jwt';
    return h;
  }

  /// base64(JSON(signed kind-27235 event)) with u/method/(payload) tags.
  static String? _nip98(String method, String url, {List<int>? body}) {
    final priv = AvaChatIdentity.instance.activePrivHex;
    if (priv == null || priv.isEmpty) return null;
    final pub = bip340.getPublicKey(priv);
    final tags = <List<String>>[
      ['u', url],
      ['method', method.toUpperCase()],
    ];
    if (body != null && body.isNotEmpty) {
      tags.add(['payload', sha256.convert(body).toString()]);
    }
    final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final id = _eventId(pub, ts, 27235, tags, '');
    final sig = bip340.sign(priv, id, _randomHex(32));
    final event = {
      'id': id, 'pubkey': pub, 'created_at': ts, 'kind': 27235,
      'tags': tags, 'content': '', 'sig': sig,
    };
    return base64.encode(utf8.encode(jsonEncode(event)));
  }

  static String _eventId(
      String pub, int createdAt, int kind, List<List<String>> tags, String content) {
    final serial = jsonEncode([0, pub, createdAt, kind, tags, content]);
    return sha256.convert(utf8.encode(serial)).toString();
  }

  static String _randomHex(int n) {
    final r = Random.secure();
    return List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  static Future<String?> _clerkJwt() async {
    final s = AvaChatIdentity.instance;
    if (!s.hasScope) return null;
    // The bound scope provides the Clerk JWT when wired.
    if (AvaChatBootstrapScopeRef.scope is DeviceSecureScope) {
      return AvaChatBootstrapScopeRef.scope!.clerkJwt();
    }
    return null;
  }

  static String get relayUrl => AvaChatConfig.relayUrl;
}

/// Lets the transport reach the bound scope for the Clerk JWT without a hard ref.
class AvaChatBootstrapScopeRef {
  static AvaChatSecureScope? scope;
}
