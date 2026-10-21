import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'telemetry.dart';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'api_exception.dart';
import 'models/reel.dart';
import 'services.dart';

/// Saved videos, independent of saved influencer profiles. Durable local saves and pending sync are namespaced by authenticated account.
class ReelBookmarks extends ChangeNotifier {
  ReelBookmarks(this.api, this.accountId);
  final ApiClient api;
  final String? Function() accountId;
  static final instance = ReelBookmarks(
    Services.instance.api,
    () => Services.instance.user?.id,
  );
  String? _account;
  int _epoch = 0;
  bool _loaded = false;
  Future<void>? _loading;
  Future<void> _syncTail = Future<void>.value();
  final Map<String, FeedReel> _items = {};
  final Set<String> _pending = {};
  final Map<String, bool> _outbox = {};
  String get _key => 'hf.reelBookmarks.v1.${Uri.encodeComponent(_account!)}';

  void _scope() {
    final next = accountId();
    if (_account == next) return;
    _account = next;
    _epoch++;
    _items.clear();
    _pending.clear();
    _outbox.clear();
    _loaded = false;
    _loading = null;
  }

  List<FeedReel> get items {
    _scope();
    return List.unmodifiable(_items.values);
  }

  bool isSaved(String id) {
    _scope();
    return _items.containsKey(id);
  }

  bool busy(String id) {
    _scope();
    return _pending.contains(id);
  }

  Future<void> load() {
    _scope();
    if (_account == null || _loaded) return Future.value();
    return _loading ??= _fetch(_epoch);
  }

  Map<String, dynamic> _json(FeedReel r) => {
    'id': r.id,
    'platform': r.platform,
    'url': r.url,
    'embedUrl': r.embedUrl,
    'thumbUrl': r.thumbUrl,
    'caption': r.caption,
    'likes': r.likes,
    'views': r.views,
    'host': {
      'slug': r.host.slug,
      'name': r.host.name,
      'handle': r.host.handle,
      'avatar': r.host.avatar,
      'ratePaise': r.host.ratePaise,
      'followers': r.host.followers,
      'presence': r.host.presence,
    },
    if (r.invite != null) ...{
      'kind': 'invite',
      'creator': {
        'platform': r.invite!.platform,
        'handle': r.invite!.handle,
        'name': r.invite!.name,
        'avatar': r.invite!.avatar,
        'followers': r.invite!.followers,
        'votes': r.invite!.votes,
      },
    },
  };
  Future<void> _persist(String key) async {
    final value = jsonEncode({
      'items': _items.values.map(_json).toList(),
      'outbox': _outbox,
    });
    if (!await (await SharedPreferences.getInstance()).setString(key, value))
      throw StateError('Could not save video on this device.');
  }

  Future<void> _fetch(int epoch) async {
    final key = _key;
    try {
      final stored = (await SharedPreferences.getInstance()).getString(key);
      _scope();
      if (epoch != _epoch) return;
      if (stored != null) {
        final json = jsonDecode(stored) as Map;
        for (final value in (json['items'] as List? ?? [])) {
          final reel = FeedReel.fromJson(
            Map<String, dynamic>.from(value as Map),
          );
          _items[reel.id] = reel;
        }
        _outbox.addAll(Map<String, bool>.from(json['outbox'] as Map? ?? {}));
      }
      _loaded = true;
      notifyListeners();
      await _sync(epoch, key);
    } finally {
      if (epoch == _epoch) _loading = null;
    }
  }

  Future<void> _sync(int epoch, String key) {
    // One server read/write sequence at a time. A queued save stays in the outbox
    // while an older GET completes, so that GET cannot erase it.
    final next = _syncTail.then((_) => _syncNow(epoch, key));
    _syncTail = next.catchError((Object _) {});
    return next;
  }

  Future<void> _syncNow(int epoch, String key) async {
    _scope();
    if (epoch != _epoch) return;
    try {
      // A collection 404 means the API is not deployed/enabled. Preserve all local
      // operations; only a subsequent item-specific rejection can be permanent.
      await api.getJson('/api/hf/reel-bookmarks');
      _scope();
      if (epoch != _epoch) return;
      for (final entry in Map.of(_outbox).entries) {
        _scope();
        if (epoch != _epoch) return;
        final path = '/api/hf/reel-bookmarks/${Uri.encodeComponent(entry.key)}';
        try {
          if (entry.value) {
            await api.putJson(path);
          } else {
            await api.deleteJson(path);
          }
        } on ApiException catch (error) {
          _scope();
          if (epoch != _epoch) return;
          final permanent =
              (error.status == 404 && error.code == 'not_found') ||
              (error.status == 409 && error.code == 'limit_reached');
          if (!permanent) rethrow; // network, auth, disabled API: retry later
          if (_outbox[entry.key] == entry.value) {
            _outbox.remove(entry.key);
            if (entry.value) _items.remove(entry.key);
          }
          await _persist(key);
          Telemetry.event('hf_reel_bookmark_sync', {
            'outcome': 'rejected',
            'reason': error.code,
          });
          continue;
        }
        _scope();
        if (epoch != _epoch) return;
        if (_outbox[entry.key] == entry.value) _outbox.remove(entry.key);
      }
      final json = await api.getJson('/api/hf/reel-bookmarks');
      _scope();
      if (epoch != _epoch) return;
      // Preserve operations queued while this request was in flight.
      final local = Map.of(_items);
      _items.clear();
      for (final value in (json['items'] as List? ?? [])) {
        final reel = FeedReel.fromJson(Map<String, dynamic>.from(value as Map));
        _items[reel.id] = reel;
      }
      for (final entry in _outbox.entries) {
        if (!entry.value) {
          _items.remove(entry.key);
        } else if (local[entry.key] != null) {
          _items[entry.key] = local[entry.key]!;
        }
      }
      await _persist(key);
      Telemetry.event('hf_reel_bookmark_sync', {'outcome': 'synced'});
    } catch (_) {
      // The API may not be deployed yet, or the phone may be offline. Keep the durable outbox.
      Telemetry.event('hf_reel_bookmark_sync', {'outcome': 'pending'});
    }
    if (epoch == _epoch) notifyListeners();
  }

  Future<void> refresh() async {
    await load();
    _scope();
    if (_account != null) await _sync(_epoch, _key);
  }

  Future<void> toggle(FeedReel reel) async {
    await load();
    _scope();
    if (_account == null || _pending.contains(reel.id)) return;
    final epoch = _epoch;
    final key = _key;
    final before = _items[reel.id];
    final previousOp = _outbox[reel.id];
    _pending.add(reel.id);
    if (before != null) {
      _items.remove(reel.id);
    } else {
      _items[reel.id] = reel;
    }
    _outbox[reel.id] = before == null;
    try {
      await _persist(key);
      _scope();
      if (epoch != _epoch) return;
      notifyListeners();
      Telemetry.event('hf_reel_action', {
        'action': before == null ? 'save' : 'unsave',
        'platform': reel.platform,
      });
      await _sync(epoch, key);
    } catch (_) {
      _scope();
      if (epoch == _epoch) {
        if (before == null) {
          _items.remove(reel.id);
        } else {
          _items[reel.id] = before;
        }
        if (previousOp == null) {
          _outbox.remove(reel.id);
        } else {
          _outbox[reel.id] = previousOp;
        }
      }
      rethrow;
    } finally {
      if (epoch == _epoch) {
        _pending.remove(reel.id);
        notifyListeners();
      }
    }
  }
}
