import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'disk_cache.dart';

/// One playable clip — a voice note, a voicemail, an agent reply, etc. Any
/// screen that wants app-wide (survives-navigation, survives-backgrounding)
/// playback constructs one of these and hands it to [AudioPlaybackService.play].
@immutable
class AudioTrack {
  /// Stable, content-addressed where possible (e.g. the server media id) —
  /// used as the persistence key for [AudioPlaybackService.savedPosition], so
  /// it MUST be unique across the whole app, not just within one thread.
  final String trackId;
  final String title; // e.g. contact name
  final String? subtitle; // e.g. "Voicemail" / "Voice note"
  /// Route/conversation id this track "belongs to" — the [MiniAudioPlayerBar]
  /// hides itself when this equals the currently-visible thread (compared via
  /// `ActiveThread.convKey`) and uses it to resolve where a tap should
  /// navigate (see [AudioPlaybackService.onTapOrigin]).
  final String? originRoute;

  const AudioTrack({
    required this.trackId,
    required this.title,
    this.subtitle,
    this.originRoute,
  });
}

/// Immutable snapshot of the shared player, broadcast via
/// [AudioPlaybackService.state].
@immutable
class PlaybackState {
  final AudioTrack track;
  final Duration position;
  final Duration? duration;
  final bool playing;
  final bool completed;

  const PlaybackState({
    required this.track,
    required this.position,
    this.duration,
    required this.playing,
    this.completed = false,
  });

  PlaybackState copyWith({
    Duration? position,
    Duration? duration,
    bool? playing,
    bool? completed,
  }) =>
      PlaybackState(
        track: track,
        position: position ?? this.position,
        duration: duration ?? this.duration,
        playing: playing ?? this.playing,
        completed: completed ?? this.completed,
      );
}

/// [AVAVM-PLAYER-1] App-wide, single-instance audio playback for voice notes /
/// voicemails / agent replies.
///
/// WHY THIS EXISTS: before this, every surface (chat_thread's voice-note
/// bubbles, the AvaDial inbox's voicemail bubbles) owned its OWN
/// `AudioPlayer()` tied to that widget's lifetime, so playback died the
/// instant the widget was disposed — navigate away from the thread and the
/// voicemail you were listening to just stopped, with no way to resume except
/// reopening the thread and starting it over from 0:00 (owner report,
/// 2026-07-16, pic2 point 2). A player living at the SERVICE layer (not a
/// widget) survives navigation for free: nothing disposes it when a screen is
/// popped, so playback (and the mini-player showing it) keeps going as the
/// user moves around the app — the WhatsApp behaviour the owner asked for.
///
/// Position is persisted PER ACCOUNT (via [DiskCache], which is already
/// namespaced to `AccountScope.id`) so a paused note/voicemail resumes where
/// you left off even after a cold start. A raw global key here would leak one
/// account's listening position into another's on a shared phone — forbidden
/// by the per-account-scoping rule in the engineering rulebook.
///
/// SCOPE NOTE (explicitly out of this change): this does NOT keep playing
/// after the OS fully kills the process, and does NOT post an OS media
/// notification / lockscreen control. Both need `audio_service` or
/// `just_audio_background` — a NEW pub dependency — which the owner asked to
/// avoid here since the app can't be built locally to verify it. While the
/// Flutter engine is alive (foregrounded OR merely backgrounded) audioplayers
/// keeps decoding normally, so playback survives in-app navigation and a
/// background dip; it does not survive a hard OS kill mid-clip. Flagged as a
/// follow-up, not silently dropped.
class AudioPlaybackService with WidgetsBindingObserver {
  AudioPlaybackService._() {
    WidgetsBinding.instance.addObserver(this);
    _wireStreams();
    _loadPositions();
  }

  static final AudioPlaybackService I = AudioPlaybackService._();

  /// Optional app-wide hook: given the [BuildContext] a [MiniAudioPlayerBar]
  /// was tapped from and the current [AudioTrack], navigate to wherever that
  /// track "belongs" (its origin thread/screen). Screens that can resolve
  /// `originRoute` to a concrete route install/override this — see
  /// `ChatThreadRegistry` in `features/avatok/chat_thread.dart` for the
  /// chat-thread implementation. Left null (or given a route it doesn't
  /// recognise) the tap is a no-op besides telemetry — the bar itself never
  /// throws either way.
  static Future<void> Function(BuildContext context, AudioTrack track)? onTapOrigin;

