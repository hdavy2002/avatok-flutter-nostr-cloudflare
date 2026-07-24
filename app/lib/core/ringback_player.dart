import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'feature_flags.dart';
import 'remote_config.dart';
import 'ringtone_catalog.dart';
import '../identity/identity.dart';

/// Caller-side ringback + busy tone playback for the 1:1 call screen.
/// Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md
///
/// The CALLER plays this locally while the call is ringing — this is NOT carrier
/// early media. The callee's default ringtone URL (resolved at dial time) is
/// played looped; if it is empty or unreachable we fall back to the bundled
/// default ringback. The busy tone is always the bundled clip.
///
/// Caching: a fetched ringtone is cached on-device per account
/// (…/ringtones/<AccountScope.id>/<file>) per the Rulebook media-cache rule, so
/// repeat calls to the same person start instantly and work offline. One player
/// per call; [stop] on every call-end path, [dispose] in the screen's dispose().
///
/// ─────────────────────────────────────────────────────────────────────────
/// [CALL-REL-3 2026-07-24] TONE PLAYER — audio-context writes GATED behind
/// `RemoteConfig.callAudioControllerV2`, not removed outright.
///
/// This class used to call `AudioPlayer.setAudioContext()` on every tone,
/// which — per the [CALL-ECHO-FIX-1] history below — is NOT player-local on
/// Android: it writes `AudioManager.mode` and `AudioManager.isSpeakerphoneOn`
/// DEVICE-WIDE. That made RingbackPlayer a second, competing owner of Android
/// call-audio state alongside `NativeVoiceAudio`/`CallSession`, which is
/// exactly the REL-5 defect ("each beep gets quieter", "speaker toggle
/// revived it") described in
/// Specs/PERMANENT-P2P-CALL-RELIABILITY-IMPLEMENTATION-PLAN-2026-07-24.md §6.
///
/// When `RemoteConfig.callAudioControllerV2` is TRUE, `RingbackPlayer` NEVER
/// sets `AudioManager` mode, focus, speaker state, SCO, or communication
/// device. It is a strict CLIENT of whatever communication session
/// `CallSession`/`NativeVoiceAudio` already opened via the new controller —
/// tones simply play; the controller decides the route. This is the target
/// interim state (`audioplayers` retained, all global writes removed by the
/// controller path), not the permanent architecture — a native `AudioTrack`
/// on `USAGE_VOICE_COMMUNICATION` is the target end state (plan §6).
///
/// When the flag is FALSE — the default for all users as of 2026-07-24 —
/// `RingbackPlayer` is the ONLY thing that ever calls
/// `NativeVoiceAudio.startP2pAudioMode()`'s Android-side equivalent for
/// tones, so removing the context write outright (as an earlier version of
/// this commit did, ungated) left tones inheriting the audioplayers 6.1
/// default `AudioContext` — `STREAM_MUSIC` + audio-focus GAIN + `MODE_NORMAL`.
/// That can (a) steal `VOICE_COMMUNICATION` focus from the native plugin,
/// self-muting the call while it rings, and (b) reopen the exact
/// [CALL-ECHO-FIX-1] `MODE_NORMAL` echo path and undo `CALL-SPEAKER-RAMP`
/// routing. So the flag-off path below calls [_ensureCallAudioContext] with
/// the EXACT pre-[CALL-REL-3] behavior (see git history at 8046d27^ for the
/// byte-for-byte prior implementation), and only the flag-on path skips it.
///
/// Every start/stop carries a monotonically increasing [_generation]. A
/// superseded async operation (e.g. a slow network ringtone fetch that
/// resolves after the call already answered) is dropped rather than played,
/// so a late completion can never restart sound over live/receptionist
/// audio.
class RingbackPlayer {
  final AudioPlayer _p = AudioPlayer();
  bool _disposed = false;
  bool _ctxSet = false;
  bool? _ctxSpeakerOn;
  AndroidAudioMode? _ctxMode;

  // audioplayers AssetSource paths are relative to the `assets/` bundle prefix.
  static String _assetRel(String p) => p.startsWith('assets/') ? p.substring(7) : p;

