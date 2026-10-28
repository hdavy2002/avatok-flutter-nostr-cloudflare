import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'repos/call_safety_repo.dart';
import 'services.dart';

/// [HF-CALL-SAFETY-APP] "Don't show this again" on the fan's pre-call safety notice. Kept on the phone, per account, so another
/// person who logs in on the same phone still sees it once.
abstract final class FanNoticePref {
  static const String _base = 'hf_call_notice_hidden_v1';

  static String _key(String uid) => '$_base.${Uri.encodeComponent(uid)}';

  static Future<bool> hidden(String? uid) async {
    if (uid == null || uid.isEmpty) return false;
    try {
      final p = await SharedPreferences.getInstance();
      return p.getBool(_key(uid)) ?? false;
    } catch (_) {
      return false; // storage unavailable: show the notice
    }
  }

  static Future<void> setHidden(String? uid, bool value) async {
    if (uid == null || uid.isEmpty) return;
    try {
      final p = await SharedPreferences.getInstance();
      if (value) {
        await p.setBool(_key(uid), true);
      } else {
        await p.remove(_key(uid));
      }
    } catch (_) {
      // best effort
    }
  }
}

/// [HF-CALL-SAFETY-APP] The signed-in person's last `GET /api/hf/safety/me`, shared by the Me tab rows and the screens behind them.
/// Per account: a different account never sees the previous one's strikes.
class CallSafetyStore extends ChangeNotifier {
  CallSafetyStore._();

  static final CallSafetyStore instance = CallSafetyStore._();

  /// Tests replace the repo; the app builds it from [Services].
  @visibleForTesting
  CallSafetyRepo? repoOverride;

  CallSafetyRepo get _repo => repoOverride ?? Services.instance.callSafetyRepo;

  SafetyMe? me;
  Object? error;
  bool loading = false;
  String? _uid;

  /// Reads the server value. A failure keeps the previous value of the SAME account and sets [error].
  Future<SafetyMe?> load() async {
    final uid = Services.instance.user?.id;
    if (_uid != uid) {
      me = null;
      error = null;
      _uid = uid;
    }
    if (uid == null) {
      notifyListeners();
      return null;
    }
    loading = true;
    notifyListeners();
    SafetyMe? result;
    try {
      final m = await _repo.me();
      if (uid == Services.instance.user?.id) {
        me = m;
        error = null;
        result = m;
      }
    } catch (e) {
      if (uid == _uid) error = e;
    }
    loading = false;
    notifyListeners();
    return result;
  }

  /// A screen that just read `GET /api/hf/safety/me` itself hands the answer over, so the Me tab rows agree with it.
  void accept(SafetyMe m) {
    final uid = Services.instance.user?.id;
    if (uid == null) return;
    _uid = uid;
    me = m;
    error = null;
    notifyListeners();
  }

  void clear() {
    me = null;
    error = null;
    _uid = null;
    notifyListeners();
  }
}
