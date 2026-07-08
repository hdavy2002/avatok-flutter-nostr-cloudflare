import 'dart:async';
import 'dart:convert';

import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/config.dart';
import '../core/disk_cache.dart';
import '../core/net/connectivity_coordinator.dart';
import '../identity/identity.dart';

/// [MSG-OUTBOX-1] A durable, per-account queue of outbound DM/group sends that
/// have NOT yet been ACKed (HTTP 200) by `POST /api/msg/send`.
///
/// WHY this exists (production bug 2026-07-04): the old send path did a
/// fire-and-forget `unawaited(_post(...))` with NO retry and NO persistence. On a
/// flaky connection the POST failed, the bubble was marked `.failed`, and
/// `_persistNow()` then EXCLUDED failed messages from the warm thread cache — so
/// the sender's own messages silently vanished on reopen and the recipient never
/// got them, with no error surfaced. The outbox makes every send durable: it is
/// enqueued BEFORE the POST, survives app restart, and is retried automatically
/// (backoff + on app-resume / hub-reconnect / thread-open) until the server ACKs
/// or we give up after ~24h.
///
/// STORAGE: one small JSON file via [DiskCache], which is already ACCOUNT-SCOPED
/// (writes land in `cache/<AccountScope.id>/…`), satisfying the mandatory
/// per-account-scoping rule — a parent and each child on one phone keep entirely
/// separate outboxes. (Same pattern as [MessageStore] / [ArchivePageStore].)
///
/// DEDUPE / SINGLE-FLIGHT: the server accepts a `client_id` but its InboxDO
/// `/append` does a plain `INSERT` (NOT `INSERT OR IGNORE` on client_id), so a
/// message posted twice with the same client_id would create a DUPLICATE server
/// row. We therefore keep STRICT single-flight per clientId here (an entry with a
/// POST already in flight is never re-posted) and remove the entry the instant a
/// 200 lands, so a completed send can never be retried. The receiver still
/// de-dupes by client_id in [SyncHub], so even a rare double-store collapses to
/// one bubble on the peer.
class OutboxEntry {
  final String clientId;
  final String to;        // peer Clerk uid (DM) — the POST `to` field (empty for a group)
  final String conv;      // group conversation id — the POST `conv` field (empty for a DM)
  final String payload;   // our app-envelope JSON string (the `body`)
  final String kind;      // 'text' | 'media' | … (POST `kind`)
  final String convKey;   // '1:<peerUid>' or 'g:<convId>' — for status routing
  final int createdAt;    // epoch ms of first enqueue
  int attempt;            // POST attempts made so far
  int nextAttemptAt;      // epoch ms — earliest time to try again (backoff)
  String lastError;
  // [MSG-ECHO-COMPLETE-1] Lifecycle: an entry is Queued→Sending→Acked→Echoed(=
  // removed). `acked` flips true when the POST returns HTTP 200 (or already_
  // processed:true), and `ackedAt` records when — but the entry is NOT deleted
  // then. Deletion happens only when the durable echo of THIS client_id returns
  // through the InboxDO cursor sync (SyncHub → [completeOnEcho]) — the single
  // completion point that makes a send exactly-once end-to-end. An acked entry
  // that is never echoed within [_ackReverifyMs] is re-POSTed on drain (server
  // dedup [SRV-MSG-IDEMP-1] makes the retry safe; already_processed:true is
  // treated as an ACK).
  bool acked;
  int ackedAt;            // epoch ms of the ACK (0 while not yet acked)

  OutboxEntry({
    required this.clientId,
    required this.to,
    required this.conv,
    required this.payload,
    required this.kind,
    required this.convKey,
    required this.createdAt,
    this.attempt = 0,
    this.nextAttemptAt = 0,
    this.lastError = '',
    this.acked = false,
    this.ackedAt = 0,
  });

  bool get isGroup => conv.isNotEmpty;

  Map<String, dynamic> toJson() => {
        'clientId': clientId,
        if (to.isNotEmpty) 'to': to,
        if (conv.isNotEmpty) 'conv': conv,
        'payload': payload,
        'kind': kind,
        'convKey': convKey,
        'createdAt': createdAt,
        'attempt': attempt,
        'nextAttemptAt': nextAttemptAt,
        if (lastError.isNotEmpty) 'lastError': lastError,
        if (acked) 'acked': true,
        if (ackedAt > 0) 'ackedAt': ackedAt,
      };

