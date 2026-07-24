import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// [AVABRAIN-CLIENT-REC-1] Client for the daily-recording AvaBrain memory
/// endpoints (server landed in [AVABRAIN-MEDIA-1]): a small, on-demand path
/// that offers to remember a recorded voice note/media clip in AvaBrain,
/// separate from — and never blocking — the existing chat/DM delivery path
/// (`MediaService` + `MediaOutbox`, `[MEDIA-OUTBOX-DURABLE-1]`). This client
/// owns ONLY the brain-memory leg: `prepare` (server decision: allowed/
/// rejected before spending upload bandwidth), `complete` (the actual raw
/// upload once prepare allows it), `status` (poll for AI processing) and
/// `delete` (remove a remembered item).
///
/// Server contract (per Specs/AVABRAIN-PRODUCT-BIBLE-2026-07-24.md §9.2):
///   POST /api/brain/media/prepare  {contentHash, mime, sizeBytes, durationSec, kind}
///     → 200 {allowed: true} | 200/409/429 {allowed: false, reason}
///       reason ∈ too_large | too_long | daily_cap_reached | disabled | deduped
///   POST /api/brain/media/complete (raw bytes body; headers x-kind, x-mime,
///        x-duration-sec, x-content-hash) → {id, state} | 409/429 {reason}
///   GET    /api/brain/media/:id → {id, state, reason?}
///   DELETE /api/brain/media/:id
///
/// A rejection here is a MEMORY decision only — it must never be surfaced as
/// a failed upload/send. Callers gate the "Remember this" UI on [prepare] and
/// treat any non-2xx from [complete] the same way: log + skip, business as
/// usual for the actual chat/companion delivery.
class BrainMediaClient {
  static String get _base => '$kBrainBase/media';

  static Map<String, dynamic> _j(String body) {
    try {
      return (jsonDecode(body) as Map).cast<String, dynamic>();
    } catch (_) {
      return {};
    }
  }

  /// sha256 of the raw (decrypted/plaintext) bytes — the same content hash
  /// used for `prepare`'s dedup + as the stable id the caller correlates
  /// prepare → complete → status with.
  static String contentHash(Uint8List bytes) =>
      crypto.sha256.convert(bytes).toString();

  /// Ask the server whether this clip is eligible to be remembered BEFORE
  /// spending the upload — caps (size/duration/daily quota), the disabled
  /// kill switch and dedup are all decided server-side so the client never
  /// has to reimplement policy. Best-effort: any network failure is treated
  /// as `allowed: false, reason: 'network_error'` so a flaky connection never
  /// looks like a silent "remember" that didn't happen.
  static Future<BrainMediaDecision> prepare({
    required String contentHash,
    required String mime,
    required int sizeBytes,
    required int durationSec,
    required String kind, // 'audio' | 'video'
  }) async {
    try {
      final r = await ApiAuth.postJson('$_base/prepare', {
        'contentHash': contentHash,
        'mime': mime,
        'sizeBytes': sizeBytes,
        'durationSec': durationSec,
        'kind': kind,
      });
      final j = _j(r.body);
      final allowed = r.statusCode == 200 && j['allowed'] == true;
      // Server puts the policy outcome in 'decision' (disabled|too_large|
      // too_long|daily_cap_reached|ok|duplicate); fall back to 'reason' first
      // in case a future error path adds one, but 'decision' is what the
      // server actually sends today.
      final reasonOrDecision = (j['reason'] ?? j['decision'] ?? '').toString();
      final decision = BrainMediaDecision(
        allowed: allowed,
        reason: reasonOrDecision.isEmpty ? null : reasonOrDecision,
        statusCode: r.statusCode,
        // N-3: on decision=='duplicate' the server returns {id, state} for the
        // existing row so the caller can short-circuit and skip the upload
        // entirely instead of re-completing bytes the server already has.
        id: (j['id'] ?? '').toString().isEmpty ? null : j['id'].toString(),
        state: (j['state'] ?? '').toString().isEmpty ? null : j['state'].toString(),
      );
      Analytics.capture('avabrain_media_prepare', {
        'allowed': allowed,
        'status': r.statusCode,
        if (decision.reason != null) 'reason': decision.reason!,
        'kind': kind,
      });
      return decision;
    } catch (e) {
      Analytics.captureException(e, StackTrace.current, screen: 'brain_media_client', handled: true);
      return BrainMediaDecision(allowed: false, reason: 'network_error', statusCode: -1);
    }
  }

