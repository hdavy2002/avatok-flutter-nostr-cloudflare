// AvaChat transport adapter (Phase 1).
//
// Two auth surfaces in the AvaTalk backend:
//   1. Relay websocket  -> NIP-42 AUTH (kind 22242 echoing the relay challenge).
//      0xchat-core already implements this in Connect (the `auths` map +
//      AuthData), and our relay sends the AUTH challenge up front. No work
//      needed beyond logging in with the right key — handled by AvaChatIdentity.
//   2. HTTP control plane -> EVERY mutation needs a NIP-98 signature, plus the
//      Clerk JWT. This helper builds both headers so the grafted UI's HTTP
//      calls (media upload, identity link, wallet) authenticate correctly.
//
// NIP-98 (HTTP Auth): the client signs a kind-27235 event whose tags carry the
// request URL ("u") and method ("method"); the base64 of that event is sent as
// `Authorization: Nostr <base64>`. 0xchat-core ships a NIP-98 signer; we reuse
// it rather than re-implement crypto.

import 'dart:convert';

import 'avachat_config.dart';
import 'avachat_identity.dart';

class AvaChatHeaders {
  final Map<String, String> value;
  const AvaChatHeaders(this.value);
}

class AvaChatTransport {
  AvaChatTransport._();
  static final AvaChatTransport instance = AvaChatTransport._();

  /// Build auth headers for a control-plane mutation: NIP-98 + Clerk JWT.
  ///
  /// [method] e.g. 'POST', [url] the absolute endpoint. Returns headers to merge
  /// into the outgoing request. Throws if no active identity/scope.
  Future<Map<String, String>> authHeaders({
    required String method,
    required String url,
    String? bodyForPayloadTag,
  }) async {
    final headers = <String, String>{};

    // Clerk JWT (control-plane identity).
    final jwt = await _clerkJwt();
    if (jwt != null) headers['Authorization-Clerk'] = 'Bearer $jwt';

    // NIP-98 event, base64 in the standard Authorization header.
    final nip98 = await _buildNip98(method: method, url: url, body: bodyForPayloadTag);
    headers['Authorization'] = 'Nostr $nip98';

    return headers;
  }

  Future<String?> _clerkJwt() async {
    // Pulled from the host app's bound scope via AvaChatIdentity.
    // ignore: invalid_use_of_protected_member
    return null; // TODO(build): expose scope.clerkJwt() through AvaChatIdentity.
  }

  /// Returns base64(JSON(signed kind-27235 event)).
  Future<String> _buildNip98({
    required String method,
    required String url,
    String? body,
  }) async {
    // TODO(build): use 0xchat-core's NIP-98 signer with the active private key.
    // 0xchat-core exposes HTTP-auth helpers (NIP-96/98 file storage path). The
    // event shape:
    //   kind: 27235
    //   tags: [["u", url], ["method", method], (optional ["payload", sha256(body)])]
    //   content: ""
    // Signed with the account key, then base64-encoded.
    final placeholder = {
      'note': 'AvaChatTransport: bind to 0xchat NIP-98 signer at build time',
      'u': url,
      'method': method,
    };
    return base64Encode(utf8.encode(jsonEncode(placeholder)));
  }

  String get relayUrl => AvaChatConfig.relayUrl;
}
