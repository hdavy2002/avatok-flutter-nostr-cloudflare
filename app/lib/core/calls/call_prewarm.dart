/// [CALL-PREWARM-1 2026-08-16] P1 of `Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md`.
///
/// The whole media stack (ICE credentials, SFU seat) is normally built AFTER
/// the callee taps Accept, serially. WhatsApp's trick is that none of that
/// work happens at pickup — both sides build their media path during the
/// ring. This is the callee half of that: the moment the incoming-call PUSH
/// lands (seconds before the ring UI can even be shown, and well before
/// Accept), [start] begins fetching ICE credentials and claiming an SFU seat
/// (`POST /api/callsfu/:room/join`) in the background. At accept time,
/// `CallSession._startSfuMedia()` calls [adopt] instead of doing that work
/// cold, so it only has to publish + pull.
///
/// Privacy: this file touches no microphone and captures no media — it only
/// warms network credentials and a server-side seat. The mic track stays
/// disabled until accept regardless (owned by `CallSession`, not here).
///
/// Gated entirely on `RemoteConfig.callPrewarmOnRingV1`: every public method
/// is a no-op while the flag is off, so this class does nothing on any build
/// or account until the flag is flipped on.
///
/// Per-account scoping (CLAUDE.md) does not apply here — this is in-memory
/// only, holds no durable or user-identifying state, and every entry lives
/// for at most tens of seconds (a ring) before being adopted or discarded.
library;

import 'dart:async';

import '../analytics.dart';
import '../ice_cache.dart';
import '../remote_config.dart';
import 'call_sfu_api.dart';

/// What [CallPrewarm.adopt] hands back to the caller: a pre-warmed SFU join
/// (may be null if the prewarm join failed or never finished) plus whatever
/// ICE servers were fetched in parallel (falls back to an empty list, exactly
/// like a fresh [IceCache.get] would fall back to `kIceServers` upstream).
class CallPrewarmedData {
  CallPrewarmedData({required this.join, required this.iceServers});

  final CallSfuJoinResult? join;
  final List<Map<String, dynamic>> iceServers;
}

class _PrewarmEntry {
  _PrewarmEntry(this.callId, this.startedAtMs);

  final String callId;
  final int startedAtMs;

  Future<CallSfuJoinResult?>? joinFuture;
  CallSfuJoinResult? joinResult;
  Future<List<Map<String, dynamic>>>? iceFuture;
}

class CallPrewarm {
  CallPrewarm._();

  static final CallPrewarm instance = CallPrewarm._();

  /// [CALL-PREWARM-1] How long a prewarmed entry is considered current. Past
  /// this, `adopt` treats it as absent and tears it down instead.
  ///
  /// Bounded by the SERVER's seat lease, not by taste: `CallRoom`'s
  /// `SFU_LEASE_MS` is 45s and a pre-warmed seat sends NO heartbeats (the
  /// transport's heartbeat only starts after connect). 40s keeps every
  /// adopted seat inside its lease with margin; a slower answer simply falls
  /// back to today's cold join.
  static const int freshWindowMs = 40000;

  _PrewarmEntry? _entry;

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  /// Begin warming [callId]'s media path. Fire-and-forget by design — NEVER
  /// await this from the ring/push-handling path; a slow or failed prewarm
  /// must never delay or break showing the incoming-call UI.
  ///
  /// No-op when [callId] is empty or `RemoteConfig.callPrewarmOnRingV1` is
  /// false. If a prewarm for this exact call is already running or ready,
  /// this is a no-op (idempotent — safe to call more than once per ring).
  void start(String callId) {
    if (callId.isEmpty) return;
    if (!RemoteConfig.callPrewarmOnRingV1) return;
    final existing = _entry;
    if (existing != null) {
      if (existing.callId == callId) return; // already warming/ready
      // A different call is still mid-warm — one ring at a time is the norm,
      // but never leak a seat if that assumption is ever wrong.
      unawaited(discard(existing.callId, 'superseded'));
    }
    final entry = _PrewarmEntry(callId, _nowMs());
    _entry = entry;
    try {
      Analytics.capture('call_prewarm_started', {'call_id': callId});
    } catch (_) {/* telemetry must never affect the ring path */}
    entry.iceFuture = IceCache.get();
    entry.joinFuture = _join(entry);
  }

