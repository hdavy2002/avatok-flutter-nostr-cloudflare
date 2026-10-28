import '../api_client.dart';

/// [HF-CALL-SAFETY-APP] Call recording, strikes, appeals and the call rules (Specs/HF-CALL-SAFETY-1.md).
///   GET  /api/hf/safety/me                    -> { status, activeStrikes, strikesToPause, reviewDueAt, heldPaise, rulesAccepted, rulesVersion, recordingEnabled, strikes:[...] }
///   POST /api/hf/safety/strikes/:id/appeal    { message } -> { ok, appealStatus }      (409 when that strike was already appealed)
///   POST /api/hf/safety/rules/accept          { version } -> { ok }
///   POST /api/hf/calls/:callId/report         { reasons:[...], note? } -> { ok }       (only a person on that call)
/// A blocked person gets 403 `{ error: "account_paused" }` or `{ error: "call_rules_required" }` from going Online, starting a call,
/// joining a queue or booking. Everything here is shown only while the public config says `hfCallRecordingEnabled`.

/// Epoch milliseconds from a server number (seconds are tolerated and lifted to milliseconds).
int? safetyMs(Object? v) {
  if (v is! num || v <= 0) return null;
  final n = v.toInt();
  return n < 100000000000 ? n * 1000 : n;
}

/// The reasons a strike can carry, with the plain-English title used when the server sends no `reasonText`.
const Map<String, String> kStrikeReasonTitles = {
  'selling': 'Selling on a call',
  'outside_payment': 'Payment outside the app',
  'contact_sharing': 'Sharing contact details',
  'abuse': 'Rude or abusive talk',
  'sexual': 'Sexual talk',
  'danger': 'A safety risk',
};

class SafetyStrike {
  const SafetyStrike({
    required this.id,
    required this.reason,
    required this.reasonText,
    this.callAt,
    this.quote,
    this.expiresAt,
    this.removedAt,
    this.removedWhy,
    this.appealStatus,
    this.canAppeal = false,
  });

  final String id;
  final String reason;
  final String reasonText;
  final int? callAt;

  /// The person's OWN words from the call, or null.
  final String? quote;
  final int? expiresAt;
  final int? removedAt;
  final String? removedWhy;

  /// null, `open`, `accepted` or `rejected`.
  final String? appealStatus;
  final bool canAppeal;

  bool get removed => removedAt != null;

  /// Counts against the account right now (not removed, not past its end date).
  bool isActiveAt(int nowMs) => !removed && (expiresAt == null || expiresAt! > nowMs);

  factory SafetyStrike.fromJson(Map<String, dynamic> j) {
    String? s(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;
    final reason = s(j['reason']) ?? 'other';
    return SafetyStrike(
      id: (j['id'] ?? '').toString(),
      reason: reason,
      reasonText: s(j['reasonText']) ?? kStrikeReasonTitles[reason] ?? 'A call rule',
      callAt: safetyMs(j['callAt']),
      quote: s(j['quote']),
      expiresAt: safetyMs(j['expiresAt']),
      removedAt: safetyMs(j['removedAt']),
      removedWhy: s(j['removedWhy']),
      appealStatus: s(j['appealStatus']),
      canAppeal: j['canAppeal'] == true,
    );
  }
}

class SafetyMe {
  const SafetyMe({
    this.status = 'active',
    this.activeStrikes = 0,
    this.strikesToPause = 3,
    this.reviewDueAt,
    this.heldPaise = 0,
    this.rulesAccepted = false,
    this.rulesVersion = 1,
    this.recordingEnabled = false,
    this.strikes = const <SafetyStrike>[],
  });

  /// `active`, `paused` or `banned`.
  final String status;
  final int activeStrikes;
  final int strikesToPause;
  final int? reviewDueAt;
  final int heldPaise;
  final bool rulesAccepted;
  final int rulesVersion;
  final bool recordingEnabled;
  final List<SafetyStrike> strikes;

  bool get isPaused => status == 'paused';
  bool get isBanned => status == 'banned';

  factory SafetyMe.fromJson(Map<String, dynamic> j) {
    int n(Object? v, int fallback) => v is num ? v.toInt() : fallback;
    final raw = j['strikes'];
    final status = j['status'] is String ? j['status'] as String : 'active';
    return SafetyMe(
      status: const {'active', 'paused', 'banned'}.contains(status) ? status : 'active',
      activeStrikes: n(j['activeStrikes'], 0),
      strikesToPause: n(j['strikesToPause'], 3) < 1 ? 3 : n(j['strikesToPause'], 3),
      reviewDueAt: safetyMs(j['reviewDueAt']),
      heldPaise: n(j['heldPaise'], 0),
      rulesAccepted: j['rulesAccepted'] == true,
      rulesVersion: n(j['rulesVersion'], 1),
      recordingEnabled: j['recordingEnabled'] == true,
      strikes: [
        if (raw is List)
          for (final e in raw)
            if (e is Map) SafetyStrike.fromJson(Map<String, dynamic>.from(e)),
      ],
    );
  }
}

/// One choice on the post-call report. [key] is what the server accepts in `reasons`.
class CallReportReason {
  const CallReportReason(this.key, this.label);
  final String key;
  final String label;
}

const List<CallReportReason> kCallReportReasons = [
  CallReportReason('selling', 'Tried to sell me something'),
  CallReportReason('outside_payment', 'Asked me to pay outside the app'),
  CallReportReason('asked_number', 'Asked for my number'),
  CallReportReason('abusive', 'Rude or abusive'),
];

class CallSafetyRepo {
  const CallSafetyRepo(this._api);

  final ApiClient _api;

  Future<SafetyMe> me() async => SafetyMe.fromJson(await _api.getJson('/api/hf/safety/me'));

  /// Throws [ApiException]; a second appeal on the same strike is a 409.
  Future<void> appeal(String strikeId, String message) async {
    await _api.postJson('/api/hf/safety/strikes/${Uri.encodeComponent(strikeId)}/appeal', body: {'message': message.trim()});
  }

  Future<void> acceptRules(int version) async {
    await _api.postJson('/api/hf/safety/rules/accept', body: {'version': version});
  }

  Future<void> reportCall(String callId, List<String> reasons, {String note = ''}) async {
    final n = note.trim();
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/report', body: {
      'reasons': reasons,
      if (n.isNotEmpty) 'note': n.length > 500 ? n.substring(0, 500) : n,
    });
  }
}
