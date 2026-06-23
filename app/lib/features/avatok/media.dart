import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/library_api.dart';
import '../../core/vault.dart';
import '../../identity/identity.dart';

String _short(String s) => s.length <= 14 ? s : '${s.substring(0, 8)}…${s.substring(s.length - 4)}';

enum MediaKind { image, video, audio, file }

/// A media attachment in a chat — references ciphertext on R2 by content hash,
/// plus the per-blob AES key (held locally; sent alongside the message over the
/// Cloudflare-native transport).
class ChatMedia {
  final MediaKind kind;
  final String id;        // sha256 of ciphertext (R2 key)
  final String keyB64;    // base64 AES-256 key
  final String nonceB64;  // base64 96-bit nonce
  final String macB64;    // base64 GCM tag
  final String contentType;
  final String name;
  final int size;
  /// Optional caption typed alongside the attachment. Rides in the SAME message
  /// envelope (WhatsApp-style) so the photo + its text are ONE bubble — and so an
  /// `@ava` instruction stays attached to the file it refers to (the server reads
  /// `cap` to link the request to this attachment).
  final String caption;
  ChatMedia({
    required this.kind, required this.id, required this.keyB64,
    required this.nonceB64, required this.macB64,
    required this.contentType, required this.name, required this.size,
    this.caption = '',
  });

  String get downloadUrl => '$kBlossomBaseUrl/$id';

  /// Envelope sent inside an encrypted DM so the recipient can fetch + decrypt.
  Map<String, dynamic> toEnvelope() => {
        't': 'media', 'kind': kind.name, 'id': id, 'k': keyB64, 'n': nonceB64,
        'mac': macB64, 'ct': contentType, 'name': name, 'size': size,
        if (caption.isNotEmpty) 'cap': caption,
      };

  static ChatMedia fromEnvelope(Map<String, dynamic> j) => ChatMedia(
        kind: MediaKind.values.byName(j['kind'].toString()),
        id: j['id'].toString(),
        keyB64: j['k'].toString(),
        nonceB64: j['n'].toString(),
        macB64: j['mac'].toString(),
        contentType: j['ct'].toString(),
        name: j['name'].toString(),
        size: (j['size'] as num?)?.toInt() ?? 0,
        caption: (j['cap'] ?? '').toString(),
      );

