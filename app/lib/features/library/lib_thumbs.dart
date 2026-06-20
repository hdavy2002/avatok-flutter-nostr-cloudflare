import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';
import 'package:video_thumbnail/video_thumbnail.dart';

import '../../core/analytics.dart';
import '../../core/avatar_cache.dart';
import '../../core/library_api.dart';
import '../../identity/identity.dart';

/// On-device, per-account thumbnail cache for AvaLibrary.
///
/// LOCAL-FIRST (rulebook §2 media pipeline): a cached thumb returns instantly; a
/// miss is fetched/rendered ONCE, written to the per-account cache dir, and reused
/// forever (content-addressed by the R2 key, so it's immutable). Nothing is
/// re-downloaded on reopen.
///
/// Coverage:
///   • Images — fetched as the tiny Cloudflare AVIF transform (avatar pipeline),
///     with a fallback to the raw original if image-resizing is unavailable.
///   • Video / PDF — pluggable renderers ([_VideoThumber] / [_PdfThumber]). These
///     need native render plugins (video_thumbnail / pdfx) that can't be
///     compile-verified in a headless session, so until they're wired in a
///     CI-validated APK build they return null and the UI shows a rich type tile.
///
/// Every failure is reported to PostHog via [Analytics] (carrying the user's
/// email/phone through the standard envelope) so a blank thumbnail is diagnosable
/// remotely by the exact URL host + HTTP status + stage that failed.
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

  /// Whether we can (today) produce a real raster thumbnail for [m].
  static bool canRender(LibraryItem m) =>
      !m.isPrivate && m.displayUrl.isNotEmpty && (isImage(m) || isVideo(m) || isPdf(m));

  /// A thumbnail File for [m], or null if one can't be produced (caller shows a
  /// type tile). Never throws.
  static Future<File?> thumb(LibraryItem m, {int px = 240}) async {
    try {
      final f = File('${await _dir()}/${_name(m, px)}');
      if (await f.exists() && await f.length() > 0) return f;

      Uint8List? bytes;
      if (isImage(m) && !m.isPrivate && m.displayUrl.isNotEmpty) {
        bytes = await _fetchImage(m, px);
      } else if (isVideo(m) && !m.isPrivate && m.displayUrl.isNotEmpty) {
        bytes = await _VideoThumber.render(m, px);
      } else if (isPdf(m) && !m.isPrivate && m.displayUrl.isNotEmpty) {
        bytes = await _PdfThumber.render(m, px);
      }
      if (bytes == null || bytes.isEmpty) return null;
      await f.writeAsBytes(bytes, flush: true);
      return f;
    } catch (e) {
      Analytics.capture('lib_thumb_failed', {
        'category': m.category,
        'mime': m.mime,
        'stage': 'cache',
        'err': e.toString(),
      });
      return null;
    }
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
        Analytics.capture('lib_thumb_failed', {
          'category': m.category,
          'mime': m.mime,
          'stage': stage,
          'status': res.statusCode,
          'url_host': Uri.parse(urls[i]).host,
        });
      } catch (e) {
        Analytics.capture('lib_thumb_failed', {
          'category': m.category,
          'mime': m.mime,
          'stage': stage,
          'err': e.toString(),
        });
      }
    }
    return null;
  }
}

/// Video first-frame renderer (native `video_thumbnail`). Grabs a frame straight
/// from the (public) video URL — no full download. Any failure returns null and
/// the UI shows a video type tile (a blank thumb can never break the screen).
class _VideoThumber {
  static Future<Uint8List?> render(LibraryItem m, int px) async {
    try {
      final bytes = await VideoThumbnail.thumbnailData(
        video: m.displayUrl,
        imageFormat: ImageFormat.JPEG,
        maxWidth: px,
        quality: 60,
      );
      if (bytes == null || bytes.isEmpty) {
        Analytics.capture('lib_thumb_failed', {
          'category': m.category, 'mime': m.mime, 'stage': 'video_render'});
        return null;
      }
      return bytes;
    } catch (e) {
      Analytics.capture('lib_thumb_failed', {
        'category': m.category, 'mime': m.mime, 'stage': 'video_render', 'err': e.toString()});
      return null;
    }
  }
}

/// PDF first-page renderer (native `pdfx`). Downloads the PDF bytes (skipping
/// very large files), rasterises page 1 to PNG, caps the work. Failure → null.
class _PdfThumber {
  static const _maxBytes = 25 * 1024 * 1024; // don't pull huge PDFs for a thumb

  static Future<Uint8List?> render(LibraryItem m, int px) async {
    PdfDocument? doc;
    PdfPage? page;
    try {
      final res = await http.get(Uri.parse(m.displayUrl)).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) {
        Analytics.capture('lib_thumb_failed', {
          'category': m.category, 'mime': m.mime, 'stage': 'pdf_fetch', 'status': res.statusCode});
        return null;
      }
      if (res.bodyBytes.length > _maxBytes) return null;
      doc = await PdfDocument.openData(res.bodyBytes);
      page = await doc.getPage(1);
      final w = px.toDouble();
      final h = page.width > 0 ? page.height / page.width * w : w;
      final img = await page.render(width: w, height: h, format: PdfPageImageFormat.png);
      return img?.bytes;
    } catch (e) {
      Analytics.capture('lib_thumb_failed', {
        'category': m.category, 'mime': m.mime, 'stage': 'pdf_render', 'err': e.toString()});
      return null;
    } finally {
      try { await page?.close(); } catch (_) {}
      try { await doc?.close(); } catch (_) {}
    }
  }
}
