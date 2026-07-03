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
  // getApplicationSupportDirectory() is a native platform-channel round-trip. The
  // chat list fires ~10 reads CONCURRENTLY on cold start; with a plain `??=` each
  // one passes the null check before the first await resolves, so all ~10 made
  // the native call (a race) → most of the ~850ms "list loading". Cache the
  // FUTURE instead: the first caller kicks off the single lookup, the rest await
  // the same future. Plus cache the per-scope dir path.
  static Future<String>? _baseFut;
  static Future<String> _baseDir() =>
      _baseFut ??= getApplicationSupportDirectory().then((d) => d.path);

  static String? _scopeDirScope;
  static String? _scopeDirPath;

  static Future<String> _scopeDir() async {
    final base = await _baseDir();
    final scope =
        (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    if (_scopeDirPath != null && _scopeDirScope == scope) return _scopeDirPath!;
    final dir = Directory('$base/cache/$scope');
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
    final base = await _baseDir();
    final dir = Directory('$base/cache/_global');
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

  /// One-time self-heal (owner request 2026-07-01): a past bad/truncated image
  /// download got saved to the on-disk avatar cache and then crashed the image
  /// decoder on render ("Invalid image data"), which is why a REINSTALL (which
  /// wipes the cache) fixed it — briefly. Purge the on-disk IMAGE cache ONCE on
  /// the first launch of a new build, keyed to [flag], so nobody has to reinstall.
  /// Only the `avatars/` image cache is deleted — account, contacts, chat history
  /// and secure data are all untouched (they live in `cache/<scope>/` and secure
  /// storage). Best-effort; never blocks boot.
  static Future<void> flushImageCachesOnce(String flag) async {
    try {
      if (await readGlobal(flag) == '1') return;
      final base = await _baseDir();
      final d = Directory('$base/avatars');
      if (await d.exists()) {
        try { await d.delete(recursive: true); } catch (_) {/* best-effort */}
      }
      await writeGlobal(flag, '1');
    } catch (_) {/* never block boot on a cache purge */}
  }

  /// Wipe ALL on-disk caches (every account scope, the `_global` pointer, and the
  /// `avatars/` image cache). Used by the boot-time self-heal after a secure-store
  /// corruption (BAD_DECRYPT): we clear the device to a fresh-install state so
  /// nothing stale renders, then the server restore rebuilds chat/contacts and the
  /// account pointer. Safe: everything here is a cache re-fetched from the server.
  /// Does NOT touch secure storage (handled separately) or the SQLite DB.
  static Future<void> purgeAllCaches() async {
    try {
      final base = await _baseDir();
      final cacheDir = Directory('$base/cache');
      if (await cacheDir.exists()) await cacheDir.delete(recursive: true);
      final avatars = Directory('$base/avatars');
      if (await avatars.exists()) await avatars.delete(recursive: true);
    } catch (e) {
      AvaLog.I.log('cache', 'purgeAllCaches FAILED: $e');
    } finally {
      // Invalidate the memoised dir paths so the next access recreates them.
      _scopeDirScope = null;
      _scopeDirPath = null;
    }
  }
}
