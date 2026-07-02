import 'dart:convert';
import 'dart:typed_data';

import 'api_auth.dart';
import 'ava_contracts.dart';
import 'ava_log.dart';
import 'config.dart';

/// One file in the user's AvaTOK Drive folder.
class DriveFile {
  final String id;
  final String name;
  final String mimeType;
  final int size;
  final String? webViewLink;
  const DriveFile(this.id, this.name, this.mimeType, this.size, this.webViewLink);
}

/// Drive usage summary for AvaStorage.
class DriveStatus {
  final bool connected;
  final int avatokBytes;
  final int totalUsage;
  final int totalLimit;
  const DriveStatus(this.connected, this.avatokBytes, this.totalUsage, this.totalLimit);
}

/// DriveService — the user's OWN files in their Google Drive AvaTOK folder.
/// The Worker holds the encrypted Google refresh token (shared with Calendar);
/// uploads/list/usage go through it. Shared chat media stays on encrypted R2.
class DriveService {
  DriveService._();
  static final DriveService I = DriveService._();

  static String _url(String path) {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin$path';
  }

  /// Returns the Google OAuth URL to open (grants Calendar + Drive in one go).
  Future<String?> connectUrl() async {
    try {
      // `?return=app` → the Worker redirects the OAuth callback to
      // avatokauth://drive-connected so the in-app auth sheet auto-closes.
      final res = await ApiAuth.postJson('${_url(AvaApi.driveConnect)}?return=app', const {},
          timeout: const Duration(seconds: 20));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return j['url']?.toString();
    } catch (e) {
      AvaLog.I.log('drive', 'connectUrl failed: $e');
      return null;
    }
  }

  Future<DriveStatus> status() async {
    try {
      final res = await ApiAuth.getSigned(_url(AvaApi.driveStatus), timeout: const Duration(seconds: 20));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return DriveStatus(
        j['connected'] == true,
        (j['avatokBytes'] as num?)?.toInt() ?? 0,
        (j['totalUsage'] as num?)?.toInt() ?? 0,
        (j['totalLimit'] as num?)?.toInt() ?? 0,
      );
    } catch (_) {
      return const DriveStatus(false, 0, 0, 0);
    }
  }

  Future<List<DriveFile>> list() async {
    try {
      final res = await ApiAuth.getSigned(_url(AvaApi.driveList), timeout: const Duration(seconds: 25));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final files = (j['files'] as List?) ?? const [];
      return files.map((e) {
        final m = (e as Map).cast<String, dynamic>();
        return DriveFile(
          m['id']?.toString() ?? '', m['name']?.toString() ?? 'file',
          m['mimeType']?.toString() ?? '', int.tryParse(m['size']?.toString() ?? '0') ?? 0,
          m['webViewLink']?.toString(),
        );
      }).toList();
    } catch (_) {
      return const [];
    }
  }

  // ── FREE backup lane: the separate "avatok-backup" Drive folder ────────────

  /// Ensure the user's "avatok-backup" Drive folder exists. Returns true only
  /// when Drive is connected AND the folder is in place — the Settings backup
  /// buttons gate on this so they never fire before the user has connected.
  Future<bool> ensureBackupFolder() async {
    try {
      final res = await ApiAuth.postJson(_url(AvaApi.driveBackupEnsure), const {},
          timeout: const Duration(seconds: 25));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return j['ready'] == true;
    } catch (e) {
      AvaLog.I.log('drive', 'ensureBackupFolder failed: $e');
      return false;
    }
  }

  /// Upload the (client-side encrypted) backup blob into the avatok-backup
  /// folder under [name]. Replaces any existing blob of the same name.
  Future<bool> backupUpload(String name, List<int> bytes) async {
    try {
      final res = await ApiAuth.postJson(
        _url(AvaApi.driveBackupUpload),
        {'name': name, 'contentB64': base64Encode(bytes)},
        timeout: const Duration(seconds: 90),
      );
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return j['ok'] == true;
    } catch (e) {
      AvaLog.I.log('drive', 'backupUpload failed: $e');
      return false;
    }
  }

  /// List file names (with sizes) in the avatok-backup folder, optionally
  /// filtered by a name prefix. Used by the incremental media backup to skip
  /// already-uploaded blobs and by restore to discover what to pull back.
  Future<List<({String name, int size})>> backupList({String? prefix}) async {
    try {
      final qs = (prefix == null || prefix.isEmpty)
          ? ''
          : '?prefix=${Uri.encodeQueryComponent(prefix)}';
      final res = await ApiAuth.getSigned('${_url(AvaApi.driveBackupList)}$qs',
          timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final files = (j['files'] as List?) ?? const [];
      return files.map((e) {
        final m = (e as Map).cast<String, dynamic>();
        return (
          name: m['name']?.toString() ?? '',
          size: int.tryParse(m['size']?.toString() ?? '0') ?? 0,
        );
      }).toList();
    } catch (e) {
      AvaLog.I.log('drive', 'backupList failed: $e');
      return const [];
    }
  }

  /// Download the named backup blob from the avatok-backup folder; null if none.
  Future<Uint8List?> backupDownload(String name) async {
    try {
      final res = await ApiAuth.getBytes(
          '${_url(AvaApi.driveBackupDownload)}?name=${Uri.encodeQueryComponent(name)}');
      if (res.statusCode != 200) return null;
      return Uint8List.fromList(res.bodyBytes);
    } catch (e) {
      AvaLog.I.log('drive', 'backupDownload failed: $e');
      return null;
    }
  }

  /// Upload bytes into AvaTOK/<bucket> (Photos|Videos|Files|Backups|Docs).
  /// Returns true on success. Fire-and-forget friendly.
  Future<bool> upload(String bucket, String name, String mime, List<int> bytes) async {
    try {
      final res = await ApiAuth.postJson(
        _url(AvaApi.driveUpload),
        {'bucket': bucket, 'name': name, 'mime': mime, 'contentB64': base64Encode(bytes)},
        timeout: const Duration(seconds: 60),
      );
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return j['ok'] == true;
    } catch (e) {
      AvaLog.I.log('drive', 'upload failed: $e');
      return false;
    }
  }
}