  /// [CALL-REL-3] Legacy (pre-2026-07-24) audio-context write, restored
  /// verbatim and now called ONLY when `RemoteConfig.callAudioControllerV2`
  /// is false — see the class doc above for why the flag-off path still
  /// needs this. When the flag is true, the new controller owns
  /// `AudioManager` state end-to-end and this method is never called.
  ///
  /// `AudioPlayer.setAudioContext` is NOT player-local on Android (verified
  /// in audioplayers 6.1.0, `WrappedPlayer.updateAudioContext`): it writes
  /// `audioManager.mode` and `audioManager.isSpeakerphoneOn` DEVICE-WIDE.
  /// `AudioContextAndroid`'s constructor defaults `audioMode` to
  /// `AndroidAudioMode.normal` (MODE_NORMAL) and `toJson()` always ships it,
  /// so omitting `audioMode` silently drops the whole device to MODE_NORMAL —
  /// the [CALL-ECHO-FIX-1] echo defect (2026-07-14 prod incident,
  /// hdavy2002@gmail.com, call avatok-622e0df2): MODE_IN_COMMUNICATION is
  /// what binds the platform AcousticEchoCanceler/NS/AGC to the
  /// VOICE_COMMUNICATION capture path, and `stop()` never restored the mode,
  /// so the device stayed in MODE_NORMAL (echo cancellation off) for the
  /// REST OF THE CALL.
  ///
  /// [mode] MUST match the call's actual lifecycle stage:
  ///  · ringback / searching tone → [AndroidAudioMode.inCommunication].
  ///  · busy tone → [AndroidAudioMode.normal] (call is over; agrees with the
  ///    concurrent `_teardown()` → `stopP2pAudioMode()` race instead of
  ///    fighting it — see [CALL-ECHO-FIX-1] history).
  ///
  /// Re-applied whenever [speakerOn] or [mode] changes, because
  /// `updateAudioContext` early-returns on an unchanged context.
  Future<void> _ensureCallAudioContext({
    required bool speakerOn,
    required AndroidAudioMode mode,
  }) async {
    if (_ctxSet && _ctxSpeakerOn == speakerOn && _ctxMode == mode) return;
    _ctxSet = true;
    _ctxSpeakerOn = speakerOn;
    _ctxMode = mode;
    try {
      await _p.setAudioContext(AudioContext(
        android: AudioContextAndroid(
          isSpeakerphoneOn: speakerOn,
          // ⚠️ NEVER omit this — the default is MODE_NORMAL and it is global.
          audioMode: mode,
          stayAwake: false,
          contentType: AndroidContentType.speech,
          usageType: AndroidUsageType.voiceCommunication,
          audioFocus: AndroidAudioFocus.none,
        ),
      ));
      Analytics.capture('call_audio_context_set', {
        'speaker_on': speakerOn,
        'audio_mode': mode.name,
        'ok': true,
      });
    } catch (e) {
      AvaLog.I.log('call', 'ringback audio-context set failed: $e');
      Analytics.capture('call_audio_context_set', {
        'speaker_on': speakerOn,
        'audio_mode': mode.name,
        'ok': false,
        'error': e.toString(),
      });
      Analytics.error(
        domain: 'call_audio',
        code: 'audio_context_set_failed',
        message: e.toString(),
        action: 'ringback_context',
        extra: {'audio_mode': mode.name, 'speaker_on': speakerOn},
      );
      Analytics.captureException(
        e,
        StackTrace.current,
        screen: 'call',
        handled: true,
        extra: {'stage': 'ringback_audio_context_set', 'audio_mode': mode.name},
      );
    }
  }

  /// [CALL-REL-3] Monotonically increasing tone generation. Every async
  /// start/stop captures the generation it began with; on completion it
  /// checks the CURRENT generation still matches before acting, so a
  /// superseded start/stop is a no-op rather than fighting a newer one.
  int _generation = 0;

  /// Tracks the last kind that reached `call_tone_started`, purely so `stop()`
  /// can report which tone it actually stopped in telemetry.
  String _lastStartedKind = 'none';

  void _toneRequested(String kind, int generation, {required bool speakerOn}) {
    Analytics.capture('call_tone_requested', {
      'kind': kind,
      'generation': generation,
      'route_requested': speakerOn ? 'speaker' : 'earpiece',
    });
  }

  void _toneStarted(String kind, int generation, {required bool speakerOn}) {
    _lastStartedKind = kind;
    Analytics.capture('call_tone_started', {
      'kind': kind,
      'generation': generation,
      'active_route': speakerOn ? 'speaker' : 'earpiece',
      'backend': 'audioplayers',
    });
  }

  void _toneStopped(String kind, int generation, {required String reason}) {
    Analytics.capture('call_tone_stopped', {
      'kind': kind,
      'generation': generation,
      'reason': reason,
    });
  }

  void _toneFailed(String kind, int generation, {required String errorCode}) {
    Analytics.capture('call_tone_failed', {
      'kind': kind,
      'generation': generation,
      'error_code': errorCode,
    });
  }

