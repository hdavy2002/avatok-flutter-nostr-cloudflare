import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../shell_v2.dart';

/// Per-account ORDER of the persistent app-switcher roots (AvaTOK · Calls ·
/// Marketplace), plus a one-time "hold to rearrange" hint flag (AVA-SHELL-8).
///
/// Why per-account (rulebook rule 1 — per-account scoping is MANDATORY): one phone
/// is routinely shared by a parent + each child, so every user keeps their own
/// preferred app order. Stored under a [scopedKey] via [readScoped], mirroring
/// [HomeCardPrefs].
///
/// The FIRST root in this order is the LANDING app on cold open (see
/// [ShellV2] / `_initRootState`). The "Ava" action in the footer is a global
/// action, never a root, so it is neither ordered nor persisted here.
///
/// 2026-07-12 nav rebrand: the Home root was retired, so AvaTalk (AvaTOK) is now
/// always the default landing app; `defaultOrder` dropped `RootId.home`.
class RootOrderPrefs {
  RootOrderPrefs._();

  // [PIVOT-MKT-LANDING-1] Bumped v1 -> v2: the default order below changed
  // (Marketplace now leads), and a stored v1 order must NOT silently carry
  // forward — otherwise every existing user keeps their old AvaTalk-first
  // order and never sees Marketplace as the landing screen. `load()` falls
  // back to `defaultOrder` for anyone with no v2 value yet, which is exactly
  // everyone pre-pivot.
  static const _key = 'shellv2_root_order_v2';
  static const _hintKey = 'shellv2_root_reorder_hint_seen_v1';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Default order ([PIVOT-MKT-LANDING-1] owner decision 2026-08-27 —
  /// marketplace-first pivot): Services (Marketplace) now leads, then AvaTalk
  /// (AvaTOK), then AvaDial (Calls). Marketplace is the default landing app but
  /// need NOT stay first — a user can drag any root to the front.
  static const List<RootId> defaultOrder = [
    RootId.services,
    RootId.avaTalk,
    RootId.avaDial,
  ];

  /// Bumps whenever the order changes so any listening surface repaints.
  static final ValueNotifier<int> revision = ValueNotifier(0);

  /// Current order (defaults to [defaultOrder]). Sanitizes unknown/duplicate keys
  /// and appends any root missing from a stored order (future-proof if a 5th root
  /// is ever added). Never throws.
  static Future<List<RootId>> load() async {
    try {
      final raw = await readScoped(_ss, _key);
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          final order = <RootId>[];
          for (final e in decoded) {
            if (e is String) {
              final match = RootId.values.where((r) => r.key == e);
              if (match.isNotEmpty && !order.contains(match.first)) {
                order.add(match.first);
              }
            }
          }
          for (final r in defaultOrder) {
            if (!order.contains(r)) order.add(r);
          }
          if (order.isNotEmpty) return order;
        }
      }
    } catch (_) {/* first run / corrupt → default order */}
    return List<RootId>.from(defaultOrder);
  }

  /// Persist a new order (account-scoped). Deduped, unknown roots dropped, missing
  /// roots appended so a root can never be lost. Bumps [revision]. Best-effort.
  static Future<void> save(List<RootId> order) async {
    final clean = <RootId>[];
    for (final r in order) {
      if (!clean.contains(r)) clean.add(r);
    }
    for (final r in defaultOrder) {
      if (!clean.contains(r)) clean.add(r);
    }
    try {
      await _ss.write(
        key: scopedKey(_key),
        value: jsonEncode([for (final r in clean) r.key]),
      );
    } catch (_) {/* best-effort */}
    revision.value++;
  }

  /// Reset to [defaultOrder] (account-scoped). Bumps [revision].
  static Future<void> reset() => save(List<RootId>.from(defaultOrder));

  /// Whether the one-time reorder hint has already been shown to this account.
  static Future<bool> hintSeen() async {
    try {
      final v = await readScoped(_ss, _hintKey);
      return v == '1';
    } catch (_) {
      return false;
    }
  }

  /// Mark the one-time reorder hint as shown for this account. Best-effort.
  static Future<void> markHintSeen() async {
    try {
      await _ss.write(key: scopedKey(_hintKey), value: '1');
    } catch (_) {/* best-effort */}
  }
}
