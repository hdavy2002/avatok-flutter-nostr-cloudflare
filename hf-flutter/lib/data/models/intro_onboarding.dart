import '../social_states.dart'; // [HF-SOCIAL-STATES]

/// [HF-INTRO-A1] Models for the influencer intro-video onboarding (`/api/hf/onboarding/*`, Specs/HF-INTRO-VIDEO-1-API.md section 1).
/// Parsing is tolerant: a missing key is a safe default, so the app keeps working while the server side changes.

/// The four categories that need an Aadhaar check, always last (owner decision D2 / D4).
const Set<String> kSensitiveCategoryIds = {'listener', 'prayer', 'virtual_friend', 'women_to_women'};

/// Women-to-Women: the creator's Aadhaar must show Female.
const String kWomenToWomenId = 'women_to_women';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

String? _str(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

int? _int(Object? v) => v is num ? v.toInt() : int.tryParse((v ?? '').toString());

List<Map<String, dynamic>> _maps(Object? v) => v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const <Map<String, dynamic>>[];

class OnbCategory {
  const OnbCategory({required this.id, required this.label, this.sensitive = false});

  final String id;
  final String label;
  final bool sensitive;

  factory OnbCategory.fromJson(Map<String, dynamic> j) {
    final id = _str(j['id']) ?? '';
    return OnbCategory(id: id, label: _str(j['label']) ?? id, sensitive: j['sensitive'] == true || kSensitiveCategoryIds.contains(id));
  }
}

/// `GET /api/hf/onboarding/categories`.
class OnbConfig {
  const OnbConfig({required this.categories, required this.langs, this.minSeconds = 10, this.maxSeconds = 20});

  /// Display order: the normal ones first, the sensitive four last.
  final List<OnbCategory> categories;

  /// Language codes (`hi en mr bn ta te gu pa kn ml`).
  final List<String> langs;
  final int minSeconds;
  final int maxSeconds;

  factory OnbConfig.fromJson(Map<String, dynamic> j) {
    final video = _map(j['video']);
    final cats = [for (final c in _maps(j['categories'])) OnbCategory.fromJson(c)].where((c) => c.id.isNotEmpty).toList();
    final langs = j['langs'] is List ? [for (final l in (j['langs'] as List)) l.toString()] : <String>[];
    return OnbConfig(
      categories: cats,
      langs: langs,
      minSeconds: _int(video['minSeconds']) ?? 10,
      maxSeconds: _int(video['maxSeconds']) ?? 20,
    );
  }

  OnbCategory? byId(String id) {
    for (final c in categories) {
      if (c.id == id) return c;
    }
    return null;
  }
}

class OnbVideo {
  const OnbVideo({required this.id, this.status = 'draft', this.videoUrl, this.posterUrl, this.durationMs = 0, this.width = 0, this.height = 0, this.lang, this.topic});

  final String id;

  /// `draft | submitted | approved | rejected | replaced`.
  final String status;
  final String? videoUrl;
  final String? posterUrl;
  final int durationMs;
  final int width;
  final int height;
  final String? lang;
  final String? topic;

  factory OnbVideo.fromJson(Map<String, dynamic> j) => OnbVideo(
        id: _str(j['id']) ?? '',
        status: _str(j['status']) ?? 'draft',
        videoUrl: _str(j['videoUrl']),
        posterUrl: _str(j['posterUrl']),
        durationMs: _int(j['durationMs']) ?? 0,
        width: _int(j['width']) ?? 0,
        height: _int(j['height']) ?? 0,
        lang: _str(j['lang']),
        topic: _str(j['topic']),
      );
}

class OnbReason {
  const OnbReason({required this.code, required this.text});

  final String code;
  final String text;
}

class OnbApplication {
  const OnbApplication({
    required this.id,
    required this.status,
    this.categories = const <OnbCategory>[],
    this.lang,
    this.introVideoId,
    this.callOption,
    this.rejectReasons = const <OnbReason>[],
    this.rejectNote,
  });

  final String id;

  /// `submitted | approved | rejected`.
  final String status;
  final List<OnbCategory> categories;
  final String? lang;
  final String? introVideoId;
  final String? callOption;
  final List<OnbReason> rejectReasons;
  final String? rejectNote;

  bool get submitted => status == 'submitted';
  bool get approved => status == 'approved';
  bool get rejected => status == 'rejected';

  factory OnbApplication.fromJson(Map<String, dynamic> j) => OnbApplication(
        id: _str(j['id']) ?? '',
        status: _str(j['status']) ?? 'submitted',
        categories: [for (final c in _maps(j['categories'])) OnbCategory.fromJson(c)],
        lang: _str(j['lang']),
        introVideoId: _str(j['introVideoId']),
        callOption: _str(j['callOption']),
        rejectReasons: [
          for (final r in _maps(j['rejectReasons'])) OnbReason(code: _str(r['code']) ?? '', text: _str(r['text']) ?? ''),
        ].where((r) => r.text.isNotEmpty).toList(),
        rejectNote: _str(j['rejectNote']),
      );
}

class OnbHost {
  const OnbHost({this.status, this.displayName, this.about, this.ratePerMin, this.photoUrl, this.callOption});

  final String? status;
  final String? displayName;
  final String? about;
  final int? ratePerMin;
  final String? photoUrl;
  final String? callOption;

  factory OnbHost.fromJson(Map<String, dynamic> j) => OnbHost(
        status: _str(j['status']),
        displayName: _str(j['displayName']),
        about: _str(j['about']),
        ratePerMin: _int(j['ratePerMin']),
        photoUrl: _str(j['photoUrl']),
        callOption: _str(j['callOption']),
      );
}

class OnbRequirements {
  const OnbRequirements({this.whatsappVerified = false, this.aadhaarDone = false, this.aadhaarGender, this.hasVerifiedSocial = false});

  final bool whatsappVerified;
  final bool aadhaarDone;

  /// `F`, `M`, `T` or null. Never sent to telemetry.
  final String? aadhaarGender;
  final bool hasVerifiedSocial;

  factory OnbRequirements.fromJson(Map<String, dynamic> j) => OnbRequirements(
        whatsappVerified: j['whatsappVerified'] == true,
        aadhaarDone: j['aadhaarDone'] == true,
        aadhaarGender: _str(j['aadhaarGender']),
        hasVerifiedSocial: j['hasVerifiedSocial'] == true,
      );
}

class OnbSocial {
  const OnbSocial({required this.platform, this.handle, this.url, this.followers});

  /// `youtube | instagram | facebook`.
  final String platform;
  final String? handle;
  final String? url;
  final int? followers;

  factory OnbSocial.fromJson(Map<String, dynamic> j) =>
      OnbSocial(platform: _str(j['platform']) ?? '', handle: _str(j['handle']), url: _str(j['url']), followers: _int(j['followers']));
}

/// `GET /api/hf/onboarding/me`.
class OnbMe {
  const OnbMe({this.host, this.video, this.application, this.requirements = const OnbRequirements(), this.socials = const <OnbSocial>[], this.socialSummary = SocialSummary.empty});

  final OnbHost? host;
  final OnbVideo? video;
  final OnbApplication? application;
  final OnbRequirements requirements;
  /// Approved, login-proven accounts only (what the Aadhaar rule reads).
  final List<OnbSocial> socials;

  /// [HF-SOCIAL-STATES] `social`: approved AND connected-below-minimum accounts, so a Page under the minimum is shown, not "Not added".
  final SocialSummary socialSummary;

  factory OnbMe.fromJson(Map<String, dynamic> j) => OnbMe(
        host: j['host'] is Map ? OnbHost.fromJson(_map(j['host'])) : null,
        video: j['video'] is Map ? OnbVideo.fromJson(_map(j['video'])) : null,
        application: j['application'] is Map ? OnbApplication.fromJson(_map(j['application'])) : null,
        requirements: OnbRequirements.fromJson(_map(j['requirements'])),
        socials: [for (final s in _maps(j['socials'])) OnbSocial.fromJson(s)].where((s) => s.platform.isNotEmpty).toList(),
        socialSummary: SocialSummary.fromJson(j['social']),
      );

  OnbSocial? social(String platform) {
    for (final s in socials) {
      if (s.platform == platform) return s;
    }
    return null;
  }
}
