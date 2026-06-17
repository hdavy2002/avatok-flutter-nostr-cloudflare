import 'package:flutter/foundation.dart';

import '../core/disk_cache.dart';
import '../core/feature_flags.dart';

/// Menu "focus mode" state (Phase 1 — Ava in-chat). When ON, the sidebar shows
/// AvaTOK + account essentials only (see `AppRegistry.focusMode`); when OFF it
/// behaves exactly as before (`AppRegistry.standard`).
///
/// The on/off bool is per-account (parent + each child share a phone) and stored
/// via [DiskCache] — non-secret, so plain on-disk cache is correct (not secure
/// storage). It is account-scoped automatically because DiskCache writes under
/// `cache/<AccountScope.id>/`.
///
/// Exposes a [ValueListenable] so the sidebar can rebuild the instant the
/// Settings toggle flips. Default is [kFocusModeDefault] (Phase 0 contract).
class FocusMode {
  FocusMode._();

  static const _kKey = 'focus_mode';

  /// Live value the sidebar listens to. Seeded with the compile-time default
  /// until [load] resolves the persisted per-account value.
  static final ValueNotifier<bool> enabled =
      ValueNotifier<bool>(kFocusModeDefault);

  static bool _loaded = false;

  /// Read the persisted value for the current account into [enabled]. Cheap to
  /// call repeatedly (e.g. on every sidebar open) — it re-reads so an account
  /// switch is reflected. Never throws.
  static Future<bool> load() async {
    final raw = await DiskCache.read(_kKey);
    final v = raw == null || raw.isEmpty ? kFocusModeDefault : raw == '1';
    _loaded = true;
    if (enabled.value != v) enabled.value = v;
    return v;
  }

  /// Whether [load] has resolved at least once this session.
  static bool get isLoaded => _loaded;

  /// Flip focus mode and persist it for the current account. Updates [enabled]
  /// synchronously so listeners (the sidebar) rebuild immediately.
  static Future<void> set(bool v) async {
    enabled.value = v;
    _loaded = true;
    await DiskCache.write(_kKey, v ? '1' : '0');
  }

  static Future<void> toggle() => set(!enabled.value);
}
