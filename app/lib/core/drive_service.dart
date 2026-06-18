import 'dart:convert';

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
      final res = await ApiAuth.postJson(_url(AvaApi.driveConnect), const {},
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
