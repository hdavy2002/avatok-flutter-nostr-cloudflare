import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Disk cache for profile photos. Avatars are content-addressed (the last path
/// segment of the blossom URL is the sha256), so a given URL+size is immutable
/// and safe to cache forever. We fetch the Cloudflare-transformed variant
/// (AVIF, quality 60, fit cover) so the download is tiny and fast, then keep it
/// on disk so it loads instantly next time — no re-download on every open.
class AvatarCache {
  // [AVATAR-MEM-CACHE] (AVA-UI-CACHE) In-memory index of already-resolved cache
  // files, keyed by the same `<name>_<px>` used on disk. The disk cache alone
  // still made every Avatar in a list do an ASYNC file read via a FutureBuilder,
  // so on the chat list each row rendered initials first and the photo "popped
  // in" one by one after its read completed. Once a URL+size has been resolved
  // this session, [peek] returns the File synchronously, so the row can render
  // the photo on the FIRST frame with no waiting flash. Bounded so it can't grow
  // without limit on a huge contact list.
  static const int _memCap = 500;
  static final Map<String, File> _mem = {};

  static void _remember(String key, File f) {
    if (_mem.containsKey(key)) return;
    if (_mem.length >= _memCap) {
      // Cheap eviction: drop the oldest inserted key (Dart maps keep insert order).
      _mem.remove(_mem.keys.first);
    }
    _mem[key] = f;
  }

  /// Synchronous, best-effort lookup of an already-resolved avatar file for this
  /// URL+size. Returns null on a cold cache (caller falls back to the async [get]
  /// via a FutureBuilder). Never touches disk — safe to call in build().
  static File? peek(String rawUrl, int px) {
    if (rawUrl.isEmpty) return null;
    return _mem[_name(rawUrl, px)];
  }

  static Future<Directory> _dir() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/avatars');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static String _name(String url, int px) {
    final seg = Uri.parse(url).pathSegments.isNotEmpty ? Uri.parse(url).pathSegments.last : url;
    final safe = seg.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return '${safe}_$px.img';
  }

  /// Cloudflare Image Transformation URL (enabled on the avatok.ai zone).
  /// https://<host>/cdn-cgi/image/<opts>/<path>
  static String transformUrl(String rawUrl, int px) {
    final u = Uri.parse(rawUrl);
    final opts = 'format=avif,quality=60,width=$px,fit=cover';
    return '${u.scheme}://${u.host}/cdn-cgi/image/$opts${u.path}';
  }

  /// Host-aware sync variant of [transformUrl] for use directly in an
  /// `Image.network(...)` src. ONLY avatok.ai hosts support the /cdn-cgi/image
  /// transform, so we rewrite those (smaller AVIF download, edge-cached) and
  /// return every other URL (YouTube thumbs, OSM tiles, placeholders, non-http
  /// data/asset URIs) UNCHANGED — a bare Image.network has no fallback to the
  /// original, so an unconditional rewrite would break external images. Safe to
  /// wrap any url with: it no-ops on anything that isn't ours.
  static String sizedUrl(String rawUrl, int px) {
    try {
      final u = Uri.parse(rawUrl);
      if (!u.hasScheme || !u.host.endsWith('avatok.ai')) return rawUrl;
      return transformUrl(rawUrl, px);
    } catch (_) {
      return rawUrl;
    }
  }

  /// Store bytes we already have (e.g. just-cropped/uploaded) so the photo shows
  /// instantly without a round-trip.
  static Future<void> putBytes(String rawUrl, int px, Uint8List bytes) async {
    try {
      final f = File('${(await _dir()).path}/${_name(rawUrl, px)}');
      await f.writeAsBytes(bytes, flush: true);
      _remember(_name(rawUrl, px), f); // warm the sync index so it shows instantly
    } catch (_) {/* best-effort */}
  }

  /// Returns a cached file for the avatar, downloading the CF-transformed
  /// variant once if needed. Returns null on any failure (caller shows initials).
  static Future<File?> get(String rawUrl, int px) async {
    if (rawUrl.isEmpty) return null;
    try {
      final f = File('${(await _dir()).path}/${_name(rawUrl, px)}');
      if (await f.exists() && await f.length() > 0) { _remember(_name(rawUrl, px), f); return f; }
      final res = await http.get(Uri.parse(transformUrl(rawUrl, px))).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && _looksLikeImage(res.bodyBytes)) {
        await f.writeAsBytes(res.bodyBytes, flush: true);
        _remember(_name(rawUrl, px), f);
        return f;
      }
    } catch (_) {/* fall through to null */}
    return null;
  }

  /// Host-aware variant for listing images. Only avatok.ai hosts support the
  /// /cdn-cgi/image transform — other hosts (e.g. test/placeholder images) are
  /// fetched raw. Caches the bytes on disk so the image loads instantly next
  /// time instead of re-downloading on every scroll/open (pic 3).
  static Future<File?> getAny(String rawUrl, int px) async {
    if (rawUrl.isEmpty) return null;
    try {
      final f = File('${(await _dir()).path}/${_name(rawUrl, px)}');
      if (await f.exists() && await f.length() > 0) { _remember(_name(rawUrl, px), f); return f; }
      final host = Uri.parse(rawUrl).host;
      final fetchUrl = host.endsWith('avatok.ai') ? transformUrl(rawUrl, px) : rawUrl;
      final res = await http.get(Uri.parse(fetchUrl)).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && _looksLikeImage(res.bodyBytes)) {
        await f.writeAsBytes(res.bodyBytes, flush: true);
        _remember(_name(rawUrl, px), f);
        return f;
      }
    } catch (_) {/* fall through to null */}
    return null;
  }

  /// A 200 response can still be junk — an HTML error page, a WAF challenge, or a
  /// truncated body — which then crashes the decoder ("Invalid image data") AND
  /// poisons the disk cache (the reinstall-loop bug). Only cache bytes that start
  /// with a known image magic number; anything else is treated as a cache miss
  /// (caller falls back to initials/placeholder). Cheap header check, no decode.
  static bool _looksLikeImage(Uint8List b) {
    if (b.length < 12) return false;
    if (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return true;                 // JPEG
    if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return true; // PNG
    if (b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46) return true;                 // GIF
    if (b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 &&
        b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return true; // RIFF/WEBP
    if (b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70) return true; // ftyp (AVIF/HEIF)
    if (b[0] == 0x42 && b[1] == 0x4D) return true;                                 // BMP
    return false;
  }
}
