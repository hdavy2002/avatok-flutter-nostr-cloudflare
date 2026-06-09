import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../identity/identity.dart';
import 'ava_log.dart';

/// Plain, per-account, on-disk cache for NON-secret BULK data: chat history,
/// contacts, conversation previews, read-state, flags, drafts, etc.
///
/// WHY NOT flutter_secure_storage: its Android `encryptedSharedPreferences`
/// backend is unreliable on several OEMs (notably Samsung). After an app restart
/// it can fail to decrypt and either throw or return empty — which silently
/// WIPED these caches on every cold start, so the chat list came up blank and the
/// app re-downloaded every contact + their history from the relay one by one.
/// Secure storage is for secrets (the nsec, vault); bulk cache belongs in normal
/// app-private files, which are already sandboxed per-app by Android and which we
/// additionally scope per account here. (The media cache already works this way.)
class DiskCache {
  // Cache the support-dir path AND the per-scope cache dir. getApplicationSupport-
  // Directory() is a native platform-channel round-trip; the chat list does ~10
  // reads on cold start and each was re-calling it (+ a mkdir check) → ~1s+ of
  // the cold-start "list loading". Resolve + create once, reuse thereafter.
  static String? _basePath;
  static String? _scopeDirScope;
  static String? _scopeDirPath;

  static Future<String> _scopeDir() async {
    _basePath ??= (await getApplicationSupportDirectory()).path;
    final scope =
        (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    if (_scopeDirPath != null && _scopeDirScope == scope) return _scopeDirPath!;
    final dir = Directory('$_basePath/cache/$scope');
    if (!await dir.exists()) await dir.create(recursive: true);
    _scopeDirScope = scope;
    _scopeDirPath = dir.path;
    return dir.path;
  }

  static Future<File> _file(String name) async {
    final dirPath = await _scopeDir();
    final safe = name.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return File('$dirPath/$safe.json');
  }

  /// Read a cached value, or null if absent. Never throws (a read failure must
  /// not blank the UI) — failures are logged so we can see them in PostHog.
  static Future<String?> read(String name) async {
    try {
      final f = await _file(name);
      if (await f.exists() && await f.length() > 0) return await f.readAsString();
    } catch (e) {
      AvaLog.I.log('cache', 'read FAILED $name: $e');
    }
    return null;
  }

  static Future<void> write(String name, String value) async {
    try {
      final f = await _file(name);
      await f.writeAsString(value, flush: true);
    } catch (e) {
      AvaLog.I.log('cache', 'write FAILED $name: $e');
    }
  }

  static Future<void> delete(String name) async {
    try {
      final f = await _file(name);
      if (await f.exists()) await f.delete();
    } catch (_) {/* best-effort */}
  }

  // ── UNSCOPED (device-level) values — e.g. the last Clerk account id, so boot
  // can render the local session instantly before any network auth check. Not
  // account-scoped by design (it's how we recover WHICH account to scope to). ──
  static Future<File> _globalFile(String name) async {
    _basePath ??= (await getApplicationSupportDirectory()).path;
    final dir = Directory('$_basePath/cache/_global');
    if (!await dir.exists()) await dir.create(recursive: true);
    final safe = name.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return File('${dir.path}/$safe.json');
  }

  static Future<String?> readGlobal(String name) async {
    try {
      final f = await _globalFile(name);
      if (await f.exists() && await f.length() > 0) return await f.readAsString();
    } catch (e) {
      AvaLog.I.log('cache', 'readGlobal FAILED $name: $e');
    }
    return null;
  }

  static Future<void> writeGlobal(String name, String value) async {
    try {
      await (await _globalFile(name)).writeAsString(value, flush: true);
    } catch (e) {
      AvaLog.I.log('cache', 'writeGlobal FAILED $name: $e');
    }
  }

  static Future<void> deleteGlobal(String name) async {
    try {
      final f = await _globalFile(name);
      if (await f.exists()) await f.delete();
    } catch (_) {/* best-effort */}
  }
}
