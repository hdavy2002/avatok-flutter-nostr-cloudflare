import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:crypto/crypto.dart' as crypto;

import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// Client-side encrypted "vault" sync. Stores opaque blobs on the server keyed
/// by (uid, kind) so per-user data (contacts, prefs, private media) follows the
/// user to any device. The blob is encrypted with the account key material
/// ([AccountKey]) — a key the user's devices restore from escrow — so only the
/// user's devices can read it; the server stores ciphertext only.
class Vault {
  static final _aes = AesGcm.with256bits();

  /// Deterministic 256-bit key from the key material hex — same on every device
  /// that restores the key, so blobs written on one device decrypt on another.
  static SecretKey _key(String keyMaterial) {
    final d = Uint8List.fromList(crypto.sha256.convert(
        Uint8List.fromList(utf8.encode('avatok-vault-v1:$keyMaterial'))).bytes);
    return SecretKey(d.sublist(0, 32));
  }

  static Future<String> encrypt(String plain, String keyMaterial) async {
    final box = await _aes.encrypt(utf8.encode(plain), secretKey: _key(keyMaterial));
    return 'v1.${base64Url.encode(box.nonce)}.${base64Url.encode(box.cipherText)}.${base64Url.encode(box.mac.bytes)}';
  }

  static Future<String?> decrypt(String blob, String keyMaterial) async {
    try {
      final p = blob.split('.');
      if (p.length != 4 || p[0] != 'v1') return null;
      final clear = await _aes.decrypt(
        SecretBox(base64Url.decode(p[2]), nonce: base64Url.decode(p[1]), mac: Mac(base64Url.decode(p[3]))),
        secretKey: _key(keyMaterial),
      );
      return utf8.decode(clear);
    } catch (_) {
      return null;
    }
  }

  /// Upload an already-encrypted blob for [kind]. Best-effort (never throws),
  /// but no longer SILENT: a failed backup upload used to vanish without a
  /// trace ([ISSUE-VAULT-RESTORE-1], 2026-07-09), so nobody could tell whether
  /// a user's server-side backup was ever written. Non-200s and exceptions now
  /// emit `vault_put_failed` telemetry.
  static Future<void> put(String kind, String encBlob) async {
    try {
      final r = await ApiAuth.postJson(kVaultUrl, {'kind': kind, 'blob': encBlob},
          timeout: const Duration(seconds: 20));
      if (r.statusCode != 200) {
        Analytics.error(
          domain: 'vault',
          code: 'vault_put_failed',
          message: 'status ${r.statusCode}',
          action: 'put',
          extra: {'kind': kind, 'status': r.statusCode},
        );
      }
    } catch (e) {
      Analytics.error(
        domain: 'vault',
        code: 'vault_put_failed',
        message: e.toString(),
        action: 'put',
        extra: {'kind': kind, 'status': 0},
      );
    }
  }

  /// Fetch the encrypted blob for [kind], or null if none / offline.
  /// DEPRECATED for restore paths — a `null` here can't distinguish "the server
  /// confirmed there's no backup" from "the request failed", which is exactly
  /// the ambiguity behind the 2026-07-09 'my data is missing' reinstall bug.
  /// Restore callers should use [fetch] instead.
  static Future<String?> get(String kind) async => (await fetch(kind)).blob;

  /// Fetch with a tri-state result + retries ([ISSUE-VAULT-RESTORE-1]).
  ///
  /// The reinstall data-loss report (2026-07-09, hdavy2002) traced to a single
  /// GET /api/vault aborting client-side (status 0, 8s default timeout) with
  /// ZERO retries and ZERO telemetry — the user's backup existed on the server
  /// the whole time. This fetch: 20s timeout, 3 attempts (1s / 3s backoff),
  /// and it reports the outcome so PostHog can prove what happened.
  static Future<VaultFetch> fetch(String kind) async {
    Object? lastError;
    int lastStatus = -1;
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        final r = await ApiAuth.getSigned('$kVaultUrl?kind=$kind',
            timeout: const Duration(seconds: 20));
        lastStatus = r.statusCode;
        if (r.statusCode == 200) {
          final j = jsonDecode(r.body) as Map<String, dynamic>;
          final b = j['blob'];
          if (b == null || b.toString().isEmpty) {
            // Server positively answered: no backup stored for this kind.
            return const VaultFetch.confirmedEmpty();
          }
          if (attempt > 1) {
            Analytics.capture('vault_get_retried_ok', {'kind': kind, 'attempt': attempt});
          }
          return VaultFetch.found(b.toString());
        }
      } catch (e) {
        lastError = e;
        lastStatus = 0; // transport-level abort, no server response
      }
      if (attempt < 3) {
        await Future<void>.delayed(Duration(seconds: attempt == 1 ? 1 : 3));
      }
    }
    Analytics.error(
      domain: 'vault',
      code: 'vault_get_failed',
      message: lastError?.toString() ?? 'status $lastStatus',
      action: 'get',
      extra: {'kind': kind, 'status': lastStatus, 'attempts': 3},
    );
    return const VaultFetch.failed();
  }
}

/// Tri-state result of [Vault.fetch]: the difference between "no backup exists"
/// (server-confirmed — safe to treat as a fresh account) and "we couldn't ask"
/// (NOT safe to assume anything, and above all not safe to overwrite the
/// server copy with local state).
class VaultFetch {
  const VaultFetch.found(String this.blob)
      : confirmedEmpty = false,
        failed = false;
  const VaultFetch.confirmedEmpty()
      : blob = null,
        confirmedEmpty = true,
        failed = false;
  const VaultFetch.failed()
      : blob = null,
        confirmedEmpty = false,
        failed = true;

  final String? blob;
  final bool confirmedEmpty;
  final bool failed;

  /// True when the server answered authoritatively (blob or confirmed-empty).
  bool get ok => !failed;
}