  final AudioPlayer _player = AudioPlayer();
  final ValueNotifier<PlaybackState?> _state = ValueNotifier<PlaybackState?>(null);

  /// null when nothing is loaded.
  ValueListenable<PlaybackState?> get state => _state;

  // trackId -> position ms. Loaded best-effort from DiskCache on first use;
  // may still be empty for the first few hundred ms after a cold start, which
  // only matters if something calls [savedPosition] in that exact window.
  Map<String, int> _positions = {};
  // trackId -> last-known clip length (ms). NOT in the published contract —
  // an additive cache so a bubble that has a saved position but ISN'T the
  // currently-loaded track can still render a real (not just "Voice") label
  // and a filled progress bar before the user taps play again. Best-effort;
  // absent for a track that has never been opened long enough to decode its
  // header.
  Map<String, int> _durations = {};
  static const _kPositionsKey = 'audio_playback_positions_v2';

  String? _loadedTrackId;

  Future<void> _loadPositions() async {
    try {
      final raw = await DiskCache.read(_kPositionsKey);
      if (raw != null && raw.isNotEmpty) {
        final m = jsonDecode(raw) as Map<String, dynamic>;
        final pos = m['positions'];
        final dur = m['durations'];
        if (pos is Map) _positions = pos.map((k, v) => MapEntry(k as String, (v as num).toInt()));
        if (dur is Map) _durations = dur.map((k, v) => MapEntry(k as String, (v as num).toInt()));
      }
    } catch (e) {
      AvaLog.I.log('audio', 'position load failed: $e');
    }
  }

  Future<void> _persistPositions() async {
    try {
      await DiskCache.write(_kPositionsKey, jsonEncode({
        'positions': _positions,
        'durations': _durations,
      }));
    } catch (e) {
      AvaLog.I.log('audio', 'position persist failed: $e');
    }
  }

  void _wireStreams() {
    _player.onPositionChanged.listen((p) {
      final cur = _state.value;
      if (cur == null || cur.position == p) return; // guard dupes, not a 100Hz rebuild
      _state.value = cur.copyWith(position: p);
      if (_loadedTrackId != null) _positions[_loadedTrackId!] = p.inMilliseconds;
    });
    _player.onDurationChanged.listen((d) {
      final cur = _state.value;
      if (cur == null || d <= Duration.zero) return;
      _state.value = cur.copyWith(duration: d);
      if (_loadedTrackId != null) {
        _durations[_loadedTrackId!] = d.inMilliseconds;
        _persistPositions();
      }
    });
    _player.onPlayerComplete.listen((_) {
      final cur = _state.value;
      if (cur == null) return;
      final trackId = cur.track.trackId;
      _positions.remove(trackId); // played to completion — nothing to resume
      _persistPositions();
      _state.value = cur.copyWith(
        playing: false,
        completed: true,
        position: cur.duration ?? cur.position,
      );
      Analytics.capture('audio_playback_complete', {
        'track_id': trackId,
        'origin_route': cur.track.originRoute ?? '',
      });
    });
  }

  /// Persisted resume point for [trackId], per-account. null = never played /
  /// finished (or the on-disk cache hasn't loaded yet — best-effort).
  Duration? savedPosition(String trackId) {
    final ms = _positions[trackId];
    if (ms == null || ms <= 0) return null;
    return Duration(milliseconds: ms);
  }

  /// True when [trackId] is the currently loaded track (playing OR paused).
  bool isCurrent(String trackId) => _loadedTrackId == trackId;

  /// NOT in the published contract — last-known clip length for [trackId],
  /// even when it isn't the currently-loaded track. Lets a bubble that has a
  /// saved (paused) position render a real "0:07 / 0:40" label + a filled
  /// progress bar BEFORE the user taps play again, instead of only once
  /// re-opened. null when this track has never been decoded.
  Duration? knownDuration(String trackId) {
    final ms = _durations[trackId];
    if (ms == null || ms <= 0) return null;
    return Duration(milliseconds: ms);
  }

