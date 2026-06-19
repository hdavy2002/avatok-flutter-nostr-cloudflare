import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/ava_contracts.dart';
import '../../core/config.dart';
import '../../identity/identity.dart';
import 'drive_client.dart';

/// BackupService (Phase 10 — Backup & Sync).
///
/// Exports the on-device SQLite (the source of truth — `avatok_<scope>.sqlite`,
/// see core/db.dart), CLIENT-SIDE ENCRYPTS it, and ships it to one of two lanes:
///
///   • PREMIUM R2 cross-device sync — uploaded to the AvaTok Worker
///     ([AvaApi.backupPrefix] → `/api/backup`). Gated by PaidFeature at the call
///     site (the settings section); the Worker also enforces a server-side
///     premium check (402 → top-up). Enables server-readable cross-device
///     restore. R2 has no egress fees.
///   • FREE Google Drive backup — uploaded to the USER'S OWN Drive appDataFolder
///     (survives uninstall). Ungated. See [DriveClient].
///
/// ENCRYPTION SCHEME (zero-knowledge — neither AvaTok nor Google can read it):
///   • Algorithm: AES-256-GCM (authenticated). Per `cryptography` package.
///   • Key: derived once per account via PBKDF2-HMAC-SHA256 (200k iterations)
///     from a per-account random 256-bit passphrase that is generated on first
///     use and stored ONLY in [FlutterSecureStorage], account-scoped via
///     [scopedKey]. The passphrase NEVER leaves the device, so the ciphertext at
///     rest (R2 or Drive) is opaque to the server and to Google.
///   • Wire format of the encrypted blob:
///       magic "AVBK1\n" | salt(16) | nonce(12) | ciphertext+GCM-tag
///     The salt makes the KDF output device/account-unique; the nonce is random
///     per encryption. Restore re-derives the key from the stored passphrase +
///     embedded salt.
///
/// NOTE on "private / on-device-only chats": the requirement is that such chats
/// are client-side encrypted before ANY backup. Because the WHOLE export is
/// encrypted with this scheme before it ever leaves the device, private chats
/// are covered by construction — there is no plaintext upload path at all. (If a
/// future selective-export excludes lanes, private convs must still go through
/// this same encrypt step.)
class BackupService {
  BackupService._();
  static final BackupService I = BackupService._();

