import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;

import '../../core/config.dart';

enum MediaKind { image, video, audio, file }

/// A media attachment in a chat — references ciphertext on R2 by content hash,
/// plus the per-blob AES key (held locally; in full E2E this key travels inside
/// the NIP-44/MLS-encrypted message envelope).
class ChatMedia {
  final MediaKind kind;
  final String id;        // sha256 of ciphertext (R2 key)
  final String keyB64;    // base64 AES-256 key
  final String nonceB64;  // base64 96-bit nonce
  final String macB64;    // base64 GCM tag
  final String contentType;
  final String name;
  final int size;
  ChatMedia({
    required this.kind, required this.id, required this.keyB64,
    required this.nonceB64, required this.macB64,
    required this.contentType, required this.name, required this.size,
  });

  String get downloadUrl => '$kMediaUrl/$id';
}

/// Encrypts media client-side (AES-GCM-256) and uploads ciphertext to the Worker,
/// which stores it content-addressed on R2. The server only ever holds ciphertext.
class MediaService {
  static final _aes = AesGcm.with256bits();

  static Future<ChatMedia> encryptAndUpload(
    Uint8List bytes, {
    required MediaKind kind,
    required String contentType,
    required String name,
  }) async {
    final secretKey = await _aes.newSecretKey();
    final nonce = _aes.newNonce();
    final box = await _aes.encrypt(bytes, secretKey: secretKey, nonce: nonce);
    final keyBytes = await secretKey.extractBytes();

    final res = await http
        .post(Uri.parse(kMediaUrl),
            headers: {'x-content-type': contentType},
            body: Uint8List.fromList(box.cipherText))
        .timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) {
      throw MediaUploadException('upload failed (${res.statusCode})');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return ChatMedia(
      kind: kind,
      id: j['id'].toString(),
      keyB64: base64Encode(keyBytes),
      nonceB64: base64Encode(nonce),
      macB64: base64Encode(box.mac.bytes),
      contentType: contentType,
      name: name,
      size: bytes.length,
    );
  }

  /// Fetches ciphertext by hash and decrypts back to plaintext bytes.
  static Future<Uint8List> downloadAndDecrypt(ChatMedia m) async {
    final res = await http.get(Uri.parse(m.downloadUrl)).timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) {
      throw MediaUploadException('download failed (${res.statusCode})');
    }
    final box = SecretBox(
      res.bodyBytes,
      nonce: base64Decode(m.nonceB64),
      mac: Mac(base64Decode(m.macB64)),
    );
    final clear = await _aes.decrypt(box,
        secretKey: SecretKey(base64Decode(m.keyB64)));
    return Uint8List.fromList(clear);
  }
}

class MediaUploadException implements Exception {
  final String message;
  MediaUploadException(this.message);
  @override
  String toString() => message;
}
