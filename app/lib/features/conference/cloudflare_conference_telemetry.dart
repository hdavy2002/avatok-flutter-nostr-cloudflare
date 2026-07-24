// [CF-CALL-003] Client-side telemetry for the Cloudflare Realtime group
// conference path — event names/props per
// Specs/CF-CONFERENCE-TELEMETRY-CONTRACT-2026-07-24.md. Where this file and
// the contract drift, the contract wins; reconcile here, not there.
//
// Every event carries the base property set (§0.2 of the contract):
// call_id, call_trace_id, transport, group_id_hash, participant_hash,
// generation, media_kind, participant_count, network_type, ice_type,
// relay_used, app_release. `conference_provider_selected` is the one
// exception (fires before a call_id exists).
//
// Forbidden content (§0.3): SDP, ICE candidates/creds, the join ticket or any
// substring of it, ws_url query string, raw group id / raw uid (hashes only),
// media bytes/transcripts. This file never accepts those as parameters.
import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../../core/analytics.dart';

String _shortHash(String input) {
  final bytes = utf8.encode(input);
  return sha256.convert(bytes).toString().substring(0, 16);
}

enum CfTrackKind { audio, video, audioVideo }

extension on CfTrackKind {
  String get wire => switch (this) {
        CfTrackKind.audio => 'audio',
        CfTrackKind.video => 'video',
        CfTrackKind.audioVideo => 'audio_video',
      };
}

/// Per-participant-session telemetry emitter. One instance per join attempt;
/// a reconnect/PC-recreation bumps `generation` on the SAME instance rather
/// than creating a new one, so the `$exception` dedup guard (§0.5) survives
/// across reconnects within one call.
class CloudflareConferenceTelemetry {
  final String groupId;
  String callId;
  String callTraceId;
  int generation;
  final String mediaKindRequested; // 'audio' | 'video' | 'audio_video'
  static const String transport = 'cloudflare_realtime';

  String networkType = 'unknown';
  String iceType = 'unknown';
  int participantCount = 0;

  // §0.5 dedup: one handled-exception + one cloudflare_conference_error per
  // unique (call_id, transport, stage, generation). Repeats bump a counter.
  final Map<String, int> _errorRepeatCounts = {};

  CloudflareConferenceTelemetry({
    required this.groupId,
    required this.callId,
    required this.callTraceId,
    required this.generation,
    required this.mediaKindRequested,
  });

  late final String _groupHash = _shortHash(groupId);

  Map<String, Object> _base({String? trackKind}) => {
        'call_id': callId,
        'call_trace_id': callTraceId,
        'transport': transport,
        'group_id_hash': _groupHash,
        'generation': generation,
        'media_kind': mediaKindRequested,
        'participant_count': participantCount,
        'network_type': networkType,
        'ice_type': iceType,
        'relay_used': iceType == 'relay',
        if (trackKind != null) 'track_kind': trackKind,
      };

  // ---- §1 provider selection (static — fires before any call_id exists) ----

  static void providerSelected({
    required String groupId,
    required String decidedProvider, // cloudflare_realtime | livekit | disabled
    required bool cloudflareEnabled,
    required bool livekitEnabled,
    required String mediaKindRequested,
    String decisionSource = 'client',
  }) {
    Analytics.capture('conference_provider_selected', {
      'group_id_hash': _shortHash(groupId),
      'decided_provider': decidedProvider,
      'cloudflare_conference_enabled': cloudflareEnabled,
      'livekit_conference_enabled': livekitEnabled,
      'media_kind_requested': mediaKindRequested,
      'decision_source': decisionSource,
    });
  }

  // ---- §2 join funnel --------------------------------------------------------

  void joinStarted({required String route, required int ticketAgeMs}) {
    Analytics.capture('cloudflare_conference_join_started', {
      ..._base(),
      'route': route,
      'ticket_age_ms': ticketAgeMs,
    });
  }

  void joined({required int elapsedMs, required int rosterSizeOnJoin}) {
    Analytics.capture('cloudflare_conference_joined', {
      ..._base(),
      'elapsed_ms': elapsedMs,
      'roster_size_on_join': rosterSizeOnJoin,
    });
  }

