import 'dart:async';
import 'dart:io' show ProcessInfo;

import 'package:livekit_client/livekit_client.dart' as lk;

import '../../core/analytics.dart';

/// Per-conference SFU telemetry (LiveKit group calls, ≤25). Mirrors the 1:1
/// CallTelemetry intent for the conference path: one instance per conference,
/// every event auto-stamped with email/phone/net/country via the [Analytics]
/// envelope so a participant's group-call issues are pullable by contact.
///
/// transport_mode is always 'sfu' here (the media is routed through the LiveKit
/// SFU, not P2P), which lets dashboards split 1:1 (p2p/relay) from group (sfu).
///
/// Emits:
///   • conference_joined            — connected to the room (join latency, count, server)
///   • conference_resumed           — re-attached to an already-running room
///   • conference_participant_changed — a peer joined/left (live + peak count)
///   • conference_quality           — heartbeat every 20 s: SFU connection quality
///     (local + worst remote), active speakers, participant/peak count, RSS memory
///   • conference_left              — duration, peak, reason, ended-for-all
/// Join failures route through Analytics.error(domain:'conference').
class ConferenceTelemetry {
  final String gid;
  final bool video;
  final bool starter;

  int? _joinedAt;
  int _peak = 1;
  int _beats = 0;
  bool _left = false;
  Timer? _sampler;

  ConferenceTelemetry({required this.gid, required this.video, required this.starter});

  /// A fresh join completed.
  void joined(lk.Room room, {required int joinMs, String? serverHost}) {
    _joinedAt = DateTime.now().millisecondsSinceEpoch;
    final n = _count(room);
    if (n > _peak) _peak = n;
    Analytics.capture('conference_joined', {
      'gid': gid,
      'video': video,
      'starter': starter,
      'transport_mode': 'sfu',
      'join_ms': joinMs,
      'participant_count': n,
      if (serverHost != null && serverHost.isNotEmpty) 'server_host': serverHost,
    });
    _startSampler(room);
  }

  /// Re-attached to a conference already running (minimize → return).
  void resumed(lk.Room room) {
    _joinedAt = DateTime.now().millisecondsSinceEpoch;
    final n = _count(room);
    if (n > _peak) _peak = n;
    Analytics.capture('conference_resumed', {
      'gid': gid, 'transport_mode': 'sfu', 'participant_count': n, 'video': video,
    });
    _startSampler(room);
  }

  void joinFailed(Object e) {
    Analytics.error(
      domain: 'conference',
      code: 'join_failed',
      message: e.toString(),
      extra: {'gid': gid, 'video': video, 'transport_mode': 'sfu'},
    );
  }

  void participantChanged(lk.Room room, String kind) {
    final n = _count(room);
    if (n > _peak) _peak = n;
    Analytics.capture('conference_participant_changed', {
      'gid': gid, 'event': kind, 'participant_count': n, 'peak_participants': _peak,
    });
  }

  void left(lk.Room? room, {required String reason, bool endedForAll = false}) {
    if (_left) return;
    _left = true;
    _sampler?.cancel();
    final dur = _joinedAt == null
        ? 0
        : ((DateTime.now().millisecondsSinceEpoch - _joinedAt!) / 1000).round();
    Analytics.capture('conference_left', {
      'gid': gid,
      'reason': reason,
      'duration_s': dur,
      'minutes_used': (dur / 60).ceil(),
      'peak_participants': _peak,
      'ended_for_all': endedForAll,
      'video': video,
      'starter': starter,
      'samples': _beats,
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────
  void _startSampler(lk.Room room) {
    _sampler?.cancel();
    _sampler = Timer.periodic(const Duration(seconds: 20), (_) => _beat(room));
  }

  void _beat(lk.Room room) {
    if (_left) return;
    _beats++;
    final parts = _participants(room);
    final n = parts.length;
    if (n > _peak) _peak = n;
    final speakers = parts.where((p) => p.isSpeaking).length;
    Analytics.capture('conference_quality', {
      'gid': gid,
      'beat': _beats,
      'participant_count': n,
      'peak_participants': _peak,
      'active_speakers': speakers,
      'transport_mode': 'sfu',
      'local_quality': room.localParticipant?.connectionQuality.name ?? 'unknown',
      'min_remote_quality': _worstRemoteQuality(room),
      'rss_mb': _rssMb(),
      'video': video,
      'elapsed_s': _joinedAt == null
          ? 0
          : ((DateTime.now().millisecondsSinceEpoch - _joinedAt!) / 1000).round(),
    });
  }

  static int _count(lk.Room room) => room.remoteParticipants.length + 1;

  static List<lk.Participant> _participants(lk.Room room) => [
        if (room.localParticipant != null) room.localParticipant!,
        ...room.remoteParticipants.values,
      ];

  /// The worst remote link quality this beat — surfaces "one participant on a bad
  /// network" without averaging it away. '' when alone.
  static String _worstRemoteQuality(lk.Room room) {
    int rank(lk.ConnectionQuality q) => switch (q) {
          lk.ConnectionQuality.excellent => 3,
          lk.ConnectionQuality.good => 2,
          lk.ConnectionQuality.poor => 1,
          _ => 0, // unknown / lost
        };
    String worst = '';
    int worstRank = 99;
    for (final p in room.remoteParticipants.values) {
      final r = rank(p.connectionQuality);
      if (r < worstRank) {
        worstRank = r;
        worst = p.connectionQuality.name;
      }
    }
    return worst;
  }

  static int _rssMb() {
    try {
      return (ProcessInfo.currentRss / (1024 * 1024)).round();
    } catch (_) {
      return 0;
    }
  }
}
