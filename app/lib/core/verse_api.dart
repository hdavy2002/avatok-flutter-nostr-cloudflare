import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// VerseApi (Phase 8) — AvaVerse creator dashboard + review replies + AvaInbox
/// conversation view. All authed reads/writes ride the [ApiAuth] contract.
const String _base = 'https://$kSignalingHost/api';

/// `$12.50` — coins are USD cents.
String verseUsd(num coins) {
  final v = coins / 100;
  final neg = v < 0 ? '-' : '';
  final a = v.abs();
  return '$neg\$${a.toStringAsFixed(a % 1 == 0 ? 0 : 2)}';
}

class VerseSummary {
  final Map<String, dynamic> raw;
  VerseSummary(this.raw);

  Map<String, dynamic> get earnings => (raw['earnings'] as Map?)?.cast<String, dynamic>() ?? const {};
  Map<String, dynamic> get momentum => (raw['momentum'] as Map?)?.cast<String, dynamic>() ?? const {};
  Map<String, dynamic> get audience => (raw['audience'] as Map?)?.cast<String, dynamic>() ?? const {};
  Map<String, dynamic> get reach => (raw['reach'] as Map?)?.cast<String, dynamic>() ?? const {};
  List<Map<String, dynamic>> _list(dynamic v) =>
      ((v as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  List<Map<String, dynamic>> get projectedEvents => _list((raw['projections'] as Map?)?['events']);
  Map<String, dynamic> get consultToday =>
      ((raw['projections'] as Map?)?['consult_today'] as Map?)?.cast<String, dynamic>() ?? const {};
  List<Map<String, dynamic>> get momentumByEvent => _list(momentum['by_event']);
  List<Map<String, dynamic>> get topEvents => _list(raw['top_events']);
  List<Map<String, dynamic>> get reviewsToReply => _list(raw['reviews_to_reply']);
  List<Map<String, dynamic>> get nudges => _list(raw['nudges']);

  int n(Map<String, dynamic> m, String k) => (m[k] as num?)?.toInt() ?? 0;
}

class InboxConv {
  final String id, kind;
  final String? title, avatarUrl, context;
  final int updatedAt;
  InboxConv.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        kind = (j['kind'] ?? 'dm').toString(),
        title = j['title']?.toString(),
        avatarUrl = j['avatar_url']?.toString(),
        context = j['context']?.toString(),
        updatedAt = (j['updated_at'] as num?)?.toInt() ?? 0;

  /// 'event' | 'channel' | 'consult' | 'system' | 'dm'
  String get source {
    final c = context ?? '';
    if (c.startsWith('event')) return 'event';
    if (c.startsWith('channel')) return 'channel';
    if (c.startsWith('consult')) return 'consult';
    if (c == 'system') return 'system';
    return 'dm';
  }

  /// For dm ids 'dm_<a>__<b>' — the other participant.
  String? peerOf(String myUid) {
    if (!id.startsWith('dm_')) return null;
    final parts = id.substring(3).split('__');
    if (parts.length != 2) return null;
    return parts[0] == myUid ? parts[1] : parts[0];
  }
}

class VerseApi {
  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static Future<VerseSummary?> summary({String period = '7d', bool fresh = false}) async {
    final r = await ApiAuth.getSigned('$_base/verse/summary?period=$period${fresh ? '&fresh=1' : ''}',
        timeout: const Duration(seconds: 15));
    if (r.statusCode != 200) return null;
    return VerseSummary(_j(r.body));
  }

  /// A1 — notify followers about a listing. Returns (sent, remaining) or an error string.
  static Future<({int sent, int remaining, String? error})> announce(String listingId, {String? message}) async {
    final r = await ApiAuth.postJson('$_base/verse/announce',
        {'listing_id': listingId, if (message != null && message.isNotEmpty) 'message': message});
    final j = _j(r.body);
    if (r.statusCode != 200) {
      return (sent: 0, remaining: (j['remaining'] as num?)?.toInt() ?? 0,
          error: (j['detail'] ?? j['error'] ?? 'Failed').toString());
    }
    return (sent: (j['sent'] as num?)?.toInt() ?? 0, remaining: (j['remaining'] as num?)?.toInt() ?? 0, error: null);
  }

  /// A2 — monthly statement CSV (share sheet) — null on error.
  static Future<String?> statementCsv(String month) async {
    final r = await ApiAuth.getSigned('$_base/verse/statement?month=$month', timeout: const Duration(seconds: 20));
    return r.statusCode == 200 ? r.body : null;
  }

  /// A2 — email the statement to the signed-in account's address.
  static Future<bool> emailStatement(String month) async {
    final r = await ApiAuth.getSigned('$_base/verse/statement?month=$month&email=1', timeout: const Duration(seconds: 20));
    return r.statusCode == 200;
  }

  /// Public reply under a review.
  static Future<bool> replyReview(String reviewId, String body) async {
    final r = await ApiAuth.postJson('$_base/reviews/$reviewId/reply', {'body': body});
    return r.statusCode == 200;
  }

  /// Tag (or create) a 1:1 thread with a context — event:<listingId> |
  /// channel:<creatorUid> | consult:<bookingId>. Fire-and-forget from the
  /// Phase 6 "Message" buttons; never overwrites an existing tag server-side.
  static Future<void> tagThread(String to, String context) async {
    try { await ApiAuth.postJson('$_base/conversations', {'to': to, 'context': context}); } catch (_) {/* best-effort */}
  }

  /// AvaInbox — unified conversation list (optionally filtered by source prefix).
  static Future<List<InboxConv>> conversations({String? context}) async {
    final q = context == null || context.isEmpty ? '' : '?context=$context';
    final r = await ApiAuth.getSigned('$_base/conversations$q');
    if (r.statusCode != 200) return [];
    return ((_j(r.body)['conversations'] as List?) ?? const [])
        .map((e) => InboxConv.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }
}
