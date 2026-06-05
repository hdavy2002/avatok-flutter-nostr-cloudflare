import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Client for AvaBrain (`/api/brain/*`). All calls are dual-auth (NIP-98 + Clerk)
/// via [ApiAuth]; the server derives the npub from the signature and routes to the
/// caller's own UserBrain DO.
///
/// Privacy note: DM content is end-to-end encrypted, so the server brain never
/// sees it. To let the brain remember things from private chats, extract facts
/// ON-DEVICE (where you have the plaintext) and sync them with [remember] — that
/// is the only path private memory reaches the server, and it's user-initiated.
class BrainApi {
  /// Ask a natural-language question over everything the brain knows.
  static Future<String> ask(String question) async {
    final res = await ApiAuth.postJson('$kBrainBase/ask', {'question': question},
        timeout: const Duration(seconds: 30));
    return _str(res.body, 'answer');
  }

  /// Generate today's briefing.
  static Future<String> briefing() async {
    final res = await ApiAuth.postJson('$kBrainBase/briefing', const {},
        timeout: const Duration(seconds: 30));
    return _str(res.body, 'briefing');
  }

  /// Sync client-extracted (e.g. DM-derived) facts/entities into the brain.
  static Future<int> remember({List<Map<String, dynamic>> facts = const [], List<Map<String, dynamic>> entities = const []}) async {
    final res = await ApiAuth.postJson('$kBrainBase/remember', {'facts': facts, 'entities': entities});
    final j = _json(res.body);
    return (j['stored'] as num?)?.toInt() ?? 0;
  }

  /// Ask the brain to diagnose a problem using the user's PostHog event log.
  static Future<String> investigate(String complaint) async {
    final res = await ApiAuth.postJson('$kBrainBase/investigate', {'complaint': complaint},
        timeout: const Duration(seconds: 30));
    return _str(res.body, 'diagnosis');
  }

  /// List the user's knowledge-graph entities (ranked by decayed importance).
  static Future<List<Map<String, dynamic>>> entities() async {
    final res = await ApiAuth.getSigned('$kBrainBase/entities');
    final j = _json(res.body);
    return ((j['entities'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  /// Recent processed brain events (timeline).
  static Future<List<Map<String, dynamic>>> timeline() async {
    final res = await ApiAuth.getSigned('$kBrainBase/timeline');
    final j = _json(res.body);
    return ((j['events'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static String _str(String body, String key) {
    final v = _json(body)[key];
    return v == null ? '' : v.toString();
  }
}
