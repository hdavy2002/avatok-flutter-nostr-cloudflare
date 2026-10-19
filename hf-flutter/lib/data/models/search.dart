/// Search, Invite votes and Favourites models (HF-WIRE-9). Match worker/src/routes/hf_search.ts and hf_favourites.ts.
/// Parsing is tolerant: a missing key is a safe default.
library;

import 'reel.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String? _str(Object? v) {
  final s = v?.toString();
  return (s == null || s.isEmpty) ? null : s;
}

List<Map<String, dynamic>> _maps(Object? v) => [
      for (final e in (v is List ? v : const []))
        if (e is Map) Map<String, dynamic>.from(e),
    ];

/// An influencer who is not on the app yet, with the fans' vote count. [handle] has the leading "@".
class MissingCreator {
  const MissingCreator({required this.handle, required this.platform, this.votes = 0, this.followers});

  final String handle;
  final String platform;
  final int votes;
  final int? followers;

  String get key => '$platform:${handle.toLowerCase()}';

  MissingCreator withVotes(int v) => MissingCreator(handle: handle, platform: platform, votes: v, followers: followers);

  factory MissingCreator.fromJson(Map<String, dynamic> j) => MissingCreator(
        handle: _str(j['handle']) ?? '',
        platform: _str(j['platform']) ?? 'instagram',
        votes: _int(j['votes']),
        followers: j['followers'] == null ? null : _int(j['followers']),
      );
}

/// `GET /api/hf/search`.
class SearchResult {
  const SearchResult({this.online = const [], this.offline = const [], this.notOnNetwork = const []});

  final List<ReelHost> online;
  final List<ReelHost> offline;
  final List<MissingCreator> notOnNetwork;

  bool get isEmpty => online.isEmpty && offline.isEmpty && notOnNetwork.isEmpty;

  factory SearchResult.fromJson(Map<String, dynamic> j) => SearchResult(
        online: [for (final m in _maps(j['online'])) ReelHost.fromJson(m)],
        offline: [for (final m in _maps(j['offline'])) ReelHost.fromJson(m)],
        notOnNetwork: [for (final m in _maps(j['notOnNetwork'])) MissingCreator.fromJson(m)],
      );
}

/// A topic chip, from `GET /api/hf/options`.
class TopicOption {
  const TopicOption({required this.slug, required this.label});

  final String slug;
  final String label;
}

/// One saved influencer in `GET /api/hf/favourites`.
class FavouriteHost {
  const FavouriteHost({required this.slug, required this.name, this.photoUrl, this.headline, this.presence = 'offline'});

  final String slug;
  final String name;
  final String? photoUrl;
  final String? headline;
  final String presence;

  bool get online => presence == 'online' || presence == 'busy';

  factory FavouriteHost.fromJson(Map<String, dynamic> j) => FavouriteHost(
        slug: _str(j['slug']) ?? '',
        name: _str(j['displayName']) ?? '',
        photoUrl: _str(j['photoUrl']),
        headline: _str(j['headline']),
        presence: _str(j['presence']) ?? 'offline',
      );
}
