import '../../kyc/data/kyc_models.dart';

/// The host onboarding step list and the "where do I resume" rule. Pure Dart: no widgets, unit-tested
/// (`test/features/host_onboarding/onboarding_steps_test.dart`). Mirrors `STEPS` in
/// `web/src/islands/host-onboarding/data.ts`; the keys are the same, so `/hosts/onboarding?step=<key>` links work.
///
/// Part A (HF-NATIVE-9, `lib/features/host_onboarding/ui/steps/`): welcome, phone, aadhaar, selfie, payout.
/// Part B (HF-NATIVE-10, `lib/features/host_onboarding/part_b/`): avatar ... done. See README.md in this folder.

/// The step keys, as in the URL (`?step=aadhaar`).
abstract final class OnboardingKeys {
  static const String welcome = 'welcome';
  static const String phone = 'phone';
  static const String aadhaar = 'aadhaar';
  static const String selfie = 'selfie';
  static const String payout = 'payout';
  static const String avatar = 'avatar';
  static const String about = 'about';
  static const String languages = 'languages';
  static const String topics = 'topics';
  static const String price = 'price';
  static const String hours = 'hours';
  static const String voice = 'voice';
  static const String review = 'review';
  static const String generating = 'generating';
  static const String preview = 'preview';
  static const String done = 'done';
}

enum OnboardingGroup {
  start('Start'),
  verify('Verify'),
  profile('Profile'),
  voice('Voice'),
  finish('Finish');

  const OnboardingGroup(this.label);
  final String label;
}

/// What the server knows about this person when the screen opens: `GET /api/hosts/me`
/// (`{host, kyc, media, job}`) plus `GET /api/account/phone/status`. Part B reads the profile fields from
/// [host] (the raw `host` object: `displayName, about, languages, style, topics, pricePerMin, hours, healthConsent,
/// womenLane, lgbtqLane, lgbtqPublic, avatarId, avatarUrl, voice:{seconds,mime,status}, genAttempts, agreementsAt,
/// reviewNote, tagline, aboutPolished, quote, status, slug`), [media] and [job].
class OnboardingServerState {
  const OnboardingServerState({
    this.host,
    this.kyc = const KycStatus(),
    this.media = const <Map<String, dynamic>>[],
    this.job,
    this.phoneVerified = false,
    this.phoneLast4,
  });

  /// The raw `host` object, or null when this person has no host row yet.
  final Map<String, dynamic>? host;
  final KycStatus kyc;
  final List<Map<String, dynamic>> media;

  /// `{id, status, stage, stages, error, createdAt, updatedAt}` of the latest profile-making job.
  final Map<String, dynamic>? job;
  final bool phoneVerified;
  final String? phoneLast4;

  /// `draft | generating | pending_host | pending_review | live | rejected | paused`. Null: no host row yet.
  String? get hostStatus => _s(host?['status']);
  bool get hasHost => host != null;

  String? hostString(String key) => _s(host?[key]);

  List<String> hostStrings(String key) {
    final v = host?[key];
    return v is List ? v.map((e) => e.toString()).toList() : const <String>[];
  }

  num? hostNum(String key) {
    final v = host?[key];
    return v is num ? v : null;
  }

  Map<String, dynamic> hostMap(String key) {
    final v = host?[key];
    return v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  }

  /// The profile has been made at least once (it is past the generating step).
  bool get generated =>
      const {'pending_host', 'pending_review', 'live', 'rejected', 'paused'}.contains(hostStatus);

  factory OnboardingServerState.fromJson(
    Map<String, dynamic> me, {
    Map<String, dynamic>? phone,
    bool sessionPhoneVerified = false,
    String? sessionPhoneMasked,
  }) {
    final hostRaw = me['host'];
    final kycRaw = me['kyc'];
    final mediaRaw = me['media'];
    final jobRaw = me['job'];
    String? last4;
    final phoneText = (phone?['phone'] ?? sessionPhoneMasked ?? '').toString();
    final digits = phoneText.replaceAll(RegExp(r'\D'), '');
    if (digits.length >= 4) last4 = digits.substring(digits.length - 4);
    return OnboardingServerState(
      host: hostRaw is Map ? Map<String, dynamic>.from(hostRaw) : null,
      kyc: kycRaw is Map ? KycStatus.fromJson(Map<String, dynamic>.from(kycRaw)) : const KycStatus(),
      media: mediaRaw is List
          ? [for (final m in mediaRaw) if (m is Map) Map<String, dynamic>.from(m)]
          : const <Map<String, dynamic>>[],
      job: jobRaw is Map ? Map<String, dynamic>.from(jobRaw) : null,
      phoneVerified: phone?['verified'] == true || sessionPhoneVerified,
      phoneLast4: last4,
    );
  }

  static String? _s(Object? v) {
    final s = (v ?? '').toString().trim();
    return s.isEmpty ? null : s;
  }
}

/// One step: its key, its group, its title and the rule that says the server already has it.
class OnboardingStepDef {
  const OnboardingStepDef(this.key, this.group, this.title, this.isDone);

