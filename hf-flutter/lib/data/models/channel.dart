/// Where one connected channel stands. Matches `state` in worker/src/routes/hf_channels.ts.
enum ChannelState {
  /// Waiting for the ownership code or for the check to finish.
  checking,

  /// Confirmed and over the follower minimum.
  approved,

  /// Confirmed, but under the follower minimum.
  needsFollowers,

  /// [HF-CREATOR-SPACES-1] Confirmed and over the follower minimum, but under the total-views minimum (YouTube).
  needsViews,

  /// The influencer removed it.
  disconnected;

  static ChannelState parse(Object? v) => switch ((v ?? '').toString()) {
        'approved' => ChannelState.approved,
        'needs_followers' => ChannelState.needsFollowers,
        'needs_views' => ChannelState.needsViews,
        'disconnected' => ChannelState.disconnected,
        _ => ChannelState.checking,
      };
}

/// One Instagram or YouTube channel of the signed-in influencer (`GET /api/hf/channels`).
class Channel {
  const Channel({
    required this.id,
    required this.platform,
    required this.handle,
    this.url,
    this.followers = 0,
    this.views = 0,
    this.state = ChannelState.checking,
    this.verified = false,
    this.needsCode = false,
    this.verifyCode,
    this.lastSyncAt,
    this.viaLogin = false,
    this.needsReconnect = false,
  });

  final String id;

  /// `instagram` or `youtube`.
  final String platform;
  final String handle;
  final String? url;
  final int followers;

  /// [HF-CREATOR-SPACES-1] Total YouTube views (0 for Instagram or when the server does not send it).
  final int views;
  final ChannelState state;

  /// The ownership code was seen once.
  final bool verified;

  /// Still waiting for the code in the bio or description.
  final bool needsCode;

  /// Only present while [needsCode].
  final String? verifyCode;

  /// Milliseconds since the epoch, or null when never synced.
  final int? lastSyncAt;

  /// [HF-IG-LOGIN-1] Ownership was proven by logging in (Instagram / YouTube), not by a code in the bio. Only logged-in channels bring in comments and likes.
  final bool viaLogin;

  /// [HF-IG-LOGIN-1] The Instagram login expired or was withdrawn: she must log in again.
  final bool needsReconnect;

  /// [HF-IG-LOGIN-1] An Instagram channel added by bio code: the app asks her to log in (HF-REEL-61).
  bool get isInstagramBioCode => isInstagram && !viaLogin && state != ChannelState.disconnected;

  bool get isInstagram => platform == 'instagram';
  String get platformName => isInstagram ? 'Instagram' : 'YouTube';
  String get followersWord => isInstagram ? 'followers' : 'subscribers';