  /// Starts (or resumes) a track. If [startAt] is null the service resumes
  /// from the persisted position for [track.trackId], if any.
  Future<void> play({
    required AudioTrack track,
    required Uint8List bytes,
    Duration? startAt,
  }) async {
    // Resuming the SAME already-loaded track (paused, or parked where the
    // user scrubbed to) — don't re-decode/re-write the temp file, which would
    // restart it from 0:00.
    if (_loadedTrackId == track.trackId && _state.value != null) {
      try {
        if (startAt != null) await _player.seek(startAt);
        await _player.resume();
        _state.value = _state.value!.copyWith(playing: true, completed: false);
        Analytics.capture('audio_playback_resume', {
          'track_id': track.trackId,
          'origin_route': track.originRoute ?? '',
        });
        return;
      } catch (_) {
        /* fall through to a full (re)load */
      }
    }
    try {
      await _player.stop();
      // audioplayers can't reliably decode a compressed clip from an
      // in-memory BytesSource on Android (no container/mime hint) — write the
      // decrypted bytes to a real temp file and play THAT, same fix already
      // proven in the per-thread player this replaces.
      final dir = await getTemporaryDirectory();
      final safeId = track.trackId.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
      final f = File('${dir.path}/avplay_$safeId.audio');
      await f.writeAsBytes(bytes, flush: true);

      final resumeAt = startAt ?? savedPosition(track.trackId);
      final resumedFromSaved = startAt == null && resumeAt != null;

      _loadedTrackId = track.trackId;
      _state.value = PlaybackState(
        track: track,
        position: resumeAt ?? Duration.zero,
        playing: false,
      );

      await _player.play(DeviceFileSource(f.path));
      if (resumeAt != null && resumeAt > Duration.zero) {
        try {
          await _player.seek(resumeAt);
        } catch (_) {/* best-effort — worst case it plays from 0:00 */}
      }
      _state.value = _state.value?.copyWith(playing: true, position: resumeAt ?? Duration.zero);

      Analytics.capture('audio_playback_start', {
        'track_id': track.trackId,
        'origin_route': track.originRoute ?? '',
        'resumed_from_saved': resumedFromSaved,
      });
      if (resumedFromSaved) {
        Analytics.capture('audio_playback_resume_from_saved', {
          'track_id': track.trackId,
          'position_ms': resumeAt.inMilliseconds,
        });
      }
    } catch (e) {
      AvaLog.I.log('audio', 'play failed: $e');
      Analytics.capture('audio_playback_error', {
        'track_id': track.trackId,
        'error': e.toString(),
      });
    }
  }

  Future<void> pause() async {
    final cur = _state.value;
    if (cur == null) return;
    try {
      await _player.pause();
      _state.value = cur.copyWith(playing: false);
      _persistCurrentPosition();
      Analytics.capture('audio_playback_pause', {'track_id': cur.track.trackId});
    } catch (e) {
      AvaLog.I.log('audio', 'pause failed: $e');
    }
  }

  Future<void> resume() async {
    final cur = _state.value;
    if (cur == null) return;
    try {
      await _player.resume();
      _state.value = cur.copyWith(playing: true, completed: false);
      Analytics.capture('audio_playback_resume', {'track_id': cur.track.trackId});
    } catch (e) {
      AvaLog.I.log('audio', 'resume failed: $e');
    }
  }

  Future<void> seek(Duration position) async {
    final cur = _state.value;
    if (cur == null) return;
    try {
      await _player.seek(position);
      _state.value = cur.copyWith(position: position);
      if (_loadedTrackId != null) _positions[_loadedTrackId!] = position.inMilliseconds;
    } catch (e) {
      AvaLog.I.log('audio', 'seek failed: $e');
    }
  }

  Future<void> stop() async {
    final cur = _state.value;
    if (cur == null) return;
    _persistCurrentPosition();
    try {
      await _player.stop();
    } catch (_) {/* best-effort */}
    _state.value = null;
    _loadedTrackId = null;
  }

  /// NOT in the published contract — an additive extension so the existing
  /// 1x/1.5x/2x voice-note speed chip (chat_thread.dart) keeps working now
  /// that playback is routed through this shared service instead of a local
  /// AudioPlayer. Safe to ignore for any consumer that doesn't need it.
  Future<void> setSpeed(double rate) async {
    try {
      await _player.setPlaybackRate(rate);
    } catch (_) {/* not supported on all platforms */}
  }

  void _persistCurrentPosition() {
    final cur = _state.value;
    if (cur == null || _loadedTrackId == null) return;
    _positions[_loadedTrackId!] = cur.position.inMilliseconds;
    _persistPositions();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    // Persist on backgrounding — not just on pause/dispose — so a hard kill
    // while a note is playing never loses the resume point.
    if (lifecycleState == AppLifecycleState.paused ||
        lifecycleState == AppLifecycleState.inactive ||
        lifecycleState == AppLifecycleState.hidden ||
        lifecycleState == AppLifecycleState.detached) {
      _persistCurrentPosition();
    }
  }
}
