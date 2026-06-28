import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// ReceptionistApi — Ava Receptionist ("Ava answers after 5 rings").
/// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md. Premium-only. First AvaVoice
/// deployment; the future AvaVoice pipeline reuses this plumbing.
const String _base = 'https://$kSignalingHost/api/receptionist';

/// Owner's receptionist configuration (server is the source of truth).
class ReceptionistSettings {
  final bool enabled;
  final String instructions; // "Leave Instructions for Ava" free text
  final String voiceName;
  final String displayName;
  final bool premium;
  final bool hasKb;
  final int softCapMs;
  final int hardCapMs;
  // v2 — persona / language / activation
  final String personaName;
  final String languageCode; // '' = auto-detect
  final String greetingText;
  final String customPrompt;
  final bool answerAll;      // Mode B: answer on first ring
  final String statusPreset; // busy|travelling|meeting|driving|holiday|after_hours|custom|''
  final String statusCustom;
  final bool declineToAva;   // Mode C: red Decline routes to Ava
  const ReceptionistSettings({
    required this.enabled,
    required this.instructions,
    required this.voiceName,
    required this.displayName,
    required this.premium,
    required this.hasKb,
    required this.softCapMs,
    required this.hardCapMs,
    this.personaName = '',
    this.languageCode = '',
    this.greetingText = '',
    this.customPrompt = '',
    this.answerAll = false,
    this.statusPreset = '',
    this.statusCustom = '',
    this.declineToAva = false,
  });
  factory ReceptionistSettings.fromJson(Map<String, dynamic> j) => ReceptionistSettings(
        enabled: j['enabled'] == true,
        instructions: (j['instructions_text'] ?? '').toString(),
        voiceName: (j['voice_name'] ?? 'Puck').toString(),
        displayName: (j['display_name'] ?? '').toString(),
        premium: j['premium'] == true,
        hasKb: j['has_kb'] == true,
        softCapMs: (j['soft_cap_ms'] as num?)?.toInt() ?? 55000,
        hardCapMs: (j['hard_cap_ms'] as num?)?.toInt() ?? 70000,
        personaName: (j['persona_name'] ?? '').toString(),
        languageCode: (j['language_code'] ?? '').toString(),
        greetingText: (j['greeting_text'] ?? '').toString(),
        customPrompt: (j['custom_prompt'] ?? '').toString(),
        answerAll: j['answer_all'] == true,
        statusPreset: (j['status_preset'] ?? '').toString(),
        statusCustom: (j['status_custom'] ?? '').toString(),
        declineToAva: j['decline_to_ava'] == true,
      );
}

/// Result of a settings save — distinguishes "blocked by premium" (the server
/// returns 200 with blocked:true) from a hard failure.
class ReceptionistSaveResult {
  final bool ok;
  final bool blocked; // premium required
  const ReceptionistSaveResult(this.ok, this.blocked);
}