  factory Channel.fromJson(Map<String, dynamic> j) => Channel(
        id: (j['id'] ?? '').toString(),
        platform: (j['platform'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        url: _s(j['url']),
        followers: _i(j['followers']),
        views: _i(j['views']),
        state: ChannelState.parse(j['state']),
        verified: j['verified'] == true,
        needsCode: j['needsCode'] == true,
        verifyCode: _s(j['verifyCode']),
        lastSyncAt: j['lastSyncAt'] is num ? (j['lastSyncAt'] as num).toInt() : null,
        viaLogin: j['viaLogin'] == true,
        needsReconnect: j['needsReconnect'] == true,
      );
}

/// `GET /api/hf/channels`.
class ChannelsList {
  const ChannelsList({this.channels = const [], this.minFollowers = defaultMinFollowers, this.minViews = defaultMinViews, this.hostStatus, this.qualified = false});

  /// [HF-CREATOR-SPACES-1] Used only until the server says otherwise (`hfInfluencerMinViews`, YouTube total views).
  static const int defaultMinViews = 1000;
  final int minViews;

  /// Used only until the server says otherwise; the real number is `hfInfluencerMinFollowers`.
  static const int defaultMinFollowers = 10;

  final List<Channel> channels;
  final int minFollowers;

  /// `hf_hosts.status` (`pending_check`, `approved`, ...), or null.
  final String? hostStatus;

  /// At least one channel is confirmed and over the minimum.
  final bool qualified;

  /// Removed channels are kept on the server but not worth showing as a card to most people; the list screen shows them last.
  List<Channel> get active => channels.where((c) => c.state != ChannelState.disconnected).toList();

  factory ChannelsList.fromJson(Map<String, dynamic> j) {
    final raw = j['channels'];
    return ChannelsList(
      channels: raw is List ? [for (final e in raw) if (e is Map) Channel.fromJson(Map<String, dynamic>.from(e))] : const [],
      minFollowers: j['minFollowers'] is num ? (j['minFollowers'] as num).toInt() : defaultMinFollowers,
      minViews: j['minViews'] is num ? (j['minViews'] as num).toInt() : defaultMinViews,
      hostStatus: _s(j['hostStatus']),
      qualified: j['qualified'] == true,
    );
  }
}

/// `POST /api/hf/channels`: the channel was found and a code was issued.
class AddedChannel {
  const AddedChannel({required this.channel, required this.verifyCode, required this.instructions, this.minFollowers = ChannelsList.defaultMinFollowers});

  final Channel channel;
  final String verifyCode;
  final String instructions;
  final int minFollowers;

  factory AddedChannel.fromJson(Map<String, dynamic> j) {
    final ch = j['channel'];
    return AddedChannel(
      channel: Channel.fromJson(ch is Map ? Map<String, dynamic>.from(ch) : const <String, dynamic>{}),
      verifyCode: (j['verifyCode'] ?? '').toString(),
      instructions: (j['instructions'] ?? '').toString(),
      minFollowers: j['minFollowers'] is num ? (j['minFollowers'] as num).toInt() : ChannelsList.defaultMinFollowers,
    );
  }
}

/// What a check found.
enum CheckResult {
  approved,
  needsFollowers,
  needsViews, // [HF-CREATOR-SPACES-1]
  codeMissing,
  notFound,
  private,
  hiddenCount,
  unknown;

  static CheckResult parse(Object? v) => switch ((v ?? '').toString()) {
        'approved' => CheckResult.approved,
        'needs_followers' => CheckResult.needsFollowers,
        'needs_views' => CheckResult.needsViews,
        'code_missing' => CheckResult.codeMissing,
        'not_found' => CheckResult.notFound,
        'private' => CheckResult.private,
        'hidden_count' => CheckResult.hiddenCount,
        _ => CheckResult.unknown,
      };
}

/// `POST /api/hf/channels/:id/check` and `/resync`.
class ChannelCheck {
  const ChannelCheck({required this.result, required this.message, required this.channel, this.minFollowers = ChannelsList.defaultMinFollowers, this.minViews = ChannelsList.defaultMinViews, this.qualified = false});

  final CheckResult result;

  /// Plain-English text from the server.
  final String message;
  final Channel channel;
  final int minFollowers;
  final int minViews; // [HF-CREATOR-SPACES-1]
  final bool qualified;

  factory ChannelCheck.fromJson(Map<String, dynamic> j) {
    final ch = j['channel'];
    return ChannelCheck(
      result: CheckResult.parse(j['result']),
      message: (j['message'] ?? '').toString(),
      channel: Channel.fromJson(ch is Map ? Map<String, dynamic>.from(ch) : const <String, dynamic>{}),
      minFollowers: j['minFollowers'] is num ? (j['minFollowers'] as num).toInt() : ChannelsList.defaultMinFollowers,
      minViews: j['minViews'] is num ? (j['minViews'] as num).toInt() : ChannelsList.defaultMinViews,
      qualified: j['qualified'] == true,
    );
  }
}

String? _s(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

int _i(Object? v) => v is num ? v.toInt() : int.tryParse((v ?? '').toString()) ?? 0;
