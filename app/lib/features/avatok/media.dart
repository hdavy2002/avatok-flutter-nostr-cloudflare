import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../../core/analytics.dart';
import '../../core/account_key.dart';
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

  // [CHAT-UPLOAD-1] When a live call is in progress the caller passes inCall:true.
  // A full-speed upload saturates the uplink and starves WebRTC (evidence: a PDF
  // upload triggered a both-sides reconnect). While in-call we (a) run the AES
  // encryption off the UI isolate (compute) and (b) pace the ciphertext PUT at
  // ~200 KB/s so the call keeps its bandwidth; off-call we upload full speed.
  static const int _kInCallUploadBytesPerSec = 200 * 1024;

  // [MEDIA-INSTANT-1c] The off-main-thread `compute()` encryption path used to
  // be gated ONLY on `inCall` — so a large photo/video sent off-call encrypted
  // synchronously on the UI isolate and janked right after its bubble
  // appeared (audit F item 4). Any attachment over this size now takes the
  // isolate path regardless of call state; small attachments stay on the
  // cheap async path (isolate spin-up cost isn't worth it for a few KB).
  static const int _kIsolateEncryptThresholdBytes = 1536 * 1024; // 1.5 MB

  static Future<ChatMedia> encryptAndUpload(
    Uint8List bytes, {
    required MediaKind kind,
    required String contentType,
    required String name,
    String caption = '',
    bool inCall = false,
  }) async {
    final secretKey = await _aes.newSecretKey();
    final nonce = _aes.newNonce();
    final keyBytes = await secretKey.extractBytes();
    // (a) Encrypt off the main thread when a call is live (never jank the call
    // UI) OR when the payload is large enough that synchronous AES-GCM would
    // jank the UI thread right after the bubble appears [MEDIA-INSTANT-1c].
    final bool useIsolate = inCall || bytes.length > _kIsolateEncryptThresholdBytes;
    final _EncResult enc = useIsolate
        ? await compute(_encryptInIsolate,
            _EncInput(bytes: bytes, key: Uint8List.fromList(keyBytes), nonce: Uint8List.fromList(nonce)))
        : await () async {
            final box = await _aes.encrypt(bytes, secretKey: secretKey, nonce: nonce);
            return _EncResult(
                cipherText: Uint8List.fromList(box.cipherText),
                mac: Uint8List.fromList(box.mac.bytes));
          }();

    final extraHeaders = {
      // The bytes are opaque ciphertext; these headers let the server categorise
      // the sender's AvaLibrary entry (never used to scan — it can't read them).
      'x-content-type': contentType,
      'x-real-mime': contentType,
      'x-file-name': name,
      'x-app': 'avatok',
    };
    // (b) In-call → paced streamed PUT; otherwise the normal single POST.
    final http.Response res = inCall
        ? await _pacedUpload(enc.cipherText, extraHeaders)
        : await ApiAuth.postBytes(
            kUploadPrivateUrl,
            enc.cipherText,
            extraHeaders: extraHeaders,
            timeout: const Duration(seconds: 60),
          );
    if (inCall) {
      Analytics.capture('chat_upload_during_call', {
        'size': bytes.length, 'kind': kind.name, 'paced': true,
      });
    }
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
      // `key` is the per-user R2 path (u/<uid>/<hash>); downloadUrl is built from it.
      id: (j['key'] ?? j['hash'] ?? j['id']).toString(),
      keyB64: base64Encode(keyBytes),
      nonceB64: base64Encode(nonce),
      macB64: base64Encode(enc.mac),
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

  /// [CHAT-UPLOAD-1] Paced PUT of the ciphertext: emits the body in ~32 KB chunks
  /// spaced so throughput stays under [_kInCallUploadBytesPerSec], leaving uplink
  /// headroom for the live WebRTC call. Auth is a Bearer JWT (no body HMAC), so a
  /// StreamedRequest is signature-safe. Never blocks the UI (runs on the event
  /// loop between paced delays).
  static Future<http.Response> _pacedUpload(
      Uint8List cipherText, Map<String, String> extraHeaders) async {
    final headers = await ApiAuth.signedHeaders('POST', kUploadPrivateUrl, extra: extraHeaders);
    headers.remove('Content-Type'); // opaque ciphertext, not JSON
    headers['Content-Type'] = 'application/octet-stream';
    final req = http.StreamedRequest('POST', Uri.parse(kUploadPrivateUrl));
    req.headers.addAll(headers);
    req.contentLength = cipherText.length;

    const chunk = 32 * 1024;
    const perChunkMs = (chunk * 1000) ~/ _kInCallUploadBytesPerSec; // ~156ms/32KB
    // Feed the sink on a paced schedule; do NOT await here or the request never
    // gets sent. send() below awaits the response.
    () async {
      var off = 0;
      try {
        while (off < cipherText.length) {
          final end = (off + chunk < cipherText.length) ? off + chunk : cipherText.length;
          req.sink.add(cipherText.sublist(off, end));
          off = end;
          if (off < cipherText.length) {
            await Future<void>.delayed(const Duration(milliseconds: perChunkMs));
          }
        }
      } finally {
        await req.sink.close();
      }
    }();

    final streamed = await http.Client().send(req).timeout(const Duration(seconds: 180));
    return http.Response.fromStream(streamed);
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
      String? encBlob;
      final keyMat = await AccountKey.I.ensureHex();
      if (keyMat != null) {
        // Wrap just the decryption material (key/nonce/mac) — not the bytes.
        final material = jsonEncode({'k': m.keyB64, 'n': m.nonceB64, 'mac': m.macB64});
        encBlob = await Vault.encrypt(material, keyMat);
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

  // ---- public plaintext-blob cache (reuses the per-account media dir) ----
  // For owner-authed media that is NOT an encrypted DM attachment — e.g. an Ava
  // Receptionist voicemail recording. The server already gates access, so we
  // cache the plaintext bytes locally, keyed by a caller-supplied id, so a
  // replay/reopen loads on-device instead of re-downloading. Scoped per account
  // like all other media (parent + child share a phone).
  static Future<Uint8List?> cachedBlob(String key) => _cacheRead(key);

  static Future<void> writeBlob(String key, Uint8List bytes) =>
      _cacheWrite(key, bytes);
}

class MediaUploadException implements Exception {
  final String message;
  MediaUploadException(this.message);
  @override
  String toString() => message;
}

// ---- [CHAT-UPLOAD-1] off-main-thread AES-GCM encryption ----
class _EncInput {
  final Uint8List bytes;
  final Uint8List key;
  final Uint8List nonce;
  _EncInput({required this.bytes, required this.key, required this.nonce});
}

class _EncResult {
  final Uint8List cipherText;
  final Uint8List mac;
  _EncResult({required this.cipherText, required this.mac});
}

/// Runs on a background isolate via `compute` so a large in-call attachment's
/// encryption never janks the call UI.
Future<_EncResult> _encryptInIsolate(_EncInput inp) async {
  final aes = AesGcm.with256bits();
  final box = await aes.encrypt(inp.bytes,
      secretKey: SecretKey(inp.key), nonce: inp.nonce);
  return _EncResult(
    cipherText: Uint8List.fromList(box.cipherText),
    mac: Uint8List.fromList(box.mac.bytes),
  );
}
