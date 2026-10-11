import 'dart:async';

import '../explore/widgets/intro_player.dart' show IntroAudio;
import '../host_profile/data/intro_player.dart';
import 'demo_data.dart';

/// The pretend clip: counts up to [seconds] on a timer and then reports "completed". No sound.
class _FakeClip {
  _FakeClip({required this.seconds});

  final int seconds;
  Timer? _timer;
  Duration position = Duration.zero;

  void start(void Function(Duration) onTick, void Function() onDone) {
    _timer?.cancel();
    // Counted in ticks, not by a clock, so a test that pumps fake time sees the same thing as a phone.
    _timer = Timer.periodic(const Duration(milliseconds: 250), (t) {
      position += const Duration(milliseconds: 250);
      if (position >= Duration(seconds: seconds)) {
        t.cancel();
        position = Duration.zero;
        onDone();
      } else {
        onTick(position);
      }
    });
  }

  void pause() => _timer?.cancel();

  void stop() {
    _timer?.cancel();
    position = Duration.zero;
  }
}

/// The Discover-card speaker: plays `demo://` clips as a 20 s silent timer, hands everything else to [real].
class DemoAwareIntroAudio implements IntroAudio {
  DemoAwareIntroAudio(this.real);

  final IntroAudio real;
  final StreamController<void> _done = StreamController<void>.broadcast();
  StreamSubscription<void>? _sub;
  final _FakeClip _clip = _FakeClip(seconds: 20);
  bool _demoActive = false;

  @override
  Future<void> play(String url) async {
    if (!isDemoAudioUrl(url)) {
      _demoActive = false;
      _clip.stop();
      return real.play(url);
    }
    await real.stop();
    _demoActive = true;
    _clip.position = Duration.zero;
    _clip.start((_) {}, () {
      _demoActive = false;
      if (!_done.isClosed) _done.add(null);
    });
  }

  @override
  Future<void> pause() async {
    if (_demoActive) {
      _clip.stop();
      _demoActive = false;
      return;
    }
    return real.pause();
  }

  @override
  Future<void> stop() async {
    _clip.stop();
    _demoActive = false;
    return real.stop();
  }

  @override
  Stream<void> get onComplete {
    _sub ??= real.onComplete.listen((_) {
      if (!_done.isClosed) _done.add(null);
    });
    return _done.stream;
  }

  @override
  void dispose() {
    _clip.stop();
    unawaited(_sub?.cancel());
    real.dispose();
    unawaited(_done.close());
  }
}

/// The profile's voice player: `demo://` clips run as a silent timer (position, length, completed), the rest
/// goes to the real player, which is only created on the first non-demo play.
class DemoAwareIntroPlayer implements IntroPlayer {
  DemoAwareIntroPlayer(this._makeReal);

  final IntroPlayer Function() _makeReal;
  IntroPlayer? _real;
  bool _demo = false;
  final _FakeClip _clip = _FakeClip(seconds: 20);
  final StreamController<IntroPlayerState> _states =
      StreamController<IntroPlayerState>.broadcast();
  final StreamController<Duration> _positions =
      StreamController<Duration>.broadcast();
  final StreamController<Duration> _durations =
      StreamController<Duration>.broadcast();

  IntroPlayer get _r => _real ??= _makeReal();
  bool _wired = false;

  void _wire() {
    if (_wired) return;
    _wired = true;
    final r = _r;
    r.states.listen((s) => _states.add(s));
    r.positions.listen((d) => _positions.add(d));
    r.durations.listen((d) => _durations.add(d));
  }

  void _runClip() {
    _states.add(IntroPlayerState.playing);
    _clip.start(_positions.add, () {
      _states.add(IntroPlayerState.completed);
    });
  }

  @override
  Stream<IntroPlayerState> get states => _states.stream;

  @override
  Stream<Duration> get positions => _positions.stream;

  @override
  Stream<Duration> get durations => _durations.stream;

  @override
  Future<void> play(String url) async {
    if (isDemoAudioUrl(url)) {
      _demo = true;
      _clip.position = Duration.zero;
      _durations.add(const Duration(seconds: 20));
      _runClip();
      return;
    }
    _demo = false;
    _wire();
    return _r.play(url);
  }

  @override
  Future<void> resume() async {
    if (_demo) {
      _runClip();
      return;
    }
    return _r.resume();
  }

  @override
  Future<void> pause() async {
    if (_demo) {
      _clip.pause();
      _states.add(IntroPlayerState.paused);
      return;
    }
    return _r.pause();
  }

  @override
  Future<void> seek(Duration to) async {
    if (_demo) return;
    return _r.seek(to);
  }

  @override
  Future<void> dispose() async {
    _clip.stop();
    await _real?.dispose();
    await _states.close();
    await _positions.close();
    await _durations.close();
  }
}
