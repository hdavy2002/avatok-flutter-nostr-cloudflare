import 'dart:convert';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';

/// STREAM B (stranger safety gate) — client API + local acceptance state.
///
/// A new thread from a NON-CONTACT is 'pending': the recipient sees the
/// [StrangerGateBar] (Safety shield / Block / Report spam / Accept) instead of
/// the composer, media is blurred, link previews are suppressed, and their
/// read-receipts are withheld from the sender (the server enforces the receipt
/// suppression via the recipient's InboxDO accept_state). On Accept the composer
/// is restored and normal receipts resume — old receipts are never sent
/// retroactively.
///
/// The server conv id is `dm_<lo>__<hi>` (see worker dmConvId); [dmConvIdFor]
/// mirrors it so the client can address the same thread the router does.
enum AcceptState { accepted, pending, blocked }

AcceptState _parseState(String? s) {
  switch (s) {
    case 'pending':
      return AcceptState.pending;
    case 'blocked':
      return AcceptState.blocked;
    default:
      return AcceptState.accepted;
  }
}

/// Server conv id for a 1:1 DM — `dm_<lo>__<hi>` (lexicographic), matching the
/// worker's dmConvId. `me`/`peer` are Clerk uids.
String dmConvIdFor(String me, String peer) {
  final lo = me.compareTo(peer) < 0 ? me : peer;
  final hi = me.compareTo(peer) < 0 ? peer : me;
  return 'dm_${lo}__$hi';
}

/// Inverse of [dmConvIdFor]: pull the OTHER party's uid out of a `dm_<lo>__<hi>`
/// server conv id, given my own uid. Returns null if the conv isn't a 1:1 DM id
/// or doesn't contain [me]. Used so a pending "Unknown sender" request (a conv
/// with no resolved local contact) can still open its real thread — the peer uid
/// is recoverable from the conv id alone. Clerk uids use single underscores, so
/// splitting on the `__` join is unambiguous.
String? peerUidFromConv(String conv, String me) {
  if (!conv.startsWith('dm_') || me.isEmpty) return null;
  final parts = conv.substring(3).split('__');
  if (parts.length != 2) return null;
  if (parts[0] == me) return parts[1];
  if (parts[1] == me) return parts[0];
  return null;
}

/// Per-account local cache of thread acceptance state, keyed by the SERVER conv
/// id (`dm_…`). Local-first so the gate renders instantly on open; the server is
/// the source of truth (multi-device) and reconciles via [StrangerGateApi.state].
class StrangerGateStore {
  static const _key = 'avatok_stranger_gate'; // DiskCache = per-account scoped

  Future<Map<String, AcceptState>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map)
          .map((k, v) => MapEntry(k.toString(), _parseState(v?.toString())));
    } catch (_) {
      return {};
    }
  }

  Future<AcceptState> get(String conv) async => (await load())[conv] ?? AcceptState.accepted;

  Future<void> set(String conv, AcceptState st) async {
    final m = await load();
    m[conv] = st;
    await DiskCache.write(_key, jsonEncode(m.map((k, v) => MapEntry(k, v.name))));
  }

  /// The set of SERVER conv ids currently in the pending stranger gate — used by
  /// the chat list to group them under a collapsed "Message requests (N)" section
  /// at the top (SAFE-GATE-2). Local-first; reconciled per-thread on open.
  Future<Set<String>> pendingConvs() async {
    final m = await load();
    return m.entries.where((e) => e.value == AcceptState.pending).map((e) => e.key).toSet();
  }
}

class SafetyScore {
  final double score; // 0..1 (>=0.8 → likely scam)
  final String label; // short human label
  final bool available; // false when the STREAM G route is absent (404)
  const SafetyScore({required this.score, required this.label, required this.available});
}

class StrangerGateApi {
  static final _store = StrangerGateStore();

  /// Mark a brand-new non-contact thread as pending locally.
  static Future<void> markPending(String conv) => _store.set(conv, AcceptState.pending);

  /// Declare a new non-contact thread 'pending' to the SERVER so it starts
  /// suppressing this recipient's read-receipts (the server can't know local
  /// contacts, so the client initiates; the server then enforces). Idempotent.
  static Future<bool> declarePending(String conv) async {
    await _store.set(conv, AcceptState.pending);
    try {
      final r = await ApiAuth.postJson(kConvAcceptStateUrl, {'conv': conv, 'state': 'pending'});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<AcceptState> localState(String conv) => _store.get(conv);

  /// Accept the pending thread → server restores normal receipts + composer.
  static Future<bool> accept(String conv) async {
    await _store.set(conv, AcceptState.accepted);
    try {
      final r = await ApiAuth.postJson(kConvAcceptUrl, {'conv': conv});
      return r.statusCode == 200;
    } catch (_) {
      return false; // local state already flipped; the next call reconciles
    }
  }

  /// Block the sender of a pending thread (or an explicit uid).
  static Future<bool> block({required String conv, String? uid}) async {
    await _store.set(conv, AcceptState.blocked);
    try {
      final r = await ApiAuth.postJson(kConvBlockUrl, {'conv': conv, if (uid != null) 'uid': uid});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Report spam → server copies the last [lastN] envelopes to spam_reports then
  /// blocks the sender. Returns the report id (or null on failure).
  static Future<String?> report({required String conv, int lastN = 10}) async {
    await _store.set(conv, AcceptState.blocked);
    try {
      final r = await ApiAuth.postJson(kSafetyReportUrl, {'conv': conv, 'last_n': lastN});
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return (j['report_id'] ?? '').toString().isEmpty ? null : j['report_id'].toString();
    } catch (_) {
      return null;
    }
  }

  /// Safety shield → STREAM G's scoring route. Degrades gracefully: a 404 (route
  /// not deployed) or any error returns available:false so the UI shows a soft
  /// "couldn't score" instead of a scary result.
  static Future<SafetyScore> score(String conv) async {
    try {
      final r = await ApiAuth.postJson(kSafetyScoreUrl, {'conv': conv});
      if (r.statusCode == 404) return const SafetyScore(score: 0, label: '', available: false);
      if (r.statusCode != 200) return const SafetyScore(score: 0, label: '', available: false);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return SafetyScore(
        score: (j['score'] as num?)?.toDouble() ?? 0,
        label: (j['label'] ?? '').toString(),
        available: true,
      );
    } catch (_) {
      return const SafetyScore(score: 0, label: '', available: false);
    }
  }

  /// Reconcile with the server (multi-device: a second device that missed the
  /// local 'pending' stamp still sees the gate). Best-effort; falls back to local.
  static Future<AcceptState> state(String conv) async {
    try {
      final r = await ApiAuth.getSigned('$kConvAcceptStateUrl?conv=${Uri.encodeQueryComponent(conv)}');
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        final st = _parseState((j['accept_state'] ?? '').toString());
        await _store.set(conv, st);
        return st;
      }
    } catch (_) {/* fall through to local */}
    return _store.get(conv);
  }
}

/// Telemetry (email auto-attached by [Analytics]). Exact spec event names.
void trackStrangerGate(String event, Map<String, Object> props) => Analytics.capture(event, props);