  /// Upload the raw bytes for a clip [prepare] already allowed. Runs strictly
  /// AFTER the local chat/companion bubble has rendered and the existing
  /// outbox has taken ownership of delivery — this is an ADDITIONAL,
  /// best-effort background leg, never a precondition for the message/note
  /// itself. A 409/429 here means the server changed its mind between
  /// prepare and complete (e.g. the daily cap filled up); treat it exactly
  /// like a declined `prepare` — never surface it as a failed send.
  static Future<BrainMediaCompleteResult> complete({
    required Uint8List bytes,
    required String contentHash,
    required String mime,
    required int durationSec,
    required String kind,
  }) async {
    try {
      final r = await ApiAuth.postBytes(
        '$_base/complete',
        bytes,
        extraHeaders: {
          'Content-Type': 'application/octet-stream',
          'x-kind': kind,
          'x-mime': mime,
          'x-duration-sec': durationSec.toString(),
          'x-content-hash': contentHash,
        },
        timeout: const Duration(seconds: 120),
      );
      final j = _j(r.body);
      final ok = r.statusCode == 200 && (j['id'] ?? '').toString().isNotEmpty;
      // Server puts the rejection outcome in 'decision' (e.g. too_large/
      // too_long on the hard 4xx path) OR 'reason' (daily_cap_reached/
      // no_consent/ingest_rejected) depending on which check failed — read
      // both so no rejection path silently loses its reason string.
      final reasonOrDecision = (j['reason'] ?? j['decision'] ?? '').toString();
      final result = BrainMediaCompleteResult(
        ok: ok,
        id: (j['id'] ?? '').toString(),
        state: (j['state'] ?? '').toString(),
        reason: reasonOrDecision.isEmpty ? null : reasonOrDecision,
        statusCode: r.statusCode,
      );
      Analytics.capture('avabrain_media_complete', {
        'ok': ok,
        'status': r.statusCode,
        if (result.reason != null) 'reason': result.reason!,
        'kind': kind,
        'bytes': bytes.length,
      });
      return result;
    } catch (e) {
      Analytics.captureException(e, StackTrace.current, screen: 'brain_media_client', handled: true);
      return BrainMediaCompleteResult(ok: false, id: '', state: '', reason: 'network_error', statusCode: -1);
    }
  }

  /// Poll processing status. Callers should back off (not hammer this on a
  /// tight loop) — see `BrainMediaStatusPoller` for the standard backoff
  /// wrapper used by the recorder flow.
  static Future<BrainMediaStatus?> status(String id) async {
    if (id.isEmpty) return null;
    try {
      final r = await ApiAuth.getSigned('$_base/$id');
      if (r.statusCode != 200) return null;
      final j = _j(r.body);
      return BrainMediaStatus(
        id: (j['id'] ?? id).toString(),
        state: (j['state'] ?? '').toString(),
        reason: (j['reason'] ?? '').toString().isEmpty ? null : j['reason'].toString(),
      );
    } catch (e) {
      Analytics.captureException(e, StackTrace.current, screen: 'brain_media_client', handled: true);
      return null;
    }
  }

  /// Remove a remembered item (user-initiated "forget this").
  static Future<bool> delete(String id) async {
    if (id.isEmpty) return false;
    try {
      final r = await ApiAuth.deleteSigned('$_base/$id');
      final ok = r.statusCode == 200 || r.statusCode == 204;
      Analytics.capture('avabrain_media_delete', {'ok': ok, 'status': r.statusCode});
      return ok;
    } catch (e) {
      Analytics.captureException(e, StackTrace.current, screen: 'brain_media_client', handled: true);
      return false;
    }
  }
}

class BrainMediaDecision {
  final bool allowed;
  final String? reason; // too_large | too_long | daily_cap_reached | disabled | duplicate | network_error
  final int statusCode;
  // N-3: populated ONLY when [reason] == 'duplicate' — the existing row's id/
  // state, so the caller can short-circuit straight to polling/using that
  // row instead of re-uploading bytes the server already has.
  final String? id;
  final String? state;
  const BrainMediaDecision({
    required this.allowed,
    this.reason,
    required this.statusCode,
    this.id,
    this.state,
  });

  /// True when [prepare] found the exact (uid, contentHash) already known —
  /// callers should skip `complete` entirely and go straight to [id]/[state].
  bool get isDuplicate => reason == 'duplicate' && id != null;
}

class BrainMediaCompleteResult {
  final bool ok;
  final String id;
  final String state;
  final String? reason;
  final int statusCode;
  const BrainMediaCompleteResult({
    required this.ok,
    required this.id,
    required this.state,
    this.reason,
    required this.statusCode,
  });
}

class BrainMediaStatus {
  final String id;
  // Server state machine (worker/migrations/brain_media_memory.sql, consumers/
  // src/brain.ts ingestMediaMemory): queued -> transcribing -> summarizing ->
  // embedding -> ready | failed | deleted. The server NEVER emits 'done' — the
  // terminal success state is 'ready'.
  final String state;
  final String? reason;
  const BrainMediaStatus({required this.id, required this.state, this.reason});

  /// Terminal states the poller should stop on: ready (success), failed, or
  /// deleted (user forgot it mid-poll).
  bool get isTerminal => state == 'ready' || state == 'failed' || state == 'deleted';
}

/// Lightweight backoff poller for `GET /api/brain/media/:id` — used so the UI
/// can show "still processing" without ever blocking the composer or making
/// AI-processing failure look like an upload failure. Caller drives it (e.g.
/// from a small state badge on the bubble); it never throws.
class BrainMediaStatusPoller {
  BrainMediaStatusPoller(this.id, {this.onUpdate});

  final String id;
  final void Function(BrainMediaStatus status)? onUpdate;

  bool _stopped = false;
  static const List<Duration> _schedule = [
    Duration(seconds: 2),
    Duration(seconds: 5),
    Duration(seconds: 15),
    Duration(seconds: 30),
    Duration(seconds: 60),
  ];

  /// Poll until a terminal state (`ready`/`failed`/`deleted`) or the schedule
  /// runs out. Safe to fire-and-forget (`unawaited(poller.run())`).
  Future<void> run() async {
    for (final delay in _schedule) {
      if (_stopped) return;
      await Future.delayed(delay);
      if (_stopped) return;
      final s = await BrainMediaClient.status(id);
      if (s == null) continue;
      onUpdate?.call(s);
      if (s.isTerminal) return;
    }
  }

  void stop() => _stopped = true;
}
