import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/api/api_client.dart';
import '../../../core/auth/session.dart';
import '../../../core/config/flags.dart';

/// The version sent when `/api/config` could not be read (the worker accepts any well-formed version).
const String kFallbackAckVersion = 'hf-ack-v1';

/// Is [version] a usable acknowledgement? When the current version is known it must match; when the config
/// could not be read ([current] null) any recorded version counts, so a person offline is never re-asked.
bool ackIsCurrent(String? version, String? current) {
  if (version == null || version.isEmpty) return false;
  if (current == null || current.isEmpty) return true;
  return version == current;
}

/// Show Welcome when neither this device nor (when signed in) this account has accepted the current version.
/// [server] is `GET /api/hf/me` `ackVersion`; pass null when signed out.
bool needsWelcome({String? local, String? server, String? current}) =>
    !(ackIsCurrent(local, current) || ackIsCurrent(server, current));

/// The 18+ and safety acknowledgement (spec 2.4, HF-WELL-8 / HF-WELL-10).
///
/// Stored on the device first (so a guest can browse), then sent with `POST /api/hf/me/ack` once signed in.
/// The device value is NOT account-scoped on purpose: it records that the person holding this phone accepted
/// the rules, and it must survive sign-out. Its key does not start with `hf.cache.` and does not end in an
/// account suffix, so `JsonCache.clearAll` leaves it alone.
class AckService {
  AckService(this._ref);

  final Ref _ref;

  static const String storageKey = 'hf.ack.version';

  /// The current version from `/api/config`, or null when the config is not loaded.
  String? currentVersion() {
    final flags = _ref.read(flagsProvider);
    if (flags is AsyncData<HfFlags>) return flags.value.hfAckVersion;
    return null;
  }

  /// What to record and send when the person accepts now.
  String versionToSend() => currentVersion() ?? kFallbackAckVersion;

  Future<String?> readLocal() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(storageKey);
      return (v == null || v.isEmpty) ? null : v;
    } catch (_) {
      return null; // unreadable storage: treated as "not accepted yet"
    }
  }

  Future<void> writeLocal(String version) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(storageKey, version);
    } catch (_) {
      // The server copy (after sign-in) still holds it.
    }
  }

  /// `POST /api/hf/me/ack {version, ack18:true, client:'android'}`. True on success; failures are reported
  /// by the API client and never block the person (the device copy stays, and [syncToServer] retries).
  Future<bool> postAck(String version) async {
    try {
      await _ref.read(apiClientProvider).postJson('/api/hf/me/ack', body: {
        'version': version,
        'ack18': true,
        'client': 'android',
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Splash decision. Also heals the two copies: an account that already accepted on another phone fills the
  /// device copy, and a device acceptance made as a guest is sent to a signed-in account that lacks it.
  Future<bool> needsWelcomeNow() async {
    final local = await readLocal();
    final session = _ref.read(sessionProvider);
    final server = session.isSignedIn ? session.me?.ackVersion : null;
    final current = currentVersion();
    final localOk = ackIsCurrent(local, current);
    final serverOk = ackIsCurrent(server, current);
    if (!localOk && serverOk) await writeLocal(server!);
    if (localOk && !serverOk && session.isSignedIn) unawaited(syncToServer().catchError((Object _) {}));
    return !(localOk || serverOk);
  }

  /// The person tapped Continue on Welcome: keep it on the device, and send it when signed in.
  Future<String> accept() async {
    final version = versionToSend();
    await writeLocal(version);
    if (_ref.read(sessionProvider).isSignedIn) await postAck(version);
    return version;
  }

  /// Signed in with an acceptance on the device that the account does not have yet: send it.
  /// [tickedNow] is true when the sign-in screen itself showed the 18+ tick (no Welcome beforehand).
  Future<void> syncToServer({bool tickedNow = false}) async {
    if (tickedNow && await readLocal() == null) await writeLocal(versionToSend());
    final local = await readLocal();
    if (local == null) return;
    final session = _ref.read(sessionProvider);
    if (!session.isSignedIn) return;
    if (session.me?.ackVersion == local) return;
    if (await postAck(local)) {
      await _ref.read(sessionProvider.notifier).refreshMe();
    }
  }
}

final ackServiceProvider = Provider<AckService>((ref) => AckService(ref));
