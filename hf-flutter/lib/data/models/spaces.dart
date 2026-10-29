/// [HF-CREATOR-SPACES-1] Women-only and LGBTQ+ channels: verification state of the signed-in person.
/// Match worker/src/routes/hf_spaces.ts (`GET /api/hf/spaces/me`) and hf_lanes.ts (`GET /api/hf/lanes/me`).
/// Parsing is tolerant: a missing key is a safe default (not verified), so the app never crashes while the server changes.
library;

import '../social_states.dart'; // [HF-SOCIAL-STATES]

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

/// [HF-CREATOR-BADGES-1] The stacked badges of a creator, from `GET /api/hf/spaces/me` `badges`. Missing keys read as "not yet".
class CreatorBadges {
  const CreatorBadges({this.phone = false, this.channel = false, this.videoKyc = false, this.space});

  final bool phone;
  final bool channel;
  final bool videoKyc;

  /// The space she belongs to, or null.
  final SpaceLane? space;

  static const CreatorBadges empty = CreatorBadges();
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
    this.kycGranted = false,
    this.badges = CreatorBadges.empty,
    this.canGoLive = false,
    this.missing = const <String>[],
    this.callerLevel = 'everyone',
    this.callerLevelLocked = false,
    this.hostStatus,
    this.social = SocialSummary.empty,
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

  /// [HF-CREATOR-BADGES-1] Customer side: full video KYC (Aadhaar verified and the latest selfie approved), enough to call
  /// a creator who only takes video-KYC callers. From `lanes.kyc.granted`; an older server falls back to [videoKycVerified].
  final bool kycGranted;

  /// Creator side (`GET /api/hf/spaces/me`).
  final CreatorBadges badges;
  final bool canGoLive;

  /// What stops her going live, e.g. `channel_or_video_kyc`, `space_video_kyc`.
  final List<String> missing;

  /// `everyone` or `video_kyc`; the setting is locked for space creators.
  final String callerLevel;
  final bool callerLevelLocked;

  /// [HF-VERIF-WORDING-1] Creator side: the profile status (`live`, `approved`, `pending_review`, ...) or null.
  final String? hostStatus;

  /// [HF-SOCIAL-STATES] Creator side: the proven social accounts in three states. Only `badges.channel` (approved) counts.
  final SocialSummary social;

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

  /// [HF-CREATOR-BADGES-1] What is still missing for plain video KYC (a customer calling a video-KYC-only creator).
  String missingForKyc() {
    if (!whatsappVerified) return 'whatsapp';
    if (!aadhaarVerified) return 'aadhaar';
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
      kycGranted: lanes['kyc'] is Map ? (lanes['kyc'] as Map)['granted'] == true : j['videoKycVerified'] == true,
    );
  }

  /// `GET /api/hf/spaces/me`.
  factory SpaceStatus.fromSpaces(Map<String, dynamic> j) {
    final g = _s(j['gender']);
    int n(Object? v, int d) => v is num ? v.toInt() : d;
    final b = j['badges'] is Map ? Map<String, dynamic>.from(j['badges'] as Map) : const <String, dynamic>{};
    final kind = _s(j['kind']);
    final level = _s(j['callerLevel']);
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
      kycGranted: j['videoKycVerified'] == true,
      badges: CreatorBadges(
        phone: b.containsKey('phone') ? b['phone'] == true : j['whatsappVerified'] == true,
        channel: b['channel'] == true,
        videoKyc: b.containsKey('videoKyc') ? b['videoKyc'] == true : j['videoKycVerified'] == true,
        space: SpaceLane.parse(b.containsKey('space') ? b['space'] : kind),
      ),
      canGoLive: j['canGoLive'] == true,
      missing: [for (final m in (j['missing'] is List ? j['missing'] as List : const [])) if (_s(m) != null) _s(m)!],
      callerLevel: level == 'video_kyc' ? 'video_kyc' : 'everyone',
      callerLevelLocked: j['callerLevelLocked'] == true,
      hostStatus: j['hostStatus'] is String ? j['hostStatus'] as String : null,
      social: SocialSummary.fromJson(j['social']),
    );
  }
}
