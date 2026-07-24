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

  /// → { status, token, model, expires_at, session_id?, metered?,
  ///     heartbeat_interval_ms? } on 200, or on insufficient balance
  ///     { status: 402, error: 'insufficient_balance', action: 'top_up' } (the
  ///     server's `json({...}, 402)` — `status` here is the real HTTP status
  ///     code this method stamps onto the map, per [_j]/spread below, NOT a
  ///     body field named "status"). Any other non-200 is `{ status, error }`.
  /// The metering fields are new ([AVABRAIN-VOICE-BILL-1]); an older worker
  /// simply omits them, so callers MUST feature-detect (`metered == true`)
  /// rather than assume.
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

  /// [AVABRAIN-VOICE-BILL-1] Metered-session keepalive. Only called when
  /// `token()`'s response had `metered: true` — an older/unmetered worker is
  /// never sent this. Best-effort: swallow network errors and let the caller
  /// decide (the caller times these out via its own periodic timer, so a lost
  /// heartbeat just means the next tick retries).
  /// → { status: 200, ok, metered?, ... } on success, or on insufficient
  ///   balance { status: 402, error: 'insufficient_balance', action: 'top_up' }
  ///   (mirrors ava_live.ts's `json({error:'insufficient_balance',
  ///   action:'top_up'}, 402)` — there is no `insufficient_balance: true`
  ///   boolean field; callers must check `r['status'] == 402` and/or
  ///   `r['error'] == 'insufficient_balance'`). `status` is always the real
  ///   HTTP status code (stamped on below), never a body field.
  static Future<Map<String, dynamic>> heartbeat(String sessionId) async {
    try {
      final r = await ApiAuth.postJson(
        'https://$kSignalingHost/api/ava/live/heartbeat',
        {'session_id': sessionId},
        timeout: const Duration(seconds: 10),
      );
      return {..._j(r.body), 'status': r.statusCode};
    } catch (e) {
      return {'status': -1, 'error': e.toString()};
    }
  }

  /// [AVABRAIN-VOICE-BILL-1] Final settlement — call EXACTLY ONCE per session
  /// on every end path (hangup, error, token expiry, app-lifecycle pause/
  /// detached). Best-effort: this is billing cleanup, not a UI gate, so a
  /// failure here must never block or re-surface as a call error.
  static Future<void> close(String sessionId, {String reason = 'hangup'}) async {
    if (sessionId.isEmpty) return;
    try {
      await ApiAuth.postJson(
        'https://$kSignalingHost/api/ava/live/close',
        {'session_id': sessionId, 'reason': reason},
        timeout: const Duration(seconds: 10),
      );
    } catch (_) {/* best-effort — never blocks call teardown */}
  }
}
