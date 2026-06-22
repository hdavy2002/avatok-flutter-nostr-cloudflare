import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Client for the fast online voice call (worker routes/ava_live.ts).
/// Mints a short-lived Gemini Live ephemeral token (model + Ava persona + voice
/// locked server-side); the client then connects directly to the Live websocket.
class AvaLiveApi {
  static const String _url = 'https://$kSignalingHost/api/ava/live/token';

  static Map<String, dynamic> _j(String b) {
    try { return (jsonDecode(b) as Map).cast<String, dynamic>(); } catch (_) { return {}; }
  }

  /// → { status, token, model, expires_at } or { status, error }.
  static Future<Map<String, dynamic>> token() async {
    final r = await ApiAuth.postJson(_url, const {}, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }
}
