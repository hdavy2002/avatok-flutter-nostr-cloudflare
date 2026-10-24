import 'package:flutter/foundation.dart';

import 'models/reel.dart';

/// [HF-REEL-ENGAGE-APP-1] The like and comment numbers of the reels on this phone, shared by the reel buttons and the comment
/// sheet so a like or a sent comment shows on the reel at once.
@immutable
class EngageState {
  const EngageState({required this.likes, required this.comments, this.liked = false});

  final EngageCount likes;
  final EngageCount comments;
  final bool liked;

  EngageState copyWith({EngageCount? likes, EngageCount? comments, bool? liked}) =>
      EngageState(likes: likes ?? this.likes, comments: comments ?? this.comments, liked: liked ?? this.liked);

  /// Optimistic like / unlike: our side moves by one.
  EngageState withLiked(bool on) => on == liked ? this : EngageState(likes: likes.plusOurs(on ? 1 : -1), comments: comments, liked: on);
}

class ReelEngageStore extends ChangeNotifier {
  ReelEngageStore();

  @visibleForTesting
  static ReelEngageStore? override;
  static ReelEngageStore get instance => override ?? _instance;
  static final _instance = ReelEngageStore();

  final Map<String, EngageState> _s = {};

  EngageState? of(String id) => _s[id];

  /// Remembers a reel's numbers the first time it is seen; later calls keep what the phone already knows (an optimistic
  /// like is not undone by a stale feed page).
  void seed(String id, {required EngageCount likes, required EngageCount comments, bool liked = false}) {
    if (_s.containsKey(id)) return;
    _s[id] = EngageState(likes: likes, comments: comments, liked: liked);
  }

  void seedReel(FeedReel r) {
    final l = r.likeCounts;
    if (l == null) return;
    seed(r.id, likes: l, comments: r.commentCounts ?? EngageCount(platform: r.comments), liked: r.likedByMe);
  }

  void put(String id, EngageState s) {
    if (_s[id] == s) return;
    _s[id] = s;
    notifyListeners();
  }

  void update(String id, EngageState Function(EngageState) f) {
    final cur = _s[id];
    if (cur == null) return;
    put(id, f(cur));
  }

  /// Signing out: nobody's "liked" state may leak to the next account.
  void clear() {
    _s.clear();
    notifyListeners();
  }
}
