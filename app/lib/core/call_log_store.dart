import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

enum CallDir { incoming, outgoing, missed }

class CallEntry {
  /// Stable cross-device identity (client UUID). The SAME entry on every device on
  /// the account shares this id, so a per-row delete/clear can be synced and a
  /// re-synced/re-pushed echo deduplicates instead of duplicating.
  final String id;
  final String name;
  final String seed;
  final bool video;
  final CallDir dir;
  final int ts; // epoch seconds
  const CallEntry({
    required this.name,
    required this.seed,
    required this.video,
    required this.dir,
    required this.ts,
    this.id = '',
  });

  CallEntry withId(String newId) =>
      CallEntry(name: name, seed: seed, video: video, dir: dir, ts: ts, id: newId);

  Map<String, dynamic> toJson() =>
      {'id': id, 'name': name, 'seed': seed, 'video': video, 'dir': dir.name, 'ts': ts};
  factory CallEntry.fromJson(Map<String, dynamic> j) => CallEntry(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        seed: (j['seed'] ?? '').toString(),
        video: j['video'] == true,
        dir: _dirOf((j['dir'] ?? 'outgoing').toString()),
        ts: (j['ts'] as num?)?.toInt() ?? 0,
      );

  static CallDir _dirOf(String s) {
    for (final d in CallDir.values) { if (d.name == s) return d; }
    return CallDir.outgoing;
  }

  /// Build from a server row/frame (InboxDO call_log) — tolerates `entry_id` or
  /// `id`, and `video` as an int (0/1) or bool. Used for live frames + /sync rows.
  factory CallEntry.fromServer(Map<String, dynamic> r) => CallEntry(
        id: (r['entry_id'] ?? r['id'] ?? '').toString(),
        name: (r['name'] ?? '').toString(),
        seed: (r['seed'] ?? '').toString(),
        // Tolerate `video` as a real bool (true/false) OR an int (0/1). The old
        // form `(r['video'] as num?)` CRASHED when the server sent a JSON bool
        // false: `false == true` is false, so it fell through to casting a bool
        // to num? → "type 'bool' is not a subtype of type 'num?'", which killed
        // the whole incoming frame (and with it any deal message in the same
        // sync batch → blank thread). Guard the cast with `is num`.
        video: r['video'] == true || (r['video'] is num && (r['video'] as num).toInt() == 1),
        dir: _dirOf((r['dir'] ?? 'outgoing').toString()),
        ts: (r['ts'] as num?)?.toInt() ?? 0,
      );

  String get timeLabel {
    final d = DateTime.fromMillisecondsSinceEpoch(ts * 1000);
    final now = DateTime.now();
    final sameDay = d.year == now.year && d.month == now.month && d.day == now.day;
    if (sameDay) return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    final y = now.subtract(const Duration(days: 1));
    if (d.year == y.year && d.month == y.month && d.day == y.day) return 'Yesterday';
    return '${d.day}/${d.month}';
  }
}

/// Local call history (most recent first, capped) — now SERVER-BACKED for
/// multi-device sync. The on-device store is the fast cache; every local mutation
/// also calls the owner's InboxDO (via the Worker) so it fans out in realtime to
/// the user's other devices (live socket frame + FCM wake for asleep devices) and
/// reconciles on the next /sync. Remote changes arrive through [SyncHub], which
/// calls the `applyRemote*` methods here (local-only — they never re-POST).
///
/// A broadcast [changes] stream lets an open Calls screen repaint the instant the
/// log changes, whether the change came from this device or another.
class CallLogStore {
  static const _key = 'avatok_call_log';
  static const _cap = 100;
  static const _uuid = Uuid();

  static final StreamController<void> _changes = StreamController<void>.broadcast();
  /// Emits whenever the local call log changes (local action or remote sync).
  static Stream<void> get changes => _changes.stream;
  static void _notify() { if (!_changes.isClosed) _changes.add(null); }

  /// Rich, queryable telemetry for the call-log feature. `origin` = local (this
  /// device acted) | remote (a change synced in from another device). Every event
  /// auto-carries the user's email (Analytics._base), so support can pull a user's
  /// full call-log activity by email. Best-effort; never throws.
  static void _track(String op, String origin, [Map<String, Object> extra = const {}]) {
    try {
      Analytics.capture('call_log_event', {'op': op, 'origin': origin, ...extra});
    } catch (_) {}
  }

