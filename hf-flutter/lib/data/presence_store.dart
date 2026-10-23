import 'package:flutter/foundation.dart';

import 'api_exception.dart';
import 'repos/presence_repo.dart';
import 'services.dart';

/// The influencer's own Online/Offline state, shared by the bottom-bar button, the Home status card
/// and the Online/Offline screen. Optimistic: the switch moves at once and rolls back if the server says no.
///
/// [HF-CALL-MODES-E2] With call modes on it also knows her [mode] (Online / Bookings only / Offline), whether she is [onCall]
/// and how many fans wait in her queue. With the flag off those stay at their quiet defaults and nothing reads them.
class PresenceStore extends ChangeNotifier {
  PresenceStore(this._repo);

  /// Tests replace this; the app builds it lazily from [Services].
  static PresenceStore? _instance;
  static PresenceStore get instance => _instance ??= PresenceStore(PresenceRepo(Services.instance.api));
  @visibleForTesting
  static set instance(PresenceStore? s) => _instance = s;

  final PresenceRepo _repo;

  /// `online`, `busy` or `offline`.
  String presence = 'offline';

  /// `online`, `bookings_only` or `offline`. Derived from [presence] when the server sends no mode.
  String mode = 'bookings_only';
  bool onCall = false;
  int queueWaiting = 0;
  bool queuePaused = false;
  bool loaded = false;
  bool saving = false;

  /// Busy counts as online: she is on a call and fans see her as in the feed.
  bool get online => presence == 'online' || presence == 'busy';
  bool get busy => presence == 'busy';

  bool _loading = false;

  /// First read only; later calls are no-ops. Used by build methods.
  void ensureLoaded() {
    if (loaded || _loading) return;
    _loading = true;
    load().whenComplete(() => _loading = false);
  }

  void _apply(PresenceState s) {
    presence = s.presence;
    mode = s.mode;
    onCall = s.onCall;
    queueWaiting = s.queueWaiting;
    queuePaused = s.queuePaused;
  }

  /// Reads the server value. Failures keep the previous value.
  Future<void> load() async {
    try {
      _apply(await _repo.fetchState());
      loaded = true;
      notifyListeners();
    } catch (_) {
      // keep what we had; the api client already reported it
    }
  }

  /// Switches presence. Returns null on success or the plain-English reason on failure (state rolled back).
  Future<String?> setOnline(bool value) async {
    if (saving) return null;
    final before = presence;
    final beforeMode = mode;
    presence = value ? 'online' : 'offline';
    mode = value ? 'online' : 'bookings_only';
    saving = true;
    notifyListeners();
    try {
      presence = await _repo.set(online: value);
      mode = presence == 'offline' ? 'bookings_only' : 'online';
      return null;
    } on ApiException catch (e) {
      presence = before;
      mode = beforeMode;
      return e.userMessage;
    } catch (_) {
      presence = before;
      mode = beforeMode;
      return ApiException.genericText;
    } finally {
      saving = false;
      notifyListeners();
    }
  }

  /// [HF-CALL-MODES-E2] Picks Online / Bookings only / Offline. Same contract as [setOnline]: null on success, else the reason
  /// (state rolled back). Leaving Online closes the queue on the server, so the waiting count is cleared at once.
  Future<String?> setMode(String value) async {
    if (saving || !kHostModes.contains(value)) return null;
    final beforePresence = presence;
    final beforeMode = mode;
    final beforeWaiting = queueWaiting;
    mode = value;
    presence = onCall ? 'busy' : (value == 'online' ? 'online' : 'offline');
    if (value != 'online') queueWaiting = 0;
    saving = true;
    notifyListeners();
    try {
      _apply(await _repo.setMode(value));
      return null;
    } on ApiException catch (e) {
      presence = beforePresence;
      mode = beforeMode;
      queueWaiting = beforeWaiting;
      return e.userMessage;
    } catch (_) {
      presence = beforePresence;
      mode = beforeMode;
      queueWaiting = beforeWaiting;
      return ApiException.genericText;
    } finally {
      saving = false;
      notifyListeners();
    }
  }

  /// Keeps the Home / settings count in step with what the queue screens just read.
  void noteQueue({required int waiting, required bool paused}) {
    if (queueWaiting == waiting && queuePaused == paused) return;
    queueWaiting = waiting;
    queuePaused = paused;
    notifyListeners();
  }
}
