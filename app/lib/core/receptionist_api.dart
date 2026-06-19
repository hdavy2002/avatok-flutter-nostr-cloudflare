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
  const ReceptionistSettings({
    required this.enabled,
    required this.instructions,
    required this.voiceName,
    required this.displayName,
    required this.premium,
    required this.hasKb,
    required this.softCapMs,
    required this.hardCapMs,
  });
  factory ReceptionistSettings.fromJson(Map<String, dynamic> j) => ReceptionistSettings(
        enabled: j['enabled'] == true,
        instructions: (j['instructions_text'] ?? '').toString(),
        voiceName: (j['voice_name'] ?? 'Puck').toString(),
        displayName: (j['display_name'] ?? '').toString(),
        premium: j['premium'] == true,
        hasKb: j['has_kb'] == true,
        softCapMs: (j['soft_cap_ms'] as num?)?.toInt() ?? 80000,
        hardCapMs: (j['hard_cap_ms'] as num?)?.toInt() ?? 120000,
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
  static Future<ReceptionistSaveResult> saveSettings({
    required bool enabled,
    required String instructions,
    required String voiceName,
    String? displayName,
  }) async {
    try {
      final r = await ApiAuth.putJson('$_base/settings', {
        'enabled': enabled,
        'instructions_text': instructions,
        'voice_name': voiceName,
        'display_name': displayName,
      });
      if (r.statusCode != 200) return const ReceptionistSaveResult(false, false);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['blocked'] == true) return const ReceptionistSaveResult(false, true);
      return ReceptionistSaveResult(j['ok'] == true, false);
    } catch (_) {
      return const ReceptionistSaveResult(false, false);
    }
  }

  /// Caller: "should I route this missed call to Ava?" Returns null when
  /// unavailable (off / not premium / disabled). Public bits only.
  static Future<Map<String, dynamic>?> configFor(String toUid) async {
    try {
      final r = await ApiAuth.getSigned('$_base/config?to=$toUid');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return j['available'] == true ? j : null;
    } catch (_) {
      return null;
    }
  }

  /// Caller: open an Ava session after ~5 rings. Returns the DO WS info.
  static Future<Map<String, dynamic>?> start({
    required String to,
    String? callId,
    String? callerPhone,
    String? callerName,
  }) async {
    try {
      final r = await ApiAuth.postJson('$_base/start', {
        'to': to,
        'call_id': callId,
        'caller_phone': callerPhone,
        'caller_name': callerName,
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
