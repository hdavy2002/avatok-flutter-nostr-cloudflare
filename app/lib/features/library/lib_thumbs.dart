import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';
import 'package:video_thumbnail/video_thumbnail.dart';

import '../../core/account_key.dart';
import '../../core/analytics.dart';
import '../../core/avatar_cache.dart';
import '../../core/library_api.dart';
import '../../core/vault.dart';
import '../../identity/identity.dart';
import '../avatok/media.dart';

/// On-device, per-account thumbnail cache for AvaLibrary.
///
/// LOCAL-FIRST (rulebook §2 media pipeline): a cached thumb returns instantly; a
/// miss is fetched/rendered ONCE, written to the per-account cache dir, and reused
/// forever (content-addressed by the R2 key, so it's immutable). Nothing is
/// re-downloaded on reopen.
///
/// Coverage — PUBLIC items (`visibility == 'public'`, a real `display_url`):
///   • Images — fetched as the tiny Cloudflare AVIF transform (avatar pipeline),
///     with a fallback to the raw original if image-resizing is unavailable.
///   • Video — native first frame straight off the URL ([_VideoThumber]).
///   • PDF   — first page rasterised by `pdfx` ([_PdfThumber]).
///   All three are real, wired renderers; the bytes land in `lib_thumbs/<scope>/`.
///
/// Coverage — PRIVATE items ([LibraryItem.isPrivate], i.e. E2E chat attachments,
/// voice notes and private AI artifacts — which is MOST of a real library).
/// [LIB-THUMB-PRIVATE-1]: these used to be excluded outright, which is why every
/// Images/Videos/PDF tile on the owner's device was a grey type glyph. Private
/// bytes never have a fetchable plaintext URL, so they are served from the
/// SHARED local thumbnail tier in `features/avatok/media.dart` instead, in this
/// order (first hit wins, cost ascending):
///
///   1. [MediaService.peekThumb] — synchronous, no I/O. A private item's
///      `LibraryItem.key` IS the `ChatMedia.id` (see [_privateThumb]), so an
///      attachment whose chat bubble has already rendered ALREADY has a 480px
///      thumbnail on disk and the Library tile costs nothing at all.
///   2. [MediaService.cachedFile] — the full decrypted plaintext is already in
///      `media/<AccountScope.id>/`; derive the thumbnail from it once.
///   3. Decrypt-on-first-view — only when the item carries decryption material
///      (`enc_blob`, received DMs) or a server-readable presigned `display_url`
///      (`storage == 'digital'`). Lazy (only the tile actually being viewed),
///      SERIALIZED, queue-capped and size-capped. Never eager, never a sweep.
///
/// A private item with NO material and NO local plaintext (typically a SENT
/// attachment whose device cache was cleared) is genuinely underivable — it
/// returns null, the type tile shows, and `lib_thumb_failed{stage:
/// private_no_material}` records exactly that.
///
/// Every failure is reported to PostHog via [Analytics] (carrying the user's
/// email/phone through the standard envelope) so a blank thumbnail is diagnosable
/// remotely by the exact URL host + HTTP status + stage that failed, and by
/// whether it was a private item.
class LibThumbs {
  static String? _scope;
  static String? _path;

