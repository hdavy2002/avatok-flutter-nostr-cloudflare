import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';

/// Per-account on/off + ORDER state for the Home dashboard cards (plan §3). Stored
/// under a scopedKey so a parent + child sharing one phone keep independent card
/// layouts (rulebook rule 1 — per-account scoping is mandatory).
///
/// Phase 3 (this file): the fixed v1 set (wallet/calllogs/messages) grows to the
/// full card set (adds analytics/earnings/visitors/listings) AND gains a
/// user-chosen ORDER, persisted here and edited via drag-reorder in the Cards
/// manager. Persisted shape is `{"visible": {...}, "order": [...]}` under a v2 key;
/// a v1-only install (visibility map, no order) is read once and migrated.
class HomeCardPrefs {
  HomeCardPrefs._();

  static const _keyV2 = 'shellv2_home_cards_v2';
  static const _keyV1 = 'shellv2_home_cards_v1'; // legacy (visibility only)
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// All card ids in their DEFAULT render order (plan §3). A stored order overrides
  /// this; any id present here but missing from a stored order is appended (so a
  /// new card added in a future build still shows up for existing users).
  static const List<String> ids = [
    'messages',
    'analytics',
    'calllogs',
    'wallet',
    'earnings',
    'visitors',
    'listings',
  ];

  static const Map<String, String> labels = {
    'wallet': 'Wallet',
    'calllogs': 'Call logs',
    'messages': 'Messages',
    'analytics': 'Analytics',
    'earnings': 'Earnings',
    'visitors': 'Visitors',
    'listings': 'Listings',
  };

  static const Map<String, String> subtitles = {
    'wallet': 'Your balance at a glance',
    'calllogs': 'Your most recent calls',
    'messages': 'Latest unread messages',
    'analytics': 'Calls & messages today',
    'earnings': 'Today, this week, this month',
    'visitors': 'Who is viewing your listings',
    'listings': 'Your top-performing listings',
  };

  /// Bumps whenever a card is toggled/reordered so an open Home dashboard repaints
  /// live.
  static final ValueNotifier<int> revision = ValueNotifier(0);

  static Map<String, bool> _defaultVisible() => {for (final id in ids) id: true};

  /// Read the raw persisted state (v2), migrating a legacy v1 visibility map.
  static Future<({Map<String, bool> visible, List<String> order})> _read() async {
    final visible = _defaultVisible();
    List<String> order = List<String>.from(ids);
    try {
      final raw = await readScoped(_ss, _keyV2);
      if (raw != null && raw.isNotEmpty) {
        final m = jsonDecode(raw);
        if (m is Map) {
          final v = m['visible'];
          if (v is Map) {
            for (final id in ids) {
              if (v[id] is bool) visible[id] = v[id] as bool;
            }
          }
          final o = m['order'];
          if (o is List) {
            order = [
              for (final e in o)
                if (e is String && ids.contains(e)) e,
            ];
            // Append any ids missing from the stored order (new cards).
            for (final id in ids) {
              if (!order.contains(id)) order.add(id);
            }
          }
        }
        return (visible: visible, order: order);
      }
      // Migrate a legacy v1 (visibility-only) map, if present.
      final v1 = await readScoped(_ss, _keyV1);
      if (v1 != null && v1.isNotEmpty) {
        final m = jsonDecode(v1);
        if (m is Map) {
          for (final id in ids) {
            if (m[id] is bool) visible[id] = m[id] as bool;
          }
        }
      }
    } catch (_) {/* first run / corrupt → all on, default order */}
    return (visible: visible, order: order);
  }

  static Future<void> _write(Map<String, bool> visible, List<String> order) async {
    try {
      await _ss.write(
        key: scopedKey(_keyV2),
        value: jsonEncode({'visible': visible, 'order': order}),
      );
    } catch (_) {/* best-effort */}
    revision.value++;
  }

  /// Current visibility map (defaults every card ON). Never throws.
  static Future<Map<String, bool>> load() async => (await _read()).visible;

  /// Current render order (defaults to [ids]). Never throws.
  static Future<List<String>> order() async => (await _read()).order;

  /// Toggle a single card and persist (account-scoped). Bumps [revision].
  static Future<void> setVisible(String id, bool visible) async {
    final cur = await _read();
    final v = {...cur.visible, id: visible};
    await _write(v, cur.order);
  }

  /// Persist a new render order (account-scoped). Bumps [revision].
  static Future<void> setOrder(List<String> newOrder) async {
    final cur = await _read();
    // Keep only known ids (deduped, first occurrence wins), then append any
    // missing so a card is never dropped.
    final order = <String>[];
    for (final id in newOrder) {
      if (ids.contains(id) && !order.contains(id)) order.add(id);
    }
    for (final id in ids) {
      if (!order.contains(id)) order.add(id);
    }
    await _write(cur.visible, order);
  }
}