  Future<CallSfuJoinResult?> _join(_PrewarmEntry entry) async {
    final swStart = _nowMs();
    try {
      final result = await CallSfuApi.join(entry.callId);
      // Superseded/discarded/adopted while the join was in flight — the
      // result is still recorded on the entry object itself (adopt/discard
      // may still be awaiting this exact future), but it must not resurrect
      // an entry that has already been cleared from `_entry`.
      entry.joinResult = result;
      try {
        Analytics.capture('call_prewarm_ready', {
          'call_id': entry.callId,
          'join_ms': _nowMs() - swStart,
        });
      } catch (_) {/* telemetry must never affect the call path */}
      return result;
    } catch (_) {
      // A failed prewarm join must never surface to the user — swallow and
      // let the normal accept-time path run exactly as if this never ran.
      return null;
    }
  }

  /// Returns the prewarmed data for [callId] EXACTLY ONCE — the entry is
  /// cleared on return, win or lose, so a second call can never adopt the
  /// same seat twice. The seat is NOT closed here: the caller now owns it.
  ///
  /// Returns null when there is nothing to adopt, the flag is off, or the
  /// entry is older than [freshWindowMs] — a stale entry is discarded
  /// (seat closed) instead of handed back, per the SAFETY rule.
  Future<CallPrewarmedData?> adopt(String callId) async {
    if (callId.isEmpty) return null;
    if (!RemoteConfig.callPrewarmOnRingV1) return null;
    final entry = _entry;
    if (entry == null || entry.callId != callId) return null;
    final ageMs = _nowMs() - entry.startedAtMs;
    if (ageMs > freshWindowMs) {
      _entry = null;
      unawaited(_closeEntry(entry, 'stale', ageMs));
      return null;
    }
    _entry = null; // exactly once, regardless of what happens below
    CallSfuJoinResult? join;
    final jf = entry.joinFuture;
    if (jf != null) {
      try {
        join = await jf;
      } catch (_) {
        join = null; // _join already swallows, but never let adopt() throw
      }
    }
    List<Map<String, dynamic>> ice = const [];
    final icf = entry.iceFuture;
    if (icf != null) {
      try {
        ice = await icf;
      } catch (_) {
        ice = const [];
      }
    }
    try {
      Analytics.capture('call_prewarm_adopted', {
        'call_id': callId,
        'age_ms': ageMs,
        'had_join': join != null && join.sessionId.isNotEmpty,
      });
    } catch (_) {/* telemetry must never affect the call path */}
    return CallPrewarmedData(join: join, iceServers: ice);
  }

  /// Tear down a pre-warmed seat for [callId] because the ring ended without
  /// being adopted — decline, caller cancel, timeout, or a stale entry.
  /// Best-effort and exception-proof: never let teardown surface an error.
  Future<void> discard(String callId, String reason) async {
    if (callId.isEmpty) return;
    final entry = _entry;
    if (entry == null || entry.callId != callId) return;
    _entry = null;
    final ageMs = _nowMs() - entry.startedAtMs;
    await _closeEntry(entry, reason, ageMs);
  }

  Future<void> _closeEntry(_PrewarmEntry entry, String reason, int ageMs) async {
    try {
      Analytics.capture('call_prewarm_discarded', {
        'call_id': entry.callId,
        'reason': reason,
        'age_ms': ageMs,
      });
    } catch (_) {/* telemetry must never affect the call path */}
    try {
      var join = entry.joinResult;
      join ??= await (entry.joinFuture ?? Future<CallSfuJoinResult?>.value(null))
          .timeout(const Duration(seconds: 3), onTimeout: () => null);
      if (join != null && join.sessionId.isNotEmpty) {
        // CallSfuApi.close is itself best-effort and never throws; no
        // publish happened during prewarm, so there are no mids to report.
        await CallSfuApi.close(entry.callId, join.sessionId, const []);
      }
    } catch (_) {/* teardown is unconditional */}
  }
}
