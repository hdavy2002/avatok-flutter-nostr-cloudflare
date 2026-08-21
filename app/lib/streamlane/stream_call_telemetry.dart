// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
//
// [STREAM-TELEMETRY-1 2026-08-21] Small, dependency-free helpers shared by
// `stream_call_service.dart`, `stream_call_screen.dart` and
// `stream_incoming_screen.dart`, split into its own file per the task brief
// so none of the three has to duplicate this logic. Nothing here talks to
// PostHog directly — callers merge these maps into their own
// `Analytics.capture` calls, exactly like every other property in this lane.
library;

import 'package:flutter/widgets.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'package:uuid/uuid.dart';

/// The exact record shape [Call.stats] emits.
///
/// verified: packages/stream_video/lib/src/call/call.dart —
/// `SharedEmitter<({PeerConnectionStatsBundle publisherStatsBundle,
/// PeerConnectionStatsBundle subscriberStatsBundle})> get stats`. Named here
/// so callers (the call screen, which caches the latest value from a
/// `call.stats.listen(...)` subscription) don't have to repeat the record
/// shape at every call site.
typedef StreamStatsBundle = ({
  PeerConnectionStatsBundle publisherStatsBundle,
  PeerConnectionStatsBundle subscriberStatsBundle,
});

class StreamCallTelemetry {
  StreamCallTelemetry._();

  /// One UUID per user gesture (tap-to-call, or a Retry of the SAME
  /// gesture), so the Worker's `attempt_id` dedup key can collapse duplicate
  /// `place` requests from a single tap instead of creating two calls.
  /// Minted once per [StreamCallService.place1to1] invocation — that method
  /// runs exactly once per gesture; nothing inside it re-authorises on
  /// retry, so a single mint already satisfies "stable across in-gesture
  /// retries".
  static String mintAttemptId() => const Uuid().v4();

  /// Cheap, synchronous app-lifecycle read for telemetry properties.
  /// `WidgetsBinding.instance.lifecycleState` never throws in practice, but
  /// this is wrapped anyway — telemetry must never be the reason a call
  /// path throws.
  static String lifecycleState() {
    try {
      final s = WidgetsBinding.instance.lifecycleState;
      if (s == null) return 'unknown';
      switch (s) {
        case AppLifecycleState.resumed:
          return 'foreground';
        case AppLifecycleState.inactive:
        case AppLifecycleState.hidden:
          // Transient (e.g. a system dialog, or mid-transition) — still the
          // foreground app from the user's point of view.
          return 'foreground';
        case AppLifecycleState.paused:
        case AppLifecycleState.detached:
          return 'background';
      }
    } catch (_) {
      return 'unknown';
    }
  }

  /// Best-effort call-quality snapshot, built from two DIFFERENT SDK
  /// surfaces:
  ///
  /// - `call.statsReporter?.currentMetrics` — verified:
  ///   packages/stream_video/lib/src/call/stats/stats_reporter.dart
  ///   (`StatsReporter extends StateNotifier<CallMetrics?>`, `currentMetrics
  ///   => state`) + packages/stream_video/lib/src/models/call_stats.dart
  ///   (`CallMetrics.publisher`/`.subscriber` are `PeerConnectionStats` with
  ///   `latency`, `jitterInMs`, `bitrateKbps`, `resolution`). The SDK
  ///   recomputes this on its OWN `callStatsReportingInterval` timer once a
  ///   session exists (call.dart ~L1743, started from `_startSession`) — we
  ///   only ever READ the latest value, never drive our own polling loop.
  ///   `publisher.latency` is the genuine round-trip time: it is set from
  ///   `publisherCandidatePair.currentRoundTripTime` in
  ///   `stats_reporter.dart`'s `_processStats`, not a guess.
  /// - [lastRawBundle], the most recent value a `call.stats.listen(...)`
  ///   subscription observed — needed ONLY because `CallMetrics` does not
  ///   surface packet loss. `RtcInboundRtpVideoStream.packetsLost` /
  ///   `RtcInboundRtpAudioStream.packetsLost` (both verified in
  ///   packages/stream_video/lib/src/webrtc/model/stats/
  ///   rtc_inbound_rtp_{video,audio}_stream.dart, both publicly exported via
  ///   the `rtc_stats_models.dart` barrel) are read off the subscriber
  ///   bundle's raw `stats` list the same way the SDK's own
  ///   `StatsReporter._processStats` reads `RtcInboundRtpVideoStream` —
  ///   `.whereType<T>()`. `firstOrNull` from `package:collection` is
  ///   deliberately NOT used here (not a declared dependency of this app;
  ///   see stream_call_service.dart's `uuid` note on the same caution) —
  ///   `whereType<T>()` is plain `dart:core` and needs no extra package.
  ///
  /// Returns an EMPTY map (never null) when nothing is available yet (e.g.
  /// before `join()` has produced a session), so a caller can always spread
  /// this into an event's properties without a null check.
  static Map<String, Object> qualityProps(
    Call call, {
    StreamStatsBundle? lastRawBundle,
  }) {
    final metrics = call.statsReporter?.currentMetrics;
    final pub = metrics?.publisher;
    final sub = metrics?.subscriber;

    int? packetsLostIn;
    final subRaw = lastRawBundle?.subscriberStatsBundle.stats;
    if (subRaw != null) {
      final videoIn = subRaw.whereType<RtcInboundRtpVideoStream>();
      final audioIn = subRaw.whereType<RtcInboundRtpAudioStream>();
      if (videoIn.isNotEmpty || audioIn.isNotEmpty) {
        final v = videoIn.isNotEmpty ? (videoIn.first.packetsLost ?? 0) : 0;
        final a = audioIn.isNotEmpty ? (audioIn.first.packetsLost ?? 0) : 0;
        packetsLostIn = v + a;
      }
    }

    return <String, Object>{
      if (pub?.latency != null) 'rtt_ms': pub!.latency!,
      if (pub?.jitterInMs != null) 'jitter_out_ms': pub!.jitterInMs!,
      if (sub?.jitterInMs != null) 'jitter_in_ms': sub!.jitterInMs!,
      if (pub?.bitrateKbps != null) 'bitrate_out_kbps': pub!.bitrateKbps!,
      if (sub?.bitrateKbps != null) 'bitrate_in_kbps': sub!.bitrateKbps!,
      if (pub?.resolution != null) 'resolution_out': pub!.resolution!,
      if (sub?.resolution != null) 'resolution_in': sub!.resolution!,
      if (packetsLostIn != null) 'packets_lost_in': packetsLostIn,
    };
  }
}
