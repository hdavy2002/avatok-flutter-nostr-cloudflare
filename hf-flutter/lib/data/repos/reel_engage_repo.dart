import '../api_client.dart';
import '../api_exception.dart';
import '../models/reel_engage.dart';

/// [HF-REEL-ENGAGE-APP-1] What the reel screen needs for likes and comments. The real one talks to the server; the demo
/// one keeps everything in memory so the demo build still works.
abstract class ReelEngageApi {
  Future<LikeResult> setLike(String reelId, bool on);
  Future<CommentsPage> comments(String reelId, {String? cursor});
  Future<ReelComment> send(String reelId, String body, {String? parentId});
  Future<void> delete(String commentId);
  Future<void> report(String commentId, String reason);
}

/// Plain-English text for a refused comment (spec 4.4). Falls back to the server's own sentence, then a generic one.
String engageErrorText(Object e, {String fallback = 'Could not do that. Please try again.'}) {
  if (e is ApiException) {
    switch (e.code) {
      case 'empty':
        return 'Write something first.';
      case 'too_long':
        return 'That comment is too long. Please make it shorter.';
      case 'no_links':
        return 'Links are not allowed in comments.';
      case 'not_allowed':
        return 'That comment is not allowed here.';
    }
    if (e.status == 429) return 'You are going too fast. Please wait a little and try again.';
    if (e.isUnauthorized) return 'Please sign in to do that.';
    return e.userMessage == ApiException.genericText ? fallback : e.userMessage;
  }
  return fallback;
}

class ReelEngageRepo implements ReelEngageApi {
  const ReelEngageRepo(this._api, {this.signedIn});

  final ApiClient _api;

  /// Whether to send the sign-in with a read (so `mine` and `likedByMe` come back). Null counts as yes.
  final bool Function()? signedIn;

  String _p(String id) => '/api/hf/reels/${Uri.encodeComponent(id)}';

  @override
  Future<LikeResult> setLike(String reelId, bool on) async {
    final j = on ? await _api.postJson('${_p(reelId)}/like') : await _api.deleteJson('${_p(reelId)}/like');
    return LikeResult.fromJson(j);
  }

  @override
  Future<CommentsPage> comments(String reelId, {String? cursor}) async => CommentsPage.fromJson(
    await _api.getJson('${_p(reelId)}/comments', query: {'cursor': cursor}, auth: signedIn?.call() ?? true),
  );

  @override
  Future<ReelComment> send(String reelId, String body, {String? parentId}) async {
    final j = await _api.postJson('${_p(reelId)}/comments', body: {'body': body, if (parentId != null) 'parentId': parentId});
    final item = j['item'] is Map ? j['item'] : j;
    return ReelComment.fromJson(Map<String, dynamic>.from(item as Map));
  }

  @override
  Future<void> delete(String commentId) async {
    await _api.deleteJson('/api/hf/reels/comments/${Uri.encodeComponent(commentId)}');
  }

  @override
  Future<void> report(String commentId, String reason) async {
    await _api.postJson('/api/hf/reels/comments/${Uri.encodeComponent(commentId)}/report', body: {'reason': reason});
  }
}

/// Demo build: likes and comments live in memory only.
class DemoReelEngage implements ReelEngageApi {
  DemoReelEngage({this.authorName = 'You'});

  final String authorName;
  final Map<String, List<ReelComment>> _byReel = {};
  final Map<String, String> _reelOf = {};
  int _n = 0;

  @override
  Future<LikeResult> setLike(String reelId, bool on) async => LikeResult(liked: on, likes: const EngageCount());

  @override
  Future<CommentsPage> comments(String reelId, {String? cursor}) async =>
      CommentsPage(items: List.of(_byReel[reelId] ?? const []));

  @override
  Future<ReelComment> send(String reelId, String body, {String? parentId}) async {
    final c = ReelComment(
      id: 'demo_${_n++}',
      authorName: authorName,
      body: body,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      mine: true,
      parentId: parentId,
    );
    _reelOf[c.id] = reelId;
    final list = _byReel.putIfAbsent(reelId, () => []);
    if (parentId == null) {
      list.insert(0, c);
    } else {
      final i = list.indexWhere((e) => e.id == parentId);
      if (i >= 0) list[i] = list[i].withReplies([...list[i].replies, c]);
    }
    return c;
  }

  @override
  Future<void> delete(String commentId) async {
    final reel = _reelOf[commentId];
    final list = _byReel[reel];
    if (list == null) return;
    list.removeWhere((e) => e.id == commentId);
    for (var i = 0; i < list.length; i++) {
      list[i] = list[i].withReplies([for (final r in list[i].replies) if (r.id != commentId) r]);
    }
  }

  @override
  Future<void> report(String commentId, String reason) async {}
}