  static const _kMagic = 'AVBK1\n';
  static const _kPassKey = 'ava_backup_passphrase'; // secure-storage base key
  static const _kLastAuto = 'ava_backup_last_auto'; // last auto-backup ms (per account)
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
  );

  final _aes = AesGcm.with256bits();
  final _kdf = Pbkdf2(
    macAlgorithm: Hmac.sha256(),
    iterations: 200000,
    bits: 256,
  );

  // ── passphrase (per-account, secure storage) ──────────────────────────────

  /// The account's backup passphrase, generating + persisting a random one on
  /// first use. Account-scoped so a parent + each child keep distinct keys.
  Future<String> _passphrase() async {
    final key = scopedKey(_kPassKey);
    var p = await _s.read(key: key);
    if (p == null || p.isEmpty) {
      final r = Random.secure();
      final bytes = Uint8List.fromList(List<int>.generate(32, (_) => r.nextInt(256)));
      p = base64Url.encode(bytes);
      await _s.write(key: key, value: p);
    }
    return p;
  }

  Future<SecretKey> _deriveKey(String passphrase, List<int> salt) =>
      _kdf.deriveKey(
        secretKey: SecretKey(utf8.encode(passphrase)),
        nonce: salt,
      );

  // ── encrypt / decrypt ─────────────────────────────────────────────────────

  /// Encrypt [plain] into the AVBK1 wire format (magic|salt|nonce|ct+tag).
  Future<Uint8List> _encrypt(Uint8List plain) async {
    final r = Random.secure();
    final salt = Uint8List.fromList(List<int>.generate(16, (_) => r.nextInt(256)));
    final nonce = Uint8List.fromList(List<int>.generate(12, (_) => r.nextInt(256)));
    final key = await _deriveKey(await _passphrase(), salt);
    final box = await _aes.encrypt(plain, secretKey: key, nonce: nonce);
    final magic = utf8.encode(_kMagic);
    // box.cipherText already excludes the MAC; append the 16-byte GCM tag.
    final out = BytesBuilder(copy: false)
      ..add(magic)
      ..add(salt)
      ..add(nonce)
      ..add(box.cipherText)
      ..add(box.mac.bytes);
    return out.toBytes();
  }

  /// Decrypt an AVBK1 blob back to the plaintext export bytes.
  Future<Uint8List> _decrypt(Uint8List blob) async {
    final magic = utf8.encode(_kMagic);
    if (blob.length < magic.length + 16 + 12 + 16) {
      throw const FormatException('backup blob too short / not AVBK1');
    }
    for (var i = 0; i < magic.length; i++) {
      if (blob[i] != magic[i]) throw const FormatException('bad backup magic');
    }
    var off = magic.length;
    final salt = blob.sublist(off, off + 16); off += 16;
    final nonce = blob.sublist(off, off + 12); off += 12;
    final tag = blob.sublist(blob.length - 16);
    final ct = blob.sublist(off, blob.length - 16);
    final key = await _deriveKey(await _passphrase(), salt);
    final clear = await _aes.decrypt(
      SecretBox(ct, nonce: nonce, mac: Mac(tag)),
      secretKey: key,
    );
    return Uint8List.fromList(clear);
  }

  // ── on-device SQLite export / import ──────────────────────────────────────

  /// Path to the active account's drift SQLite file (mirrors core/db.dart
  /// `_open()`): `<appSupport>/avatok_<scope>.sqlite`.
  Future<File> _dbFile() async {
    final dir = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty)
        ? 'default'
        : AccountScope.id!;
    return File('${dir.path}/avatok_$scope.sqlite');
  }

  /// Read the on-device SQLite as the raw export blob. The DB is the source of
  /// truth, so a byte copy is a complete, restorable export.
  Future<Uint8List> exportPlain() async {
    final f = await _dbFile();
    if (!await f.exists()) return Uint8List(0);
    return Uint8List.fromList(await f.readAsBytes());
  }

  /// Overwrite the on-device SQLite with restored bytes. The caller is expected
  /// to close/reopen [Db.I] after this (account-scoped DB rebuilds on access).
  Future<void> importPlain(Uint8List plain) async {
    if (plain.isEmpty) return;
    final f = await _dbFile();
    await f.writeAsBytes(plain, flush: true);
  }

  /// Produce the encrypted backup blob for the current account (export → encrypt).
  Future<Uint8List> buildEncryptedBlob() async => _encrypt(await exportPlain());

  // ── PREMIUM R2 lane (via the Worker) ──────────────────────────────────────

  static String get _backupUrl {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    // AvaApi.backupPrefix is '/api/backup/'; the blob route is '/api/backup'.
    return '$origin${AvaApi.backupPrefix.substring(0, AvaApi.backupPrefix.length - 1)}';
  }

  static String get _statusUrl => '$_backupUrl/status';

  /// Upload the encrypted blob to R2 via the Worker (PUT /api/backup).
  /// Returns true on success; a 402 means premium is required (the caller
  /// should have gated with PaidFeature, but we surface it safely).
  Future<BackupResult> syncToR2() async {
    try {
      final blob = await buildEncryptedBlob();
      if (blob.isEmpty) return const BackupResult(ok: false, reason: 'empty');
      // Signed PUT with a raw byte body. ApiAuth exposes no signed-PUT-bytes
      // helper and is frozen (Phase 2), so build the same auth headers it would:
      // a NIP-98 (kind-27235) signature over the URL+method+body, plus the
      // optional Clerk bearer. Mirrors ApiAuth._headers for the PUT method.
      final headers = <String, String>{'Content-Type': 'application/octet-stream'};
      final nip98 = ApiAuth.nip98('PUT', _backupUrl, body: blob);
      if (nip98 != null) headers['X-Nostr-Auth'] = nip98;
      try {
        final bearer = await ApiAuth.clerkBearer?.call();
        if (bearer != null && bearer.isNotEmpty) headers['Authorization'] = 'Bearer $bearer';
      } catch (_) {/* Clerk optional */}
      final res = await http
          .put(Uri.parse(_backupUrl), headers: headers, body: blob)
          .timeout(const Duration(seconds: 90));
      if (res.statusCode == 402) {
        return const BackupResult(ok: false, reason: 'premium_required');
      }
      if (res.statusCode != 200) {
        return BackupResult(ok: false, reason: 'http_${res.statusCode}');
      }
      return const BackupResult(ok: true);
    } catch (e) {
      return const BackupResult(ok: false, reason: 'network');
    }
  }

  /// Pull the latest encrypted blob from R2 (GET /api/backup), decrypt, and
  /// restore the on-device SQLite. Returns true on a successful restore.
  Future<BackupResult> restoreFromR2() async {
    try {
      final res = await ApiAuth.getBytes(_backupUrl);
      if (res.statusCode == 404) return const BackupResult(ok: false, reason: 'no_backup');
      if (res.statusCode != 200) return BackupResult(ok: false, reason: 'http_${res.statusCode}');
      final plain = await _decrypt(Uint8List.fromList(res.bodyBytes));
      await importPlain(plain);
      return const BackupResult(ok: true);
    } catch (e) {
      return BackupResult(ok: false, reason: 'restore_failed:$e');
    }
  }

  /// Backup status (version / size / last-updated) for the R2 lane, or null.
  Future<BackupStatus?> r2Status() async {
    try {
      final res = await ApiAuth.getSigned(_statusUrl);
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      if (j['exists'] != true) return null;
      return BackupStatus(
        version: (j['version'] as num?)?.toInt() ?? 0,
        sizeBytes: (j['sizeBytes'] as num?)?.toInt() ?? 0,
        updatedAt: (j['updatedAt'] as num?)?.toInt() ?? 0,
      );
    } catch (_) {
      return null;
    }
  }

  // ── automatic daily backup ────────────────────────────────────────────────

  /// Daily auto-backup (best-effort, throttled to ~once/24h per account). Encrypts
  /// the on-device SQLite and pushes it to the user's lane: premium → our R2;
  /// if not premium, falls back to their FREE Google Drive (when connected).
  /// Never throws — safe to fire-and-forget on app launch. With this in place the
  /// device + backup are the durable copy, so the InboxDO can safely shed history.
  Future<void> maybeAutoBackup() async {
    try {
      final key = scopedKey(_kLastAuto);
      final last = int.tryParse(await _s.read(key: key) ?? '') ?? 0;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (now - last < 20 * 3600 * 1000) return; // ~once per day
      var r = await syncToR2();
      if (!r.ok && r.reason == 'premium_required') {
        r = await backupToDrive(); // free lane for non-premium users
      }
      if (r.ok) await _s.write(key: key, value: now.toString());
    } catch (_) { /* best-effort; retry next launch */ }
  }

  // ── FREE Google Drive lane (user's own Drive) ─────────────────────────────

  /// Backup the encrypted blob to the user's own Google Drive (appDataFolder).
  /// Ungated (free). Requires a Drive access token from [DriveClient] (see its
  /// OAuth TODO). Returns the result; a missing token surfaces as 'no_token'.
  Future<BackupResult> backupToDrive() async {
    try {
      final blob = await buildEncryptedBlob();
      if (blob.isEmpty) return const BackupResult(ok: false, reason: 'empty');
      final ok = await DriveClient.I.upload(
        fileName: _driveFileName(),
        bytes: blob,
      );
      return BackupResult(ok: ok, reason: ok ? null : 'drive_upload_failed');
    } catch (e) {
      if (e is DriveAuthRequired) return const BackupResult(ok: false, reason: 'no_token');
      return const BackupResult(ok: false, reason: 'drive_error');
    }
  }

  /// Restore from the user's own Google Drive (download → decrypt → import).
  Future<BackupResult> restoreFromDrive() async {
    try {
      final bytes = await DriveClient.I.download(fileName: _driveFileName());
      if (bytes == null || bytes.isEmpty) return const BackupResult(ok: false, reason: 'no_backup');
      final plain = await _decrypt(Uint8List.fromList(bytes));
      await importPlain(plain);
      return const BackupResult(ok: true);
    } catch (e) {
      if (e is DriveAuthRequired) return const BackupResult(ok: false, reason: 'no_token');
      return BackupResult(ok: false, reason: 'restore_failed:$e');
    }
  }

  /// Drive backup file name — account-scoped so multiple accounts on one phone
  /// (and the same Drive) keep distinct backups in appDataFolder.
  String _driveFileName() {
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    return 'avatok-backup-$scope.avbk';
  }
}

/// Result of a backup/restore op.
class BackupResult {
  final bool ok;

  /// Machine reason on failure: 'empty' | 'premium_required' | 'no_token' |
  /// 'no_backup' | 'network' | 'http_<code>' | 'drive_*' | 'restore_failed:*'.
  final String? reason;
  const BackupResult({required this.ok, this.reason});
}

/// Manifest metadata for a stored backup.
class BackupStatus {
  final int version;
  final int sizeBytes;
  final int updatedAt;
  const BackupStatus({required this.version, required this.sizeBytes, required this.updatedAt});
}
