// ai_chat_api.dart — STREAM G "AI in chats" client. Thin wrappers over the
// Worker's /api/ai/* + /api/safety/score routes (dual-auth via ApiAuth). Every
// call is best-effort: on any error we return an empty/neutral result so a chat
// UI never breaks because an AI helper was unreachable.
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// One catch-up bullet: who said it + a one-line paraphrase.
class CatchupBullet {
  final String sender;
  final String text;
  const CatchupBullet(this.sender, this.text);
}

/// Result of a stranger-thread scam scan. CONTRACT mirrors the Worker's
/// { score, reason } response (Stream B depends on this shape).
class SafetyScore {
  final double score; // 0..1
  final String reason;
  const SafetyScore(this.score, this.reason);
  bool get isHigh => score >= 0.8;
}

class AiChatApi {
  static const String _catchupUrl = '$kApiBase/ai/catchup';
  static const String _smartRepliesUrl = '$kApiBase/ai/smart-replies';
  static const String _translateUrl = '$kApiBase/ai/translate';
  static const String _groupTranslateUrl = '$kApiBase/ai/group-translate';
  static const String _safetyScoreUrl = '$kApiBase/safety/score';

  /// [GROUP-AI-1] "What did I miss?" — summarise unread text into <=6 attributed
  /// bullets. `sinceSeq` is the InboxDO row id of the last-read message (unread
  /// window). Returns [] when off/guardrail-off/empty.
  static Future<List<CatchupBullet>> catchup(String conv, {int sinceSeq = 0}) async {
    try {
      final r = await ApiAuth.postJson(_catchupUrl, {'conv': conv, 'since_seq': sinceSeq});
      if (r.statusCode != 200) return const [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final raw = (j['bullets'] as List?) ?? const [];
      return raw
          .whereType<Map>()
          .map((m) => CatchupBullet((m['sender'] ?? '').toString(), (m['text'] ?? '').toString()))
          .where((b) => b.text.isNotEmpty)
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// [GROUP-AI-4] 3 short reply suggestions for the last <=4 messages. Returns []
  /// when disabled/guardrail-off/error (chips just don't show).
  static Future<List<String>> smartReplies(List<Map<String, Object>> msgs) async {
    try {
      final r = await ApiAuth.postJson(_smartRepliesUrl, {'msgs': msgs});
      if (r.statusCode != 200) return const [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return ((j['suggestions'] as List?) ?? const []).map((s) => s.toString()).where((s) => s.isNotEmpty).take(3).toList();
    } catch (_) {
      return const [];
    }
  }

  /// [GROUP-AI-5] Inline translate one text bubble into [to] (BCP-47 or a plain
  /// language name). Returns null on failure so the caller can keep the original.
  static Future<String?> translate(String text, String to) async {
    try {
      final r = await ApiAuth.postJson(_translateUrl, {'text': text, 'to': to});
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final t = (j['text'] ?? '').toString();
      return t.isEmpty ? null : t;
    } catch (_) {
      return null;
    }
  }

  /// [GROUP-AI-2] Translate a batch of fetched group messages into [lang]. Only
  /// text rows should be passed (voice notes are not translated v1). Returns a
  /// map of msg_id → translated text (misses fall back to the original client-side).
  static Future<Map<String, String>> groupTranslate(
      String conv, String lang, List<Map<String, String>> msgs) async {
    try {
      final r = await ApiAuth.postJson(_groupTranslateUrl, {'conv': conv, 'lang': lang, 'msgs': msgs});
      if (r.statusCode != 200) return const {};
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final out = <String, String>{};
      for (final item in ((j['items'] as List?) ?? const [])) {
        if (item is Map) {
          final id = (item['id'] ?? '').toString();
          final text = (item['text'] ?? '').toString();
          if (id.isNotEmpty && text.isNotEmpty) out[id] = text;
        }
      }
      return out;
    } catch (_) {
      return const {};
    }
  }

  /// [GROUP-AI-6] Scam score for a stranger thread. `auto` marks the one-shot
  /// auto-scan on first render (vs an explicit Safety Shield tap). Fail-open →
  /// a neutral { score:0 } on any error. Stream B calls this too.
  static Future<SafetyScore> safetyScore(String conv, {bool auto = false}) async {
    try {
      final r = await ApiAuth.postJson(_safetyScoreUrl, {'conv': conv, 'auto': auto});
      if (r.statusCode != 200) return const SafetyScore(0, '');
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final s = (j['score'] as num?)?.toDouble() ?? 0;
      return SafetyScore(s.clamp(0, 1).toDouble(), (j['reason'] ?? '').toString());
    } catch (_) {
      return const SafetyScore(0, '');
    }
  }
}
