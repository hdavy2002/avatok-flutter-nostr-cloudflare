import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'feature_flags.dart';
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
class RingbackPlayer {
  final AudioPlayer _p = AudioPlayer();
  bool _disposed = false;
  bool _ctxSet = false;
  bool? _ctxSpeakerOn;
  AndroidAudioMode? _ctxMode;

  // audioplayers AssetSource paths are relative to the `assets/` bundle prefix.
  static String _assetRel(String p) => p.startsWith('assets/') ? p.substring(7) : p;

  /// [CALL-SPEAKER-RAMP 2026-07-12] Pin the ringback/beeps to the VOICE-CALL
  /// audio route so they play at call volume the instant the speaker is toggled,
  /// instead of ramping up from silence. The default audioplayers context is
  /// USAGE_MEDIA → STREAM_MUSIC, which — while the device is already in
  /// MODE_IN_COMMUNICATION for the WebRTC call — gets re-routed/attenuated with a
  /// gain ramp when the comm device switches. voiceCommunication usage maps to
  /// STREAM_VOICE_CALL, and `audioFocus: none` MIXES with the live call audio
  /// (no focus grab, no ducking).
  ///
  /// ─────────────────────────────────────────────────────────────────────────
  /// [CALL-ECHO-FIX-1 2026-07-14] THIS METHOD CAUSED THE ECHO. Read before
  /// touching it.
  ///
  /// `AudioPlayer.setAudioContext` is NOT player-local on Android. Verified in
  /// audioplayers 6.1.0 (the version this app pins),
  /// `WrappedPlayer.updateAudioContext`:
  ///
  ///     this.context = audioContext.copy()
  ///     // AudioManager values are set globally
  ///     audioManager.mode = context.audioMode
  ///     audioManager.isSpeakerphoneOn = context.isSpeakerphoneOn
  ///
  /// Both lines are DEVICE-WIDE. And `AudioContextAndroid`'s constructor
  /// defaults `audioMode` to `AndroidAudioMode.normal` (MODE_NORMAL), with
  /// `toJson()` always shipping it. So the previous version of this method —
  /// which simply omitted `audioMode` — silently set the whole device to
  /// MODE_NORMAL the first time any tone played, undoing the
  /// `NativeVoiceAudio.startP2pAudioMode()` (MODE_IN_COMMUNICATION) that
  /// `call_session.dart` had just established.
  ///
  /// MODE_IN_COMMUNICATION is what binds the platform AcousticEchoCanceler /
  /// NS / AGC to the VOICE_COMMUNICATION capture path. Dropping to MODE_NORMAL
  /// switches the hardware echo canceller OFF — and `stop()` only stops the
  /// player, it never restored the mode, so the device stayed in MODE_NORMAL
  /// for the REST OF THE CALL. Result: the user's own voice, played out of
  /// their earpiece, was re-captured by their mic and sent back to them.
  /// (2026-07-14 prod incident, hdavy2002@gmail.com, call avatok-622e0df2.)
  ///
  /// TWO fixes, both required:
  ///  1. `audioMode: AndroidAudioMode.inCommunication` — assert the mode we
  ///     actually want rather than letting the default assert MODE_NORMAL.
  ///     This makes the context set a NO-OP against the call's audio session
  ///     instead of a regression of it.
  ///  2. `isSpeakerphoneOn: speakerOn` — the old hardcoded `false` was ALSO
  ///     applied globally, so playing any tone force-routed a speakerphone call
  ///     back to the earpiece. The old comment ("the call's own route decides")
  ///     was simply wrong about this API. The caller now passes the live route.
  ///
  /// Re-applied whenever [speakerOn] or [mode] changes, because
  /// `updateAudioContext` early-returns on an unchanged context — so a stale
  /// `isSpeakerphoneOn` would otherwise be re-asserted on the next tone and
  /// fight the user's speaker toggle.
  ///
  /// [mode] MUST match the call's actual lifecycle stage:
  ///  · ringback / searching tone → [AndroidAudioMode.inCommunication]. The call
  ///    is live (or being set up) and the AEC must stay bound.
  ///  · busy tone → [AndroidAudioMode.normal]. The call is OVER. This is not a
  ///    detail — `_endWith` fires `playBusyTone()` and `_teardown()` (which
  ///    calls `NativeVoiceAudio.stopP2pAudioMode()` → MODE_NORMAL) BOTH
  ///    unawaited, so their order is a race. If the busy tone asserted
  ///    inCommunication it could land AFTER teardown restored normal and strand
  ///    the whole device in MODE_IN_COMMUNICATION indefinitely — breaking media
  ///    volume until some other app happened to reset it. Agreeing with
  ///    teardown makes the race harmless either way.
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
    }
  }

  /// Play the callee's ringback (looped). [value] is a bundled catalog id
  /// (preferred), or empty → bundled default, or a legacy http(s) URL.
  ///
  /// [speakerOn] MUST be the call's live route — see [_ensureCallAudioContext];
  /// this value is applied to the DEVICE, not just to this player.
  Future<void> playRingback(String value, {bool speakerOn = false}) async {
    try {
      await _ensureCallAudioContext(
          speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
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
          await _playDefaultRingback();
          return;
        }
        src = AssetSource(_assetRel(item.asset));
      }
      if (_disposed) return;
      await _p.play(src);
    } catch (e) {
      AvaLog.I.log('call', 'ringback play failed ($value): $e — using default');
      await _playDefaultRingback(speakerOn: speakerOn);
    }
  }

  Future<void> _playDefaultRingback({required bool speakerOn}) async {
    if (_disposed) return;
    try {
      await _ensureCallAudioContext(
          speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
      await _p.setReleaseMode(ReleaseMode.loop);
      await _p.play(AssetSource(_assetRel(kDefaultRingbackAsset)));
    } catch (_) { /* give up silently — a missing tone must never crash a call */ }
  }

  /// [CALL-SEARCH-TONE-1] PSTN-style call-progress beeps (looped) while the
  /// network is still locating the callee's device — played before the
  /// device-ringing receipt arrives, then replaced by [playRingback]. The
  /// single shared player means the swap is a plain play() call.
  Future<void> playSearchingTone({bool speakerOn = false}) async {
    if (_disposed) return;
    try {
      await _ensureCallAudioContext(
          speakerOn: speakerOn, mode: AndroidAudioMode.inCommunication);
      await _p.setReleaseMode(ReleaseMode.loop);
      await _p.play(AssetSource(_assetRel(kSearchingToneAsset)));
    } catch (e) {
      AvaLog.I.log('call', 'searching tone play failed: $e');
    }
  }

  /// Play the bundled busy tone a few cycles (does not loop forever).
  ///
  /// Uses [AndroidAudioMode.normal], NOT inCommunication — the call is over by
  /// the time this plays and `_teardown` is concurrently restoring MODE_NORMAL.
  /// See [_ensureCallAudioContext] for why agreeing with teardown matters.
  Future<void> playBusyTone({bool speakerOn = false}) async {
    if (_disposed) return;
    try {
      await _ensureCallAudioContext(
          speakerOn: speakerOn, mode: AndroidAudioMode.normal);
      await _p.setReleaseMode(ReleaseMode.release);
      await _p.play(AssetSource(_assetRel(kBusyToneAsset)));
    } catch (e) {
      AvaLog.I.log('call', 'busy tone play failed: $e');
    }
  }

  Future<void> stop() async {
    try { await _p.stop(); } catch (_) {}
  }

  Future<void> dispose() async {
    _disposed = true;
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
