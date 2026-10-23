import '../api_client.dart';

/// [HF-APP-PARITY-SAFETY] Report a person, block / unblock, and the influencer's hearts / waiting counts.
///   POST   /api/hf/reports            { contact, profile, call, details } -> { ok, id:"HF-R-XXXXXXXX" }   (worker/src/routes/hf_reports.ts)
///   POST   /api/hf/calls/:id/block    { reason } -> { ok }                                                 (worker/src/routes/hf_dash_v3.ts)
///   GET    /api/hf/blocks             -> { ok, items:[{key,name,slug,at}] }
///   DELETE /api/hf/blocks/:key        -> { ok }
///   GET    /api/hf/me/summary         -> { ..., fraands:{ saved, newThisWeek, hearts, waiting } }  hearts / waiting are null for a fan

/// One choice in the report list. [key] is also the block reason the server understands.
class SafetyReason {
  const SafetyReason(this.key, this.label);
  final String key;
  final String label;
}

/// The same four reasons the worker accepts for a block (BLOCK_REASONS).
const List<SafetyReason> reportReasons = [
  SafetyReason('rude', 'Rude or abusive'),
  SafetyReason('money_or_otp', 'Asked me for money or an OTP'),
  SafetyReason('inappropriate', 'Inappropriate talk or behaviour'),
  SafetyReason('other', 'Something else'),
];

/// The note box stops here (the server allows 6000, a short note is plenty).
const int reportNoteMax = 500;

/// Used as the "call" field when the report starts from a profile and not from a call.
const String reportNoCall = 'No call (from profile)';

class ReportReceipt {
  const ReportReceipt(this.id);
  final String id;

  factory ReportReceipt.fromJson(Map<String, dynamic> j) {
    final id = j['id'];
    return ReportReceipt(id is String && id.isNotEmpty ? id : '');
  }

  /// The line shown after sending (the website says the same).
  String get message => id.isEmpty
      ? 'Report received. Our team will look at it.'
      : 'Report received. Reference $id. Our team will look at it. If you are in danger, call 112.';
}

class BlockedPerson {
  const BlockedPerson({required this.key, required this.name, this.slug});
  final String key;
  final String name;
  final String? slug;

  factory BlockedPerson.fromJson(Map<String, dynamic> j) => BlockedPerson(
        key: j['key'] is String ? j['key'] as String : '',
        name: j['name'] is String && (j['name'] as String).isNotEmpty ? j['name'] as String : 'Someone',
        slug: j['slug'] is String && (j['slug'] as String).isNotEmpty ? j['slug'] as String : null,
      );
}

/// Hearts and "Notify me" counts on the influencer Home. Null = not known.
class FraandsCounts {
  const FraandsCounts({this.hearts, this.waiting});
  final int? hearts;
  final int? waiting;

  factory FraandsCounts.fromJson(Map<String, dynamic> j) {
    final f = j['fraands'];
    if (f is! Map) return const FraandsCounts();
    int? n(Object? v) => v is num ? v.toInt() : null;
    return FraandsCounts(hearts: n(f['hearts']), waiting: n(f['waiting']));
  }
}

/// What the report sends in `details`: the reason first, then the person's own words.
String reportDetails(SafetyReason reason, String note) {
  final n = note.trim();
  return n.isEmpty ? 'Reason: ${reason.label}' : 'Reason: ${reason.label}\n$n';
}

class SafetyRepo {
  const SafetyRepo(this._api);

  final ApiClient _api;

  /// [contact] is the person's own email or number; [profile] the other person's name; [call] the call id.
  Future<ReportReceipt> report({
    required String contact,
    required String profile,
    required String call,
    required SafetyReason reason,
    String note = '',
  }) async {
    final j = await _api.postJson('/api/hf/reports', body: {
      'contact': contact.trim(),
      'profile': profile.trim(),
      'call': call.trim().isEmpty ? reportNoCall : call.trim(),
      'details': reportDetails(reason, note.length > reportNoteMax ? note.substring(0, reportNoteMax) : note),
    });
    return ReportReceipt.fromJson(j);
  }

  /// Blocks the other person of one of your calls. They leave My Fraands and cannot call or book you.
  Future<void> block(String callId, {String reason = 'other'}) async {
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/block', body: {'reason': reason});
  }

  Future<List<BlockedPerson>> blocks() async {
    final j = await _api.getJson('/api/hf/blocks');
    return [
      for (final e in (j['items'] is List ? j['items'] as List : const []))
        if (e is Map) BlockedPerson.fromJson(Map<String, dynamic>.from(e)),
    ];
  }

  Future<void> unblock(String key) async {
    await _api.deleteJson('/api/hf/blocks/${Uri.encodeComponent(key)}');
  }

  /// Influencer only; a fan gets nulls.
  Future<FraandsCounts> fraandsCounts() async => FraandsCounts.fromJson(await _api.getJson('/api/hf/me/summary'));
}
