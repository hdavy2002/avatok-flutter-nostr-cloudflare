import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'profile_store.dart';
import 'voice/google_voice.dart';

/// Client for the fast online voice call (worker routes/ava_live.ts).
/// Mints a short-lived Gemini Live ephemeral token (model + Ava persona + voice
/// locked server-side); the client then connects directly to the Live websocket.
class AvaLiveApi {
  static const String _url = 'https://$kSignalingHost/api/ava/live/token';

  static Map<String, dynamic> _j(String b) {
    try { return (jsonDecode(b) as Map).cast<String, dynamic>(); } catch (_) { return {}; }
  }

  /// → { status, token, model, expires_at } or { status, error }.
  /// Sends the user's chosen Gemini voice + first name (both locked into the
  /// session server-side, so Ava can greet them by name).
  static Future<Map<String, dynamic>> token() async {
    await GoogleVoicePref.load();
    await AvaVoiceLangPref.load();
    String firstName = '';
    try {
      final p = await ProfileStore().load();
      firstName = p.displayName.trim().split(RegExp(r'\s+')).first;
    } catch (_) {}
    final r = await ApiAuth.postJson(
      _url,
      {
        'voice': GoogleVoicePref.current,
        'name': firstName,
        // '' = Auto (server omits languageCode and lets Gemini auto-detect).
        'lang': AvaVoiceLangPref.current,
      },
      timeout: const Duration(seconds: 15),
    );
    return {..._j(r.body), 'status': r.statusCode};
  }
}