  /// Play the callee's ringback (looped). [value] is a bundled catalog id
  /// (preferred), or empty → bundled default, or a legacy http(s) URL.
  ///
  /// [speakerOn] doubles as telemetry (which route the call is currently on,
  /// for the `call_tone_started`/`requested` events) AND, when
  /// `RemoteConfig.callAudioControllerV2` is false, the actual value applied
  /// to `AudioManager.isSpeakerphoneOn` via [_ensureCallAudioContext]. When
  /// the flag is true it is telemetry only — the communication session
  /// already owns `AudioManager` and this class never writes to it.
  Future<void> playRingback(String value, {bool speakerOn = false}) async {
    final gen = ++_generation;
    _toneRequested('ringback', gen, speakerOn: speakerOn);
    try {
      if (!RemoteConfig.callAudioControllerV2) {
        await _ensureCallAudioContext(
            speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
        if (_disposed || gen != _generation) return; // superseded — drop it
      }
      await _p.setReleaseMode(ReleaseMode.loop);
      Source src;
      if (value.isEmpty) {
        src = AssetSource(_assetRel(kDefaultRingbackAsset));
      } else if (value.startsWith('http')) {
        // Legacy URL path (cache + stream).
        final cached = await _cachedFile(value);
        if (cached != null && await cached.exists() && await cached.length() > 0) {
          src = DeviceFileSource(cached.path);
        } else {
          src = UrlSource(value);
          // ignore: unawaited_futures
          _cacheInBackground(value);
        }
      } else {
        // Catalog id → play the matching app-bundled tone (instant, offline).
        final item = ringtoneById(value);
        if (item == null) {
          await _playDefaultRingback(speakerOn: speakerOn, generation: gen);
          return;
        }
        src = AssetSource(_assetRel(item.asset));
      }
      if (_disposed || gen != _generation) return; // superseded — drop it
      await _p.play(src);
      if (gen != _generation) {
        // A newer request/stop landed while play() was in flight — silence it
        // immediately rather than let stale ringback bleed into whatever the
        // newer generation started (e.g. receptionist audio).
        try { await _p.stop(); } catch (_) {}
        return;
      }
      _toneStarted('ringback', gen, speakerOn: speakerOn);
    } catch (e) {
      AvaLog.I.log('call', 'ringback play failed ($value): $e — using default');
      Analytics.error(
        domain: 'call_audio',
        code: 'ringback_play_failed',
        message: e.toString(),
        action: 'fallback_default_ringback',
      );
      Analytics.captureException(
        e,
        StackTrace.current,
        screen: 'call',
        handled: true,
        extra: const {'stage': 'ringback_play'},
      );
      _toneFailed('ringback', gen, errorCode: 'play_failed');
      await _playDefaultRingback(speakerOn: speakerOn, generation: gen);
    }
  }

  Future<void> _playDefaultRingback({required bool speakerOn, required int generation}) async {
    if (_disposed || generation != _generation) return;
    try {
      if (!RemoteConfig.callAudioControllerV2) {
        await _ensureCallAudioContext(
            speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
        if (_disposed || generation != _generation) return;
      }
      await _p.setReleaseMode(ReleaseMode.loop);
      if (_disposed || generation != _generation) return;
      await _p.play(AssetSource(_assetRel(kDefaultRingbackAsset)));
      if (generation != _generation) {
        try { await _p.stop(); } catch (_) {}
        return;
      }
      _toneStarted('ringback', generation, speakerOn: speakerOn);
    } catch (e) {
      _toneFailed('ringback', generation, errorCode: 'default_play_failed');
      /* give up silently — a missing tone must never crash a call */
    }
  }

  /// [CALL-SEARCH-TONE-1] PSTN-style call-progress beeps (looped) while the
  /// network is still locating the callee's device — played before the
  /// device-ringing receipt arrives, then replaced by [playRingback]. The
  /// single shared player means the swap is a plain play() call.
  Future<void> playSearchingTone({bool speakerOn = false}) async {
    final gen = ++_generation;
    _toneRequested('searching', gen, speakerOn: speakerOn);
    if (_disposed) return;
    try {
      if (!RemoteConfig.callAudioControllerV2) {
        await _ensureCallAudioContext(
            speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
        if (_disposed || gen != _generation) return;
      }
      await _p.setReleaseMode(ReleaseMode.loop);
      // [AVACALL-TONE-1] Pin the tone to full volume — the caller experienced it
      // as inaudible (2026-07-20) even though `searching_tone_played` was logged.
      // A stale per-player volume from an earlier tone could leave it near-silent;
      // asserting 1.0 here makes the beeps reliably audible. Player volume only —
      // never a device-wide write.
      if (gen != _generation) return;
      try { await _p.setVolume(1.0); } catch (_) {}
      if (_disposed || gen != _generation) return;
      await _p.play(AssetSource(_assetRel(kSearchingToneAsset)));
      if (gen != _generation) {
        try { await _p.stop(); } catch (_) {}
        return;
      }
      _toneStarted('searching', gen, speakerOn: speakerOn);
    } catch (e) {
      // [AVACALL-TONE-1] A silent searching tone must never be invisible again:
      // emit an explicit failure event (was log-only) so a broken/missing asset or
      // a player error is queryable in PostHog next to `searching_tone_played`.
      AvaLog.I.log('call', 'searching tone play failed: $e');
      Analytics.capture('searching_tone_play_failed', {
        'error': e.toString(),
        'asset': kSearchingToneAsset,
      });
      Analytics.captureException(
        e,
        StackTrace.current,
        screen: 'call',
        handled: true,
        extra: const {'stage': 'searching_tone_play'},
      );
      _toneFailed('searching', gen, errorCode: 'play_failed');
    }
  }

  /// Play the bundled busy tone a few cycles (does not loop forever).
  ///
  /// The call is over by the time this plays. When
  /// `RemoteConfig.callAudioControllerV2` is true, this never touches
  /// `AudioManager` at all — the controller owns it end-to-end. When false,
  /// [_ensureCallAudioContext] asserts `AndroidAudioMode.normal` to agree
  /// with the concurrent `_teardown()` restoring MODE_NORMAL, rather than
  /// fighting it.
  Future<void> playBusyTone({bool speakerOn = false}) async {
    final gen = ++_generation;
    _toneRequested('busy', gen, speakerOn: speakerOn);
    if (_disposed) return;
    try {
      if (!RemoteConfig.callAudioControllerV2) {
        // Call is over — agree with the concurrent `_teardown()` restoring
        // MODE_NORMAL rather than asserting inCommunication (see
        // [_ensureCallAudioContext] doc).
        await _ensureCallAudioContext(speakerOn: speakerOn, mode: AndroidAudioMode.normal);
        if (_disposed || gen != _generation) return;
      }
      await _p.setReleaseMode(ReleaseMode.release);
      if (_disposed || gen != _generation) return;
      await _p.play(AssetSource(_assetRel(kBusyToneAsset)));
      if (gen != _generation) {
        try { await _p.stop(); } catch (_) {}
        return;
      }
      _toneStarted('busy', gen, speakerOn: speakerOn);
    } catch (e) {
      AvaLog.I.log('call', 'busy tone play failed: $e');
      Analytics.captureException(
        e,
        StackTrace.current,
        screen: 'call',
        handled: true,
        extra: const {'stage': 'busy_tone_play'},
      );
      _toneFailed('busy', gen, errorCode: 'play_failed');
    }
  }

  /// Stop whatever tone is playing. Bumps the generation FIRST so any
  /// in-flight async start (ringtone fetch, default-tone fallback, etc.)
  /// sees itself superseded and drops its own late `play()`/`_toneStarted`.
  /// Callers that must not proceed until the tone has actually stopped
  /// (e.g. the receptionist hand-off — plan §6: "receptionist begins only
  /// after tone confirmed stopped") should `await` this.
  Future<void> stop({String reason = 'call_state_change'}) async {
    final gen = ++_generation;
    final kind = _lastStartedKind;
    try {
      await _p.stop();
    } catch (_) {}
    _toneStopped(kind, gen, reason: reason);
    _lastStartedKind = 'none';
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    try { await _p.stop(); } catch (_) {}
    try { await _p.dispose(); } catch (_) {}
  }

  // ---- per-account on-device cache --------------------------------------

  Future<Directory> _cacheDir() async {
    final base = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? '_' : AccountScope.id!;
    final d = Directory('${base.path}/ringtones/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  // Stable filename from the URL's last path segment (server uses a uuid.mp3).
  String _fileName(String url) {
    final seg = Uri.parse(url).pathSegments;
    final last = seg.isNotEmpty ? seg.last : url.hashCode.toString();
    final safe = last.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    return safe.isEmpty ? '${url.hashCode}.mp3' : safe;
  }

  Future<File?> _cachedFile(String url) async {
    try {
      final dir = await _cacheDir();
      return File('${dir.path}/${_fileName(url)}');
    } catch (_) {
      return null;
    }
  }

  Future<void> _cacheInBackground(String url) async {
    try {
      final file = await _cachedFile(url);
      if (file == null || (await file.exists() && await file.length() > 0)) return;
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 20));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await file.writeAsBytes(res.bodyBytes, flush: true);
      }
    } catch (_) { /* best-effort; streaming already covered this call */ }
  }
}
