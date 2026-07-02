import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_contracts.dart';
import '../../core/config.dart';
import '../../core/db.dart';
import '../../core/drive_service.dart';
import '../../core/remote_config.dart';
import '../../identity/identity.dart';

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
///   • FREE Google Drive backup — uploaded to a dedicated "avatok-backup" folder
///     in the USER'S OWN Drive via the server-mediated [DriveService] (the same
///     gcal/drive.file OAuth AvaStorage uses). Ungated. The legacy device-side
///     appDataFolder path (DriveClient) is retired — it needed a consumer OAuth
///     token that was never wired, which is why free backups errored before.
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

  // ── passphrase (per-account, secure storage + SERVER ESCROW) ──────────────
  //
  // NEW-PHONE RESTORE FIX: the passphrase used to live ONLY in secure storage,
  // which does not survive an uninstall (Android keystore) or exist on a new
  // device — so the one scenario backups exist for (reinstall / new phone) was
  // exactly the one where the blob could no longer be decrypted. The passphrase
  // is now ALSO escrowed server-side (POST /api/keybackup?kind=bk), wrapped
  // under KEY_WRAP_MASTER per account — the same model as the aek escrow. The
  // user's Drive holds the ciphertext, our D1 holds the wrapped key; neither
  // alone can read a backup, and a Clerk sign-in recovers both. The server
  // NEVER overwrites an existing bk escrow (first write wins), so a freshly
  // generated local passphrase can never orphan the backups already in Drive —
  // instead the client ADOPTS the escrowed value below.

  static String get _escrowUrl => '$kKeyBackupUrl?kind=bk';

  /// The escrowed passphrase for this account, or null (none / offline).
  Future<String?> _escrowFetch() async {
    try {
      final r = await ApiAuth.getSigned(_escrowUrl, timeout: const Duration(seconds: 15));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['found'] != true) return null;
      final b64 = (j['aek'] ?? '').toString();
      if (b64.isEmpty) return null;
      final p = utf8.decode(base64.decode(b64));
      return p.isEmpty ? null : p;
    } catch (_) {
      return null;
    }
  }

  /// Escrow [p] server-side (idempotent; the server keeps the FIRST value).
  Future<void> _escrowPut(String p) async {
    try {
      await ApiAuth.postJson(_escrowUrl, {'aek': base64.encode(utf8.encode(p))},
          timeout: const Duration(seconds: 15));
    } catch (_) {/* best-effort — retried on every backup */}
  }

  // Per-session memo so a media backup of N files does ONE escrow round-trip,
  // not N (the escrow GET is rate-limited). Invalidated on account switch.
  String? _passMemo;
  String? _passMemoScope;

  /// The account's backup passphrase. Resolution order keeps every device on
  /// ONE key per account: local value → server escrow (adopt) → generate new
  /// (store + escrow). Called on every backup so escrow/local converge even if
  /// an earlier escrow attempt was offline.
  Future<String> _passphrase() async {
    final key = scopedKey(_kPassKey);
    final scope = AccountScope.id ?? 'default';
    if (_passMemo != null && _passMemoScope == scope) return _passMemo!;
    var p = await _s.read(key: key);
    // Reconcile with the escrow. If the server already holds a (different)
    // passphrase, the ESCROWED one wins — it is the only key that can open the
    // backups already sitting in Drive/R2, and the server refuses overwrites.
    final escrowed = await _escrowFetch();
    if (escrowed != null && escrowed.isNotEmpty) {
      if (p != escrowed) {
        await _s.write(key: key, value: escrowed);
        if (p != null && p.isNotEmpty) {
          Analytics.capture('backup_key_adopted_from_escrow', {'had_local': true});
        }
        p = escrowed;
      }
      _passMemo = p; _passMemoScope = scope;
      return p!;
    }
    if (p == null || p.isEmpty) {
      final r = Random.secure();
      final bytes = Uint8List.fromList(List<int>.generate(32, (_) => r.nextInt(256)));
      p = base64Url.encode(bytes);
      await _s.write(key: key, value: p);
    }
    await _escrowPut(p); // no escrow yet (or offline GET) → publish ours
    _passMemo = p; _passMemoScope = scope;
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

  /// Overwrite the on-device SQLite with restored bytes — SAFELY:
  ///  1. close the open drift handle (an open connection flushing stale pages
  ///     over the new file was the old corruption risk),
  ///  2. remove any -wal/-shm sidecars (a stale WAL would be replayed over the
  ///     restored bytes on next open),
  ///  3. write the file, then let the next [Db.I] access reopen it fresh.
  /// No app restart needed any more.
  Future<void> importPlain(Uint8List plain) async {
    if (plain.isEmpty) return;
    await Db.reset();
    final f = await _dbFile();
    for (final ext in const ['-wal', '-shm', '-journal']) {
      final side = File('${f.path}$ext');
      try { if (await side.exists()) await side.delete(); } catch (_) {/* best-effort */}
    }
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
      // Signed PUT with a raw byte body. Clerk-only auth (Nostr/NIP-98 removed):
      // reuse ApiAuth's header builder (Clerk Bearer + trace id), overriding the
      // content type for the raw-bytes body.
      final headers = await ApiAuth.signedHeaders('PUT', _backupUrl,
          body: blob, extra: {'Content-Type': 'application/octet-stream'});
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
    if (!RemoteConfig.driveAutoBackup) return; // P8: flag-gated (default ON)
    try {
      final key = scopedKey(_kLastAuto);
      final last = int.tryParse(await _s.read(key: key) ?? '') ?? 0;
      final now = DateTime.now().millisecondsSinceEpoch;
      if (now - last < 20 * 3600 * 1000) return; // ~once per day
      // P8 (owner decision 2026-07-02): EVERY user auto-backs-up to their OWN
      // Google Drive — no premium gate. Premium users ALSO mirror to our R2 as a
      // best-effort extra (a `premium_required` there is fine and expected).
      final drive = await backupToDrive();
      final r2 = await syncToR2();
      if (drive.ok || r2.ok) {
        await _s.write(key: key, value: now.toString());
        // Media pass (incremental — already-uploaded blobs are skipped, so the
        // steady-state daily cost is one Drive list call). Soft-fail.
        await backupMediaToDrive();
      }
      Analytics.capture('drive_auto_backup', {
        'drive_ok': drive.ok, 'r2_ok': r2.ok,
        if (!drive.ok) 'drive_reason': drive.reason,
      });
    } catch (_) { /* best-effort; retry next launch */ }
  }

  // ── FREE Google Drive lane (user's own Drive) ─────────────────────────────

  /// Backup the encrypted blob to the user's own Google Drive, in a dedicated
  /// "avatok-backup" folder, via the server-mediated [DriveService] (the same
  /// gcal/drive.file OAuth used by AvaStorage). Ungated (free). The caller must
  /// have connected Drive first (Settings gates the button on that); if not, the
  /// upload returns false and surfaces as 'no_token'.
  Future<BackupResult> backupToDrive() async {
    try {
      final blob = await buildEncryptedBlob();
      if (blob.isEmpty) return const BackupResult(ok: false, reason: 'empty');
      // Make sure the avatok-backup folder exists (no-op once created). A false
      // here means Drive isn't connected yet → tell the user to connect.
      if (!await DriveService.I.ensureBackupFolder()) {
        return const BackupResult(ok: false, reason: 'no_token');
      }
      final ok = await DriveService.I.backupUpload(_driveFileName(), blob);
      return BackupResult(ok: ok, reason: ok ? null : 'drive_upload_failed');
    } catch (e) {
      return const BackupResult(ok: false, reason: 'drive_error');
    }
  }

  /// Restore from the user's own Google Drive (download → decrypt → import).
  Future<BackupResult> restoreFromDrive() async {
    try {
      final bytes = await DriveService.I.backupDownload(_driveFileName());
      if (bytes == null || bytes.isEmpty) return const BackupResult(ok: false, reason: 'no_backup');
      final plain = await _decrypt(Uint8List.fromList(bytes));
      await importPlain(plain);
      return const BackupResult(ok: true);
    } catch (e) {
      return BackupResult(ok: false, reason: 'restore_failed:$e');
    }
  }

  /// Drive backup file name — account-scoped so multiple accounts on one phone
  /// (and the same Drive) keep distinct backups in the avatok-backup folder.
  String _driveFileName() {
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    return 'avatok-backup-$scope.avbk';
  }

  // ── media backup / restore (Drive, incremental) ───────────────────────────
  //
  // Chat media plaintext is cached per account on-device (MediaService →
  // <appSupport>/media/<scope>/<hash>) and its ciphertext lives content-
  // addressed on R2, with per-blob keys riding inside message envelopes (in the
  // DB backup). So after a DB restore, media CAN lazily re-download from R2 —
  // this Drive lane is the belt-and-braces copy for the day an R2 blob is gone.
  // Each cache file is encrypted with the SAME escrowed backup key (AVBK1) and
  // uploaded once: content-addressed names make the backup incremental — files
  // already listed in Drive are skipped. Per-file cap keeps the Worker's
  // base64-JSON proxy well inside its memory/time limits; capped-out files are
  // still recoverable from R2.

  static const int _kMediaMaxBytes = 40 * 1024 * 1024; // per-file cap (40 MB)

  String _scopeId() =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;

  /// Drive name prefix for this account's media blobs.
  String _mediaPrefix() => 'avatok-media-${_scopeId()}-';

  /// The per-account media cache dir (mirrors MediaService._cacheDir).
  Future<Directory> _mediaDir() async {
    final base = await getApplicationSupportDirectory();
    return Directory('${base.path}/media/${_scopeId()}');
  }

  /// Incrementally back up the media cache to Drive. Skips files already in
  /// the avatok-backup folder and files over [_kMediaMaxBytes]. Never throws.
  Future<MediaBackupResult> backupMediaToDrive() async {
    var uploaded = 0, skipped = 0, failed = 0, tooBig = 0;
    try {
      if (!await DriveService.I.ensureBackupFolder()) {
        return const MediaBackupResult(ok: false, reason: 'no_token');
      }
      final dir = await _mediaDir();
      if (!await dir.exists()) return const MediaBackupResult(ok: true);
      final prefix = _mediaPrefix();
      final existing = <String>{
        for (final f in await DriveService.I.backupList(prefix: prefix)) f.name,
      };
      await for (final ent in dir.list()) {
        if (ent is! File) continue;
        final base = ent.uri.pathSegments.last;
        final driveName = '$prefix$base.avbm';
        if (existing.contains(driveName)) { skipped++; continue; }
        try {
          final len = await ent.length();
          if (len == 0) { skipped++; continue; }
          if (len > _kMediaMaxBytes) { tooBig++; continue; }
          final blob = await _encrypt(Uint8List.fromList(await ent.readAsBytes()));
          final ok = await DriveService.I.backupUpload(driveName, blob);
          ok ? uploaded++ : failed++;
        } catch (_) { failed++; }
      }
      Analytics.capture('media_backup_result', {
        'uploaded': uploaded, 'skipped': skipped, 'failed': failed, 'too_big': tooBig,
      });
      return MediaBackupResult(
        ok: failed == 0, reason: failed == 0 ? null : 'partial',
        uploaded: uploaded, skipped: skipped, failed: failed, tooBig: tooBig,
      );
    } catch (e) {
      Analytics.capture('media_backup_result', {'ok': false, 'err': e.toString()});
      return MediaBackupResult(
        ok: false, reason: 'media_error',
        uploaded: uploaded, skipped: skipped, failed: failed, tooBig: tooBig,
      );
    }
  }

  /// Pull every media blob for this account back from Drive into the local
  /// cache (download → decrypt → write). Files already cached are skipped, so
  /// this is safe to run right after a DB restore on a new phone. Never throws.
  Future<MediaBackupResult> restoreMediaFromDrive() async {
    var restored = 0, skipped = 0, failed = 0;
    try {
      final prefix = _mediaPrefix();
      final files = await DriveService.I.backupList(prefix: prefix);
      if (files.isEmpty) return const MediaBackupResult(ok: true);
      final dir = await _mediaDir();
      if (!await dir.exists()) await dir.create(recursive: true);
      for (final f in files) {
        var base = f.name.substring(prefix.length);
        if (base.endsWith('.avbm')) base = base.substring(0, base.length - 5);
        if (base.isEmpty) continue;
        final out = File('${dir.path}/$base');
        try {
          if (await out.exists() && await out.length() > 0) { skipped++; continue; }
          final blob = await DriveService.I.backupDownload(f.name);
          if (blob == null || blob.isEmpty) { failed++; continue; }
          final plain = await _decrypt(Uint8List.fromList(blob));
          await out.writeAsBytes(plain, flush: true);
          restored++;
        } catch (_) { failed++; }
      }
      Analytics.capture('media_restore_result', {
        'restored': restored, 'skipped': skipped, 'failed': failed,
      });
      return MediaBackupResult(
        ok: failed == 0, reason: failed == 0 ? null : 'partial',
        uploaded: restored, skipped: skipped, failed: failed,
      );
    } catch (e) {
      Analytics.capture('media_restore_result', {'ok': false, 'err': e.toString()});
      return MediaBackupResult(
        ok: false, reason: 'media_error',
        uploaded: restored, skipped: skipped, failed: failed,
      );
    }
  }

  /// Full Drive backup: the DB blob first (the critical piece — it holds the
  /// media envelope keys), then the incremental media pass.
  Future<BackupResult> backupAllToDrive() async {
    final db = await backupToDrive();
    if (!db.ok) return db;
    final media = await backupMediaToDrive();
    // Media problems never fail the backup as a whole (R2 still covers those
    // files); surface a soft reason so the UI can mention it.
    return BackupResult(ok: true, reason: media.ok ? null : 'media_partial');
  }

  /// Full Drive restore: DB first (envelope keys + chats), then media back
  /// into the cache. DB failure aborts; media failure is soft (R2 re-download
  /// still works lazily).
  Future<BackupResult> restoreAllFromDrive() async {
    final db = await restoreFromDrive();
    if (!db.ok) return db;
    final media = await restoreMediaFromDrive();
    return BackupResult(ok: true, reason: media.ok ? null : 'media_partial');
  }
}

/// Result of a backup/restore op.
class BackupResult {
  final bool ok;

  /// Machine reason on failure: 'empty' | 'premium_required' | 'no_token' |
  /// 'no_backup' | 'network' | 'http_<code>' | 'drive_*' | 'restore_failed:*'.
  /// 'media_partial' rides on an OK result when the DB part succeeded but some
  /// media blobs failed (they remain recoverable from R2).
  final String? reason;
  const BackupResult({required this.ok, this.reason});
}

/// Result of a media backup/restore pass. [uploaded] doubles as "restored"
/// on the restore path.
class MediaBackupResult {
  final bool ok;
  final String? reason; // 'no_token' | 'partial' | 'media_error'
  final int uploaded;
  final int skipped;
  final int failed;
  final int tooBig;
  const MediaBackupResult({
    required this.ok, this.reason,
    this.uploaded = 0, this.skipped = 0, this.failed = 0, this.tooBig = 0,
  });
}

/// Manifest metadata for a stored backup.
class BackupStatus {
  final int version;
  final int sizeBytes;
  final int updatedAt;
  const BackupStatus({required this.version, required this.sizeBytes, required this.updatedAt});
}
