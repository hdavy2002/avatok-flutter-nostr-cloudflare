/// Which side of the app this person uses. Code says "host", visible text says "influencer".
enum UserRole { fan, host }

/// `GET /api/hf/me` (worker/src/routes/hf_me.ts):
/// `{uid, displayName, phoneMasked, whatsappVerified, ackVersion, age18ConfirmedAt, isHost,
///   host: {status, slug} | null, lanes: {women, lgbtq}, closing}`.
///
/// Parsing is tolerant: a missing key is a safe default, so the app keeps working while the server
/// side changes.
class Me {
  const Me({
    required this.uid,
    this.name,
    this.role = UserRole.fan,
    this.hostStatus,
    this.hostSlug,
    this.phoneMasked,
    this.whatsappVerified = false,
    this.ackVersion,
    this.closing = false,
    this.email,
    this.age18ConfirmedAt,
    this.firstName,
    this.lastName,
    this.handle,
  });

  final String uid;

  /// The display name, or null while the person has not set one.
  final String? name;
  final UserRole role;

  /// `draft | pending_review | live | rejected | paused ...` when the person has an influencer profile.
  final String? hostStatus;
  final String? hostSlug;
  final String? phoneMasked;
  final bool whatsappVerified;
  final String? ackVersion;

  /// The account is being closed.
  final bool closing;

  /// The person's own email (Clerk's, or the one typed at sign-up), or null.
  final String? email;

  /// Epoch ms of the 18+ confirmation, or null when not confirmed yet.
  final int? age18ConfirmedAt;

  /// [HF-APP-PARITY-PROFILE] The name parts typed at sign-up or in Edit profile, or null when never set.
  final String? firstName;
  final String? lastName;

  /// The permanent @handle (server field `username`), without the @, or null while it is not assigned.
  final String? handle;

  bool get isHost => role == UserRole.host;

  factory Me.fromJson(Map<String, dynamic> j) {
    final hostRaw = j['host'];
    final host = hostRaw is Map ? Map<String, dynamic>.from(hostRaw) : null;
    return Me(
      uid: (j['uid'] ?? '').toString(),
      name: _s(j['displayName']) ?? _s(j['name']),
      role: (j['isHost'] == true || host != null) ? UserRole.host : UserRole.fan,
      hostStatus: host == null ? null : _s(host['status']),
      hostSlug: host == null ? null : _s(host['slug']),
      phoneMasked: _s(j['phoneMasked']),
      whatsappVerified: j['whatsappVerified'] == true,
      ackVersion: _s(j['ackVersion']),
      closing: j['closing'] == true,
      email: _s(j['email']),
      age18ConfirmedAt: j['age18ConfirmedAt'] is num ? (j['age18ConfirmedAt'] as num).toInt() : null,
      firstName: _s(j['firstName']),
      lastName: _s(j['lastName']),
      handle: _s(j['username'])?.replaceFirst(RegExp(r'^@+'), ''),
    );
  }

  static String? _s(Object? v) {
    final s = (v ?? '').toString().trim();
    return s.isEmpty ? null : s;
  }
}

/// [HF-APP-PARITY-PROFILE] "Name influencers see", same rule as the website's Profile page: the name already saved for influencers,
/// and while none was ever saved, the first name. Empty when both are empty.
String influencerFacingName(String? saved, String? first) {
  String clean(String? v) => (v ?? '').trim().replaceAll(RegExp(r'\s+'), ' ');
  final s = clean(saved);
  return s.isNotEmpty ? s : clean(first);
}
