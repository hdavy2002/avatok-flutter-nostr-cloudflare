import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'config.dart';

/// One file in AvaLibrary (a row of `user_media`, projected for the client).
class LibraryItem {
  final String id;
  final String category; // image|video|document|audio|other
  final String key; // content-addressed R2 path (u/<npub>/<kind>/<hash>)
  final String displayUrl;
  final String? thumbnailUrl;
  final String mime;
  final String name;
  final int size;
  final String visibility; // public|private
  final String app;
  final String? folderId;
  final String sourceKind; // sent|received
  final String? encBlob; // received-DM decryption material (encrypted to me)
  final int createdAt;
  const LibraryItem({
    required this.id, required this.category, required this.key, required this.displayUrl,
    this.thumbnailUrl, required this.mime, required this.name, required this.size,
    required this.visibility, required this.app, this.folderId, required this.sourceKind,
    this.encBlob, required this.createdAt,
  });

  bool get isPrivate => visibility == 'private';

  factory LibraryItem.fromJson(Map<String, dynamic> j) => LibraryItem(
        id: j['id'].toString(),
        category: (j['category'] ?? j['media_type'] ?? 'other').toString(),
        key: (j['key'] ?? '').toString(),
        displayUrl: (j['display_url'] ?? '').toString(),
        thumbnailUrl: j['thumbnail_url']?.toString(),
        mime: (j['mime_type'] ?? 'application/octet-stream').toString(),
        name: (j['file_name'] ?? 'file').toString(),
        size: (j['size_bytes'] as num?)?.toInt() ?? 0,
        visibility: (j['visibility'] ?? 'public').toString(),
        app: (j['original_app'] ?? 'avatok').toString(),
        folderId: j['folder_id']?.toString(),
        sourceKind: (j['source_kind'] ?? 'sent').toString(),
        encBlob: j['enc_blob']?.toString(),
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
      );
}

/// A user-created folder under an app root.
class LibraryFolder {
  final String id;
  final String app;
  final String name;
  final String? parentId;
  const LibraryFolder({required this.id, required this.app, required this.name, this.parentId});
  factory LibraryFolder.fromJson(Map<String, dynamic> j) => LibraryFolder(
        id: j['id'].toString(), app: (j['app'] ?? 'avatok').toString(),
        name: (j['name'] ?? '').toString(), parentId: j['parent_id']?.toString(),
      );
}

/// The navigation skeleton: per-app totals + per-category counts + user folders.
class LibraryTree {
  final List<AppNode> apps;
  final Map<String, List<LibraryFolder>> foldersByApp;
  const LibraryTree({required this.apps, required this.foldersByApp});
  factory LibraryTree.fromJson(Map<String, dynamic> j) {
    final apps = ((j['apps'] as List?) ?? const [])
        .map((e) => AppNode.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    final fba = <String, List<LibraryFolder>>{};
    ((j['folders_by_app'] as Map?) ?? const {}).forEach((k, v) {
      fba[k.toString()] = ((v as List?) ?? const [])
          .map((e) => LibraryFolder.fromJson((e as Map).cast<String, dynamic>())).toList();
    });
    return LibraryTree(apps: apps, foldersByApp: fba);
  }
}

class AppNode {
  final String app;
  final int total;
  final int bytes;
  final Map<String, int> byCategory; // category -> count
  const AppNode({required this.app, required this.total, required this.bytes, required this.byCategory});
  factory AppNode.fromJson(Map<String, dynamic> j) {
    final bc = <String, int>{};
    ((j['by_category'] as Map?) ?? const {}).forEach((k, v) {
      bc[k.toString()] = ((v as Map?)?['count'] as num?)?.toInt() ?? 0;
    });
    return AppNode(
      app: (j['app'] ?? 'avatok').toString(),
      total: (j['total'] as num?)?.toInt() ?? 0,
      bytes: (j['bytes'] as num?)?.toInt() ?? 0,
      byCategory: bc,
    );
  }
}

/// Client for the AvaLibrary cross-app file manager. Dual-auth via [ApiAuth];
/// the server scopes everything to the caller's npub. Tree is cached local-first
/// (account-scoped) so the screen paints instantly before the network returns.
class LibraryApi {
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _treeCacheKey = 'avalibrary_tree';

  /// Cached tree (instant paint), or null if nothing cached for this account.
  static Future<LibraryTree?> cachedTree() async {
    try {
      final raw = await _s.read(key: scopedKey(_treeCacheKey));
      if (raw == null || raw.isEmpty) return null;
      return LibraryTree.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) { return null; }
  }

  static Future<LibraryTree> tree() async {
    final r = await ApiAuth.getSigned(kLibraryTreeUrl);
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    try { await _s.write(key: scopedKey(_treeCacheKey), value: r.body); } catch (_) {}
    return LibraryTree.fromJson(j);
  }

