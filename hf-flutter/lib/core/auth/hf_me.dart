/// `GET /api/hf/me` (HF-NATIVE-S1): one cheap call for routing, tabs and the Me screen.
///
/// `{uid, displayName, phoneMasked, whatsappVerified, ackVersion, isHost, host:{status, slug}|null,
///   lanes:{women, lgbtq}, closing}`
///
/// Parsing is tolerant: a missing key is a safe default, so the app keeps working while the server
/// side is rolled out.
class HfMe {
  const HfMe({
    required this.uid,
    this.displayName,
    this.phoneMasked,
    this.whatsappVerified = false,
    this.ackVersion,
    this.isHost = false,
    this.host,
    this.womenLane = false,
    this.lgbtqLane = false,
    this.closing = false,
  });

  final String uid;
  final String? displayName;
  final String? phoneMasked;
  final bool whatsappVerified;

  /// The 18+ and safety acknowledgement version already accepted on this account (`hf-ack-v1`), or null.
  final String? ackVersion;
  final bool isHost;

  /// Non-null when this person has a host profile (any status). The Host tab shows when this is set.
  final HfMeHost? host;
  final bool womenLane;
  final bool lgbtqLane;

  /// The account is being closed.
  final bool closing;

  bool get hasHost => host != null;

  factory HfMe.fromJson(Map<String, dynamic> j) {
    bool flag(Object? v) {
      if (v is bool) return v;
      if (v is Map) return v['granted'] == true;
      return false;
    }

    final hostRaw = j['host'];
    final lanes = j['lanes'];
    return HfMe(
      uid: (j['uid'] ?? '').toString(),
      displayName: _s(j['displayName']),
      phoneMasked: _s(j['phoneMasked']),
      whatsappVerified: j['whatsappVerified'] == true,
      ackVersion: _s(j['ackVersion']),
      isHost: j['isHost'] == true || hostRaw is Map,
      host: hostRaw is Map ? HfMeHost.fromJson(Map<String, dynamic>.from(hostRaw)) : null,
      womenLane: lanes is Map ? flag(lanes['women']) : false,
      lgbtqLane: lanes is Map ? flag(lanes['lgbtq']) : false,
      closing: j['closing'] == true,
    );
  }

  static String? _s(Object? v) {
    final s = (v ?? '').toString().trim();
    return s.isEmpty ? null : s;
  }
}

class HfMeHost {
  const HfMeHost({required this.status, this.slug});

  /// `draft | generating | pending_host | pending_review | live | rejected | paused`.
  final String status;
  final String? slug;

  bool get isLive => status == 'live';

  factory HfMeHost.fromJson(Map<String, dynamic> j) =>
      HfMeHost(status: (j['status'] ?? 'draft').toString(), slug: j['slug']?.toString());
}