class ReceptionistApi {
  /// Owner: read own config.
  static Future<ReceptionistSettings?> getSettings() async {
    try {
      final r = await ApiAuth.getSigned('$_base/settings');
      if (r.statusCode != 200) return null;
      return ReceptionistSettings.fromJson(
          jsonDecode(r.body) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// Owner: update config. Enabling is premium-gated server-side.
  ///
  /// Auto-retries transient failures (a thrown network error, a 0/5xx status, or
  /// a signed-auth clock-skew 401) up to 3 attempts with a short backoff. This is
  /// what fixed the "Save instructions took 3 tries" report: a single dropped
  /// request or a not-yet-warm auth token used to surface as a hard "couldn't
  /// save" toast, so the user kept tapping Save manually. A 200 response — even a
  /// premium `blocked:true` — is authoritative and never retried.
  static Future<ReceptionistSaveResult> saveSettings({
    required bool enabled,
    required String instructions,
    required String voiceName,
    String? displayName,
    // v2 — persona / language / activation
    String? personaName,
    String? languageCode,
    String? greetingText,
    String? customPrompt,
    bool? answerAll,
    String? statusPreset,
    String? statusCustom,
    bool? declineToAva,
  }) async {
    final body = <String, dynamic>{
      'enabled': enabled,
      'instructions_text': instructions,
      'voice_name': voiceName,
      'display_name': displayName,
      if (personaName != null) 'persona_name': personaName,
      if (languageCode != null) 'language_code': languageCode,
      if (greetingText != null) 'greeting_text': greetingText,
      if (customPrompt != null) 'custom_prompt': customPrompt,
      if (answerAll != null) 'answer_all': answerAll,
      if (statusPreset != null) 'status_preset': statusPreset,
      if (statusCustom != null) 'status_custom': statusCustom,
      if (declineToAva != null) 'decline_to_ava': declineToAva,
    };
    const maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        final r = await ApiAuth.putJson('$_base/settings', body);
        // 2xx is authoritative — parse and return (no retry, even when blocked).
        if (r.statusCode == 200) {
          final j = jsonDecode(r.body) as Map<String, dynamic>;
          if (j['blocked'] == true) return const ReceptionistSaveResult(false, true);
          return ReceptionistSaveResult(j['ok'] == true, false);
        }
        // 4xx (other than a transient 401) is a real client error — don't retry.
        final transient = r.statusCode == 0 || r.statusCode == 401 || r.statusCode >= 500;
        if (!transient || attempt == maxAttempts) {
          return const ReceptionistSaveResult(false, false);
        }
      } catch (_) {
        // Network/timeout — retry unless we're out of attempts.
        if (attempt == maxAttempts) return const ReceptionistSaveResult(false, false);
      }
      // Linear backoff: 250ms, 500ms before the next attempt.
      await Future.delayed(Duration(milliseconds: 250 * attempt));
    }
    return const ReceptionistSaveResult(false, false);
  }

  // Caller-side dial-time cache: an owner's receptionist availability changes
  // rarely, so we avoid re-probing /config on every call to the same contact
  // within a short window. TTL-only (the caller can't observe the owner's save),
  // and the server re-checks the real daily allowance on /start — so a stale
  // "available" can never overspend, it just gets a 402 and falls back to no-answer.
  static final Map<String, ({Map<String, dynamic>? value, int expiry})> _cfgCache = {};
  static const int _cfgTtlMs = 3 * 60 * 1000; // 3 min — cache "available" results
  // "unavailable" is cached only briefly: a temporary off-state (daily allowance
  // just topped up, a transient blip) must clear within seconds, not block calls
  // for minutes. (This is what made a topped-up cap still say "No answer".)
  static const int _cfgNegTtlMs = 20 * 1000; // 20 s

  /// Drop the cached availability for a contact (e.g. after a failed hand-off),
  /// forcing a fresh probe on the next call.
  static void invalidateConfig(String toUid) => _cfgCache.remove(toUid);

  /// Caller: "should I route this missed call to Ava?" Returns null when
  /// unavailable (off / not premium / disabled). Public bits only. Cached per
  /// contact for [_cfgTtlMs] to skip the server round-trip on repeat calls.
  static Future<Map<String, dynamic>?> configFor(String toUid) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final hit = _cfgCache[toUid];
    if (hit != null && hit.expiry > now) return hit.value;
    try {
      final r = await ApiAuth.getSigned('$_base/config?to=$toUid');
      if (r.statusCode != 200) {
        _cfgCache[toUid] = (value: null, expiry: now + _cfgNegTtlMs);
        return null;
      }
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final available = j['available'] == true;
      final result = available ? j : null;
      // Long cache for "available", short for "unavailable".
      _cfgCache[toUid] = (value: result, expiry: now + (available ? _cfgTtlMs : _cfgNegTtlMs));
      return result;
    } catch (_) {
      return null; // transient error — don't poison the cache
    }
  }

  /// Caller: open an Ava session after ~5 rings. Returns the DO WS info.
  static Future<Map<String, dynamic>?> start({
    required String to,
    String? callId,
    String? callerPhone,
    String? callerName,
    String activationMode = 'rings', // rings|first_ring|manual|decline
    // Team Receptionist context: when this hand-off is the no-answer fallback for a
    // staffer dialed via a team IVR menu, pass the team id + menu slot so the
    // voicemail card reaches the staffer + manager. Spec: TEAM-RECEPTIONIST-IVR-SPEC.md.
    String? teamId,
    int? teamSlot,
  }) async {
    try {
      final r = await ApiAuth.postJson('$_base/start', {
        'to': to,
        'call_id': callId,
        'caller_phone': callerPhone,
        'caller_name': callerName,
        'activation_mode': activationMode,
        if (teamId != null) 'team_id': teamId,
        if (teamSlot != null) 'team_slot': teamSlot,
      });
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return j['ok'] == true ? j : null;
    } catch (_) {
      return null;
    }
  }

  /// Caller: safety finalize if the WS never connected.
  static Future<void> finish(String sessionId,
      {String reason = 'caller_hangup'}) async {
    try {
      await ApiAuth.postJson('$_base/finish', {
        'session_id': sessionId,
        'cutoff_reason': reason,
      });
    } catch (_) {/* best-effort */}
  }

  /// Owner: upload a knowledge file (Gemini File Search RAG). Premium-gated.
  static Future<bool> uploadKb(List<int> bytes, String name) async {
    try {
      final r = await ApiAuth.postBytes(
          '$_base/kb?name=${Uri.encodeQueryComponent(name)}', bytes);
      if (r.statusCode != 200) return false;
      return (jsonDecode(r.body) as Map<String, dynamic>)['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Owner: detach the knowledge store (Ava stops grounding on it).
  static Future<bool> clearKb() async {
    try {
      final r = await ApiAuth.deleteSigned('$_base/kb');
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Absolute WS URL for the ReceptionRoom DO from a relative rtc_url.
  static String wsUrl(String rtcUrl) {
    final rel = rtcUrl.startsWith('/') ? rtcUrl : '/$rtcUrl';
    return 'wss://$kSignalingHost$rel';
  }
}
