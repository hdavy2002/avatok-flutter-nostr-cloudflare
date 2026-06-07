import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Encrypts the user's Nostr private key with their account password so it can be
/// safely backed up to the server (clerk_nostr_link.encrypted_nsec_backup) and
/// restored after logging in on a new device. The server only ever sees the
/// ciphertext — it cannot derive the key without the password.
///
/// Scheme (recorded in `method`): PBKDF2-HMAC-SHA256 (210k iters) derives a
/// 256-bit key from the password + a random salt; AES-256-GCM encrypts the
/// private-key hex with a random nonce. Output is a compact dotted string:
///   v1.<saltB64>.<nonceB64>.<cipherB64>.<macB64>
class KeyBackup {
  static const String method = 'pbkdf2s256-aesgcm-v1';
  static const int _iterations = 210000;

  static final _kdf = Pbkdf2(
    macAlgorithm: Hmac.sha256(),
    iterations: _iterations,
    bits: 256,
  );
  static final _aes = AesGcm.with256bits();

  static String _b64(List<int> b) => base64Url.encode(b);
  static Uint8List _unb64(String s) => Uint8List.fromList(base64Url.decode(s));

  static List<int> _randomBytes(int n) {
    final r = Random.secure();
    return List<int>.generate(n, (_) => r.nextInt(256));
  }

  static Future<SecretKey> _deriveKey(String password, List<int> salt) =>
      _kdf.deriveKey(
        secretKey: SecretKey(utf8.encode(password)),
        nonce: salt,
      );

  /// Encrypt [privHex] (the 64-char hex private key) with [password].
  static Future<String> encryptSecret(String privHex, String password) async {
    final salt = _randomBytes(16);
    final key = await _deriveKey(password, salt);
    // nonce omitted → AES-GCM generates a fresh random one, returned on the box.
    final box = await _aes.encrypt(utf8.encode(privHex), secretKey: key);
    return 'v1.${_b64(salt)}.${_b64(box.nonce)}.${_b64(box.cipherText)}.${_b64(box.mac.bytes)}';
  }

  /// Decrypt a backup blob with [password]. Returns the private-key hex, or null
  /// if the password is wrong or the blob is malformed/tampered.
  static Future<String?> decryptSecret(String blob, String password) async {
    try {
      final parts = blob.split('.');
      if (parts.length != 5 || parts[0] != 'v1') return null;
      final salt = _unb64(parts[1]);
      final nonce = _unb64(parts[2]);
      final cipher = _unb64(parts[3]);
      final mac = _unb64(parts[4]);
      final key = await _deriveKey(password, salt);
      final clear = await _aes.decrypt(
        SecretBox(cipher, nonce: nonce, mac: Mac(mac)),
        secretKey: key,
      );
      return utf8.decode(clear);
    } catch (_) {
      return null; // wrong password (MAC fails) or corrupt data
    }
  }
}
