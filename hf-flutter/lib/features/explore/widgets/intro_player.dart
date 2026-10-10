import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';

/// The one speaker for host voice intros. An interface, so widget tests swap in a fake with no platform channel.
abstract class IntroAudio {
  /// Starts [url] from the beginning (stopping whatever played before).
  Future<void> play(String url);
  Future<void> pause();
  Future<void> stop();

  /// Fires when the clip plays to its end.
  Stream<void> get onComplete;
  void dispose();
}

/// `audioplayers`, created on the first tap (never at start-up, so a cold start pays nothing).
class AudioplayersIntroAudio implements IntroAudio {
  AudioPlayer? _player;
  final StreamController<void> _done = StreamController<void>.broadcast();
  StreamSubscription<void>? _sub;

  AudioPlayer _ensure() {
    final existing = _player;
    if (existing != null) return existing;
    final p = AudioPlayer();
    _sub = p.onPlayerComplete.listen((_) => _done.add(null));
    return _player = p;
  }

  @override
  Future<void> play(String url) async {
    final p = _ensure();
    await p.stop();
    await p.play(UrlSource(url));
  }

  @override
  Future<void> pause() async => _player?.pause();

  @override
  Future<void> stop() async => _player?.stop();

  @override
  Stream<void> get onComplete => _done.stream;

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    unawaited(_player?.dispose());
    unawaited(_done.close());
  }
}

final introAudioProvider = Provider<IntroAudio>((ref) {
  final audio = AudioplayersIntroAudio();
  ref.onDispose(audio.dispose);
  return audio;
});

/// Which host's intro is playing (its slug), or null. Only one plays at a time: starting another stops the first.
class IntroPlayerState {
  const IntroPlayerState({this.playingSlug, this.failedSlug});

  final String? playingSlug;

  /// The last intro that could not play (the card shows a short note).
  final String? failedSlug;

  bool isPlaying(String slug) => playingSlug == slug;
}

final introPlayerProvider = NotifierProvider<IntroPlayerController, IntroPlayerState>(IntroPlayerController.new);

class IntroPlayerController extends Notifier<IntroPlayerState> {
  StreamSubscription<void>? _sub;

  @override
  IntroPlayerState build() {
    ref.onDispose(() => unawaited(_sub?.cancel()));
    return const IntroPlayerState();
  }

  IntroAudio get _audio => ref.read(introAudioProvider);

  /// Tap on a card's play button: play it, or pause it when it is already playing. [from] is where the
  /// card sits (`explore`, `home`, `profile`), for telemetry.
  Future<void> toggle({required String slug, required String url, required String from}) async {
    if (state.isPlaying(slug)) {
      state = const IntroPlayerState();
      try {
        await _audio.pause();
      } catch (_) {
        // nothing to pause
      }
      return;
    }
    _sub ??= _audio.onComplete.listen((_) => state = const IntroPlayerState());
    // Claim the speaker first, so the previous card's button flips back at once.
    state = IntroPlayerState(playingSlug: slug);
    try {
      await _audio.play(url);
      Analytics.capture('hf_app_intro_played', <String, Object>{'slug': slug, 'from': from});
    } catch (e, st) {
      if (state.playingSlug == slug) state = IntroPlayerState(failedSlug: slug);
      Analytics.captureException(e, st, screen: from, handled: true, extra: {'where': 'intro_play'});
    }
  }

  /// Stops whatever plays (leaving the screen, opening a profile).
  Future<void> stop() async {
    if (state.playingSlug == null) return;
    state = const IntroPlayerState();
    try {
      await _audio.stop();
    } catch (_) {
      // already stopped
    }
  }
}
