import 'package:hf_app/data/models/reel.dart';
import 'package:hf_app/data/reel_bookmarks.dart';

/// Widget tests exercise control/list wiring. Persistence, sync and account races
/// are exercised with the real store in data/reel_bookmarks_test.dart.
class WidgetBookmarks extends ReelBookmarks {
  WidgetBookmarks(super.api, super.accountId);
  final _saved = <String, FeedReel>{};
  @override
  List<FeedReel> get items => _saved.values.toList();
  @override
  bool isSaved(String id) => _saved.containsKey(id);
  @override
  bool busy(String id) => false;
  @override
  Future<void> load() async {}
  @override
  Future<void> refresh() async {}
  @override
  Future<void> toggle(FeedReel reel) async {
    final saved = _saved.remove(reel.id) != null;
    if (!saved) _saved[reel.id] = reel;
    notifyListeners();
    final path = '/api/hf/reel-bookmarks/${reel.id}';
    try {
      if (saved) { await api.deleteJson(path); } else { await api.putJson(path); }
    } catch (_) { /* Local-first view stays changed while sync is unavailable. */ }
  }
}
