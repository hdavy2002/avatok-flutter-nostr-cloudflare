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

  /// Store bytes we already have (e.g. just-cropped/uploaded) so the photo shows
  /// instantly without a round-trip.
  static Future<void> putBytes(String rawUrl, int px, Uint8List bytes) async {
    try {
      final f = File('${(await _dir()).path}/${_name(rawUrl, px)}');
      await f.writeAsBytes(bytes, flush: true);
    } catch (_) {/* best-effort */}
  }

  /// Returns a cached file for the avatar, downloading the CF-transformed
  /// variant once if needed. Returns null on any failure (caller shows initials).
  static Future<File?> get(String rawUrl, int px) async {
    if (rawUrl.isEmpty) return null;
    try {
      final f = File('${(await _dir()).path}/${_name(rawUrl, px)}');
      if (await f.exists() && await f.length() > 0) return f;
      final res = await http.get(Uri.parse(transformUrl(rawUrl, px))).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await f.writeAsBytes(res.bodyBytes, flush: true);
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
      if (await f.exists() && await f.length() > 0) return f;
      final host = Uri.parse(rawUrl).host;
      final fetchUrl = host.endsWith('avatok.ai') ? transformUrl(rawUrl, px) : rawUrl;
      final res = await http.get(Uri.parse(fetchUrl)).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await f.writeAsBytes(res.bodyBytes, flush: true);
        return f;
      }
    } catch (_) {/* fall through to null */}
    return null;
  }
}
