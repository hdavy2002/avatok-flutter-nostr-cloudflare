import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

/// Consent belongs to the authenticated account. The legacy device-global key is
/// deliberately ignored; accepting on one account cannot consent for another.
class AckService {
  AckService(this._ref);

  final Ref _ref;

  static const String storageKey = 'hf.ack.version';

  String? get _uid {
    final session = _ref.read(sessionProvider);
    return session.isSignedIn ? (session.user?.id ?? session.me?.uid) : null;
  }

  /// The current version from `/api/config`, or null when the config is not loaded.
  String? currentVersion() {
    final flags = _ref.read(flagsProvider);
    if (flags is AsyncData<HfFlags>) return flags.value.hfAckVersion;
    return null;
  }

  /// What to record and send when the person accepts now.
  String versionToSend() => currentVersion() ?? kFallbackAckVersion;

  Future<String?> readLocal() async {
    final uid = _uid;
    if (uid == null) return null;
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString('${storageKey}_$uid');
      return _uid != uid || v == null || v.isEmpty ? null : v;
    } catch (_) {
      return null; // unreadable storage: treated as "not accepted yet"
    }
  }

  Future<void> writeLocal(String version) async {
    final uid = _uid;
    if (uid == null) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('${storageKey}_$uid', version);
    } catch (_) {
      // The server copy (after sign-in) still holds it.
    }
  }

  /// `POST /api/hf/me/ack {version, ack18:true, client:'android'}`. True on success; failures are reported
  /// by the API client and never block the person (the device copy stays, and [syncToServer] retries).
  Future<bool> postAck(String version, {String? expectedUid}) async {
    final uid = expectedUid ?? _uid;
    if (uid == null || _uid != uid) return false;
    try {
      // Freeze the credential before dispatch. ApiClient's usual 401 retry could
      // otherwise pick up a different account on a shared phone mid-request.
      final jwt = await _ref.read(clerkProvider).sessionToken();
      if (jwt == null || _uid != uid || !_tokenBelongsTo(jwt, uid)) return false;
      await _ref.read(apiClientProvider).request('POST', '/api/hf/me/ack',
        auth: false, headers: {'Authorization': 'Bearer $jwt'}, body: {
          'version': version, 'ack18': true, 'client': 'android',
        });
      return _uid == uid;
    } catch (_) { return false; }
  }

  bool _tokenBelongsTo(String token, String uid) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return false;
      final claims = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
      return claims is Map && claims['sub'] == uid;
    } catch (_) { return false; }
  }

  /// Privileged action decision. Sync only copies belonging to this authenticated UID.
  /// The old global value and guest state never participate.
  Future<bool> needsWelcomeNow() async {
    final uid = _uid;
    final local = await readLocal();
    if (uid != _uid) return true;
    final session = _ref.read(sessionProvider);
    final server = session.isSignedIn ? session.me?.ackVersion : null;
    final current = currentVersion();
    final localOk = ackIsCurrent(local, current);
    final serverOk = ackIsCurrent(server, current);
    if (!localOk && serverOk) await writeLocal(server!);
    if (localOk && !serverOk && session.isSignedIn) unawaited(syncToServer().catchError((Object _) {}));
    return _uid != uid || !(localOk || serverOk);
  }

  /// The person tapped Continue on Welcome: keep it on the device, and send it when signed in.
  Future<String> accept() async {
    final uid = _uid;
    final version = versionToSend();
    await writeLocal(version);
    if (uid != null && _uid == uid && await postAck(version, expectedUid: uid)) {
      if (_uid == uid) await _ref.read(sessionProvider.notifier).refreshMe();
    }
    return version;
  }

  /// Signed in with an acceptance on the device that the account does not have yet: send it.
  /// [tickedNow] is true when the sign-in screen itself showed the 18+ tick (no Welcome beforehand).
  Future<void> syncToServer({bool tickedNow = false}) async {
    final uid = _uid;
    if (tickedNow) await writeLocal(versionToSend());
    final local = await readLocal();
    if (local == null || uid == null || _uid != uid) return;
    final session = _ref.read(sessionProvider);
    if (!session.isSignedIn) return;
    if (session.me?.ackVersion == local) return;
    if (await postAck(local, expectedUid: uid)) {
      await _ref.read(sessionProvider.notifier).refreshMe();
    }
  }
}

final ackServiceProvider = Provider<AckService>((ref) => AckService(ref));
