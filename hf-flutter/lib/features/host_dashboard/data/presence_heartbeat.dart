import 'dart:async';

/// Keeps an online host online. The worker marks a host offline after 8 hours without a beat
/// (`PRESENCE_TTL_MS`), so the app sends `POST /api/hosts/me/presence/beat` every 5 minutes, but ONLY
/// while the host is online AND the app is in the foreground. In the background nothing runs (no
/// background service, no battery drain); coming back to the foreground sends one beat at once.
///
/// Pure Dart: the screen feeds it `setOnline` and `setForeground`; tests drive it with a fake clock.
class PresenceHeartbeat {
  PresenceHeartbeat({required this.beat, this.interval = const Duration(minutes: 5)});

  /// Sends one beat. Must not throw (the screen wraps the API call).
  final void Function() beat;
  final Duration interval;

  bool _online = false;
  bool _foreground = true;
  Timer? _timer;

  bool get running => _timer != null;
  bool get online => _online;
  bool get foreground => _foreground;

  /// The host went online or offline. [beatNow]: also send a beat at once when this starts the timer
  /// (used when the dashboard opens and finds the host already online; a fresh toggle needs none, the
  /// server just stamped the time).
  void setOnline(bool value, {bool beatNow = false}) {
    _online = value;
    _sync(beatNow: beatNow);
  }

  /// The app moved to the foreground or background. Returning to the foreground beats once at once.
  void setForeground(bool value) {
    final was = _foreground;
    _foreground = value;
    _sync(beatNow: value && !was);
  }

  void _sync({required bool beatNow}) {
    final active = _online && _foreground;
    if (!active) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    if (_timer == null) {
      _timer = Timer.periodic(interval, (_) => beat());
      if (beatNow) beat();
    } else if (beatNow) {
      beat();
    }
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}