  static Future<String> _dir() async {
    final base = await getApplicationSupportDirectory();
    final scope =
        (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    if (_path != null && _scope == scope) return _path!;
    final d = Directory('${base.path}/lib_thumbs/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    _scope = scope;
    _path = d.path;
    return d.path;
  }

  static String _name(LibraryItem m, int px) {
    final seg = m.key.isNotEmpty ? m.key : (m.displayUrl.isNotEmpty ? m.displayUrl : m.id);
    final safe = seg.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    final tail = safe.length > 80 ? safe.substring(safe.length - 80) : safe;
    return '${tail}_$px.thumb';
  }

  /// Mime-aware classifiers — robust to legacy rows whose `category` column is
  /// null/`other` but whose mime is correct (a known cause of blank tiles).
  static bool isImage(LibraryItem m) =>
      m.category == 'image' || m.mime.startsWith('image/');
  static bool isVideo(LibraryItem m) =>
      m.category == 'video' || m.mime.startsWith('video/');
  static bool isPdf(LibraryItem m) =>
      m.mime == 'application/pdf' || m.name.toLowerCase().endsWith('.pdf');

  static bool _renderable(LibraryItem m) => isImage(m) || isVideo(m) || isPdf(m);

  /// Whether we can (today) produce a real raster thumbnail for [m].
  ///
  /// SYNCHRONOUS AND CHEAP BY CONTRACT — this is called during layout, once per
  /// tile, on every build. The private branch only ever does map lookups
  /// ([MediaService.peekThumb]/[MediaService.peekFile] are documented as safe in
  /// `build()`) and string tests. No `await`, no disk, no network, ever.
  ///
  /// It is deliberately OPTIMISTIC for a private item that has decryption
  /// material but no local bytes yet: `true` here just means "worth asking
  /// [thumb] for one". If that turns out to be wrong, [thumb] returns null and
  /// the caller falls back to the type tile exactly as before.
  static bool canRender(LibraryItem m) {
    if (!_renderable(m)) return false;
    if (!m.isPrivate) return m.displayUrl.isNotEmpty;
    return _privateRoute(m) != _PrivRoute.none;
  }

  /// A thumbnail File for [m], or null if one can't be produced (caller shows a
  /// type tile). Never throws.
  ///
  /// For a PRIVATE item the returned File belongs to the SHARED media cache
  /// (`media/<AccountScope.id>/<id>.thumb`) rather than to `lib_thumbs/` — the
  /// chat bubble and the Library tile deliberately share one derived thumbnail
  /// instead of storing the same 40 KB twice. Callers must render it and must
  /// NEVER delete it. [px] is honoured for public items; private items get the
  /// shared tier's [MediaService.kThumbMaxEdge] (480px long edge), which is
  /// oversampled for a grid tile anyway.
  static Future<File?> thumb(LibraryItem m, {int px = 240}) async {
    if (m.isPrivate) return _privateThumb(m);
    try {
      final f = File('${await _dir()}/${_name(m, px)}');
      if (await f.exists() && await f.length() > 0) return f;

      Uint8List? bytes;
      if (m.displayUrl.isEmpty) return null;
      if (isImage(m)) {
        bytes = await _fetchImage(m, px);
      } else if (isVideo(m)) {
        bytes = await _VideoThumber.fromUrl(m, px);
      } else if (isPdf(m)) {
        bytes = await _PdfThumber.fromUrl(m, px);
      }
      if (bytes == null || bytes.isEmpty) return null;
      await f.writeAsBytes(bytes, flush: true);
      return f;
    } catch (e) {
      _fail(m, 'cache', err: e);
      return null;
    }
  }

  /// Standard failure event. `private` + `stage` are what make a blank tile
  /// diagnosable remotely — the two questions are always "was it private?" and
  /// "how far did it get?".
  static void _fail(LibraryItem m, String stage,
      {Object? err, int? status, String? host, String? reason}) {
    unawaited(Analytics.capture('lib_thumb_failed', {
      'category': m.category,
      'mime': m.mime,
      'stage': stage,
      'private': m.isPrivate,
      'source_kind': m.sourceKind,
      'size': m.size,
      if (status != null) 'status': status,
      if (host != null) 'url_host': host,
      if (reason != null) 'reason': reason,
      if (err != null) 'err': err.toString(),
    }));
  }

  /// 1) Cloudflare AVIF transform (tiny, fast, cached at the edge). 2) raw
  /// original if resizing is unavailable. Telemetry on every miss.
  static Future<Uint8List?> _fetchImage(LibraryItem m, int px) async {
    final urls = <String>[AvatarCache.transformUrl(m.displayUrl, px), m.displayUrl];
    for (var i = 0; i < urls.length; i++) {
      final stage = i == 0 ? 'cf_transform' : 'raw';
      try {
        final res = await http.get(Uri.parse(urls[i])).timeout(const Duration(seconds: 15));
        if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) return res.bodyBytes;
        _fail(m, stage, status: res.statusCode, host: Uri.parse(urls[i]).host);
      } catch (e) {
        _fail(m, stage, err: e);
      }
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [LIB-THUMB-PRIVATE-1] PRIVATE ITEMS
  //
  // THE KEY MAPPING (this is the whole reason the cheap path exists):
  //   `LibraryItem.key` IS `ChatMedia.id`.
  //     • sender  — `MediaService.encryptAndUpload` sets `ChatMedia.id` from the
  //       upload response's `key`, and `uploadPrivate` (worker/src/routes/
  //       media.ts) INSERTs that SAME `r2Key` into `user_media.key`.
  //     • receiver — `MediaService.recordReceived` calls
  //       `LibraryApi.record(key: m.id, …)`, and `libraryRecord` INSERTs it
  //       verbatim.
  //     • and `MediaService._resolveStaleDigitalUrl` already relies on exactly
  //       this identity (`if (it.key == m.id)`).
  //   The `MediaService` on-disk cache is keyed by `ChatMedia.id`, so a private
  //   Library row whose chat bubble has ever rendered is ALREADY thumbed —
  //   `peekThumb` hits synchronously and there is nothing to fetch or decrypt.
  // ───────────────────────────────────────────────────────────────────────────

  /// Network fetch+decrypt is a real cost, so it is size-capped per kind. A
  /// cached-plaintext derivation has no cap (the bytes are already local).
  static const int _kMaxNetImageBytes = 20 * 1024 * 1024;
  static const int _kMaxNetPdfBytes = 20 * 1024 * 1024;
  static const int _kMaxNetVideoBytes = 12 * 1024 * 1024;

  /// How a private item's bytes could be reached — decided synchronously.
  static _PrivRoute _privateRoute(LibraryItem m) {
    final id = m.key;
    if (id.isEmpty) return _PrivRoute.none;
    if (MediaService.peekThumb(id) != null) return _PrivRoute.thumbHit;
    if (MediaService.peekFile(id) != null) return _PrivRoute.localBytes;
    if (_noMaterial.contains(id)) return _PrivRoute.none;
    // A `storage == 'digital'` row (MVP voice notes, private AI artifacts) is
    // server-readable PLAINTEXT: `getLibrary` re-mints a short-lived SigV4
    // presigned `display_url` on every read. That signature is also the only
    // way to tell it apart from a `blossom` row, whose `display_url` is the
    // bare CIPHERTEXT object and is useless without a key.
    // [LIB-READABLE-1] Was `_isPresigned(m.displayUrl)` — a string sniff for
    // `X-Amz-Signature` that missed the worker's HMAC fallback URL entirely and
    // sent every such row down the `coldDisk` -> `none` path, i.e. the blank
    // type tile the owner photographed. See `LibraryItem.isDirectlyReadable`.
    if (m.isDirectlyReadable) return _PrivRoute.presignedPlaintext;
    if ((m.encBlob ?? '').isNotEmpty) return _PrivRoute.decrypt;
    // Cold index: the disk may still hold the plaintext even though `peekFile`
    // missed (it is in-memory only). Worth one async look.
    return _PrivRoute.coldDisk;
  }

  // [LIB-READABLE-1] `_isPresigned` was removed — its one caller now asks
  // `LibraryItem.isDirectlyReadable`, which is the same question answered in
  // one place for both the thumbnail path and the open path. Two private
  // copies of this predicate is how they managed to be wrong in exactly the
  // same way while looking like unrelated bugs.

  /// Items we have proven underivable this session — never re-tried, so a
  /// hopeless tile costs one attempt, not one per scroll.
  static final Set<String> _noMaterial = <String>{};

  static Future<File?> _privateThumb(LibraryItem m) async {
    final id = m.key;
    if (id.isEmpty) {
      _fail(m, 'private_no_material', reason: 'no_key');
      return null;
    }
    try {
      // 1 — free. Already derived by the chat path (or by a previous tile).
      final hit = MediaService.peekThumb(id);
      if (hit != null) return hit;

      // 2 — full plaintext already on disk (in-memory index OR a cold-start
      // disk look). `cachedFile` covers both.
      final cached = await MediaService.cachedFile(id);
      if (cached != null) return _deriveFromLocal(m, cached);

      // 3 — bytes are not on this device yet. Bounded, serialized, lazy.
      final route = _privateRoute(m);
      if (route == _PrivRoute.none ||
          route == _PrivRoute.coldDisk ||
          route == _PrivRoute.localBytes) {
        // coldDisk/localBytes already resolved above — reaching here means the
        // file genuinely isn't there and we have no way to get it.
        _noMaterial.add(id);
        _fail(m, 'private_no_material',
            reason: route == _PrivRoute.coldDisk ? 'not_cached_no_material' : 'no_route');
        return null;
      }
      if (!_withinNetCap(m)) {
        _fail(m, 'private_skipped', reason: 'too_large');
        return null;
      }
      return await _serial(() => _fetchPrivate(m, route));
    } catch (e) {
      _fail(m, 'private_render', err: e);
      return null;
    }
  }

  static bool _withinNetCap(LibraryItem m) {
    if (m.size <= 0) return true; // unknown size — the queue cap still bounds us
    if (isVideo(m)) return m.size <= _kMaxNetVideoBytes;
    if (isPdf(m)) return m.size <= _kMaxNetPdfBytes;
    return m.size <= _kMaxNetImageBytes;
  }

  /// Derive (once) a thumbnail from the FULL plaintext already sitting in the
  /// per-account media cache, and hand it to the shared tier so the chat bubble
  /// gets it too. Returns the shared `<id>.thumb` File.
  static Future<File?> _deriveFromLocal(LibraryItem m, File full) async {
    try {
      if (isVideo(m)) {
        // The native extractor wants a PATH, and the media cache already is one
        // — no temp copy, no full decode into RAM.
        final raster = await VideoThumbnail.thumbnailData(
          video: full.path,
          imageFormat: ImageFormat.JPEG,
          maxWidth: MediaService.kThumbMaxEdge,
          quality: 60,
        );
        if (raster == null || raster.isEmpty) {
          _fail(m, 'private_video_render');
          return null;
        }
        return await MediaService.storeThumb(m.key, raster, kind: 'video');
      }
      final bytes = await full.readAsBytes();
      if (bytes.isEmpty) return null;
      if (isPdf(m)) {
        final raster = await _PdfThumber.fromBytes(m, bytes, MediaService.kThumbMaxEdge);
        if (raster == null || raster.isEmpty) return null;
        return await MediaService.storeThumb(m.key, raster, kind: 'pdf');
      }
      // Image: `storeThumb` does the header-only decode + targeted downscale +
      // isolate JPEG encode. The full-resolution bitmap is never materialised.
      return await MediaService.storeThumb(m.key, bytes, kind: 'image');
    } catch (e) {
      _fail(m, 'private_local_derive', err: e);
      return null;
    }
  }

  /// Bring the plaintext onto the device (decrypting if needed), cache it via
  /// [MediaService] so the chat path benefits too, then derive the thumbnail.
  static Future<File?> _fetchPrivate(LibraryItem m, _PrivRoute route) async {
    // Re-check: while queued, another tile (or the chat) may have produced it.
    final raced = MediaService.peekThumb(m.key);
    if (raced != null) return raced;

    try {
      if (route == _PrivRoute.presignedPlaintext) {
        final res =
            await http.get(Uri.parse(m.displayUrl)).timeout(const Duration(seconds: 30));
        if (res.statusCode != 200 || res.bodyBytes.isEmpty) {
          _fail(m, 'private_presigned_fetch', status: res.statusCode);
          return null;
        }
        // Cache it under the SAME id the chat path uses, so this download is
        // paid exactly once for the whole app.
        await MediaService.writeBlob(m.key, Uint8List.fromList(res.bodyBytes));
        final f = await MediaService.cachedFile(m.key);
        if (f == null) return null;
        return _deriveFromLocal(m, f);
      }

      // route == decrypt — unwrap the per-blob AES material the recipient
      // stored in `enc_blob` (Vault-encrypted to their account key), rebuild a
      // ChatMedia and reuse the ONE canonical download+decrypt+cache path.
      final media = await _rebuildChatMedia(m);
      if (media == null) {
        _noMaterial.add(m.key);
        _fail(m, 'private_no_material', reason: 'enc_blob_unreadable');
        return null;
      }
      final bytes = await MediaService.downloadAndDecrypt(media);
      if (bytes.isEmpty) return null;
      final f = await MediaService.cachedFile(m.key);
      if (f != null) return _deriveFromLocal(m, f);
      // Extremely unlikely (downloadAndDecrypt always caches), but never let a
      // missing handle become a thrown exception on a paint path.
      if (isImage(m)) return await MediaService.storeThumb(m.key, bytes, kind: 'image');
      return null;
    } catch (e) {
      _fail(m, 'private_decrypt', err: e);
      return null;
    }
  }

  /// `enc_blob` → `{k,n,mac}` → a [ChatMedia] pointing at the same R2 key.
  /// Null when the account key isn't available or the blob won't unwrap (both
  /// mean "this device cannot read this item", not an error worth throwing).
  static Future<ChatMedia?> _rebuildChatMedia(LibraryItem m) async {
    try {
      final blob = m.encBlob ?? '';
      if (blob.isEmpty) return null;
      final keyMat = await AccountKey.I.ensureHex();
      if (keyMat == null || keyMat.isEmpty) return null;
      final clear = await Vault.decrypt(blob, keyMat);
      if (clear == null || clear.isEmpty) return null;
      final j = jsonDecode(clear) as Map<String, dynamic>;
      final k = (j['k'] ?? '').toString();
      final n = (j['n'] ?? '').toString();
      final mac = (j['mac'] ?? '').toString();
      if (k.isEmpty || n.isEmpty || mac.isEmpty) return null;
      return ChatMedia(
        kind: isImage(m)
            ? MediaKind.image
            : isVideo(m)
                ? MediaKind.video
                : MediaKind.file,
        id: m.key,
        keyB64: k,
        nonceB64: n,
        macB64: mac,
        contentType: m.mime,
        name: m.name,
        size: m.size,
      );
    } catch (_) {
      return null;
    }
  }

  // ── bounded, serialized private-fetch gate ─────────────────────────────────
  //
  // A Videos tab is 30 tiles. Without this, scrolling it would start 30
  // concurrent decrypt+download jobs. One at a time, at most
  // [_kFetchQueueCap] waiting; past that a tile simply gets null this pass.
  //
  // The cap is 24 (same as `MediaService._kThumbQueueCap`) and deliberately
  // NOT smaller: `_LibTileState` asks exactly ONCE per mount and latches
  // `_tried` on a null, so a tile rejected for a full queue keeps its type tile
  // until it is recycled. A page is ~30 rows, so 24 covers a screenful plus
  // overscan while still refusing an unbounded backlog.
  static const int _kFetchQueueCap = 24;
  static int _queued = 0;
  static Future<void> _chain = Future<void>.value();

  static Future<File?> _serial(Future<File?> Function() job) {
    if (_queued >= _kFetchQueueCap) return Future<File?>.value(null);
    _queued++;
    final done = Completer<File?>();
    _chain = _chain.then((_) async {
      try {
        done.complete(await job());
      } catch (_) {
        if (!done.isCompleted) done.complete(null);
      }
    }).catchError((_) {
      if (!done.isCompleted) done.complete(null);
    });
    return done.future.whenComplete(() => _queued--);
  }
}

/// Which on-device route (if any) can produce bytes for a private item.
enum _PrivRoute {
  /// Nothing we can do — show the type tile.
  none,

  /// A derived thumbnail is already indexed. Free.
  thumbHit,

  /// The full plaintext is in the synchronous media index.
  localBytes,

  /// Not in the index, but possibly on disk — one async look.
  coldDisk,

  /// `storage == 'digital'`: `display_url` is a fresh presigned plaintext URL.
  presignedPlaintext,

  /// Received E2E attachment: `enc_blob` holds the AES material.
  decrypt,
}

/// Video first-frame renderer (native `video_thumbnail`). For PUBLIC items it
/// grabs a frame straight from the URL — no full download. (Private items go via
/// [LibThumbs._deriveFromLocal], which points the same plugin at the decrypted
/// file already in the per-account media cache.) Any failure returns null and
/// the UI shows a video type tile — a blank thumb can never break the screen.
class _VideoThumber {
  static Future<Uint8List?> fromUrl(LibraryItem m, int px) async {
    try {
      final bytes = await VideoThumbnail.thumbnailData(
        video: m.displayUrl,
        imageFormat: ImageFormat.JPEG,
        maxWidth: px,
        quality: 60,
      );
      if (bytes == null || bytes.isEmpty) {
        LibThumbs._fail(m, 'video_render');
        return null;
      }
      return bytes;
    } catch (e) {
      LibThumbs._fail(m, 'video_render', err: e);
      return null;
    }
  }
}

/// PDF first-page renderer (native `pdfx`). Rasterises page 1 to PNG and caps
/// the work. Failure → null.
class _PdfThumber {
  static const _maxBytes = 25 * 1024 * 1024; // don't pull huge PDFs for a thumb

  /// PUBLIC path: download the PDF (skipping very large files) then rasterise.
  static Future<Uint8List?> fromUrl(LibraryItem m, int px) async {
    try {
      final res = await http.get(Uri.parse(m.displayUrl)).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) {
        LibThumbs._fail(m, 'pdf_fetch', status: res.statusCode);
        return null;
      }
      if (res.bodyBytes.length > _maxBytes) return null;
      return fromBytes(m, res.bodyBytes, px);
    } catch (e) {
      LibThumbs._fail(m, 'pdf_fetch', err: e);
      return null;
    }
  }

  /// Shared rasteriser — also the PRIVATE path's entry point, where the bytes
  /// are the already-decrypted plaintext and nothing is downloaded at all.
  static Future<Uint8List?> fromBytes(LibraryItem m, Uint8List bytes, int px) async {
    if (bytes.isEmpty || bytes.length > _maxBytes) return null;
    PdfDocument? doc;
    PdfPage? page;
    try {
      doc = await PdfDocument.openData(bytes);
      page = await doc.getPage(1);
      final w = px.toDouble();
      final h = page.width > 0 ? page.height / page.width * w : w;
      final img = await page.render(width: w, height: h, format: PdfPageImageFormat.png);
      return img?.bytes;
    } catch (e) {
      LibThumbs._fail(m, 'pdf_render', err: e);
      return null;
    } finally {
      try { await page?.close(); } catch (_) {}
      try { await doc?.close(); } catch (_) {}
    }
  }
}
