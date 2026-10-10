import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum IntroPlayerState { playing, paused, stopped, completed }

/// The little audio surface the voice intro needs. Screens depend on this, never on `audioplayers`,
/// so widget tests swap in a fake and never touch a platform channel.
abstract interface class IntroPlayer {
  Stream<IntroPlayerState> get states;
  Stream<Duration> get positions;
  Stream<Duration> get durations;

  /// Start playing [url] from the beginning.
  Future<void> play(String url);

  /// Continue after [pause].
  Future<void> resume();
  Future<void> pause();
  Future<void> seek(Duration to);
  Future<void> dispose();
}

class AudioplayersIntroPlayer implements IntroPlayer {
  AudioplayersIntroPlayer() : _player = AudioPlayer();

  final AudioPlayer _player;

  @override
  Stream<IntroPlayerState> get states => _player.onPlayerStateChanged.map((s) {
        switch (s) {
          case PlayerState.playing:
            return IntroPlayerState.playing;
          case PlayerState.paused:
            return IntroPlayerState.paused;
          case PlayerState.completed:
            return IntroPlayerState.completed;
          case PlayerState.stopped:
          case PlayerState.disposed:
            return IntroPlayerState.stopped;
        }
      });

  @override
  Stream<Duration> get positions => _player.onPositionChanged;

  @override
  Stream<Duration> get durations => _player.onDurationChanged;

  @override
  Future<void> play(String url) => _player.play(UrlSource(url));

  @override
  Future<void> resume() => _player.resume();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration to) => _player.seek(to);

  @override
  Future<void> dispose() => _player.dispose();
}

/// Makes one player per voice-intro widget, on its first tap. Tests override this with a fake.
final introPlayerFactoryProvider = Provider<IntroPlayer Function()>((ref) => AudioplayersIntroPlayer.new);
