import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// DriveClient (Phase 10 — Backup & Sync, FREE lane).
///
/// Uploads/downloads the (already client-side-encrypted) backup blob to the
/// USER'S OWN Google Drive — specifically the special `appDataFolder` space,
/// which is hidden per-app storage that survives app uninstall and is invisible
/// in the user's normal Drive UI. This is Drive STORAGE, NOT Google Docs.
///
/// The blob handed to [upload] is already AES-256-GCM encrypted by
/// [BackupService], so Google stores opaque ciphertext it cannot read.
///
/// ── OAUTH STATUS (read this) ───────────────────────────────────────────────
/// The Drive REST upload/download/manifest logic below is REAL and testable
/// against any valid OAuth access token with the `drive.appdata` scope. What is
/// NOT wired here is the *acquisition* of that token: a headless consumer Google
/// OAuth + Drive-scope consent flow needs platform plumbing
/// (google_sign_in / an OAuth web flow + a `client_id`) that can't be
/// completed/verified in this build. So [accessTokenProvider] is a STUB that
/// returns null by default and THROWS [DriveAuthRequired] at the call site.
///
/// To make Drive backup live, a follow-up wires real consumer OAuth:
///   • TODO(drive-oauth): set [DriveClient.accessTokenProvider] to a function
///     that returns a fresh `drive.appdata`-scoped access token — e.g. via the
///     `google_sign_in` package (scopes: ['https://www.googleapis.com/auth/drive.appdata'])
///     or an installed-app OAuth flow with PKCE. Token refresh is the provider's
///     responsibility (return a non-expired token each call).
/// Everything else in this file (find-by-name, multipart create, media update,
/// download) is production-ready and exercises the real Drive v3 API.
class DriveClient {
  DriveClient._();
  static final DriveClient I = DriveClient._();

  static const _filesBase = 'https://www.googleapis.com/drive/v3/files';
  static const _uploadBase = 'https://www.googleapis.com/upload/drive/v3/files';

  /// Supplies a fresh, `drive.appdata`-scoped OAuth access token. STUBBED to
  /// null (→ [DriveAuthRequired]). Wire real consumer OAuth here (see class doc).
  static Future<String?> Function()? accessTokenProvider;

  Future<String> _token() async {
    final t = await accessTokenProvider?.call();
    if (t == null || t.isEmpty) throw const DriveAuthRequired();
    return t;
  }

  Map<String, String> _authHeader(String token, {String? contentType}) => {
        'Authorization': 'Bearer $token',
        if (contentType != null) 'Content-Type': contentType,
      };

  /// Find an existing appDataFolder file by name; returns its fileId or null.
  Future<String?> _findFileId(String token, String name) async {
    final uri = Uri.parse(_filesBase).replace(queryParameters: {
      'spaces': 'appDataFolder',
      'q': "name = '${name.replaceAll("'", r"\'")}'",
      'fields': 'files(id,name,modifiedTime)',
      'pageSize': '1',
    });
    final res = await http.get(uri, headers: _authHeader(token)).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) return null;
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final files = (j['files'] as List?) ?? const [];
    if (files.isEmpty) return null;
    return (files.first as Map<String, dynamic>)['id'] as String?;
  }

  /// Upload [bytes] as [fileName] into appDataFolder. Creates the file on first
  /// backup (multipart, so the parents=appDataFolder metadata is attached), then
  /// updates the same fileId on subsequent backups (media upload). Returns true
  /// on success.
  Future<bool> upload({required String fileName, required Uint8List bytes}) async {
    final token = await _token();
    final existing = await _findFileId(token, fileName);

    if (existing == null) {
      // Create: multipart/related — metadata part + binary media part.
      const boundary = 'avatok_backup_boundary_x7';
      final meta = jsonEncode({'name': fileName, 'parents': ['appDataFolder']});
      final pre = utf8.encode(
        '--$boundary\r\n'
        'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        '$meta\r\n'
        '--$boundary\r\n'
        'Content-Type: application/octet-stream\r\n\r\n',
      );
      final post = utf8.encode('\r\n--$boundary--');
      final body = BytesBuilder(copy: false)..add(pre)..add(bytes)..add(post);
      final uri = Uri.parse('$_uploadBase?uploadType=multipart&fields=id');
      final res = await http
          .post(uri,
              headers: _authHeader(token, contentType: 'multipart/related; boundary=$boundary'),
              body: body.toBytes())
          .timeout(const Duration(seconds: 90));
      return res.statusCode == 200 || res.statusCode == 201;
    } else {
      // Update the existing file's media (keeps the same fileId).
      final uri = Uri.parse('$_uploadBase/$existing?uploadType=media&fields=id');
      final res = await http
          .patch(uri, headers: _authHeader(token, contentType: 'application/octet-stream'), body: bytes)
          .timeout(const Duration(seconds: 90));
      return res.statusCode == 200;
    }
  }

  /// Download the appDataFolder file named [fileName]; null when absent.
  Future<Uint8List?> download({required String fileName}) async {
    final token = await _token();
    final id = await _findFileId(token, fileName);
    if (id == null) return null;
    final uri = Uri.parse('$_filesBase/$id').replace(queryParameters: {'alt': 'media'});
    final res = await http.get(uri, headers: _authHeader(token)).timeout(const Duration(seconds: 90));
    if (res.statusCode != 200) return null;
    return Uint8List.fromList(res.bodyBytes);
  }

  /// Whether Drive backup is usable right now (a token provider is wired AND it
  /// returns a token). Used by the settings UI to show "connect Drive" vs ready.
  Future<bool> isAvailable() async {
    try {
      final t = await accessTokenProvider?.call();
      return t != null && t.isNotEmpty;
    } catch (_) {
      return false;
    }
  }
}

/// Thrown when a Drive op needs an access token but none is available (the OAuth
/// flow isn't wired/connected yet). Callers surface this as "connect Drive".
class DriveAuthRequired implements Exception {
  const DriveAuthRequired();
  @override
  String toString() => 'DriveAuthRequired: connect Google Drive to back up';
}
