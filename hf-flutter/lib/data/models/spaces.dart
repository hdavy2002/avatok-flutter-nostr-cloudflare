/// [HF-CREATOR-SPACES-1] Women-only and LGBTQ+ channels: verification state of the signed-in person.
/// Match worker/src/routes/hf_spaces.ts (`GET /api/hf/spaces/me`) and hf_lanes.ts (`GET /api/hf/lanes/me`).
/// Parsing is tolerant: a missing key is a safe default (not verified), so the app never crashes while the server changes.
library;

String? _s(Object? v) {
  final s = v?.toString().trim();
  return (s == null || s.isEmpty) ? null : s;
}

/// The two space channels. The wire value is [name] (`women` / `lgbtq`).
enum SpaceLane {
  women,
  lgbtq;

  static SpaceLane? parse(Object? v) => switch (v?.toString()) {
        'women' => SpaceLane.women,
        'lgbtq' => SpaceLane.lgbtq,
        _ => null,
      };

  /// "Only verified women can call this channel" (spec 4).
  String get lockedText => this == SpaceLane.women ? 'Only verified women can call this channel' : 'Only verified LGBTQ+ members can call this channel';
  String get tagText => this == SpaceLane.women ? 'Women-only channel' : 'LGBTQ+ channel';
  String get chipText => this == SpaceLane.women ? 'Women-only' : 'LGBTQ+';
}

/// `none | pending | approved | rejected`.
class SelfieState {
  const SelfieState({this.status = 'none', this.reason});

  final String status;
  final String? reason;

  bool get approved => status == 'approved';
  bool get pending => status == 'pending';
  bool get rejected => status == 'rejected';

  factory SelfieState.fromJson(Object? v) {
    if (v is! Map) return const SelfieState();
    final st = _s(v['status']);
    return SelfieState(status: (st == 'pending' || st == 'approved' || st == 'rejected') ? st! : 'none', reason: _s(v['reason']));
  }
}

/// Everything the verification flow and the customer gate need, read from either `/api/hf/lanes/me` (customer) or
/// `/api/hf/spaces/me` (creator).
class SpaceStatus {
  const SpaceStatus({
    this.whatsappVerified = false,
    this.aadhaarVerified = false,
    this.gender,
    this.selfie = const SelfieState(),
    this.declared = false,
    this.videoKycVerified = false,
    this.womenGranted = false,
    this.lgbtqGranted = false,
    this.qualified = false,
    this.kind,
    this.minFollowers = 20,
    this.minViews = 1000,
  });

  final bool whatsappVerified;
  final bool aadhaarVerified;

  /// `F`, `M`, `T` or null. Never sent to telemetry.
  final String? gender;
  final SelfieState selfie;

  /// The private LGBTQ+ self-declaration was made.
  final bool declared;
  final bool videoKycVerified;
  final bool womenGranted;
  final bool lgbtqGranted;

  /// Creator side: a space creator is fully qualified.
  final bool qualified;

  /// Creator side: `channel | women | lgbtq` or null.
  final String? kind;
  final int minFollowers;
  final int minViews;

  bool grantedFor(SpaceLane lane) => lane == SpaceLane.women ? womenGranted : lgbtqGranted;

  /// What is still missing for [lane], as a short word for telemetry (never the gender or the declaration itself).
  String missingFor(SpaceLane lane) {
    if (!whatsappVerified) return 'whatsapp';
    if (!aadhaarVerified) return 'aadhaar';
    if (lane == SpaceLane.women && gender != 'F') return 'gender';
    if (lane == SpaceLane.lgbtq && !declared) return 'declaration';
    if (selfie.pending) return 'selfie_pending';
    if (!selfie.approved) return 'selfie';
    return 'none';
  }

  static const SpaceStatus empty = SpaceStatus();

  /// `GET /api/hf/lanes/me`: `{whatsappVerified, aadhaarVerified, gender, selfie, videoKycVerified, lanes:{women:{eligible,granted}, lgbtq:{declared,granted}}}`.
  factory SpaceStatus.fromLanes(Map<String, dynamic> j) {
    final lanes = j['lanes'] is Map ? Map<String, dynamic>.from(j['lanes'] as Map) : const <String, dynamic>{};
    final w = lanes['women'] is Map ? Map<String, dynamic>.from(lanes['women'] as Map) : const <String, dynamic>{};
    final l = lanes['lgbtq'] is Map ? Map<String, dynamic>.from(lanes['lgbtq'] as Map) : const <String, dynamic>{};
    final g = _s(j['gender']);
    return SpaceStatus(
      whatsappVerified: j['whatsappVerified'] == true,
      aadhaarVerified: j['aadhaarVerified'] == true,
      gender: (g == 'F' || g == 'M' || g == 'T') ? g : null,
      selfie: SelfieState.fromJson(j['selfie']),
      declared: l['declared'] == true,
      videoKycVerified: j['videoKycVerified'] == true,
      womenGranted: w['granted'] == true,
      lgbtqGranted: l['granted'] == true,
    );
  }

  /// `GET /api/hf/spaces/me`.
  factory SpaceStatus.fromSpaces(Map<String, dynamic> j) {
    final g = _s(j['gender']);
    int n(Object? v, int d) => v is num ? v.toInt() : d;
    return SpaceStatus(
      whatsappVerified: j['whatsappVerified'] == true,
      aadhaarVerified: j['aadhaarVerified'] == true,
      gender: (g == 'F' || g == 'M' || g == 'T') ? g : null,
      selfie: SelfieState.fromJson(j['selfie']),
      declared: j['lgbtqDeclared'] == true,
      videoKycVerified: j['videoKycVerified'] == true,
      qualified: j['qualified'] == true,
      kind: _s(j['kind']),
      minFollowers: n(j['minFollowers'], 20),
      minViews: n(j['minViews'], 1000),
    );
  }
}
