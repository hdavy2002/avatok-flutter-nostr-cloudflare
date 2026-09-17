import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../identity/identity.dart';
import 'analytics.dart';

/// Versioned, account-scoped image cache. Public transformations use WebP on
/// native clients; signed/private/external URLs retain their original request.
class AvatarCache {
  static const accept = 'image/webp,image/jpeg,image/png,image/gif;q=0.8';
  static const _policy = 'v3-webp-q60-cover';
  static const _memCap = 500;
  static final Map<String, File> _mem = {};
  static final Map<String, Future<File?>> _pending = {};
  static String? _memScope;
  static String? _warmedScope;
  static String get _scopeNow => AccountScope.id ?? 'guest';
  static String _hash(String value) => sha256.convert(utf8.encode(value)).toString();
  static void _ensureScope() {
    if (_memScope == _scopeNow) return;
    _memScope = _scopeNow;
    _mem.clear();
  }
  static void _remember(String scope, String key, File file) {
    if (scope != _scopeNow) return;
    _ensureScope();
    if (_mem.length >= _memCap) _mem.remove(_mem.keys.first);
    _mem[key] = file;
  }
  static int _width(int px) {
    for (final size in const [64, 128, 256, 384, 512, 768, 1024, 1536, 2048]) {
      if (px <= size) return size;
    }
    return 2048;
  }
  static bool _ours(Uri u) =>
      (u.scheme == 'https' || u.scheme == 'http') && u.userInfo.isEmpty &&
      (u.host == 'avatok.ai' || u.host.endsWith('.avatok.ai'));

  static String transformUrl(String rawUrl, int px) {
    final u = Uri.tryParse(rawUrl);
    if (u == null || !_ours(u) || u.hasQuery || u.hasFragment ||
        u.path.startsWith('/cdn-cgi/image/') ||
        u.path.startsWith('/api/') ||
        u.path.toLowerCase().contains('/private') ||
        u.path.toLowerCase().contains('/encrypted')) return rawUrl;
    return u.replace(path: '/cdn-cgi/image/format=webp,quality=60,width=${_width(px)},fit=cover${u.path}').toString();
  }
  static String sizedUrl(String rawUrl, int px) => transformUrl(rawUrl, px);

  static String _name(String url, int px, {String? keyOverride, bool transform = true}) {
    final uri = Uri.tryParse(url);
    // Stable caller-provided artifact IDs keep signed-query rotation cacheable,
    // while origin, path, account directory and policy prevent alias collisions.
    final identity = keyOverride != null && keyOverride.isNotEmpty
        ? '${uri?.scheme}://${uri?.authority}${uri?.path}|artifact:$keyOverride'
        : url;
    return '${_hash('$_policy|$identity|${_width(px)}|transform:$transform')}.img';
  }

  static Future<Directory> _dir(String scope) async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/avatars/$_policy/${_hash(scope)}');
    await d.create(recursive: true);
    return d;
  }

  static File? peek(String rawUrl, int px, {String? cacheKey, bool transform = true}) {
    _ensureScope();
    return _mem[_name(rawUrl, px, keyOverride: cacheKey, transform: transform)];
  }

  static Future<void> warm() async {
    final scope = _scopeNow;
    if (_warmedScope == scope) return;
    _warmedScope = scope;
    try {
      final d = await _dir(scope);
      final files = await d.list(followLinks: false).where((e) =>
          e is File && e.path.endsWith('.img')).cast<File>().take(_memCap).toList();
      for (final file in files) {
        if (await file.length() > 0) _remember(scope, file.uri.pathSegments.last, file);
      }
    } catch (_) {}
  }
  static void reset() {
    _mem.clear();
    _memScope = null;
    _warmedScope = null;
  }
  static Future<void> _write(File f, Uint8List bytes) async {
    await f.parent.create(recursive: true);
    final temp = File('${f.path}.${DateTime.now().microsecondsSinceEpoch}.tmp');
    await temp.writeAsBytes(bytes, flush: true);
    await temp.rename(f.path);
  }

  static Future<void> putBytes(String rawUrl, int px, Uint8List bytes) async {
    final scope = _scopeNow;
    try {
      if (!_looksLikeImage(bytes)) return;
      final name = _name(rawUrl, px);
      final f = File('${(await _dir(scope)).path}/$name');
      await _write(f, bytes);
      _remember(scope, name, f);
    } catch (_) {}
  }
  static Future<File?> get(String rawUrl, int px) => getAny(rawUrl, px);

  static Future<File?> getAny(String rawUrl, int px, {String? cacheKey, bool transform = true}) async {
    if (rawUrl.isEmpty) return null;
    final scope = _scopeNow;
    final name = _name(rawUrl, px, keyOverride: cacheKey, transform: transform);
    final key = '$scope/$name';
    final pending = _pending[key];
    if (pending != null) return pending;
    final request = _load(scope, name, rawUrl, px, transform);
    _pending[key] = request;
    try { return await request; } finally { _pending.remove(key); }
  }

  static Future<File?> _load(String scope, String name, String rawUrl, int px, bool transform) async {
    try {
      final f = File('${(await _dir(scope)).path}/$name');
      if (await f.exists() && await f.length() > 0) {
        if (scope != _scopeNow) return null;
        _remember(scope, name, f);
        return f;
      }
      final fetchUrl = transform ? sizedUrl(rawUrl, px) : rawUrl;
      final uri = Uri.tryParse(fetchUrl);
      if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https')) return null;
      final res = await http.get(uri, headers: {'Accept': accept})
          .timeout(const Duration(seconds: 15));
      if (scope != _scopeNow) return null;
      if (res.statusCode == 200 && _looksLikeImage(res.bodyBytes)) {
        await _write(f, res.bodyBytes);
        if (scope != _scopeNow) return null;
        _remember(scope, name, f);
        // Sample structural metrics only: no URL, artifact ID or signed query.
        if (int.parse(name.substring(0, 2), radix: 16) < 8) {
          unawaited(Analytics.capture('native_image_loaded', {
            'bytes': res.bodyBytes.length,
            'content_type': res.headers['content-type'] ?? 'unknown',
            'transform': fetchUrl != rawUrl, 'width': _width(px),
            'cache_policy': _policy, 'account_scoped': true,
          }));
        }
        return f;
      }
    } catch (_) {}
    return null;
  }

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