  /// Copy with a caption attached (set after the picker's caption step, before
  /// the envelope is sent).
  ChatMedia withCaption(String c) => ChatMedia(
        kind: kind, id: id, keyB64: keyB64, nonceB64: nonceB64, macB64: macB64,
        contentType: contentType, name: name, size: size, caption: c,
      );
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
    String caption = '',
  }) async {
    final secretKey = await _aes.newSecretKey();
    final nonce = _aes.newNonce();
    final box = await _aes.encrypt(bytes, secretKey: secretKey, nonce: nonce);
    final keyBytes = await secretKey.extractBytes();

    final res = await ApiAuth.postBytes(
      kUploadPrivateUrl,
      box.cipherText,
      // The bytes are opaque ciphertext; these headers let the server categorise
      // the sender's AvaLibrary entry (never used to scan — it can't read them).
      extraHeaders: {
        'x-content-type': contentType,
        'x-real-mime': contentType,
        'x-file-name': name,
        'x-app': 'avatok',
      },
      timeout: const Duration(seconds: 60),
    );
    if (res.statusCode != 200) {
      AvaLog.I.log('media', 'UPLOAD FAILED kind=${kind.name} ${bytes.length}B -> HTTP ${res.statusCode}');
      // Telemetry (email rides in the envelope): a failed upload is why a sent
      // attachment never appears for the peer — pinpointable by user + status.
      Analytics.capture('chat_media_upload_failed', {
        'kind': kind.name, 'status': res.statusCode, 'size': bytes.length,
      });
      throw MediaUploadException('upload failed (${res.statusCode})');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    AvaLog.I.log('media', 'upload ok kind=${kind.name} ${bytes.length}B key=${_short((j['key'] ?? j['hash'] ?? '').toString())}');
    final media = ChatMedia(
      kind: kind,
      // `key` is the per-user R2 path (u/<npub>/<hash>); downloadUrl is built from it.
      id: (j['key'] ?? j['hash'] ?? j['id']).toString(),
      keyB64: base64Encode(keyBytes),
      nonceB64: base64Encode(nonce),
      macB64: base64Encode(box.mac.bytes),
      contentType: contentType,
      name: name,
      size: bytes.length,
      caption: caption,
    );
    // Cache the SENDER's own plaintext now (content-addressed by id). Without
    // this, reopening the chat re-downloaded + re-decrypted media we just sent;
    // now our own photos/videos/voice/files load instantly local-first too.
    await _cacheWrite(media.id, bytes);
    return media;
  }

  /// Fetches ciphertext by hash and decrypts back to plaintext bytes.
  /// Local-first: decrypted media is content-addressed (immutable), so we cache
  /// the plaintext on disk (per-account) — reopening a chat or returning from
  /// another app never re-downloads or re-decrypts. This is the standard for all
  /// chat media (images, voice, video, files) across every AvaVerse app.
  static Future<Uint8List> downloadAndDecrypt(ChatMedia m) async {
    final cached = await _cacheRead(m.id);
    if (cached != null) {
      AvaLog.I.log('media', 'download cache-HIT kind=${m.kind.name} key=${_short(m.id)} ${cached.length}B');
      return cached;
    }
    final t0 = DateTime.now().millisecondsSinceEpoch;
    http.Response res;
    try {
      res = await http.get(Uri.parse(m.downloadUrl)).timeout(const Duration(seconds: 60));
    } catch (e) {
      AvaLog.I.log('media', 'download ERROR kind=${m.kind.name} key=${_short(m.id)}: $e');
      Analytics.capture('chat_media_load_failed', {
        'kind': m.kind.name, 'stage': 'download', 'err': e.toString(),
      });
      rethrow;
    }
    if (res.statusCode != 200) {
      AvaLog.I.log('media', 'download FAILED kind=${m.kind.name} key=${_short(m.id)} -> HTTP ${res.statusCode}');
      Analytics.capture('chat_media_load_failed', {
        'kind': m.kind.name, 'stage': 'download', 'status': res.statusCode,
      });
      throw MediaUploadException('download failed (${res.statusCode})');
    }
    try {
      final box = SecretBox(
        res.bodyBytes,
        nonce: base64Decode(m.nonceB64),
        mac: Mac(base64Decode(m.macB64)),
      );
      final clear = await _aes.decrypt(box, secretKey: SecretKey(base64Decode(m.keyB64)));
      final bytes = Uint8List.fromList(clear);
      await _cacheWrite(m.id, bytes);
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      AvaLog.I.log('media', 'download+decrypt ok kind=${m.kind.name} key=${_short(m.id)} ${res.bodyBytes.length}B->${bytes.length}B ${ms}ms');
      return bytes;
    } catch (e) {
      // A MAC/key mismatch means the envelope and the ciphertext disagree — the
      // recipient would see "nothing happens". Surface it instead of swallowing.
      AvaLog.I.log('media', 'DECRYPT FAILED kind=${m.kind.name} key=${_short(m.id)} ${res.bodyBytes.length}B: $e');
      Analytics.capture('chat_media_load_failed', {
        'kind': m.kind.name, 'stage': 'decrypt', 'err': e.toString(),
      });
      rethrow;
    }
  }

  /// Records a RECEIVED DM attachment into the recipient's AvaLibrary so it shows
  /// up cross-device, scoped to their account. The per-blob AES key is encrypted
  /// to the recipient via the Vault (key derived from THEIR Nostr key) before it
  /// leaves the device — the server only ever stores ciphertext, never plaintext
  /// keys (E2E boundary preserved). Best-effort: failure never blocks the chat.
  static Future<void> recordReceived(ChatMedia m, {String app = 'avatok'}) async {
    try {
      final id = ApiAuth.identity;
      String? encBlob;
      if (id != null) {
        // Wrap just the decryption material (key/nonce/mac) — not the bytes.
        final material = jsonEncode({'k': m.keyB64, 'n': m.nonceB64, 'mac': m.macB64});
        encBlob = await Vault.encrypt(material, id.privHex);
      }
      await LibraryApi.record(
        key: m.id, mime: m.contentType, size: m.size, name: m.name,
        app: app, encBlob: encBlob, displayUrl: m.downloadUrl,
      );
    } catch (e) {/* best-effort — local view still works */
      AvaLog.I.log('media', 'recordReceived failed key=${_short(m.id)}: $e');
    }
  }

  // ---- per-account on-disk media cache ----
  static Future<Directory> _cacheDir() async {
    final base = await getApplicationSupportDirectory();
    final scope = AccountScope.id == null || AccountScope.id!.isEmpty ? 'default' : AccountScope.id!;
    final d = Directory('${base.path}/media/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static String _cacheName(String id) => id.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');

  static Future<Uint8List?> _cacheRead(String id) async {
    try {
      final f = File('${(await _cacheDir()).path}/${_cacheName(id)}');
      if (await f.exists() && await f.length() > 0) return await f.readAsBytes();
    } catch (_) {/* miss */}
    return null;
  }

  static Future<void> _cacheWrite(String id, Uint8List bytes) async {
    try {
      final f = File('${(await _cacheDir()).path}/${_cacheName(id)}');
      await f.writeAsBytes(bytes, flush: true);
    } catch (_) {/* best-effort */}
  }
}

class MediaUploadException implements Exception {
  final String message;
  MediaUploadException(this.message);
  @override
  String toString() => message;
}
