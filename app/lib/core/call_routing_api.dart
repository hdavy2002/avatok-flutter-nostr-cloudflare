import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// CallRoutingApi — client for POST /api/call/no-answer (Specs/PLAN-2026-07-11-
/// dialpad-business-calls-ava-voice-agent.md §3 step 4, worker/src/routes/api.ts
/// callNoAnswer()). Called by the CALLER once a genuine ring-timeout has
/// elapsed on an outgoing BUSINESS (dialpad) call, so the server can decide
/// the after-ring outcome (agent / voicemail / none) per the callee's Agent
/// Profile. Only meaningful while RemoteConfig.businessCallUx is on; any
/// network/parse failure or a 503 (flag off) returns null and the caller falls
/// back to the plain no-answer card with no voicemail/agent option.
class CallRoutingApi {
  CallRoutingApi._();

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  /// [callee] = the person that was dialed and didn't answer. [callId] = the
  /// call room id (same id the ring push/CallRoom DO used). Returns
  /// `{next:'voicemail'|'agent'|'none', start?:{to,call_id,trace_id}, voicemail_available:bool}`
  /// on success, or null on any failure.
  static Future<Map<String, dynamic>?> noAnswer({
    required String callee,
    required String callId,
    String? traceId,
  }) async {
    try {
      final r = await ApiAuth.postJson('$kApiBase/call/no-answer', {
        'callee': callee,
        'call_id': callId,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      return j.isEmpty ? null : j;
    } catch (_) {
      return null;
    }
  }
}
