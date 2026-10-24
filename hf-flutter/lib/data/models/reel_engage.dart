/// [HF-REEL-ENGAGE-APP-1] Likes and comments on a reel. Match worker `GET/POST /api/hf/reels/:id/comments` (Specs/HF-REEL-ENGAGE-1.md).
/// Parsing is tolerant: a missing key is a safe default. The server never sends a user id or phone.
library;

import 'reel.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
String? _str(Object? v) {
  final s = v?.toString();
  return (s == null || s.isEmpty) ? null : s;
}

/// One comment. [source] is `ours`, `youtube` or `instagram`.
class ReelComment {
  const ReelComment({
    required this.id,
    this.source = 'ours',
    this.authorName = '',
    this.authorAvatar,
    this.authorUrl,
    this.body = '',
    this.likeCount,
    this.createdAt = 0,
    this.mine = false,
    this.parentId,
    this.replies = const [],
  });

  final String id;
  final String source;
  final String authorName;
  final String? authorAvatar;
  final String? authorUrl;
  final String body;
  final int? likeCount;

  /// Milliseconds since the epoch.
  final int createdAt;
  final bool mine;
  final String? parentId;
  final List<ReelComment> replies;

  bool get isOurs => source == 'ours';

  /// "YouTube" / "Instagram" for the small chip; null for ours (no chip).
  String? get sourceLabel => source == 'youtube'
      ? 'YouTube'
      : source == 'instagram'
      ? 'Instagram'
      : null;

  ReelComment withReplies(List<ReelComment> r) => ReelComment(
    id: id,
    source: source,
    authorName: authorName,
    authorAvatar: authorAvatar,
    authorUrl: authorUrl,
    body: body,
    likeCount: likeCount,
    createdAt: createdAt,
    mine: mine,
    parentId: parentId,
    replies: r,
  );

  factory ReelComment.fromJson(Map<String, dynamic> j) {
    final a = j['author'] is Map ? Map<String, dynamic>.from(j['author'] as Map) : const <String, dynamic>{};
    final src = _str(j['source']);
    final lc = j['likeCount'];
    return ReelComment(
      id: _str(j['id']) ?? '',
      source: (src == 'youtube' || src == 'instagram') ? src! : 'ours',
      authorName: _str(a['name']) ?? 'Someone',
      authorAvatar: _str(a['avatar']),
      authorUrl: _str(a['url']),
      body: _str(j['body']) ?? '',
      likeCount: lc is num ? lc.toInt() : null,
      createdAt: _int(j['createdAt']),
      mine: j['mine'] == true,
      parentId: _str(j['parentId']),
      replies: [
        for (final e in (j['replies'] is List ? j['replies'] as List : const []))
          if (e is Map) ReelComment.fromJson(Map<String, dynamic>.from(e)),
      ],
    );
  }
}

/// One page of comments plus the current numbers.
class CommentsPage {
  const CommentsPage({this.items = const [], this.nextCursor, this.likes, this.comments, this.likedByMe = false});

  final List<ReelComment> items;
  final String? nextCursor;
  final EngageCount? likes;
  final EngageCount? comments;
  final bool likedByMe;

  factory CommentsPage.fromJson(Map<String, dynamic> j) {
    final c = j['counts'] is Map ? Map<String, dynamic>.from(j['counts'] as Map) : const <String, dynamic>{};
    return CommentsPage(
      items: [
        for (final e in (j['items'] is List ? j['items'] as List : const []))
          if (e is Map) ReelComment.fromJson(Map<String, dynamic>.from(e)),
      ],
      nextCursor: _str(j['nextCursor']),
      likes: EngageCount.tryParse(c['likes']),
      comments: EngageCount.tryParse(c['comments']),
      likedByMe: j['likedByMe'] == true,
    );
  }
}

/// Answer of a like / unlike.
class LikeResult {
  const LikeResult({required this.liked, required this.likes});

  final bool liked;
  final EngageCount likes;

  factory LikeResult.fromJson(Map<String, dynamic> j) =>
      LikeResult(liked: j['liked'] == true, likes: EngageCount.tryParse(j['likes']) ?? const EngageCount());
}
