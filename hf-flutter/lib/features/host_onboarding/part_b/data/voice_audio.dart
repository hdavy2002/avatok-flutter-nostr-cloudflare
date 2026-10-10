import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/auth/session.dart';
import '../../../../core/env.dart';

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/// A finished recording. The bytes are in memory (5 minutes of 64 kbit/s AAC is about 2.4 MB, well under the
/// worker's 15 MB limit); [path] is the temp file, kept so the host can listen to it before saving.
class VoiceClip {
  const VoiceClip({required this.bytes, required this.path, required this.mime, required this.seconds});

  final Uint8List bytes;
  final String path;

  /// One of the worker's accepted types. AAC in an MP4 container: `audio/mp4`.
  final String mime;

  /// Measured on the phone, rounded to whole seconds.
  final int seconds;

  VoiceClip withSeconds(int s) => VoiceClip(bytes: bytes, path: path, mime: mime, seconds: s);
}

/// Why the microphone could not be used. [code]: `denied` (permission) or `failed`.
class VoiceRecorderException implements Exception {
  const VoiceRecorderException(this.code, [this.detail]);

  final String code;
  final String? detail;

  bool get isDenied => code == 'denied';

  @override
  String toString() => 'VoiceRecorderException($code${detail == null ? '' : ': $detail'})';
}

/// The microphone, behind a small interface so widget tests use a fake (`FakeVoiceRecorder`).
/// One instance records one clip: [start], then [stop] (or [cancel]), then [dispose].
abstract class VoiceRecorder {
  /// Starts recording AAC to a temp file. Throws [VoiceRecorderException].
  Future<void> start();

  /// Loudness from 0 to 1, a few times a second while recording (for the level meter).
  Stream<double> get levels;

  /// Stops and returns the whole clip. Throws [VoiceRecorderException].
  Future<VoiceClip> stop();

  /// Stops and throws the clip away.
  Future<void> cancel();

  Future<void> dispose();
}

typedef VoiceRecorderFactory = VoiceRecorder Function();

/// Tests override this with a factory that returns a fake.
final voiceRecorderFactoryProvider = Provider<VoiceRecorderFactory>((ref) => PackageVoiceRecorder.new);

/// The real recorder, on the `record` package (AAC-LC, mono, 64 kbit/s: clear speech, small file).
class PackageVoiceRecorder implements VoiceRecorder {
  final AudioRecorder _rec = AudioRecorder();
  final StreamController<double> _levels = StreamController<double>.broadcast();
  final Stopwatch _clock = Stopwatch();
  StreamSubscription<Amplitude>? _amp;
  String? _path;

  @override
  Stream<double> get levels => _levels.stream;

  @override
  Future<void> start() async {
    try {
      if (!await _rec.hasPermission()) throw const VoiceRecorderException('denied');
      final dir = await Directory.systemTemp.createTemp('hf_voice');
      final path = '${dir.path}/intro.m4a';
      _path = path;
      await _rec.start(
        const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, sampleRate: 44100, numChannels: 1),
        path: path,
      );
      _clock
        ..reset()
        ..start();
      _amp = _rec.onAmplitudeChanged(const Duration(milliseconds: 200)).listen((a) {
        // -60 dB (quiet room) to 0 dB (very loud) mapped to 0..1.
        final level = ((a.current + 60) / 60).clamp(0.0, 1.0).toDouble();
        if (!_levels.isClosed) _levels.add(level);
      });
    } on VoiceRecorderException {
      rethrow;
    } catch (e) {
      throw VoiceRecorderException('failed', '$e');
    }
  }

  @override
  Future<VoiceClip> stop() async {
    try {
      _clock.stop();
      await _amp?.cancel();
      _amp = null;
      final out = await _rec.stop();
      final path = out ?? _path;
      if (path == null) throw const VoiceRecorderException('failed', 'no file');
      final bytes = await File(path).readAsBytes();
      return VoiceClip(bytes: bytes, path: path, mime: 'audio/mp4', seconds: (_clock.elapsedMilliseconds / 1000).round());
    } on VoiceRecorderException {
      rethrow;
    } catch (e) {
      throw VoiceRecorderException('failed', '$e');
    }
  }

  @override
  Future<void> cancel() async {
    try {
      _clock.stop();
      await _amp?.cancel();
      _amp = null;
      await _rec.cancel();
    } catch (_) {
      // already stopped
    }
  }

  @override
  Future<void> dispose() async {
    try {
      await _amp?.cancel();
      await _rec.dispose();
    } catch (_) {
      // already released
    }
    await _levels.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

enum ClipPlayerState { playing, paused, stopped, completed }

/// The little audio surface the voice step needs, for a file on the phone. Screens depend on this, never on
/// `audioplayers`, so widget tests swap in a fake and never touch a platform channel.
abstract interface class ClipPlayer {
  Stream<ClipPlayerState> get states;
  Stream<Duration> get positions;
  Stream<Duration> get durations;
  Future<void> playFile(String path);
  Future<void> resume();
  Future<void> pause();
  Future<void> seek(Duration to);
  Future<void> dispose();
}

class AudioplayersClipPlayer implements ClipPlayer {
  AudioplayersClipPlayer() : _player = AudioPlayer();

  final AudioPlayer _player;

  @override
  Stream<ClipPlayerState> get states => _player.onPlayerStateChanged.map((s) {
        switch (s) {
          case PlayerState.playing:
            return ClipPlayerState.playing;
          case PlayerState.paused:
            return ClipPlayerState.paused;
          case PlayerState.completed:
            return ClipPlayerState.completed;
          case PlayerState.stopped:
          case PlayerState.disposed:
            return ClipPlayerState.stopped;
        }
      });

  @override
  Stream<Duration> get positions => _player.onPositionChanged;

  @override
  Stream<Duration> get durations => _player.onDurationChanged;

  @override
  Future<void> playFile(String path) => _player.play(DeviceFileSource(path));

  @override
  Future<void> resume() => _player.resume();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration to) => _player.seek(to);

  @override
  Future<void> dispose() => _player.dispose();
}

/// Makes one player per playback widget, on its first tap. Tests override this with a fake.
final clipPlayerFactoryProvider = Provider<ClipPlayer Function()>((ref) => AudioplayersClipPlayer.new);

// ---------------------------------------------------------------------------------------------
// The host's own saved introduction
// ---------------------------------------------------------------------------------------------

/// `GET /api/hosts/me/voice` answers the audio bytes and needs the sign-in token, so a player cannot open it
/// as a plain URL. This downloads it to a temp file once and returns the path (null when there is none).
abstract class OwnVoiceFetcher {
  const OwnVoiceFetcher();

  Future<String?> fetchToFile();
}

class HttpOwnVoiceFetcher extends OwnVoiceFetcher {
  const HttpOwnVoiceFetcher(this._tokens);

  final AuthTokens _tokens;

  @override
  Future<String?> fetchToFile() async {
    try {
      final token = await _tokens.sessionToken();
      final res = await http
          .get(
            Uri.parse('${Env.apiOrigin}/api/hosts/me/voice'),
            headers: <String, String>{if (token != null) 'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 60));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) return null;
      final dir = await Directory.systemTemp.createTemp('hf_voice_saved');
      final file = File('${dir.path}/saved-intro');
      await file.writeAsBytes(res.bodyBytes);
      return file.path;
    } catch (_) {
      return null;
    }
  }
}

final ownVoiceFetcherProvider = Provider<OwnVoiceFetcher>((ref) => HttpOwnVoiceFetcher(ref.watch(clerkProvider)));