  // ---- §3 publish / pull ------------------------------------------------------

  void publishStarted({required CfTrackKind trackKind, required int midCount, required int attempt}) {
    Analytics.capture('cloudflare_track_publish_started', {
      ..._base(trackKind: trackKind.wire),
      'mid_count': midCount,
      'attempt': attempt,
    });
  }

  void publishCompleted({required CfTrackKind trackKind, required int attempt, required int elapsedMs}) {
    // 'failure_code' is omitted (not sent as an explicit null) on success —
    // Analytics.capture's Map<String, Object> value type is non-nullable;
    // an absent key reads the same as null in PostHog queries.
    Analytics.capture('cloudflare_track_publish_completed', {
      ..._base(trackKind: trackKind.wire),
      'attempt': attempt,
      'elapsed_ms': elapsedMs,
    });
  }

  void publishFailed({
    required CfTrackKind trackKind,
    required int attempt,
    required int elapsedMs,
    required String failureCode,
  }) {
    Analytics.capture('cloudflare_track_publish_failed', {
      ..._base(trackKind: trackKind.wire),
      'attempt': attempt,
      'elapsed_ms': elapsedMs,
      'failure_code': failureCode,
    });
  }

  void pullStarted({
    required String trackKind, // audio | video
    required String qualityPolicy, // high|medium|low|off
    required String subscriptionReason,
    required int attempt,
  }) {
    Analytics.capture('cloudflare_track_pull_started', {
      ..._base(trackKind: trackKind),
      'quality_policy': qualityPolicy,
      'subscription_reason': subscriptionReason,
      'attempt': attempt,
    });
  }

  void pullCompleted({required String trackKind, required int attempt, required int elapsedMs}) {
    Analytics.capture('cloudflare_track_pull_completed', {
      ..._base(trackKind: trackKind),
      'attempt': attempt,
      'elapsed_ms': elapsedMs,
    });
  }

  void pullFailed({
    required String trackKind,
    required int attempt,
    required int elapsedMs,
    required String failureCode,
  }) {
    Analytics.capture('cloudflare_track_pull_failed', {
      ..._base(trackKind: trackKind),
      'attempt': attempt,
      'elapsed_ms': elapsedMs,
      'failure_code': failureCode,
    });
  }

  // ---- §4 media health / renderer / route ------------------------------------

  void mediaHealth({
    required String trackKind, // audio | video
    required String cls,
    String? fromClass,
    required String invariantReached,
    int? rtpBytesDelta,
    int? decodeFramesDelta,
    int? playoutDelta,
    double? concealmentPct,
    double? jitterMs,
    double? lossPct,
    String? route,
  }) {
    Analytics.capture('cloudflare_media_health', {
      ..._base(trackKind: trackKind),
      'class': cls,
      if (fromClass != null) 'from_class': fromClass,
      'invariant_reached': invariantReached,
      if (rtpBytesDelta != null) 'rtp_bytes_delta': rtpBytesDelta,
      if (decodeFramesDelta != null) 'decode_frames_delta': decodeFramesDelta,
      if (playoutDelta != null) 'playout_delta': playoutDelta,
      if (concealmentPct != null) 'concealment_pct': concealmentPct,
      if (jitterMs != null) 'jitter_ms': jitterMs,
      if (lossPct != null) 'loss_pct': lossPct,
      if (route != null) 'route': route,
    });
  }

  void rendererState({required String state, int? stallMs}) {
    Analytics.capture('cloudflare_renderer_state', {
      ..._base(),
      'renderer_state': state,
      if (stallMs != null) 'stall_ms': stallMs,
    });
  }

  void routeState({required String activeRoute, required bool routeConfirmed}) {
    Analytics.capture('cloudflare_route_state', {
      ..._base(),
      'active_route': activeRoute,
      'route_confirmed': routeConfirmed,
    });
  }

  // ---- §5 reconnect ------------------------------------------------------------

  void reconnectStarted({required String attemptId, required String reason, required bool mediaKeptAlive}) {
    Analytics.capture('cloudflare_reconnect_started', {
      ..._base(),
      'attempt_id': attemptId,
      'reason': reason,
      'media_kept_alive': mediaKeptAlive,
    });
  }

