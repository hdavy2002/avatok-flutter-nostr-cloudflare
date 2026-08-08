import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

enum CallDir { incoming, outgoing, missed }

/// [CALL-LOG-TIME-1] Why a call ended, so the history can say "Declined" instead
/// of an insulting "0s". Stored as a short lowercase token on [CallEntry.outcome]
/// and rendered by `core/ui/call_log_format.dart`. An EMPTY outcome means
/// "recorded by a build that predates this field" — the formatter then falls back
/// to the direction + duration it does have, so old rows still read sensibly.
class CallOutcome {
  CallOutcome._();
  /// Media actually flowed — a real conversation. Duration is meaningful.
  static const connected = 'connected';
  /// Rang out with no decision from the callee.
  static const missed = 'missed';
  /// The callee pressed Decline.
  static const declined = 'declined';
  /// Ring timed out on the caller's side.
  static const noAnswer = 'no_answer';
  /// The caller hung up before the callee answered.
  static const cancelled = 'cancelled';
  /// The callee was already on a call.
  static const busy = 'busy';
  /// Setup died (network/ICE) — never reached a person.
  static const failed = 'failed';
}

class CallEntry {
  /// Stable cross-device identity (client UUID). The SAME entry on every device on
  /// the account shares this id, so a per-row delete/clear can be synced and a
  /// re-synced/re-pushed echo deduplicates instead of duplicating.
  final String id;
  final String name;
  final String seed;
  final bool video;
  final CallDir dir;
  final int ts; // epoch seconds — when the call STARTED (device local clock)

  /// [CALL-LOG-TIME-1] Connected talk time in whole seconds. 0 = the call never
  /// connected (see [outcome]) or the row was written by a build that predates
  /// this field. NEVER render `0s`.
  final int durationSec;

  /// [CALL-LOG-TIME-1] One of the [CallOutcome] tokens; '' when unknown (legacy row).
  final String outcome;

  const CallEntry({
    required this.name,
    required this.seed,
    required this.video,
    required this.dir,
    required this.ts,
    this.id = '',
    this.durationSec = 0,
    this.outcome = '',
  });

  CallEntry withId(String newId) => copyWith(id: newId);

  CallEntry copyWith({String? id, int? durationSec, String? outcome}) => CallEntry(
        name: name,
        seed: seed,
        video: video,
        dir: dir,
        ts: ts,
        id: id ?? this.id,
        durationSec: durationSec ?? this.durationSec,
        outcome: outcome ?? this.outcome,
      );

  /// True when the call actually connected — the only case where a duration is
  /// worth showing.
  bool get connected => durationSec > 0 || outcome == CallOutcome.connected;

  Map<String, dynamic> toJson() => {
        'id': id, 'name': name, 'seed': seed, 'video': video, 'dir': dir.name, 'ts': ts,
        'dur': durationSec, 'outcome': outcome,
      };
  factory CallEntry.fromJson(Map<String, dynamic> j) => CallEntry(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        seed: (j['seed'] ?? '').toString(),
        video: j['video'] == true,
        dir: _dirOf((j['dir'] ?? 'outgoing').toString()),
        ts: (j['ts'] as num?)?.toInt() ?? 0,
        durationSec: (j['dur'] as num?)?.toInt() ?? 0,
        outcome: (j['outcome'] ?? '').toString(),
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
        // [CALL-LOG-TIME-1] The InboxDO `call_log` table has no dur/outcome
        // columns yet, so these are absent on every server row TODAY and the
        // defaults (0 / '') apply. Parsed anyway so the client is already
        // correct the moment the server columns are added — no second client
        // release needed. Tolerates the value arriving as a num or a string.
        // Guarded with `is num` for the same reason `video` is: a bare
        // `as num?` cast CRASHES the whole sync frame if the server ever sends
        // this as a string.
        durationSec: r['dur'] is num
            ? (r['dur'] as num).toInt()
            : (int.tryParse('${r['dur'] ?? ''}') ?? 0),
        outcome: (r['outcome'] ?? '').toString(),
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
    _track('add', 'local', {
      'dir': entry.dir.name, 'video': entry.video, 'size': list.length,
      // [CALL-LOG-TIME-1] Usually 0/'' here — `add` runs when the call STARTS.
      // The real numbers arrive on the paired call_log_event op=finish below.
      'duration_sec': entry.durationSec, 'outcome': entry.outcome,
    });
    unawaited(_post(kCallLogAppendUrl, _wire(entry), 'append'));
    return entry;
  }

  /// [CALL-LOG-TIME-1] Close out an entry written at call START with what we only
  /// learn at call END: how long it actually connected for, and why it stopped.
  ///
  /// The call log is written the moment a call is placed/received (so an entry
  /// exists even if the app is killed mid-call), which means the row is born with
  /// `durationSec: 0` and no outcome. Without this second write the history can
  /// only ever say "outgoing", which is exactly the uselessness this issue is
  /// about.
  ///
  /// Local write is authoritative and instant. The server re-append is
  /// best-effort and FORWARD-LOOKING: the InboxDO `call_log` table has no
  /// dur/outcome columns yet, so today the other devices on the account keep the
  /// row without a duration. That is a server-side follow-up, not a reason to
  /// withhold the duration from the phone the call actually happened on.
  Future<void> finish(String id, {int durationSec = 0, String outcome = ''}) async {
    if (id.isEmpty) return;
    final list = await load();
    final i = list.indexWhere((x) => x.id == id);
    if (i < 0) return;
    final dur = durationSec < 0 ? 0 : durationSec;
    final updated = list[i].copyWith(
      durationSec: dur,
      outcome: outcome.isEmpty ? list[i].outcome : outcome,
    );
    if (updated.durationSec == list[i].durationSec && updated.outcome == list[i].outcome) {
      return; // nothing new to say — don't churn storage or the UI
    }
    list[i] = updated;
    await _save(list);
    _notify();
    _track('finish', 'local', {
      'dir': updated.dir.name,
      'video': updated.video,
      'duration_sec': updated.durationSec,
      'outcome': updated.outcome,
    });
    unawaited(_post(kCallLogAppendUrl, _wire(updated), 'finish'));
  }

  /// The append wire body. `dur`/`outcome` are additive fields the current worker
  /// ignores (its `callAppend` reads named keys only, so an unknown key is a
  /// no-op, not a 400) — sending them now means no client release is needed when
  /// the columns land server-side.
  static Map<String, dynamic> _wire(CallEntry e) => {
        'entry_id': e.id, 'name': e.name, 'seed': e.seed,
        'video': e.video, 'dir': e.dir.name, 'ts': e.ts,
        'dur': e.durationSec, 'outcome': e.outcome,
      };

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
