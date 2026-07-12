import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';

/// Per-account on/off state for the Home dashboard cards (plan §3). Stored under
/// a scopedKey so a parent + child sharing one phone keep independent card
/// layouts (rulebook rule 1 — per-account scoping is mandatory). v1 ships a
/// FIXED set + order (plan §9 item 5); drag-reorder + more cards land in Phase 3.
class HomeCardPrefs {
  HomeCardPrefs._();

  static const _key = 'shellv2_home_cards_v1';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Fixed card ids, in render order.
  static const List<String> ids = ['wallet', 'calllogs', 'messages'];

  static const Map<String, String> labels = {
    'wallet': 'Wallet',
    'calllogs': 'Call logs',
    'messages': 'Messages',
  };

  static const Map<String, String> subtitles = {
    'wallet': 'Your balance at a glance',
    'calllogs': 'Your most recent calls',
    'messages': 'Latest unread messages',
  };

  /// Bumps whenever a card is toggled so an open Home dashboard repaints live.
  static final ValueNotifier<int> revision = ValueNotifier(0);

  /// Current visibility map (defaults every card ON). Never throws.
  static Future<Map<String, bool>> load() async {
    final out = {for (final id in ids) id: true};
    try {
      final raw = await readScoped(_ss, _key);
      if (raw != null && raw.isNotEmpty) {
        final m = jsonDecode(raw);
        if (m is Map) {
          for (final id in ids) {
            if (m[id] is bool) out[id] = m[id] as bool;
          }
        }
      }
    } catch (_) {/* first run / corrupt → all on */}
    return out;
  }

  /// Toggle a single card and persist (account-scoped). Bumps [revision].
  static Future<void> setVisible(String id, bool visible) async {
    final cur = await load();
    cur[id] = visible;
    try {
      await _ss.write(key: scopedKey(_key), value: jsonEncode(cur));
    } catch (_) {/* best-effort */}
    revision.value++;
  }
}
