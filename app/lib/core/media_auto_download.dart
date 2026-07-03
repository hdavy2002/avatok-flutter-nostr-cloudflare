import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

/// Auto-download policy for incoming chat media (STREAM J / D17).
///
/// Governs whether a received attachment (photo, video, file, voice note) is
/// fetched + decrypted EAGERLY on render, or left as a blurred placeholder the
/// user taps to fetch. A manual tap is ALWAYS allowed — this only gates the
/// automatic pre-fetch. Once fetched, media is cached forever per the existing
/// local-first rule in [MediaService].
///
/// Three modes (WhatsApp-parity), persisted per-account:
///   • [always]   — Download media automatically (DEFAULT, preserves prior behavior).
///   • [wifiOnly] — Download only on Wi-Fi / Ethernet; on cellular → placeholder.
///   • [never]    — Never auto-download; always show the tap-to-fetch placeholder.
///
/// The stranger-gate always wins: a thread whose `accept_state == 'pending'`
/// NEVER auto-downloads regardless of mode (D17 / §B1) — a stranger must not be
/// able to make your device fetch their payload before you accept the thread.
enum AutoDownloadMode { always, wifiOnly, never }

class MediaAutoDownload {
  MediaAutoDownload._();

  /// Secure-storage base key. Namespaced per-account via [scopedKey] so a parent
  /// and each child sharing one phone keep independent settings (MANDATORY —
  /// see account_storage.dart).
  static const String _baseKey = 'auto_download_mode';

  static final FlutterSecureStorage _sec = const FlutterSecureStorage();

  /// In-memory cache of the loaded mode (avoids a secure-storage read on every
  /// bubble render). Invalidated on [setMode]; re-loaded lazily.
  static AutoDownloadMode? _cached;

  static const AutoDownloadMode _default = AutoDownloadMode.always;

  static String _encode(AutoDownloadMode m) => switch (m) {
        AutoDownloadMode.always => 'always',
        AutoDownloadMode.wifiOnly => 'wifi_only',
        AutoDownloadMode.never => 'never',
      };

  static AutoDownloadMode _decode(String? s) => switch (s) {
        'wifi_only' => AutoDownloadMode.wifiOnly,
        'never' => AutoDownloadMode.never,
        _ => _default, // 'always', null, or any legacy value
      };

  /// The current per-account mode. Reads (and migrates a legacy un-namespaced
  /// value) via [readScoped]; falls back to [always] on any error.
  static Future<AutoDownloadMode> mode() async {
    if (_cached != null) return _cached!;
    try {
      final raw = await readScoped(_sec, _baseKey);
      _cached = _decode(raw);
    } catch (_) {
      _cached = _default;
    }
    return _cached!;
  }

  /// Persist a new mode for the active account. Idempotent; updates the cache.
  static Future<void> setMode(AutoDownloadMode m) async {
    _cached = m;
    try {
      await _sec.write(key: scopedKey(_baseKey), value: _encode(m));
    } catch (_) {/* best-effort — cache still reflects the choice this session */}
  }

  /// Call when the active account changes (login / switch) so the next read
  /// re-loads under the new scope instead of returning the previous account's
  /// cached mode.
  static void resetCache() => _cached = null;

  /// True when the device is on an un-metered network (Wi-Fi or Ethernet).
  /// connectivity_plus v6 returns a LIST (a device can be on several at once);
  /// we treat the presence of wifi/ethernet as "on Wi-Fi".
  static Future<bool> _onWifi() async {
    try {
      final results = await Connectivity().checkConnectivity();
      return results.contains(ConnectivityResult.wifi) ||
          results.contains(ConnectivityResult.ethernet);
    } catch (_) {
      // Unknown connectivity → be conservative and treat as NOT wifi, so
      // wifi-only mode does not auto-fetch over what might be cellular data.
      return false;
    }
  }

  /// The core gate. Returns true only when an incoming attachment should be
  /// fetched + decrypted automatically on render.
  ///
  /// [acceptState] is the recipient's thread-level accept state (§B1):
  /// `'pending' | 'accepted' | 'blocked'` — or null when unknown / not a
  /// stranger-gated thread. A `'pending'` thread NEVER auto-downloads.
  ///
  /// A manual tap must bypass this entirely (do NOT call this for tap-to-fetch);
  /// this only governs the automatic pre-fetch.
  static Future<bool> shouldAutoFetch({String? acceptState}) async {
    // (3) Stranger gate wins over everything (D17 / §B1).
    if (acceptState == 'pending' || acceptState == 'blocked') return false;

    // (1) Mode.
    final m = await mode();
    switch (m) {
      case AutoDownloadMode.never:
        return false;
      case AutoDownloadMode.always:
        return true;
      case AutoDownloadMode.wifiOnly:
        // (2) Connectivity — only on Wi-Fi / Ethernet.
        return _onWifi();
    }
  }
}
