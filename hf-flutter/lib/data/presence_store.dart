import 'package:flutter/foundation.dart';

import 'api_exception.dart';
import 'repos/presence_repo.dart';
import 'services.dart';

/// The influencer's own Online/Offline state, shared by the bottom-bar button, the Home status card
/// and the Online/Offline screen. Optimistic: the switch moves at once and rolls back if the server says no.
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

  /// Reads the server value. Failures keep the previous value.
  Future<void> load() async {
    try {
      presence = await _repo.fetch();
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
    presence = value ? 'online' : 'offline';
    saving = true;
    notifyListeners();
    try {
      presence = await _repo.set(online: value);
      return null;
    } on ApiException catch (e) {
      presence = before;
      return e.userMessage;
    } catch (_) {
      presence = before;
      return ApiException.genericText;
    } finally {
      saving = false;
      notifyListeners();
    }
  }
}