  static OutboxEntry? fromJson(Map<String, dynamic> j) {
    final clientId = (j['clientId'] ?? '').toString();
    final to = (j['to'] ?? '').toString();
    final conv = (j['conv'] ?? '').toString();
    final payload = (j['payload'] ?? '').toString();
    // Need a client id, a destination (DM `to` OR group `conv`), and a body.
    if (clientId.isEmpty || (to.isEmpty && conv.isEmpty) || payload.isEmpty) return null;
    return OutboxEntry(
      clientId: clientId,
      to: to,
      conv: conv,
      payload: payload,
      kind: (j['kind'] ?? 'text').toString(),
      convKey: (j['convKey'] ?? (conv.isNotEmpty ? 'g:$conv' : '1:$to')).toString(),
      createdAt: (j['createdAt'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
      attempt: (j['attempt'] as num?)?.toInt() ?? 0,
      nextAttemptAt: (j['nextAttemptAt'] as num?)?.toInt() ?? 0,
      lastError: (j['lastError'] ?? '').toString(),
      acked: j['acked'] == true,
      ackedAt: (j['ackedAt'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Result of a send attempt, fanned out so [AvaDm] can drive the per-bubble
/// status (sending… → not sent) and clear the durable state once ACKed.
class OutboxStatus {
  final String clientId;
  final String convKey;
  final bool ok;      // true = server ACKed (200) and the entry is now removed
  final bool gaveUp;  // true = permanently abandoned (cap/expiry) — surface an error
  final String message;
  OutboxStatus({required this.clientId, required this.convKey, required this.ok, this.gaveUp = false, this.message = ''});
}

class Outbox {
  static final Outbox I = Outbox._();
  Outbox._();

  static const _file = 'avatok_outbox'; // DiskCache scopes this per account
  // Give-up policy: stop retrying after ~50 attempts OR 24h, whichever first.
  static const _maxAttempts = 50;
  static const _maxAgeMs = 24 * 60 * 60 * 1000;
  // [MSG-ECHO-COMPLETE-1] An entry ACKed (HTTP 200) but never echoed back through
  // cursor sync within this window is re-POSTed on the next drain. The server-side
  // dedup index ([SRV-MSG-IDEMP-1], landing concurrently) makes the retry safe: a
  // second POST with the same client_id returns the existing row + already_
  // processed:true, which we treat as an ACK — no duplicate server row.
  static const _ackReverifyMs = 60 * 1000;

  // In-memory mirror of the persisted queue, keyed by clientId (insertion order
  // preserved so we send oldest-first). Loaded lazily per account.
  final Map<String, OutboxEntry> _q = {};
  bool _loaded = false;
  String? _loadedScope; // AccountScope.id the in-memory queue was loaded for
  final Set<String> _inFlight = {}; // single-flight guard per clientId
  Timer? _tickTimer;
  StreamSubscription? _netSub; // [NET-COORD-1] coordinator state-change drain trigger

  /// [NET-COORD-1] Subscribe the outbox drain to the ConnectivityCoordinator
  /// ("NetBrain"): a transition into CONNECTED or RECOVERING means the device can
  /// reach the server, so flush any queued sends. This is retry trigger (c) and
  /// is ADDITIVE — the existing triggers (enqueue / app_resume / hub_connected /
  /// thread_open / self-driving timer) stay. Idempotent; call once at startup.
  /// TODO [NET-COORD-2]: once the coordinator is the single source of truth, the
  /// overlapping hub_connected/app_resume drain triggers can be retired per the
  /// flags-are-temporary / single-owner policy — kept now to avoid regressions.
  void bindConnectivity() {
    _netSub ??= ConnectivityCoordinator.I.changes.listen((s) {
      if (s == NetState.connected || s == NetState.recovering) {
        unawaited(drain(reason: 'netbrain_${s.name}'));
      }
    });
  }

  final _status = StreamController<OutboxStatus>.broadcast();
  Stream<OutboxStatus> get status => _status.stream;

  String get _scope => AccountScope.id ?? '';

  Future<void> _ensureLoaded() async {
    // Reload when the active account changes (shared phone: parent ⇄ child).
    if (_loaded && _loadedScope == _scope) return;
    _q.clear();
    _inFlight.clear();
    _loadedScope = _scope;
    _loaded = true;
    final raw = await DiskCache.read(_file);
    if (raw == null || raw.isEmpty) return;
    try {
      for (final e in (jsonDecode(raw) as List)) {
        final entry = OutboxEntry.fromJson((e as Map).cast<String, dynamic>());
        if (entry != null) _q[entry.clientId] = entry;
      }
    } catch (_) {/* corrupt file — start empty rather than crash the thread */}
  }

  Future<void> _persist() async {
    try {
      await DiskCache.write(_file, jsonEncode(_q.values.map((e) => e.toJson()).toList()));
    } catch (_) {/* best-effort; the in-memory queue still drives retries this session */}
  }

  /// Enqueue a pending send BEFORE the POST is attempted (durable-first). Returns
  /// immediately; the queue drain performs the actual POST + retries. Idempotent
  /// per clientId (re-enqueuing an existing id is a no-op that just kicks a drain).
  Future<void> enqueue({
    required String clientId,
    required String payload,
    required String convKey,
    String to = '',       // DM: peer uid
    String conv = '',     // group: conversation id
    String kind = 'text',
  }) async {
    if (to.isEmpty && conv.isEmpty) return; // no destination — nothing to send
    await _ensureLoaded();
    if (!_q.containsKey(clientId)) {
      _q[clientId] = OutboxEntry(
        clientId: clientId, to: to, conv: conv, payload: payload, kind: kind, convKey: convKey,
        createdAt: DateTime.now().millisecondsSinceEpoch,
      );
      await _persist();
      Analytics.capture('msg_outbox_enqueued', {
        'kind': kind, 'conv_kind': convKey.startsWith('g:') ? 'group' : 'dm', 'queued': _q.length,
      });
    }
    // Drive an immediate attempt for this (and any due) entry.
    unawaited(drain(reason: 'enqueue'));
  }

  /// Ensure the per-account queue is loaded from disk (idempotent). A caller that
  /// needs [isPending] to be accurate right now (e.g. a thread restoring cached
  /// bubbles) should await this first, since [isPending] is a synchronous check.
  Future<void> ensureLoaded() => _ensureLoaded();

  /// True while [clientId] is still queued (not yet ACKed). Lets a thread restore
  /// the "sending…" vs "not sent — tap to retry" affordance for a pending message.
  /// Accurate only once [ensureLoaded]/[drain]/[enqueue] has run for this account.
  bool isPending(String clientId) => _q.containsKey(clientId);

  /// Attempt to flush the queue: POST every entry whose backoff window has elapsed
  /// and that isn't already in flight. Called on enqueue, app-resume, hub-reconnect
  /// and thread-open. A single [_tickTimer] re-arms itself while anything remains
  /// queued, so a message left behind on a flaky link keeps retrying with backoff
  /// even if no external trigger fires. Never posts the same clientId concurrently.
  Future<void> drain({String reason = 'tick'}) async {
    await _ensureLoaded();
    if (_q.isEmpty) { _tickTimer?.cancel(); _tickTimer = null; return; }
    final now = DateTime.now().millisecondsSinceEpoch;
    // Snapshot to avoid mutating the map while iterating (entries can be removed
    // on ACK or give-up mid-loop).
    for (final entry in List<OutboxEntry>.of(_q.values)) {
      if (_inFlight.contains(entry.clientId)) continue; // single-flight
      // [MSG-ECHO-COMPLETE-1] An acked-but-not-yet-echoed entry is normally left
      // alone (SyncHub's echo is its completion). But if the echo never returned
      // within _ackReverifyMs of the ACK, re-POST to re-verify — server dedup
      // makes this safe and the response's already_processed:true counts as ACK.
      if (entry.acked) {
        if (entry.ackedAt > 0 && now - entry.ackedAt >= _ackReverifyMs && entry.nextAttemptAt <= now) {
          unawaited(_attempt(entry));
        }
        continue;
      }
      if (entry.nextAttemptAt > now) continue;          // still backing off
      unawaited(_attempt(entry));
    }
    _rearm();
  }

  /// Re-arm the self-driving retry timer to fire at the earliest pending
  /// nextAttemptAt (min 5s, so a burst of failures doesn't hot-loop).
  void _rearm() {
    _tickTimer?.cancel();
    if (_q.isEmpty) { _tickTimer = null; return; }
    final now = DateTime.now().millisecondsSinceEpoch;
    var soonest = now + _maxAgeMs;
    for (final e in _q.values) {
      if (_inFlight.contains(e.clientId)) continue;
      // [MSG-ECHO-COMPLETE-1] An acked entry is driven by its echo, not backoff;
      // its only timer-relevant deadline is the re-verify window after the ACK.
      final due = e.acked ? (e.ackedAt > 0 ? e.ackedAt + _ackReverifyMs : soonest) : e.nextAttemptAt;
      if (due < soonest) soonest = due;
    }
    final waitMs = (soonest - now).clamp(5000, 120000).toInt(); // 5s..2min, matches backoff cap
    _tickTimer = Timer(Duration(milliseconds: waitMs), () => unawaited(drain(reason: 'timer')));
  }

  /// Exponential backoff schedule: 5s, 15s, 60s, then every 2min.
  int _backoffMs(int attempt) {
    switch (attempt) {
      case 1: return 5000;
      case 2: return 15000;
      case 3: return 60000;
      default: return 120000;
    }
  }

  Future<void> _attempt(OutboxEntry entry) async {
    if (!_inFlight.add(entry.clientId)) return; // already posting this id
    final startedAt = DateTime.now().millisecondsSinceEpoch;
    entry.attempt++;
    try {
      final res = await ApiAuth.postJson(kMsgSendUrl, {
        // DM addresses by peer uid (`to`); a group addresses by conversation id
        // (`conv`). The server accepts exactly one of them (messaging.ts sendMsg).
        if (entry.isGroup) 'conv': entry.conv else 'to': entry.to,
        'kind': entry.kind, 'body': entry.payload, 'client_id': entry.clientId,
        // [MSG-SEND-TIMEOUT-1] The 8s postJson default sat below sendMsg's real
        // tail latency (Clerk verify + D1 + DO append + awaited offline FCM), so
        // slow-network sends "timed out" client-side while succeeding server-side
        // (57 TimeoutExceptions / 3 days for one user). 20s covers the tail; the
        // idempotent client_id retry stays as the backstop.
      }, timeout: const Duration(seconds: 20));
      // [SRV-MSG-IDEMP-1] A retry of an already-stored client_id returns 200 with
      // already_processed:true — same as a fresh ACK (the row already exists, no
      // duplicate is created). Treat both as ACK.
      final ok = res.statusCode == 200;
      if (ok) {
        // [MSG-ECHO-COMPLETE-1] ACK marks the entry `acked` (persisted) — it is
        // NOT deleted here. The single completion point is the durable echo of
        // this client_id returning through cursor sync (SyncHub → completeOnEcho),
        // which finally removes it. This is exactly-once end-to-end: the UI still
        // shows "sent" on ACK (below), but the durable queue only clears on echo.
        final wasAcked = entry.acked;
        entry.acked = true;
        entry.ackedAt = DateTime.now().millisecondsSinceEpoch;
        if (!wasAcked) {
          Analytics.capture('msg_outbox_sent', {
            'attempt': entry.attempt,
            'latency_ms': DateTime.now().millisecondsSinceEpoch - startedAt,
            'age_ms': startedAt - entry.createdAt,
            'kind': entry.kind,
            'conv_kind': entry.convKey.startsWith('g:') ? 'group' : 'dm',
          });
          // Surface "sent" to the UI on ACK — the checkmark is a UX signal, not a
          // durability confirmation, so it must not wait for the echo.
          _emit(OutboxStatus(clientId: entry.clientId, convKey: entry.convKey, ok: true));
        }
      } else {
        entry.lastError = 'http ${res.statusCode}';
        AvaLog.I.log('outbox', 'send FAILED ${res.statusCode} (attempt ${entry.attempt}) cid=${entry.clientId}');
        _afterFailure(entry);
      }
    } catch (e) {
      entry.lastError = e.toString();
      _afterFailure(entry);
    } finally {
      _inFlight.remove(entry.clientId);
      // [MSG-ECHO-COMPLETE-1] ACK now MARKS the entry `acked` (it stays in _q
      // until its echo returns via completeOnEcho); a terminal give-up removed it
      // in _afterFailure. A still-retrying entry stays in _q with an advanced
      // nextAttemptAt. Persist the current queue + re-arm the self-driving timer.
      await _persist();
      _rearm();
    }
  }

  bool _shouldGiveUp(OutboxEntry entry) {
    // [MSG-ECHO-COMPLETE-1] An acked entry is already durably stored server-side;
    // its re-verify POSTs must never trigger a "not sent" give-up (the message WAS
    // sent — we're only waiting for the echo to confirm). Give-up applies only to
    // never-acked entries.
    if (entry.acked) return false;
    final age = DateTime.now().millisecondsSinceEpoch - entry.createdAt;
    return entry.attempt >= _maxAttempts || age >= _maxAgeMs;
  }

  /// [MSG-ECHO-COMPLETE-1] THE single completion point. Called by [SyncHub] the
  /// instant an inbound message whose `client_id` matches a queued entry is
  /// ingested — i.e. our own send has durably echoed back through the InboxDO
  /// cursor sync. Removes the entry (Echoed = Complete) so it can never be
  /// re-posted, and emits [msg_echo_received] with the ACK→echo round-trip. Safe
  /// (and expected) to be called for a clientId the outbox has already dropped or
  /// never held — those are no-ops. Also completes an entry that echoed BEFORE its
  /// ACK landed (a fast round-trip / re-verify race): the send is durable either
  /// way, so the echo is authoritative.
  void completeOnEcho(String clientId) {
    if (clientId.isEmpty) return;
    final entry = _q[clientId];
    if (entry == null) return; // unknown / already completed — nothing to do
    _q.remove(clientId);
    final now = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('msg_echo_received', {
      'client_msg_id': clientId,
      'ack_to_echo_ms': entry.ackedAt > 0 ? now - entry.ackedAt : -1,
      'acked': entry.acked,
      'conv_kind': entry.convKey.startsWith('g:') ? 'group' : 'dm',
    });
    // Persist the shrunk queue + re-arm (best-effort; async fire-and-forget so the
    // hot ingest path isn't blocked on a file write).
    unawaited(_persist());
    _rearm();
  }

  void _afterFailure(OutboxEntry entry) {
    if (_shouldGiveUp(entry)) {
      _q.remove(entry.clientId);
      Analytics.capture('msg_outbox_gave_up', {
        'attempt': entry.attempt,
        'age_ms': DateTime.now().millisecondsSinceEpoch - entry.createdAt,
        'kind': entry.kind,
        'last_error': entry.lastError.length > 120 ? entry.lastError.substring(0, 120) : entry.lastError,
        'conv_kind': entry.convKey.startsWith('g:') ? 'group' : 'dm',
      });
      // Terminal 'not sent' — leave the bubble in its failed state for a manual
      // tap-to-retry, which re-enqueues a fresh attempt cycle.
      _emit(OutboxStatus(clientId: entry.clientId, convKey: entry.convKey, ok: false, gaveUp: true, message: entry.lastError));
      return;
    }
    entry.nextAttemptAt = DateTime.now().millisecondsSinceEpoch + _backoffMs(entry.attempt);
    // INTERIM failure: do NOT emit a 'failed' status. The outbox keeps auto-retrying
    // with backoff, so the bubble should stay in "sending…" (a clock) — not flip to
    // "not sent · tap to retry", which would (a) mislead the user and (b) let a tap
    // spawn a SECOND queued send for a message we're already retrying (the server
    // doesn't dedupe client_id, so that risks a duplicate row). We only surface a
    // failed affordance on terminal give-up (above) so the manual retry is
    // meaningful. Status is still observable via telemetry (each _attempt logs).
  }

  void _emit(OutboxStatus s) {
    if (!_status.isClosed) _status.add(s);
  }

  /// Drop a queued entry without sending (e.g. the user deleted the bubble). Safe
  /// no-op if not present or mid-flight (the in-flight POST still completes but its
  /// ACK removal becomes a no-op).
  Future<void> discard(String clientId) async {
    await _ensureLoaded();
    if (_q.remove(clientId) != null) await _persist();
  }

  /// Account switch/logout: drop the in-memory mirror so the NEXT account's queue
  /// loads fresh from its own scoped file. The persisted file is left intact (keyed
  /// per account), so re-login resumes that account's pending sends.
  void reset() {
    _tickTimer?.cancel();
    _tickTimer = null;
    _q.clear();
    _inFlight.clear();
    _loaded = false;
    _loadedScope = null;
  }
}
