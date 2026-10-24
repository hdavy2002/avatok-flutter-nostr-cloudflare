import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models/reel_engage.dart';
import 'services.dart';

/// [HF-REEL-COMMENTS-CACHE-1] The first page of comments of each reel, kept on the phone so the comment sheet opens at once.
/// In memory (newest-used [memoryCap] reels) and saved per signed-in account (newest [diskCap] reels): `mine` and `likedByMe`
/// differ per person, so one account never reads another's saved page. A guest has a "guest" slot of its own.
class ReelCommentsCache {
  ReelCommentsCache(this.accountId, {this.memoryCap = 50, this.diskCap = 30});

  final String? Function() accountId;
  final int memoryCap;
  final int diskCap;

  @visibleForTesting
  static ReelCommentsCache? override;
  static ReelCommentsCache get instance => override ?? _instance;
  static final _instance = ReelCommentsCache(() => Services.instance.user?.id);

  String? _scopeKey;

  /// Oldest first; the last entry is the most recently used.
  final LinkedHashMap<String, Map<String, dynamic>> _mem = LinkedHashMap();
  bool _diskLoaded = false;
  Future<void>? _diskLoading;
  Future<void> _tail = Future<void>.value();

  String get _slot => accountId() ?? 'guest';
  String get _prefKey => 'hf.reelComments.v1.${Uri.encodeComponent(_slot)}';

  /// Drops everything held for another account the moment the account changes.
  void _scope() {
    final now = _slot;
    if (_scopeKey == now) return;
    _scopeKey = now;
    _mem.clear();
    _diskLoaded = false;
    _diskLoading = null;
  }

  CommentsPage? _page(Map<String, dynamic>? j) => j == null ? null : CommentsPage.fromJson(j);

  /// Memory only, instant. Null when this phone has not kept the page in memory.
  CommentsPage? peek(String reelId) {
    _scope();
    final j = _mem.remove(reelId);
    if (j == null) return null;
    _mem[reelId] = j; // most recently used
    return _page(j);
  }

  /// Memory first, then the saved copy on the phone.
  Future<CommentsPage?> read(String reelId) async {
    _scope();
    final hit = peek(reelId);
    if (hit != null) return hit;
    final slot = _scopeKey;
    await (_diskLoading ??= _loadDisk());
    if (_scopeKey != slot) return null; // the account changed while reading
    return peek(reelId);
  }

  Future<void> _loadDisk() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefKey);
      if (raw != null && !_diskLoaded) {
        final j = jsonDecode(raw) as Map;
        final order = (j['order'] as List? ?? const []).map((e) => '$e').toList();
        final pages = j['pages'] is Map ? Map<String, dynamic>.from(j['pages'] as Map) : const <String, dynamic>{};
        // saved entries are older than anything written this run, so they go in front
        final newer = Map<String, Map<String, dynamic>>.of(_mem);
        _mem.clear();
        for (final id in order) {
          final p = pages[id];
          if (p is Map && !newer.containsKey(id)) _mem[id] = Map<String, dynamic>.from(p);
        }
        _mem.addAll(newer);
        while (_mem.length > memoryCap) {
          _mem.remove(_mem.keys.first);
        }
      }
    } catch (_) {
      // a damaged copy is just a miss
    }
    _diskLoaded = true;
  }

  /// Stores [page] as the newest entry and saves it.
  Future<void> write(String reelId, CommentsPage page) {
    _scope();
    _mem.remove(reelId);
    _mem[reelId] = Map<String, dynamic>.from(page.toJson());
    while (_mem.length > memoryCap) {
      _mem.remove(_mem.keys.first);
    }
    final key = _prefKey;
    final slot = _scopeKey;
    // one save at a time, in order; the saved copy is read first so older reels are not lost
    _tail = _tail.then((_) async {
      if (_scopeKey != slot) return; // signed out or switched while waiting
      try {
        await (_diskLoading ??= _loadDisk());
        if (_scopeKey != slot) return;
        final keep = _mem.keys.toList();
        final ids = keep.sublist(keep.length > diskCap ? keep.length - diskCap : 0);
        await (await SharedPreferences.getInstance()).setString(key, jsonEncode({'order': ids, 'pages': {for (final id in ids) id: _mem[id]}}));
      } catch (_) {
        // the memory copy still works
      }
    });
    return _tail;
  }

  /// Sign-out: forget what is held in memory. The saved copies stay under their own account.
  void clearMemory() {
    _mem.clear();
    _diskLoaded = false;
    _diskLoading = null;
    _scopeKey = null;
  }
}
