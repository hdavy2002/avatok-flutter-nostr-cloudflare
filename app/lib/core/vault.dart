import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:pointycastle/export.dart' show SHA256Digest;

import 'api_auth.dart';
import 'config.dart';

/// Client-side encrypted "vault" sync. Stores opaque blobs on the server keyed
/// by (npub, kind) so per-user data — currently the contact list — follows the
/// user to any device. The blob is encrypted with a key DERIVED FROM the user's
/// Nostr private key, so only the user's devices (which restore that key) can
/// read it; the server stores ciphertext only.
class Vault {
  static final _aes = AesGcm.with256bits();

  /// Deterministic 256-bit key from the private key hex — same on every device
  /// that restores the key, so blobs written on one device decrypt on another.
  static SecretKey _key(String privHex) {
    final d = SHA256Digest().process(
        Uint8List.fromList(utf8.encode('avatok-vault-v1:$privHex')));
    return SecretKey(d.sublist(0, 32));
  }

  static Future<String> encrypt(String plain, String privHex) async {
    final box = await _aes.encrypt(utf8.encode(plain), secretKey: _key(privHex));
    return 'v1.${base64Url.encode(box.nonce)}.${base64Url.encode(box.cipherText)}.${base64Url.encode(box.mac.bytes)}';
  }

  static Future<String?> decrypt(String blob, String privHex) async {
    try {
      final p = blob.split('.');
      if (p.length != 4 || p[0] != 'v1') return null;
      final clear = await _aes.decrypt(
        SecretBox(base64Url.decode(p[2]), nonce: base64Url.decode(p[1]), mac: Mac(base64Url.decode(p[3]))),
        secretKey: _key(privHex),
      );
      return utf8.decode(clear);
    } catch (_) {
      return null;
    }
  }

  /// Upload an already-encrypted blob for [kind]. Best-effort (silent on failure).
  static Future<void> put(String kind, String encBlob) async {
    try {
      await ApiAuth.postJson(kVaultUrl, {'kind': kind, 'blob': encBlob});
    } catch (_) {/* best-effort sync */}
  }

  /// Fetch the encrypted blob for [kind], or null if none / offline.
  static Future<String?> get(String kind) async {
    try {
      final r = await ApiAuth.getSigned('$kVaultUrl?kind=$kind');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final b = j['blob'];
      return (b == null || b.toString().isEmpty) ? null : b.toString();
    } catch (_) {
      return null;
    }
  }
}
