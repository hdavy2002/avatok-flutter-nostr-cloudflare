import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';

/// AvaUnread (Ava Copilot Phase A — plan §6).
///
/// A tiny per-conversation `ava_unread` counter: how many PRIVATE Ava-lane
/// messages (Moments, doc results, Guardian notes) arrived in a conv since the
/// user last opened it. Kept SEPARATE from the normal unread badge so Ava never
/// inflates the human count.
///
/// Storage is MANDATORY per-account (`scopedKey`/`readScoped`,
/// app/lib/core/account_storage.dart) — a parent and child sharing one phone
/// keep separate counters by construction. Values are best-effort UI state:
/// every failure degrades to 0, never throws into the caller.
class AvaUnread {
  AvaUnread._();

  static const String _base = 'ava_unread';
  static const FlutterSecureStorage _s = FlutterSecureStorage();

  /// Bumped after every mutation so list rows can repaint their badge without
  /// a poll (`AvaUnread.revision` in a ListenableBuilder).
  static final ValueNotifier<int> revision = ValueNotifier<int>(0);

  static String _key(String convKey) => '${_base}_$convKey';

  /// The current counter for [convKey] ('1:<peerUid>' / 'g:<gid>'), 0 when unset.
  static Future<int> count(String convKey) async {
    try {
      final v = await readScoped(_s, _key(convKey));
      return int.tryParse(v ?? '') ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// +1 for a private Ava-lane arrival in [convKey]. Returns the new count.
  static Future<int> increment(String convKey) async {
    final next = await count(convKey) + 1;
    try {
      await _s.write(key: scopedKey(_key(convKey)), value: '$next');
    } catch (_) {/* best-effort UI state */}
    revision.value++;
    return next;
  }

  /// Reset on thread open (the user has now seen the lane).
  static Future<void> clear(String convKey) async {
    try {
      await _s.delete(key: scopedKey(_key(convKey)));
    } catch (_) {/* best-effort UI state */}
    revision.value++;
  }
}
