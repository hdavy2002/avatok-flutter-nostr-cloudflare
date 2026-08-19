import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
// [CHAT-MEDIA-THUMB-1] `dart:ui` is the PLATFORM image decoder. It is imported
// with the `ui` prefix (there is nothing else named `ui` in this file) purely
// for `ImmutableBuffer`/`ImageDescriptor`/`Codec`, which can decode a JPEG
// DIRECTLY at a target size — see [_downscale].
import 'dart:ui' as ui;

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
// [CHAT-MEDIA-THUMB-1] Only ever used to RE-ENCODE an already-downscaled
// (<=480px) bitmap to JPEG. It never decodes, and never sees a full-size image.
import 'package:image/image.dart' as img;
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

  /// [AVA-VOICE-PLAINTEXT-1] `'blossom'` (default, unchanged) = client-side
  /// AES-GCM ciphertext on the public bucket — [downloadUrl] is valid, correct
  /// client-side URL math. `'digital'` = MVP unencrypted voice notes (owner
  /// decision 2026-07-25, `RemoteConfig.voiceNoteEncryptionEnabled == false`):
  /// PLAINTEXT bytes the server can read, stored in the PRIVATE `digital` R2
  /// bucket (worker/src/routes/media.ts `uploadPrivate` `x-encrypted: 0`) —
  /// never public, never client-URL-computable. [keyB64]/[nonceB64]/[macB64]
  /// are meaningless (empty) for `'digital'`: there is nothing to decrypt.
  final String storage;

  /// [AVA-VOICE-PLAINTEXT-1] For `storage == 'digital'` ONLY: the presigned
  /// URL minted by the server at upload/receive time (900s TTL —
  /// `presignDigitalReadUrl`, worker/src/routes/media.ts). This is a FIRST-
  /// FETCH convenience, never a permanent reference — once
  /// [MediaService.downloadPlaintext] has fetched the bytes once they are
  /// cached on-device forever (same local-first contract as the encrypted
  /// path) and this URL is never needed again for that device. If it has gone
  /// stale before the first fetch (chat reopened long after send/receive),
  /// [MediaService.downloadPlaintext] falls back to a best-effort AvaLibrary
  /// round-trip — see that method's doc comment.
  final String? digitalUrl;

  ChatMedia({
    required this.kind, required this.id, required this.keyB64,
    required this.nonceB64, required this.macB64,
    required this.contentType, required this.name, required this.size,
    this.caption = '',
    this.storage = 'blossom',
    this.digitalUrl,
  });

  /// Only correct client-side URL math for `storage == 'blossom'` (the public,
  /// content-addressed bucket). For `storage == 'digital'` this is NOT a
  /// fetchable URL — use [MediaService.downloadPlaintext] instead, which knows
  /// how to resolve/refresh the private presigned URL. Left as a plain string
  /// (not deprecated/removed) because every existing `storage == 'blossom'`
  /// call site still depends on it being a cheap synchronous getter.
  String get downloadUrl => '$kBlossomBaseUrl/$id';

  bool get isServerReadable => storage == 'digital';

  /// Envelope sent inside a DM so the recipient can fetch (+ decrypt, when
  /// `storage == 'blossom'`). `storage`/`url` are only emitted for the
  /// `'digital'` case — omitted entirely for ordinary encrypted media so an
  /// old/unaffected build's `fromEnvelope` (which defaults both) round-trips
  /// byte-for-byte exactly as it did before this change.
  Map<String, dynamic> toEnvelope() => {
        't': 'media', 'kind': kind.name, 'id': id, 'k': keyB64, 'n': nonceB64,
        'mac': macB64, 'ct': contentType, 'name': name, 'size': size,
        if (caption.isNotEmpty) 'cap': caption,
        if (storage != 'blossom') 'storage': storage,
        if (digitalUrl != null && digitalUrl!.isNotEmpty) 'url': digitalUrl,
      };

  static ChatMedia fromEnvelope(Map<String, dynamic> j) => ChatMedia(
        kind: MediaKind.values.byName(j['kind'].toString()),
        id: j['id'].toString(),
        keyB64: (j['k'] ?? '').toString(),
        nonceB64: (j['n'] ?? '').toString(),
        macB64: (j['mac'] ?? '').toString(),
        contentType: j['ct'].toString(),
        name: j['name'].toString(),
        size: (j['size'] as num?)?.toInt() ?? 0,
        caption: (j['cap'] ?? '').toString(),
        storage: (j['storage'] ?? 'blossom').toString(),
        digitalUrl: j['url']?.toString(),
      );

  /// Copy with a caption attached (set after the picker's caption step, before
  /// the envelope is sent).
  ChatMedia withCaption(String c) => ChatMedia(
        kind: kind, id: id, keyB64: keyB64, nonceB64: nonceB64, macB64: macB64,
        contentType: contentType, name: name, size: size, caption: c,
        storage: storage, digitalUrl: digitalUrl,
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
    // [CHAT-MEDIA-THUMB-1] …and derive the sender's own thumbnail from the
    // bytes already in hand, so reopening a thread with a photo I JUST sent
    // takes the instant path too. Fire-and-forget, off the send path.
    if (kind == MediaKind.image) ensureThumb(media.id, bytes: bytes);
    return media;
  }

  /// [AVA-VOICE-PLAINTEXT-1] Uploads PLAINTEXT bytes — NO client-side AES —
  /// via the SAME `/upload/private` endpoint [encryptAndUpload] uses, but with
  /// `x-encrypted: 0` (worker/src/routes/media.ts `uploadPrivate`). MVP voice
  /// notes (owner decision 2026-07-25, CLAUDE.md): while
  /// `RemoteConfig.voiceNoteEncryptionEnabled` is false, a recorded voice note
  /// goes through this path instead of [encryptAndUpload] so Ava's transcribe/
  /// translate jobs can actually read the bytes.
  ///
  /// UNENCRYPTED DOES NOT MEAN PUBLIC: the server stores this in the PRIVATE
  /// `digital` R2 bucket (never the public `blossom` bucket an "unguessable
  /// path" would be), and every later read (this device or the recipient's) is
  /// authorization-gated to conversation membership and served only via a
  /// short-lived (900s) presigned URL — never a permanent public link. This is
  /// the exact `storage: 'digital'` distinction [ChatMedia.storage] documents.
  static Future<ChatMedia> uploadPlaintext(
    Uint8List bytes, {
    required MediaKind kind,
    required String contentType,
    required String name,
    String caption = '',
  }) async {
    final extraHeaders = {
      'x-real-mime': contentType,
      'x-file-name': name,
      'x-app': 'avatok',
      'x-encrypted': '0',
    };
    final http.Response res = await ApiAuth.postBytes(
      kUploadPrivateUrl,
      bytes,
      extraHeaders: extraHeaders,
      timeout: const Duration(seconds: 60),
    );
    if (res.statusCode != 200) {
      AvaLog.I.log('media', 'PLAINTEXT UPLOAD FAILED kind=${kind.name} ${bytes.length}B -> HTTP ${res.statusCode}');
      Analytics.capture('chat_media_upload_failed', {
        'kind': kind.name, 'status': res.statusCode, 'size': bytes.length, 'storage': 'digital',
      });
      throw MediaUploadException('upload failed (${res.statusCode})');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final id = (j['key'] ?? j['hash'] ?? '').toString();
    final url = (j['url'] ?? '').toString();
    AvaLog.I.log('media', 'plaintext upload ok kind=${kind.name} ${bytes.length}B key=${_short(id)}');
    final media = ChatMedia(
      kind: kind,
      id: id,
      keyB64: '', nonceB64: '', macB64: '', // nothing to decrypt — plaintext on the wire
      contentType: contentType,
      name: name,
      size: bytes.length,
      caption: caption,
      storage: 'digital',
      digitalUrl: url.isNotEmpty ? url : null,
    );
    // Sender caches its own plaintext immediately, exactly like the encrypted
    // path — after this, `media.digitalUrl` is never needed again on THIS
    // device even once it expires.
    await _cacheWrite(media.id, bytes);
    return media;
  }

  /// Creates a temporary server-readable copy of an already-decrypted
  /// Messenger attachment after the user explicitly approves Ava analysis.
  /// The original E2E-encrypted attachment is never replaced or re-keyed.
  static Future<ChatMedia> uploadReadableCopyForAva(
    Uint8List bytes, {
    required ChatMedia source,
    required MediaKind kind,
    required String contentType,
    required String name,
  }) async {
    final extraHeaders = {
      'x-real-mime': contentType,
      'x-file-name': name,
      'x-app': 'ava',
      'x-encrypted': '0',
      'x-ava-readable': '1',
      'x-ava-approval': '1',
      'x-source-media-id': source.id,
    };
    final res = await ApiAuth.postBytes(
      kUploadPrivateUrl,
      bytes,
      extraHeaders: extraHeaders,
      timeout: const Duration(seconds: 60),
    );
    if (res.statusCode != 200) {
      Analytics.capture('ava_readable_copy_failed', {
        'kind': kind.name, 'status': res.statusCode, 'size': bytes.length,
      });
      throw MediaUploadException('Ava approval upload failed (${res.statusCode})');
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final id = (j['id'] ?? j['key'] ?? j['hash'] ?? '').toString();
    final url = (j['url'] ?? '').toString();
    final copy = ChatMedia(
      kind: kind,
      id: id,
      keyB64: '', nonceB64: '', macB64: '',
      contentType: contentType,
      name: name,
      size: bytes.length,
      storage: 'digital',
      digitalUrl: url.isNotEmpty ? url : null,
    );
    await _cacheWrite(copy.id, bytes);
    Analytics.capture('ava_readable_copy_created', {
      'kind': kind.name, 'size': bytes.length,
    });
    return copy;
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
    // [AVA-VOICE-PLAINTEXT-1] `storage=='digital'` (MVP unencrypted voice
    // notes) has no ciphertext to decrypt — dispatch to the plaintext path so
    // every EXISTING caller of this method (share, transcribe, voice-bubble
    // playback…) gets unencrypted-voice-note support with no call-site
    // changes required.
    if (m.storage == 'digital') return _downloadPlaintext(m);
    final tRead = DateTime.now().millisecondsSinceEpoch;
    final cached = await _cacheRead(m.id);
    if (cached != null) {
      AvaLog.I.log('media', 'download cache-HIT kind=${m.kind.name} key=${_short(m.id)} ${cached.length}B');
      // [CHAT-MEDIA-FIRSTFRAME-1] A disk hit is still 4 async hops, so it can
      // never paint on frame 1 — the ms here is what `peekFile` removes.
      noteCacheEvent('hit',
          source: 'disk',
          ms: DateTime.now().millisecondsSinceEpoch - tRead,
          bytes: cached.length);
      // [CHAT-MEDIA-THUMB-1] Backfill: we are already holding the plaintext of
      // a photo that has no thumbnail yet — derive one now so the NEXT open
      // takes the instant thumb path. Fire-and-forget, no-op if it exists.
      if (m.kind == MediaKind.image) ensureThumb(m.id, bytes: cached);
      return cached;
    }
    final t0 = DateTime.now().millisecondsSinceEpoch;
    http.Response res;
    try {
      res = await http.get(Uri.parse(m.downloadUrl)).timeout(const Duration(seconds: 60));
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] Never the full `e.toString()` — `http.ClientException`
      // embeds the request `uri=…` (query string included), so a classified type
      // + the scrubbing `captureException` path (analytics.dart `_scrub`) is used
      // instead of a free-text error field.
      AvaLog.I.log('media', 'download ERROR kind=${m.kind.name} key=${_short(m.id)} err=${e.runtimeType}');
      await Analytics.captureException(e, st, screen: 'media_download', handled: true,
          extra: {'kind': m.kind.name, 'stage': 'download'});
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
      noteCacheEvent('miss', source: 'network', ms: ms, bytes: bytes.length);
      // [CHAT-MEDIA-THUMB-1] First-ever view of this photo: derive the
      // thumbnail from the bytes we just decrypted (no second read, no second
      // decode of the full file). Fire-and-forget.
      if (m.kind == MediaKind.image) ensureThumb(m.id, bytes: bytes);
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

  /// Reads an AvaLibrary item through the same local-first media path as chat.
  /// Library entries used to be treated as metadata only, which made every
  /// private audio/video tile refuse playback even when it had the encrypted
  /// key material needed to open it.
  static Future<Uint8List> downloadLibraryItem(LibraryItem item) async {
    if (item.key.isEmpty) throw MediaUploadException('file has no storage key');
    final cached = await _cacheRead(item.key);
    if (cached != null) return cached;

    // Public files and server-readable private digital files have a usable
    // display URL. Private E2E files must be rebuilt from enc_blob below.
    final url = item.displayUrl;
    final isPresigned = url.contains('X-Amz-Signature') || url.contains('x-amz-signature');
    if (!item.isPrivate || isPresigned) {
      if (url.isEmpty) throw MediaUploadException('file has no readable URL');
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) {
        throw MediaUploadException('file download failed (${res.statusCode})');
      }
      final bytes = Uint8List.fromList(res.bodyBytes);
      await _cacheWrite(item.key, bytes);
      return bytes;
    }

    final blob = item.encBlob ?? '';
    if (blob.isEmpty) throw MediaUploadException('private file has no decryption material');
    final keyMat = await AccountKey.I.ensureHex();
    if (keyMat == null || keyMat.isEmpty) throw MediaUploadException('account key unavailable');
    final clear = await Vault.decrypt(blob, keyMat);
    if (clear == null || clear.isEmpty) throw MediaUploadException('private file key unavailable');
    final j = jsonDecode(clear) as Map<String, dynamic>;
    final kind = item.category == 'video' || item.mime.startsWith('video/')
        ? MediaKind.video
        : item.category == 'audio' || item.mime.startsWith('audio/')
            ? MediaKind.audio
            : item.category == 'image' || item.mime.startsWith('image/')
                ? MediaKind.image
                : MediaKind.file;
    return downloadAndDecrypt(ChatMedia(
      kind: kind,
      id: item.key,
      keyB64: (j['k'] ?? '').toString(),
      nonceB64: (j['n'] ?? '').toString(),
      macB64: (j['mac'] ?? '').toString(),
      contentType: item.mime,
      name: item.name,
      size: item.size,
    ));
  }

  /// Records a RECEIVED DM attachment into the recipient's AvaLibrary so it shows
  /// up cross-device, scoped to their account. The per-blob AES key is encrypted
  /// to the recipient via the Vault (key derived from THEIR Nostr key) before it
  /// leaves the device — the server only ever stores ciphertext, never plaintext
  /// keys (E2E boundary preserved). Best-effort: failure never blocks the chat.
  ///
  /// [conv] — [AVA-MEDIA-AUTHZ-1] REQUIRED: forwarded to [LibraryApi.record],
  /// which the server now uses to verify both the media owner and the caller
  /// belong to the same conversation before minting a presigned read URL. The
  /// caller (chat_thread.dart) must resolve a real server conversation id —
  /// never pass an empty string.
  ///
  /// [AVA-VOICE-PLAINTEXT-1] For `storage=='digital'` (MVP unencrypted voice
  /// notes) there is no decryption material to wrap — this content was never
  /// E2E-encrypted at all — so [encBlob] stays null and `storage:'digital'` is
  /// passed instead, telling the server (worker/src/routes/media.ts
  /// `libraryRecord`) to route the recipient's own Library row through the
  /// SAME private DIGITAL-bucket/presigned-URL scheme the sender used.
  static Future<void> recordReceived(ChatMedia m, {required String conv, String app = 'avatok'}) async {
    try {
      final isDigital = m.storage == 'digital';
      String? encBlob;
      if (!isDigital) {
        final keyMat = await AccountKey.I.ensureHex();
        if (keyMat != null) {
          // Wrap just the decryption material (key/nonce/mac) — not the bytes.
          final material = jsonEncode({'k': m.keyB64, 'n': m.nonceB64, 'mac': m.macB64});
          encBlob = await Vault.encrypt(material, keyMat);
        }
      }
      await LibraryApi.record(
        key: m.id, mime: m.contentType, size: m.size, name: m.name,
        conv: conv,
        app: app, encBlob: encBlob,
        displayUrl: isDigital ? m.digitalUrl : m.downloadUrl,
        storage: isDigital ? 'digital' : null,
      );
    } catch (e, st) {/* best-effort — local view still works */
      AvaLog.I.log('media', 'recordReceived failed key=${_short(m.id)} err=${e.runtimeType}');
      await Analytics.captureException(e, st, screen: 'media_record_received', handled: true,
          extra: {'kind': m.kind.name});
    }
  }

  /// [AVA-VOICE-PLAINTEXT-1] Plaintext counterpart of the ciphertext fetch
  /// above — no AES, just fetch + cache. `m.digitalUrl` (embedded in the
  /// message envelope at send/receive time) is a 900s presigned URL: good for
  /// the FIRST fetch soon after send/receive; once cached locally it is never
  /// needed again on this device (same local-first contract as encrypted
  /// media). If it has gone stale before ANY fetch ever happened (e.g. the
  /// chat is reopened long after receipt and the note was never played),
  /// falls back to a best-effort AvaLibrary round-trip
  /// ([_resolveStaleDigitalUrl]) instead of hanging or failing silently.
  static Future<Uint8List> _downloadPlaintext(ChatMedia m) async {
    final tRead = DateTime.now().millisecondsSinceEpoch;
    final cached = await _cacheRead(m.id);
    if (cached != null) {
      AvaLog.I.log('media', 'download cache-HIT(plaintext) kind=${m.kind.name} key=${_short(m.id)} ${cached.length}B');
      noteCacheEvent('hit',
          source: 'disk',
          ms: DateTime.now().millisecondsSinceEpoch - tRead,
          bytes: cached.length);
      return cached;
    }
    Future<http.Response> fetchOnce(String u) =>
        http.get(Uri.parse(u)).timeout(const Duration(seconds: 60));
    final t0 = DateTime.now().millisecondsSinceEpoch;
    http.Response? firstAttempt;
    final firstUrl = m.digitalUrl ?? '';
    if (firstUrl.isNotEmpty) {
      try { firstAttempt = await fetchOnce(firstUrl); } catch (_) { firstAttempt = null; }
    }
    // Missing/expired/unauthorized (no URL at all, or the 900s presign is
    // stale) — one best-effort round-trip re-resolve, then fail honestly.
    // `res` is a FRESH, explicitly non-nullable local assigned exactly once on
    // every reachable path below (never reassigned/promoted across branches),
    // so there is nothing for null-safety flow analysis to get wrong.
    final http.Response res;
    if (firstAttempt != null && firstAttempt.statusCode != 403 && firstAttempt.statusCode != 404) {
      res = firstAttempt;
    } else {
      final fresh = await _resolveStaleDigitalUrl(m);
      if (fresh == null || fresh.isEmpty) {
        AvaLog.I.log('media', 'download(plaintext) FAILED kind=${m.kind.name} key=${_short(m.id)}: no readable URL');
        Analytics.capture('chat_media_load_failed', {
          'kind': m.kind.name, 'stage': 'download_plaintext', 'reason': 'no_url',
        });
        throw MediaUploadException('no readable URL for this attachment');
      }
      try {
        res = await fetchOnce(fresh);
      } catch (e, st) {
        // [AVA-MEDIA-AUTHZ-1] `fresh` is a 900s SigV4 presigned URL — a bearer
        // read credential. `http.ClientException.toString()` embeds the full
        // request URI (incl. `X-Amz-Signature`), so this must never land as a
        // free-text field: classified type in the log line, full scrub via
        // captureException for PostHog.
        AvaLog.I.log('media', 'download(plaintext) ERROR kind=${m.kind.name} key=${_short(m.id)} err=${e.runtimeType}');
        await Analytics.captureException(e, st, screen: 'media_download_plaintext', handled: true,
            extra: {'kind': m.kind.name, 'stage': 'download_plaintext'});
        rethrow;
      }
    }
    if (res.statusCode != 200) {
      AvaLog.I.log('media', 'download(plaintext) FAILED kind=${m.kind.name} key=${_short(m.id)} -> HTTP ${res.statusCode}');
      Analytics.capture('chat_media_load_failed', {
        'kind': m.kind.name, 'stage': 'download_plaintext', 'status': res.statusCode,
      });
      throw MediaUploadException('download failed (${res.statusCode})');
    }
    final bytes = Uint8List.fromList(res.bodyBytes);
    await _cacheWrite(m.id, bytes);
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    AvaLog.I.log('media', 'download(plaintext) ok kind=${m.kind.name} key=${_short(m.id)} ${bytes.length}B ${ms}ms');
    noteCacheEvent('miss', source: 'network', ms: ms, bytes: bytes.length);
    return bytes;
  }

  /// Best-effort recovery when a `storage=='digital'` attachment's embedded
  /// presigned URL has gone stale AND its bytes were never fetched even once
  /// locally. There is no dedicated "resolve a fresh URL by id" route for a
  /// raw upload (unlike AI job artifacts, which re-mint `artifact_url` on
  /// every `GET /api/ai/jobs/:id` — worker/src/lib/ai_media_jobs.ts) — this
  /// reuses the EXISTING `GET /api/library` list endpoint instead
  /// (worker/src/routes/media.ts `getLibrary` re-mints `display_url` for
  /// every `storage=='digital'` row on every read), matching by this file's
  /// exact name first (server-side `file_name LIKE`; voice-note names carry a
  /// content-hash prefix so this is effectively a unique match), falling back
  /// to a name+size match. Never throws; returns null so the caller fails
  /// honestly instead of hanging.
  static Future<String?> _resolveStaleDigitalUrl(ChatMedia m) async {
    try {
      final res = await LibraryApi.list(app: 'avatok', category: 'audio', q: m.name);
      for (final it in res.items) {
        if (it.key == m.id) return it.displayUrl.isNotEmpty ? it.displayUrl : null;
      }
      for (final it in res.items) {
        if (it.name == m.name && it.size == m.size) {
          return it.displayUrl.isNotEmpty ? it.displayUrl : null;
        }
      }
    } catch (_) {/* best-effort */}
    return null;
  }

  // ---- per-account on-disk media cache ----
  //
  // [CHAT-MEDIA-FIRSTFRAME-1] Three things live here now, and the ORDER of the
  // comments matches the order of the three costs they remove:
  //
  //  1. [_dirFut] — `getApplicationSupportDirectory()` is a native
  //     platform-channel round-trip. It used to run on EVERY read and EVERY
  //     write, i.e. once per photo in the thread, plus an `exists()` and
  //     sometimes a `create()`. Same fix (and the same reason) as
  //     `AvatarCache._dirFut` and `DiskCache._baseFut` — whose comment records
  //     that memoising it removed most of the ~850ms list-loading cost. The
  //     FUTURE is memoised, not the value: with a `??=` on a value every
  //     concurrent caller passes the null check before the first await resolves
  //     and they all make the native call anyway.
  //
  //  2. [_mem] + [peekFile] — a synchronous index of files ALREADY on disk, so a
  //     previously-seen attachment can be rendered on the FIRST frame. Even a
  //     guaranteed cache HIT could not paint on frame 1 before, because
  //     [_cacheRead] is four async hops (dir → exists → length → readAsBytes):
  //     the bubble showed the placeholder, then the photo. Every open. Forever.
  //     Only the PATH is cached — never decrypted bytes: decoded/undecoded image
  //     bytes are RAM-heavy, and Flutter's own `imageCache` (capped in main.dart
  //     at 300 images / 64 MB) is the right owner of the decoded frame.
  //
  //  3. [warm] — builds that index once, from ONE `listSync()` at boot, so the
  //     very first thread opened after launch is instant too (an index that only
  //     fills as bubbles render is empty exactly when it matters).
  //
  // ACCOUNT SCOPING: the media dir is per-account (`media/<AccountScope.id>`) —
  // mandatory in this repo, a parent and a child share one phone and must never
  // be served each other's attachments. Both the memoised directory AND the
  // in-memory index are therefore guarded by [_ensureScope], which drops
  // everything the first time it notices `AccountScope.id` has changed.
  // [CHAT-MEDIA-THUMB-1] Raised from 400: the directory now holds up to TWO
  // entries per attachment (`<name>` and `<name>.thumb`), and the index is the
  // only thing that makes a photo paint on frame 1 — halving its effective
  // reach would undo [CHAT-MEDIA-FIRSTFRAME-1] for older attachments. Entries
  // are `File` handles (a path string), not bytes, so this is cheap.
  static const int _memCap = 800;
  static final Map<String, File> _mem = {};
  static String? _memScope;
  static bool _warmed = false;
  static Future<Directory>? _dirFut;

  static String get _scopeNow =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;

  /// Cheap (one string compare) — safe to call from `build()` via [peekFile].
  static void _ensureScope() {
    final s = _scopeNow;
    if (_memScope == s) return;
    _memScope = s;
    _mem.clear();
    _warmed = false;
    _dirFut = null;
  }

  static void _remember(String name, File f) {
    if (_mem.containsKey(name)) return;
    if (_mem.length >= _memCap) {
      // Cheap eviction: drop the oldest inserted key (Dart maps keep insert order).
      _mem.remove(_mem.keys.first);
    }
    _mem[name] = f;
  }

  static Future<Directory> _cacheDir() {
    _ensureScope();
    return _dirFut ??= _openCacheDir();
  }

  static Future<Directory> _openCacheDir() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/media/$_scopeNow');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static String _cacheName(String id) => id.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');

  /// [CHAT-MEDIA-FIRSTFRAME-1] SYNCHRONOUS, best-effort lookup of an
  /// already-cached attachment's file. Returns null on a cold index (the caller
  /// falls back to the async [downloadAndDecrypt] path). Never touches disk, so
  /// it is safe to call from `build()`.
  ///
  /// Render the returned File with `Image.file(f)`, NOT `Image.memory(...)`:
  /// `MemoryImage` is keyed on the byte buffer's IDENTITY, so freshly-read bytes
  /// are a brand-new key and Flutter re-decodes the JPEG from scratch on every
  /// thread open — that decode is the "flash". `FileImage` is keyed on the path,
  /// so the decoded frame is reused straight out of `PaintingBinding.imageCache`
  /// and paints synchronously on a warm cache.
  static File? peekFile(String id) {
    if (id.isEmpty) return null;
    _ensureScope();
    // Self-heal. `warm()` is called once at boot, but boot may happen BEFORE
    // `AccountScope.id` is restored (index built under 'default'), and an
    // account SWITCH deliberately drops the index — in both cases nobody would
    // ever re-warm and every photo would silently fall back to the async path
    // forever. This kicks off exactly one re-index per scope, asynchronously:
    // it never blocks this frame (we still return the current answer below),
    // it just means the NEXT frame has a populated index. `warm()` sets its own
    // guard synchronously, so concurrent builds cannot start it twice.
    if (!_warmed) unawaited(warm());
    return _mem[_cacheName(id)];
  }

  /// [CHAT-MEDIA-THUMB-2] ASYNC on-disk lookup of the cached FULL plaintext for
  /// [id] — the file itself, not its bytes. [peekFile] answers from the
  /// in-memory index only (safe in `build()`); this one also asks the disk, so
  /// it works on a cold index and after an app restart.
  ///
  /// Exists for the callers that need a PATH rather than bytes: the native
  /// video-poster extractor (`VideoThumbnail.thumbnailData(video: <path>)`) and
  /// inline video playback both want a file on disk, and the per-account media
  /// cache ALREADY holds exactly that. Before this, `ChatVideoCard` decrypted
  /// the whole video into RAM and wrote a SECOND full-size copy to the temp
  /// directory on every card mount just to hand a path to the plugin.
  ///
  /// The returned File belongs to the media cache — callers must NEVER delete
  /// it (that would evict a real attachment), unlike the temp copies they own.
  static Future<File?> cachedFile(String id) async {
    if (id.isEmpty) return null;
    final peeked = peekFile(id);
    if (peeked != null) return peeked;
    try {
      final name = _cacheName(id);
      final f = File('${(await _cacheDir()).path}/$name');
      if (await f.exists() && await f.length() > 0) {
        _remember(name, f);
        return f;
      }
    } catch (_) {/* miss */}
    return null;
  }

  /// Drop ONE entry from the synchronous index (sync, no I/O — safe to call
  /// from an `errorBuilder`). The async path still works; it just re-reads.
  ///
  /// [CHAT-MEDIA-THUMB-1] Drops the derived THUMBNAIL entry too. If the full
  /// file is poison the thumbnail derived from it is at best suspect, and
  /// leaving it indexed would keep serving a stale bubble forever.
  static void forgetPeek(String id) {
    if (id.isEmpty) return;
    _mem.remove(_cacheName(id));
    _mem.remove(_thumbName(id));
  }

  /// A cached file that could not be DECODED is poison: leaving it there means
  /// every retry re-reads the same bad bytes and the bubble can never recover.
  /// Drop the index entry AND delete the file so the next fetch is a genuine
  /// re-download. Never throws; fire-and-forget.
  static Future<void> evictCached(String id) async {
    forgetPeek(id);
    noteCacheEvent('stale', source: 'disk');
    try {
      final d = await _cacheDir();
      final f = File('${d.path}/${_cacheName(id)}');
      if (await f.exists()) await f.delete();
      // [CHAT-MEDIA-THUMB-1] and the derived thumbnail with it.
      final t = File('${d.path}/${_thumbName(id)}');
      if (await t.exists()) await t.delete();
    } catch (_) {/* best-effort */}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [CHAT-MEDIA-THUMB-1] LOCAL THUMBNAIL TIER
  //
  // WHY (measured on build 10521, owner's device, not guessed): with the
  // frame-1 index warm, `cache_event{store:chat_media,result:hit,source:disk}`
  // still reported render_ms 99 for a 3,151,102-byte photo (and 1.4 MB / 957 KB
  // for the others). The photos are 1–3 MB full-size camera JPEGs being painted
  // into a ~240dp bubble. `cacheWidth` bounds the DECODED BITMAP but Flutter
  // must still READ AND PARSE the whole multi-megabyte JPEG first — that parse
  // is the ~100ms "flash". WhatsApp is instant because the bubble shows a small
  // thumbnail and only the fullscreen viewer ever touches the original.
  //
  // WHAT: a second, derived file per photo — ~480px on the long edge, JPEG —
  // stored BESIDE the full plaintext in the SAME per-account media dir with a
  // `.thumb` suffix. Derived entirely on-device from bytes we already have:
  //   * NO wire-format change (`ChatMedia` is untouched),
  //   * NO server work,
  //   * works for photos ALREADY on the phone (generated on first view).
  //
  // SIZE: 480px covers a 240dp bubble at 2x DPR exactly and is oversampled at
  // the common 2.x–3x range; the card's own `cacheWidth` clamps the rest. A
  // 480px JPEG is typically 30–60 KB — one to two orders of magnitude less to
  // parse than the original, which is the entire point.
  //
  // ACCOUNT SCOPING: thumbnails go through [_cacheDir], so they inherit
  // `media/<AccountScope.id>` unchanged — a child can never be served a
  // parent's thumbnail, and [_ensureScope] drops thumbs from the index on an
  // account switch exactly like full files.
  // ───────────────────────────────────────────────────────────────────────────

  /// Long-edge target, in pixels.
  static const int kThumbMaxEdge = 480;
  static const int _kThumbJpegQuality = 82;
  static const String _kThumbSuffix = '.thumb';

  /// Index/disk name of the thumbnail derived from [id]. Media ids are R2 keys
  /// (`u/<uid>/<sha256>`), so a real full-file name can never end in
  /// `.thumb` — the two namespaces cannot collide.
  static String _thumbName(String id) => '${_cacheName(id)}$_kThumbSuffix';

  /// [CHAT-MEDIA-THUMB-1] SYNCHRONOUS, best-effort lookup of an already-
  /// generated thumbnail. Exact mirror of [peekFile]: in-memory only, no I/O,
  /// safe to call from `build()`. Null → the caller falls back to the full file
  /// (and should kick off [ensureThumb] so the NEXT open is instant).
  static File? peekThumb(String id) {
    if (id.isEmpty) return null;
    _ensureScope();
    if (!_warmed) unawaited(warm());
    return _mem[_thumbName(id)];
  }

  /// Drop ONLY the thumbnail (index + disk) — used when the THUMB itself fails
  /// to decode. Deliberately does NOT touch the full file: a bad thumbnail must
  /// degrade to the full image, never to a re-download or a broken bubble.
  /// Never throws; fire-and-forget.
  static Future<void> evictThumb(String id) async {
    if (id.isEmpty) return;
    final name = _thumbName(id);
    _mem.remove(name);
    noteCacheEvent('stale', source: 'thumb');
    try {
      final f = File('${(await _cacheDir()).path}/$name');
      if (await f.exists()) await f.delete();
    } catch (_) {/* best-effort */}
  }

  // Generation is SERIALIZED (one at a time) and BOUNDED. Opening a thread with
  // a dozen unthumbed photos must not become a dozen concurrent decodes — that
  // is the "CPU storm" this tier exists to avoid, not to create.
  static const int _kThumbQueueCap = 24;
  static final Set<String> _thumbPending = <String>{};
  static final List<_ThumbJob> _thumbQueue = <_ThumbJob>[];
  static bool _thumbDraining = false;

  /// [CHAT-MEDIA-THUMB-1] FIRE-AND-FORGET request to derive the thumbnail for
  /// [id]. Returns immediately — NEVER awaited on a paint path, never called
  /// with an `await` from `build()`.
  ///
  /// [bytes] is the plaintext when the caller already holds it (the download/
  /// decrypt path); omit it and the worker reads the cached full file from disk
  /// itself, OFF the paint path. Cheap and idempotent: an already-indexed,
  /// already-queued or already-on-disk thumbnail is a no-op.
  ///
  /// BACKFILL POLICY: this is the ONLY trigger. There is deliberately no boot
  /// batch and no opportunistic sweep — photos already on the phone get their
  /// thumbnail the first time their bubble is actually rendered, so nothing is
  /// ever added to the launch critical path.
  static void ensureThumb(String id, {Uint8List? bytes}) {
    if (id.isEmpty) return;
    _ensureScope();
    final name = _thumbName(id);
    if (_mem.containsKey(name)) return;
    if (!_thumbPending.add(id)) return;
    if (_thumbQueue.length >= _kThumbQueueCap) {
      // Bounded: drop the OLDEST request rather than growing without limit.
      // A dropped request costs nothing — the next render re-queues it.
      final dropped = _thumbQueue.removeAt(0);
      _thumbPending.remove(dropped.id);
    }
    _thumbQueue.add(_ThumbJob(id, bytes));
    if (!_thumbDraining) unawaited(_drainThumbQueue());
  }

  static Future<void> _drainThumbQueue() async {
    if (_thumbDraining) return;
    _thumbDraining = true;
    try {
      while (_thumbQueue.isNotEmpty) {
        final job = _thumbQueue.removeAt(0);
        try {
          await _generateThumb(job.id, job.bytes);
        } catch (_) {/* one bad photo must never stall the queue */}
        _thumbPending.remove(job.id);
        // Yield to the event loop between photos so a backlog can never hold
        // the UI isolate for several consecutive decodes.
        await Future<void>.delayed(Duration.zero);
      }
    } finally {
      _thumbDraining = false;
    }
  }

  static Future<void> _generateThumb(String id, Uint8List? src) async {
    final name = _thumbName(id);
    if (_mem.containsKey(name)) return;
    final d = await _cacheDir();
    // Explicitly a NEW non-nullable local rather than reassigning [src] — no
    // reliance on null-promotion across a try/catch boundary.
    final Uint8List? source = src ?? await _readFullForThumb(d, id);
    if (source == null || source.isEmpty) return;
    await storeThumb(id, source);
  }

  /// [CHAT-MEDIA-THUMB-2] AWAITABLE thumbnail write — the shared tail of the
  /// whole tier. Downscales [source] to ~[kThumbMaxEdge], writes it beside the
  /// full file as `<id>.thumb`, indexes it for [peekThumb], and returns the
  /// File so the caller can render it in the SAME session it generated it.
  ///
  /// [ensureThumb] (fire-and-forget, queued, photos) is the trigger for chat
  /// PHOTOS, whose source bytes are the plaintext we already hold. The other
  /// two producers cannot use it, because their source is a DERIVED raster
  /// nobody else can reproduce cheaply and which is only in hand for a moment:
  ///   * VIDEO — a native first-frame JPEG from `VideoThumbnail`,
  ///   * PDF   — a `pdfx` first-page raster.
  /// Both hand their raster straight here instead, and get back a path they can
  /// render immediately AND that survives the app restart. That is the whole
  /// point: before this, both rebuilt their preview from the FULL asset on every
  /// single card mount.
  ///
  /// [kind] rides the telemetry only ('image' | 'video' | 'pdf') so a
  /// systematically failing producer is one query away.
  ///
  /// NEVER throws: on any failure it returns null and the caller keeps its
  /// existing in-memory/full-asset rendering. A thumbnail is an optimisation,
  /// never a precondition for showing the bubble.
  static Future<File?> storeThumb(String id, Uint8List source,
      {String kind = 'image'}) async {
    if (id.isEmpty || source.isEmpty) return null;
    _ensureScope();
    final name = _thumbName(id);
    final indexed = _mem[name];
    if (indexed != null) return indexed;
    final t0 = DateTime.now().millisecondsSinceEpoch;
    // Nullable + an explicit null check rather than a `final` assigned inside a
    // `try` — definite-assignment analysis across a try/catch is exactly the
    // kind of thing there is no local compiler here to check.
    File? handle;
    try {
      handle = File('${(await _cacheDir()).path}/$name');
      // Already on disk from a previous session — just index it (this is the
      // cheap path after a cold start with a cold [_mem]).
      if (await handle.exists() && await handle.length() > 0) {
        _remember(name, handle);
        return handle;
      }
    } catch (_) {/* fall through and regenerate */}
    final tf = handle;
    if (tf == null) return null;

    final small = await _downscale(source);
    if (small == null || small.isEmpty) return null;
    try {
      await tf.writeAsBytes(small, flush: true);
      _remember(name, tf);
    } catch (_) {
      return null; // a write failure just means the next open retries
    }
    // FIRE-AND-FORGET. No message content, no contact identifier — sizes and a
    // duration only; the standard [Analytics] envelope carries the email that
    // makes a future pull possible.
    unawaited(Analytics.capture('chat_media_thumb_generated', {
      'bytes': small.length,
      'src_bytes': source.length,
      'gen_ms': DateTime.now().millisecondsSinceEpoch - t0,
      'max_edge': kThumbMaxEdge,
      'kind': kind,
    }));
    return tf;
  }

  /// Reads the cached FULL plaintext for [id]. Null when it isn't on disk (the
  /// photo has never been fetched) or the read fails — either way there is
  /// simply nothing to derive a thumbnail from yet.
  static Future<Uint8List?> _readFullForThumb(Directory d, String id) async {
    try {
      final full = File('${d.path}/${_cacheName(id)}');
      if (!await full.exists()) return null;
      return await full.readAsBytes();
    } catch (_) {
      return null;
    }
  }

  /// [CHAT-MEDIA-THUMB-1] Decode [bytes] DIRECTLY at ~[kThumbMaxEdge] on the
  /// long edge and re-encode as JPEG. Returns null on anything that isn't a
  /// decodable image (a mislabelled attachment must never throw into a bubble).
  ///
  /// The `dart:ui` codec is the whole trick: `instantiateCodec(targetWidth:)`
  /// hands the target to the PLATFORM decoder, which never materialises the
  /// full-resolution bitmap at all. Decoding at full size and then resizing
  /// would pay exactly the cost this tier exists to remove.
  ///
  /// [ui.ImageDescriptor.encoded] parses only the HEADER, so the source
  /// dimensions are known before any pixels are produced — needed to pick
  /// width-vs-height, because a bare `targetWidth: 480` on a tall portrait
  /// leaves the LONG edge far above 480.
  static Future<Uint8List?> _downscale(Uint8List bytes) async {
    ui.Codec? codec;
    ui.Image? im;
    try {
      final ui.ImmutableBuffer buf = await ui.ImmutableBuffer.fromUint8List(bytes);
      final ui.ImageDescriptor desc = await ui.ImageDescriptor.encoded(buf);
      final int sw = desc.width, sh = desc.height;
      if (sw <= 0 || sh <= 0) {
        buf.dispose();
        return null;
      }
      int? tw, th;
      if (sw >= sh) {
        if (sw > kThumbMaxEdge) tw = kThumbMaxEdge;
      } else {
        if (sh > kThumbMaxEdge) th = kThumbMaxEdge;
      }
      final ui.Codec c = await desc.instantiateCodec(targetWidth: tw, targetHeight: th);
      // Same ownership contract as `PaintingBinding.instantiateImageCodecWithSize`:
      // the buffer is released once the codec exists. (On the throw path above,
      // the outer catch takes over and the buffer is collected with the frame —
      // a rare error path, not worth a try/finally that would muddy the
      // definite-assignment analysis of `c`.)
      buf.dispose();
      codec = c;
      final frame = await c.getNextFrame();
      final ui.Image image = frame.image;
      im = image;
      final bd = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (bd == null) return null;
      // The RGBA round-trip is pure bytes, so the JPEG encode CAN safely leave
      // the UI isolate — and it is the most expensive step left. (The codec
      // work above cannot: `dart:ui` handles are not sendable across isolates.)
      return await compute(
        _encodeThumbJpeg,
        _ThumbEncodeInput(
          rgba: Uint8List.fromList(
              bd.buffer.asUint8List(bd.offsetInBytes, bd.lengthInBytes)),
          width: image.width,
          height: image.height,
          quality: _kThumbJpegQuality,
        ),
      );
    } catch (_) {
      // Not an image, a corrupt file, an unsupported codec — the caller simply
      // keeps rendering the full-size file.
      return null;
    } finally {
      try { im?.dispose(); } catch (_) {}
      try { codec?.dispose(); } catch (_) {}
    }
  }

  /// [CHAT-MEDIA-FIRSTFRAME-1] Populate the synchronous [peekFile] index from
  /// what is ALREADY on disk. Without this, [_mem] is empty on every cold start,
  /// so the first thread opened after launch misses on frame 1 for every photo —
  /// which is exactly the case the owner reports ("it feels like it downloaded").
  ///
  /// The disk filename IS the index key ([_cacheName] of the media id), so one
  /// directory listing reconstructs the whole index with no parsing and no
  /// per-file async work.
  ///
  /// [CHAT-MEDIA-THUMB-1] Thumbnails live in the SAME directory under
  /// `<name>.thumb`, so this ONE `listSync` indexes them too with no extra I/O
  /// and no extra code — `_mem` is keyed by filename, and [peekThumb] looks up
  /// the suffixed key. That is why the tier costs nothing at boot.
  ///
  /// Uses SYNCHRONOUS I/O (`listSync`/`statSync`). That is deliberate and is
  /// acceptable exactly ONCE, at boot, off the widget path — never per build and
  /// never per attachment. Call it from boot only; do not call it from a widget.
  /// Idempotent, and never throws.
  static Future<void> warm() async {
    _ensureScope();
    if (_warmed) return;
    _warmed = true;
    try {
      final d = await _cacheDir();
      _ensureScope();
      // Cap the scan so a pathological directory can't stall boot.
      final entries = d.listSync(followLinks: false).take(4000).toList();
      final files = <MapEntry<String, File>>[];
      final stamps = <String, DateTime>{};
      for (final e in entries) {
        if (e is! File) continue;
        final name = e.uri.pathSegments.isNotEmpty ? e.uri.pathSegments.last : '';
        if (name.isEmpty) continue;
        FileStat st;
        try {
          st = e.statSync();
        } catch (_) {
          continue;
        }
        if (st.size <= 0) continue; // truncated/poisoned entry — treat as absent
        files.add(MapEntry(name, e));
        stamps[name] = st.modified;
      }
      if (files.length > _memCap) {
        // Keep the most recent entries; the rest fall back to the async path.
        files.sort((a, b) => (stamps[b.key] ?? DateTime(0)).compareTo(stamps[a.key] ?? DateTime(0)));
      }
      for (final e in files.take(_memCap)) {
        _mem.putIfAbsent(e.key, () => e.value);
      }
    } catch (_) {/* never block boot on a cache warm */}
  }

  /// [CHAT-MEDIA-FIRSTFRAME-1] Standardized cache signal for the chat-media
  /// path, which was previously uninstrumented end to end (there was no event at
  /// all distinguishing a memory hit, a disk hit and a download — which is why
  /// this had to be diagnosed from source rather than from telemetry).
  ///
  /// FIRE-AND-FORGET — never awaited on a paint path. Carries no message
  /// content and no contact identifier; the standard [Analytics] envelope
  /// already carries the user's email so a future pull can find it.
  static void noteCacheEvent(String result, {required String source, int? ms, int? bytes}) {
    unawaited(Analytics.cacheEvent('chat_media', result,
        renderMs: ms, bytes: bytes, accountScoped: true, extra: {'source': source}));
  }

  static Future<Uint8List?> _cacheRead(String id) async {
    try {
      final name = _cacheName(id);
      final f = File('${(await _cacheDir()).path}/$name');
      if (await f.exists() && await f.length() > 0) {
        final b = await f.readAsBytes();
        _remember(name, f); // so the NEXT open can paint this on frame 1
        return b;
      }
    } catch (_) {/* miss */}
    return null;
  }

  /// [CHAT-MEDIA-FIRSTFRAME-1] Now that [_cacheDir] is memoised it no longer
  /// re-`create()`s the directory on every call, so a purge (or an OS cache
  /// eviction) that deletes `media/<scope>/` could otherwise leave us holding a
  /// handle to a directory that no longer exists — and every later write would
  /// fail silently, permanently disabling the media cache. Costs nothing on the
  /// happy path: only a FAILED write drops the memo, re-creates the directory
  /// and retries once. Same shape as `AvatarCache._write`.
  static Future<void> _cacheWrite(String id, Uint8List bytes) async {
    final name = _cacheName(id);
    try {
      var f = File('${(await _cacheDir()).path}/$name');
      try {
        await f.writeAsBytes(bytes, flush: true);
      } catch (_) {
        _dirFut = null;
        final d = await _cacheDir();
        await d.create(recursive: true);
        f = File('${d.path}/$name');
        await f.writeAsBytes(bytes, flush: true);
      }
      _remember(name, f);
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

// ---- [CHAT-MEDIA-THUMB-1] thumbnail generation plumbing ----

/// One queued thumbnail request. [bytes] is the plaintext when the caller
/// already had it; null means "read the cached full file yourself".
class _ThumbJob {
  final String id;
  final Uint8List? bytes;
  _ThumbJob(this.id, this.bytes);
}

class _ThumbEncodeInput {
  final Uint8List rgba;
  final int width;
  final int height;
  final int quality;
  _ThumbEncodeInput({
    required this.rgba,
    required this.width,
    required this.height,
    required this.quality,
  });
}

/// Runs on a background isolate via `compute`. PURE BYTES — no `dart:ui`
/// handles cross the isolate boundary (they are not sendable), which is why the
/// decode stays on the main isolate and only this encode moves.
///
/// JPEG, not `toByteData(format: png)`: the source is a photo, and PNG is
/// lossless — a 480x640 PNG of a camera frame is commonly 400–700 KB, an order
/// of magnitude larger than the ~30–60 KB JPEG, which would put a meaningful
/// slice of the parse cost straight back into the bubble.
Uint8List _encodeThumbJpeg(_ThumbEncodeInput inp) {
  final image = img.Image.fromBytes(
    width: inp.width,
    height: inp.height,
    bytes: inp.rgba.buffer,
    numChannels: 4,
  );
  // `Uint8List.fromList` for the same reason as `profile/qr_share.dart` and
  // `avatar_crop_screen.dart` do it — keeps the declared return type honest
  // regardless of what `encodeJpg` is statically typed as in this version.
  return Uint8List.fromList(img.encodeJpg(image, quality: inp.quality));
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