  /// Files in one view: a user folder, or an app→category system folder.
  static Future<({List<LibraryItem> items, int? cursor})> list({
    String? app, String? category, String? folder, int? cursor, String? q,
  }) async {
    final qp = <String, String>{};
    if (folder != null) qp['folder'] = folder;
    else {
      if (app != null) qp['app'] = app;
      if (category != null) qp['category'] = category;
    }
    if (cursor != null) qp['cursor'] = cursor.toString();
    if (q != null && q.trim().isNotEmpty) qp['q'] = q.trim(); // server-side name search (Phase 4)
    final uri = Uri.parse(kLibraryUrl).replace(queryParameters: qp.isEmpty ? null : qp);
    final r = await ApiAuth.getSigned(uri.toString());
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    final items = ((j['items'] as List?) ?? const [])
        .map((e) => LibraryItem.fromJson((e as Map).cast<String, dynamic>())).toList();
    return (items: items, cursor: (j['cursor'] as num?)?.toInt());
  }

  static Future<List<LibraryFolder>> folders(String app) async {
    final r = await ApiAuth.getSigned('$kLibraryFoldersUrl?app=$app');
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    return ((j['folders'] as List?) ?? const [])
        .map((e) => LibraryFolder.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  static Future<String?> createFolder({required String app, required String name, String? parentId}) async {
    final r = await ApiAuth.postJson(kLibraryFoldersUrl, {'app': app, 'name': name, if (parentId != null) 'parent_id': parentId});
    return (jsonDecode(r.body) as Map<String, dynamic>)['id']?.toString();
  }

  static Future<void> renameFolder(String id, String name) =>
      ApiAuth.putJson(kLibraryFoldersUrl, {'id': id, 'name': name}); // PATCH-equiv handled server-side via method

  static Future<void> deleteFolder(String id) => ApiAuth.deleteSigned('$kLibraryFoldersUrl?id=$id');

  /// Move a FILE. [folderId] null = the app's category root. [app] (optional)
  /// re-homes it under another app root — files can move anywhere in AvaLibrary.
  static Future<void> move(String id, String? folderId, {String? app}) =>
      ApiAuth.postJson(kLibraryMoveUrl, {'id': id, 'folder_id': folderId, if (app != null) 'app': app});

  /// Copy a FILE as a shortcut (same content key — no extra storage).
  static Future<String?> copy(String id, String? folderId, {String? app}) async {
    final r = await ApiAuth.postJson(kLibraryCopyUrl, {'id': id, 'folder_id': folderId, if (app != null) 'app': app});
    return (jsonDecode(r.body) as Map<String, dynamic>)['id']?.toString();
  }

  /// Move a FOLDER (with everything in it). [parentId] null = top level of [app].
  static Future<void> moveFolder(String id, {String? app, String? parentId}) =>
      ApiAuth.postJson(kLibraryFolderMoveUrl, {'id': id, if (app != null) 'app': app, 'parent_id': parentId});

  /// Copy a FOLDER and its whole subtree (files duplicated as shortcuts).
  static Future<String?> copyFolder(String id, {String? app, String? parentId}) async {
    final r = await ApiAuth.postJson(kLibraryFolderCopyUrl, {'id': id, if (app != null) 'app': app, 'parent_id': parentId});
    return (jsonDecode(r.body) as Map<String, dynamic>)['id']?.toString();
  }

  static Future<void> delete(String id) => ApiAuth.postJson(kLibraryDeleteUrl, {'id': id});

  /// Upload a (public) file/photo into AvaLibrary, optionally straight into a
  /// folder. Returns the new media id (or null). Bytes go to the public bucket;
  /// the server records the AvaLibrary entry + runs moderation/brain ingestion.
  static Future<String?> uploadFile({
    required List<int> bytes, required String mime, required String name,
    String app = 'avalibrary', String? folderId,
  }) async {
    final r = await ApiAuth.postBytes(kUploadPublicUrl, bytes, extraHeaders: {
      'x-content-type': mime,
      'x-file-name': name,
      'x-app': app,
      if (folderId != null) 'x-folder': folderId,
    }, timeout: const Duration(seconds: 90));
    if (r.statusCode != 200) {
      throw Exception('upload failed (${r.statusCode})');
    }
    return (jsonDecode(r.body) as Map<String, dynamic>)['id']?.toString();
  }

  /// Record a RECEIVED DM file so it appears in the recipient's Library too. The
  /// decryption material is encrypted to the recipient ([encBlob]) — the server
  /// stores ciphertext only, never the plaintext AES key.
  static Future<void> record({
    required String key, required String mime, required int size, required String name,
    String app = 'avatok', String? encBlob, String? displayUrl,
  }) async {
    try {
      await ApiAuth.postJson(kLibraryRecordUrl, {
        'key': key, 'mime': mime, 'size': size, 'name': name, 'app': app,
        'source_kind': 'received',
        if (encBlob != null) 'enc_blob': encBlob,
        if (displayUrl != null) 'display_url': displayUrl,
      });
    } catch (_) {/* best-effort; local cache still shows it */}
  }
}