  void reconnectCompleted({
    required String attemptId,
    required bool mediaKeptAlive,
    required int elapsedMs,
    required bool pcRecreated,
  }) {
    Analytics.capture('cloudflare_reconnect_completed', {
      ..._base(),
      'attempt_id': attemptId,
      'media_kept_alive': mediaKeptAlive,
      'elapsed_ms': elapsedMs,
      'pc_recreated': pcRecreated,
    });
  }

  void reconnectFailed({required String attemptId, required int elapsedMs, required String terminalReason}) {
    Analytics.capture('cloudflare_reconnect_failed', {
      ..._base(),
      'attempt_id': attemptId,
      'elapsed_ms': elapsedMs,
      'terminal_reason': terminalReason,
    });
  }

  // ---- §6 roster ----------------------------------------------------------------

  void participantJoined({required String subjectUid, required int rosterSizeAfter}) {
    Analytics.capture('cloudflare_participant_joined', {
      ..._base(),
      'participant_hash': _shortHash(subjectUid),
      'subject_participant_hash': _shortHash(subjectUid),
      'roster_size_after': rosterSizeAfter,
    });
  }

  void participantLeft({required String subjectUid, required int rosterSizeAfter, required String leaveReason}) {
    Analytics.capture('cloudflare_participant_left', {
      ..._base(),
      'participant_hash': _shortHash(subjectUid),
      'subject_participant_hash': _shortHash(subjectUid),
      'roster_size_after': rosterSizeAfter,
      'leave_reason': leaveReason,
    });
  }

  // ---- §7 billing ------------------------------------------------------------

  void billingBeat({required int beatSeq, required int billedMsInterval}) {
    Analytics.capture('cloudflare_billing_beat', {
      ..._base(),
      'beat_seq': beatSeq,
      'billed_ms_interval': billedMsInterval,
    });
  }

  void billingReconciled({required String reconcileReason, required int driftMs}) {
    Analytics.capture('cloudflare_billing_reconciled', {
      ..._base(),
      'reconcile_reason': reconcileReason,
      'drift_ms': driftMs,
    });
  }

  // ---- §8 terminal --------------------------------------------------------------

  void conferenceLeft({
    required String leaveReason,
    required int sessionDurationMs,
    required String finalMediaHealthClass,
  }) {
    Analytics.capture('cloudflare_conference_left', {
      ..._base(),
      'leave_reason': leaveReason,
      'session_duration_ms': sessionDurationMs,
      'final_media_health_class': finalMediaHealthClass,
    });
  }

  /// §0.5 handled-Issue convention: fires BOTH `cloudflare_conference_error`
  /// and a standard `$exception` via Analytics.captureException(handled:true),
  /// deduped by (call_id, transport, stage, generation) — a repeat at the same
  /// key bumps `repeat_count` instead of re-emitting a new Issue.
  void error({
    required String stage,
    required String direction, // publish|pull|control|ticket|socket|billing
    required bool recoverable,
    Object? exception,
    StackTrace? stack,
    String? trackKind,
    String? trackNameHash,
  }) {
    final key = '$callId|$transport|$stage|$generation';
    final repeatCount = (_errorRepeatCounts[key] ?? 0) + 1;
    _errorRepeatCounts[key] = repeatCount;

    Analytics.capture('cloudflare_conference_error', {
      ..._base(trackKind: trackKind),
      'stage': stage,
      'direction': direction,
      'repeat_count': repeatCount,
      'recoverable': recoverable,
    });

    if (repeatCount == 1) {
      Analytics.captureException(
        exception ?? Exception('cloudflare_conference_error:$stage'),
        stack,
        screen: 'cloudflare_conference',
        handled: true,
        extra: {
          'call_id': callId,
          'call_trace_id': callTraceId,
          'transport': transport,
          'stage': stage,
          'generation': generation,
          'media_kind': mediaKindRequested,
          'participant_count': participantCount,
          'network_type': networkType,
          'ice_type': iceType,
          'relay_used': iceType == 'relay',
          'direction': direction,
          if (trackKind != null) 'track_kind': trackKind,
          if (trackNameHash != null) 'track_name_hash': trackNameHash,
        },
      );
    }
  }
}
