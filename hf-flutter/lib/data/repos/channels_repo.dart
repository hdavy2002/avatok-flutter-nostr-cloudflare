import '../api_client.dart';
import '../api_exception.dart';
import '../models/channel.dart';

/// The version of the consent text on the "connect a channel" screen. Change it whenever the wording changes;
/// the server stores it with the time (worker/src/routes/hf_channels.ts, `consent_version`).
const String kChannelConsentVersion = 'ch-1';

/// Influencer Channels: connect an Instagram or YouTube channel, prove it is hers with a one-time code,
/// and let the server decide (followers at or over `hfInfluencerMinFollowers`).
class ChannelsRepo {
  const ChannelsRepo(this._api);

  final ApiClient _api;

  static const String notOpenText = 'Channels are not open yet. Please check back soon.';

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on ApiException catch (e) {
      // The flag is off: a normal state, shown as a friendly message instead of the generic one.
      if (e.isNotEnabled) {
        throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: notOpenText);
      }
      rethrow;
    }
  }

  /// The signed-in person's own channels.
  Future<ChannelsList> list() => _guard(() async => ChannelsList.fromJson(await _api.getJson('/api/hf/channels')));

  /// [platform] is `instagram` or `youtube`. Throws `ApiException` with the server's message for
  /// `channel_not_found`, `channel_claimed` (someone else owns it), `channel_private`, `limit_reached`, `invalid_field`.
  Future<AddedChannel> add({required String platform, required String handleOrUrl}) => _guard(() async {
        final body = {
          'platform': platform,
          'handleOrUrl': handleOrUrl.trim(),
          'consent': {'version': kChannelConsentVersion, 'embeds': true, 'counts': true, 'ownChannel': true, 'feed': true},
        };
        return AddedChannel.fromJson(await _api.postJson('/api/hf/channels', body: body));
      });

  /// [HF-WIRE-14] "Sign in with YouTube" (HF-REEL-33). [accessToken] comes from Google sign-in with the read-only YouTube scope. The server asks
  /// YouTube whose channel it is (that proves ownership: no code), approves when she is over the minimum, and brings in the details of her public
  /// videos (embeds only). The token is used once and never stored. Errors: `token_invalid`, `no_youtube_channel`, `channel_claimed`, `limit_reached`.
  Future<ChannelCheck> connectYoutube(String accessToken) => _guard(
      () async => ChannelCheck.fromJson(await _api.postJson('/api/hf/channels/youtube/connect', body: {'accessToken': accessToken})));

  /// Re-reads the bio or description (never cached) and decides.
  Future<ChannelCheck> check(String id) => _guard(() async => ChannelCheck.fromJson(await _api.postJson('/api/hf/channels/$id/check')));

  /// Refreshes the follower count of a confirmed channel.
  Future<ChannelCheck> resync(String id) => _guard(() async => ChannelCheck.fromJson(await _api.postJson('/api/hf/channels/$id/resync')));

  /// Disconnects the channel (the server keeps the row).
  Future<void> remove(String id) => _guard(() async {
        await _api.deleteJson('/api/hf/channels/$id');
      });

  /// The follower minimum from the public config (`hfInfluencerMinFollowers`), for screens shown before any channel exists.
  Future<int> minFollowers() async {
    try {
      final cfg = await _api.getJson('/api/config', auth: false);
      final v = cfg['hfInfluencerMinFollowers'];
      return v is num && v >= 0 ? v.toInt() : ChannelsList.defaultMinFollowers;
    } catch (_) {
      return ChannelsList.defaultMinFollowers;
    }
  }
}
