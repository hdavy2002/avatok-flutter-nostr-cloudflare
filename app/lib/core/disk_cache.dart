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
  static Future<File> _file(String name) async {
    final base = await getApplicationSupportDirectory();
    final scope =
        (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    final dir = Directory('${base.path}/cache/$scope');
    if (!await dir.exists()) await dir.create(recursive: true);
    final safe = name.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return File('${dir.path}/$safe.json');
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
}