  final String key;
  final OnboardingGroup group;
  final String title;

  /// True when the server state shows this step is complete. Resume picks the first step that is not.
  final bool Function(OnboardingServerState s) isDone;
}

bool _anyProgress(OnboardingServerState s) =>
    s.hasHost || s.kyc.aadhaarDone || s.kyc.selfieStatus != 'none' || s.kyc.payoutDone;

/// Every step, in order. Part B may refine an `isDone` rule for its own steps.
final List<OnboardingStepDef> kOnboardingSteps = <OnboardingStepDef>[
  const OnboardingStepDef(OnboardingKeys.welcome, OnboardingGroup.start, 'Welcome', _anyProgress),
  OnboardingStepDef(OnboardingKeys.phone, OnboardingGroup.verify, 'Your WhatsApp number', (s) => s.phoneVerified),
  OnboardingStepDef(OnboardingKeys.aadhaar, OnboardingGroup.verify, 'Aadhaar check', (s) => s.kyc.aadhaarDone),
  OnboardingStepDef(
    OnboardingKeys.selfie,
    OnboardingGroup.verify,
    'Selfie video',
    // A rejected video has to be recorded again.
    (s) => s.kyc.selfieStatus == 'pending' || s.kyc.selfieStatus == 'approved',
  ),
  OnboardingStepDef(OnboardingKeys.payout, OnboardingGroup.verify, 'Where we pay you', (s) => s.kyc.payoutDone),
  OnboardingStepDef(OnboardingKeys.avatar, OnboardingGroup.profile, 'Choose your avatar', (s) => s.hostString('avatarId') != null),
  OnboardingStepDef(
    OnboardingKeys.about,
    OnboardingGroup.profile,
    'About you',
    (s) => (s.hostString('displayName') ?? '').length >= 2 && s.hostString('about') != null,
  ),
  OnboardingStepDef(
    OnboardingKeys.languages,
    OnboardingGroup.profile,
    'Languages and style',
    (s) => s.hostStrings('languages').isNotEmpty && s.hostString('style') != null,
  ),
  OnboardingStepDef(
    OnboardingKeys.topics,
    OnboardingGroup.profile,
    'What you like to talk about',
    (s) => s.hostStrings('topics').isNotEmpty,
  ),
  OnboardingStepDef(OnboardingKeys.price, OnboardingGroup.profile, 'Your price', (s) => s.hostNum('pricePerMin') != null),
  OnboardingStepDef(OnboardingKeys.hours, OnboardingGroup.profile, 'Hours and comfort', (s) {
    final days = s.hostMap('hours')['days'];
    return days is List && days.isNotEmpty;
  }),
  OnboardingStepDef(OnboardingKeys.voice, OnboardingGroup.voice, 'Record your introduction', (s) {
    final seconds = s.hostMap('voice')['seconds'];
    return seconds is num && seconds > 0;
  }),
  OnboardingStepDef(
    OnboardingKeys.review,
    OnboardingGroup.finish,
    'Check everything',
    (s) => s.hostNum('agreementsAt') != null || s.generated || s.hostStatus == 'generating',
  ),
  OnboardingStepDef(OnboardingKeys.generating, OnboardingGroup.finish, 'Creating your profile', (s) => s.generated),
  OnboardingStepDef(
    OnboardingKeys.preview,
    OnboardingGroup.finish,
    'Your profile',
    (s) => s.hostStatus == 'pending_review' || s.hostStatus == 'live',
  ),
  OnboardingStepDef(OnboardingKeys.done, OnboardingGroup.finish, 'Sent for review', (s) => false),
];

/// Position of [key] in [kOnboardingSteps], or -1.
int onboardingStepIndex(String? key) => kOnboardingSteps.indexWhere((s) => s.key == key);

/// The step to resume at, from what the server knows.
///
/// - `pending_review` or `live`: `done` (sent for review / live).
/// - `generating`: `generating`.
/// - `rejected` or `paused`: `preview` ("Fix and send again" reopens at the preview).
/// - otherwise: the first step whose [OnboardingStepDef.isDone] is false.
String resumeStepKey(OnboardingServerState s) {
  switch (s.hostStatus) {
    case 'pending_review':
    case 'live':
      return OnboardingKeys.done;
    case 'generating':
      return OnboardingKeys.generating;
    case 'rejected':
    case 'paused':
      return OnboardingKeys.preview;
  }
  for (final step in kOnboardingSteps) {
    if (!step.isDone(s)) return step.key;
  }
  return OnboardingKeys.done;
}

/// Where the screen opens. A `?step=` from a link wins only when it is not past the resume step, so a link
/// can take a person back to edit, but never skip the checks that come first. Unknown keys resume.
String startStepKey(OnboardingServerState s, {String? requested}) {
  final resume = resumeStepKey(s);
  final ri = onboardingStepIndex(requested);
  if (requested == null || ri < 0) return resume;
  return ri <= onboardingStepIndex(resume) ? requested : resume;
}
