import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models/bag.dart';
import 'services.dart';

/// [HF-CHANNEL-APP-1] The fan's bag: merch from any influencers, paid once. Saved on the phone under `hf_bag_v1`, one copy per
/// signed-in account (the account id is part of the key, so a second person on the same phone never sees this bag). A bag filled
/// before signing in is kept under a guest key and moves into the account's bag the first time the person signs in.
/// Storage that cannot be read or written is fine: the bag then lives in memory only.
class BagStore extends ChangeNotifier {
  BagStore({String? Function()? accountId}) : _accountId = accountId ?? (() => Services.instance.user?.id);

  static BagStore? _override;
  static BagStore? _cached;

  /// The app-wide bag. Tests install their own with [override].
  static BagStore get instance => _override ?? (_cached ??= BagStore());

  @visibleForTesting
  static set override(BagStore? s) => _override = s;

  /// The server takes 1 to 10 lines in one checkout.
  static const int maxLines = 10;
  static const String _base = 'hf_bag_v1';

  final String? Function() _accountId;
  final List<BagLine> _lines = [];
  List<BagLine> _carry = [];
  String? _scopeId;
  bool _started = false;
  bool _loaded = false;
  int _epoch = 0;
  Future<void>? _loading;
  BagPending? _pending;
  final Map<String, String> _unavailable = {};

  String _keyFor(String? id) => '$_base.${Uri.encodeComponent(id ?? 'guest')}';

  /// Follows the signed-in account. Never notifies (it runs from build methods); the load that follows does.
  void _sync() {
    final next = _accountId();
    if (_started && next == _scopeId) return;
    final wasGuest = _started && _scopeId == null;
    _carry = wasGuest && next != null ? List<BagLine>.of(_lines) : <BagLine>[];
    _scopeId = next;
    _started = true;
    _epoch++;
    _lines.clear();
    _pending = null;
    _unavailable.clear();
    _loaded = false;
    _loading = null;
    unawaited(ensureLoaded());
  }

  bool get loaded {
    _sync();
    return _loaded;
  }

  List<BagLine> get lines {
    _sync();
    return List<BagLine>.unmodifiable(_lines);
  }

  bool get isEmpty => lines.isEmpty;

  /// The online payment that was started and not yet confirmed paid, if any.
  BagPending? get pending {
    _sync();
    return _pending;
  }

  Future<void> setPending(BagPending? p) async {
    await ensureLoaded();
    _pending = p;
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      final key = '${_keyFor(_scopeId)}.pending';
      if (p == null) {
        await prefs.remove(key);
      } else {
        await prefs.setString(key, jsonEncode(p.toJson()));
      }
    } catch (_) {
      // kept in memory only
    }
  }

  /// Product ids the server said are no longer available (409 item_unavailable) with the sentence to show. In memory only.
  String? unavailableReason(String productId) {
    _sync();
    return _unavailable[productId];
  }

  bool get hasUnavailable {
    _sync();
    return _lines.any((l) => _unavailable.containsKey(l.productId));
  }

  void markUnavailable(String productId, String message) {
    _sync();
    _unavailable[productId] = message;
    notifyListeners();
  }

  /// Items counted by quantity: what the badge shows.
  int get count {
    _sync();
    return _lines.fold<int>(0, (a, l) => a + l.qty);
  }

  int get totalPaise {
    _sync();
    return _lines.fold<int>(0, (a, l) => a + l.totalPaise);
  }

  Future<void> ensureLoaded() {
    _sync();
    if (_loaded) return Future<void>.value();
    return _loading ??= _load(_epoch);
  }

  Future<void> _load(int epoch) async {
    final guestKey = _keyFor(null);
    var stored = <BagLine>[];
    BagPending? pending;
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_keyFor(_scopeId));
      if (raw != null) stored = _decode(raw);
      final rawP = p.getString('${_keyFor(_scopeId)}.pending');
      if (rawP != null) {
        final j = jsonDecode(rawP);
        if (j is Map) {
          final b = BagPending.fromJson(Map<String, dynamic>.from(j));
          if (b.groupId.isNotEmpty) pending = b;
        }
      }
      if (_carry.isNotEmpty && _scopeId != null) await p.remove(guestKey);
    } catch (_) {
      // unreadable storage: start empty
    }
    if (epoch != _epoch) return;
    _lines
      ..clear()
      ..addAll(stored);
    _pending = pending;
    final carry = _carry;
    _carry = <BagLine>[];
    for (final l in carry) {
      _mergeIn(l);
    }
    _loaded = true;
    _loading = null;
    if (carry.isNotEmpty) unawaited(_save());
    notifyListeners();
  }

  static List<BagLine> _decode(String raw) {
    try {
      final j = jsonDecode(raw);
      if (j is! List) return <BagLine>[];
      return [
        for (final e in j)
          if (e is Map && '${e['productId'] ?? ''}'.isNotEmpty) BagLine.fromJson(Map<String, dynamic>.from(e)),
      ];
    } catch (_) {
      return <BagLine>[];
    }
  }

  Future<void> _save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_keyFor(_scopeId), jsonEncode([for (final l in _lines) l.toJson()]));
    } catch (_) {
      // the bag still works in memory
    }
  }

  /// Adds [line], or adds its quantity to the same line already there (never above [BagLine.maxQty]). False when the bag already
  /// holds [maxLines] other lines.
  Future<bool> add(BagLine line) async {
    await ensureLoaded();
    final ok = _mergeIn(line);
    if (ok) {
      notifyListeners();
      await _save();
    }
    return ok;
  }

  bool _mergeIn(BagLine line) {
    final i = _lines.indexWhere((l) => l.key == line.key);
    if (i >= 0) {
      final q = _lines[i].qty + line.qty;
      _lines[i] = _lines[i].withQty(q > line.maxQty ? line.maxQty : q);
      return true;
    }
    if (_lines.length >= maxLines) return false;
    _lines.add(line.qty > line.maxQty ? line.withQty(line.maxQty) : line);
    return true;
  }

  Future<void> setQty(String key, int qty) async {
    await ensureLoaded();
    final i = _lines.indexWhere((l) => l.key == key);
    if (i < 0) return;
    final max = _lines[i].maxQty;
    _lines[i] = _lines[i].withQty(qty < 1 ? 1 : (qty > max ? max : qty));
    notifyListeners();
    await _save();
  }

  Future<void> remove(String key) async {
    await ensureLoaded();
    _lines.removeWhere((l) => l.key == key);
    _unavailable.removeWhere((id, _) => !_lines.any((l) => l.productId == id));
    notifyListeners();
    await _save();
  }

  Future<void> clear() async {
    await ensureLoaded();
    _lines.clear();
    notifyListeners();
    await _save();
  }
}