  final FlutterSecureStorage _s;
  CallLogStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<List<CallEntry>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map(CallEntry.fromJson)
          .toList();
    } catch (_) {
      return [];
    }
  }

  // ---- local actions (write local + push to server) --------------------------

  /// Record a new call. Assigns an id if missing, stores it locally (dedup by id),
  /// then best-effort pushes it to the server so the user's other devices get it.
  Future<CallEntry> add(CallEntry e) async {
    final entry = e.id.isEmpty ? e.withId(_uuid.v4()) : e;
    final list = await load();
    if (!list.any((x) => x.id == entry.id)) list.insert(0, entry);
    await _save(_capped(list));
    _notify();
    _track('add', 'local', {'dir': entry.dir.name, 'video': entry.video, 'size': list.length});
    unawaited(_post(kCallLogAppendUrl, {
      'entry_id': entry.id, 'name': entry.name, 'seed': entry.seed,
      'video': entry.video, 'dir': entry.dir.name, 'ts': entry.ts,
    }, 'append'));
    return entry;
  }

  /// Delete a single entry by its position in the most-recent-first list.
  Future<void> removeAt(int index) async {
    final list = await load();
    if (index < 0 || index >= list.length) return;
    final removed = list.removeAt(index);
    await _save(list);
    _notify();
    _track('delete', 'local', {'size': list.length});
    if (removed.id.isNotEmpty) {
      unawaited(_post(kCallLogDeleteUrl, {'entry_id': removed.id}, 'delete'));
    }
  }

  /// Delete a single entry by its stable id.
  Future<void> removeById(String id) async {
    if (id.isEmpty) return;
    final list = await load();
    final before = list.length;
    list.removeWhere((x) => x.id == id);
    if (list.length == before) return;
    await _save(list);
    _notify();
    _track('delete', 'local', {'size': list.length});
    unawaited(_post(kCallLogDeleteUrl, {'entry_id': id}, 'delete'));
  }

  /// Delete the entire call history for the current account.
  Future<void> clear() async {
    await _s.delete(key: scopedKey(_key));
    _notify();
    _track('clear', 'local');
    unawaited(_post(kCallLogClearUrl, const {}, 'clear'));
  }

  // ---- remote application (local-only; called by SyncHub) ---------------------

  /// Add an entry pushed from another device (live 'call' frame or /sync). No-op if
  /// the id is already present (dedups the echo of our own add). Never re-POSTs.
  Future<void> applyRemoteAdd(CallEntry e) async {
    if (e.id.isEmpty) return;
    final list = await load();
    if (list.any((x) => x.id == e.id)) return;
    list.add(e);
    list.sort((a, b) => b.ts.compareTo(a.ts)); // keep most-recent-first
    await _save(_capped(list));
    _notify();
    _track('add', 'remote', {'size': list.length});
  }

  /// Remove an entry deleted on another device. Never re-POSTs.
  Future<void> applyRemoteDelete(String id) async {
    if (id.isEmpty) return;
    final list = await load();
    final before = list.length;
    list.removeWhere((x) => x.id == id);
    if (list.length == before) return;
    await _save(list);
    _notify();
    _track('delete', 'remote', {'size': list.length});
  }

  /// Clear the log because another device cleared it. Never re-POSTs.
  Future<void> applyRemoteClear() async {
    await _s.delete(key: scopedKey(_key));
    _notify();
    _track('clear', 'remote');
  }

  /// Reconcile against the authoritative server snapshot from /sync. Rows carry a
  /// `deleted` flag: tombstoned ids are removed locally; live ids we're missing are
  /// added. Local-only entries not yet acknowledged by the server are PRESERVED
  /// (they'll be (re)appended), so an offline-recorded call is never lost.
  Future<void> applyServerSnapshot(List<Map<String, dynamic>> rows) async {
    if (rows.isEmpty) return;
    final list = await load();
    final byId = {for (final e in list) e.id: e};
    var changed = false;
    for (final r in rows) {
      final id = (r['entry_id'] ?? r['id'] ?? '').toString();
      if (id.isEmpty) continue;
      final deleted = ((r['deleted'] as num?)?.toInt() ?? 0) == 1;
      if (deleted) {
        if (byId.remove(id) != null) changed = true;
      } else if (!byId.containsKey(id)) {
        byId[id] = CallEntry.fromServer(r);
        changed = true;
      }
    }
    if (!changed) return;
    final merged = byId.values.toList()..sort((a, b) => b.ts.compareTo(a.ts));
    await _save(_capped(merged));
    _notify();
    _track('snapshot_reconcile', 'remote', {'size': merged.length, 'server_rows': rows.length});
  }

  // ---- internals -------------------------------------------------------------

  List<CallEntry> _capped(List<CallEntry> list) =>
      list.length <= _cap ? list : list.sublist(0, _cap);

  Future<void> _save(List<CallEntry> list) async {
    await _s.write(key: scopedKey(_key), value: jsonEncode(list.map((x) => x.toJson()).toList()));
  }

  Future<void> _post(String url, Map<String, dynamic> body, String op) async {
    try {
      await ApiAuth.postJson(url, body);
    } catch (e) {
      // Best-effort: the device keeps the local change; the next /sync reconciles.
      try { Analytics.capture('call_log_sync_failed', {'op': op, 'err': e.toString()}); } catch (_) {}
    }
  }
}
