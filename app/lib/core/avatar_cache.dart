import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../identity/identity.dart';

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

  // [AVATAR-WARM-1] Per-account guard for the PROCESS-WIDE [_mem] index. The
  // avatars/ directory itself is deliberately NOT account-scoped — entries are
  // content-addressed (the filename is the sha256 of the bytes, from the last
  // path segment of the blossom URL), so a key can only ever resolve to the one
  // set of bytes it names and no account can be handed another account's photo
  // by a key collision. The guard exists so a *switch* doesn't leave the
  // previous account's working set resident: on the first touch after
  // AccountScope.id changes we drop the index, which also stops a stale entry
  // outliving a photo change made by the other account in the same process.
  static String? _memScope;

  static String get _scopeNow =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'guest' : AccountScope.id!;

  /// Cheap (one string compare) — safe to call from build() via [peek].
  static void _ensureScope() {
    final s = _scopeNow;
    if (_memScope == s) return;
    _memScope = s;
    _mem.clear();
  }

  static void _remember(String key, File f) {
    _ensureScope();
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
  ///
  /// [PUBLIC-IMG-PEEK-1] [cacheKey] mirrors [getAny]'s parameter and MUST be
  /// passed whenever the async lookup passed it, or the sync and async paths key
  /// on different names and the peek can never hit for that image.
  static File? peek(String rawUrl, int px, {String? cacheKey}) {
    if (rawUrl.isEmpty) return null;
    _ensureScope();
    return _mem[_name(rawUrl, px, keyOverride: cacheKey)];
  }

  // [AVATAR-WARM-1] getApplicationSupportDirectory() is a native platform-channel
  // round-trip, and this used to run on EVERY get/getAny/putBytes — i.e. once per
  // avatar, ~15-20 concurrent round-trips the moment a chat list painted. Memoise
  // the FUTURE (not the value): with a plain `??=` on a value, every concurrent
  // caller passes the null check before the first await resolves and they all make
  // the native call anyway. Same fix, same reason, as DiskCache._baseFut — whose
  // comment records that it removed most of the ~850ms list-loading cost.
  static Future<Directory>? _dirFut;

  static Future<Directory> _dir() => _dirFut ??= _openDir();

  static Future<Directory> _openDir() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/avatars');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static bool _warmed = false;

  /// [AVATAR-WARM-1] Populate the synchronous [peek] index from what is ALREADY
  /// on disk, so a cached avatar paints on the FIRST frame instead of showing an
  /// initials circle and popping to the photo when a per-row FutureBuilder
  /// resolves. Without this, [_mem] is empty on every cold start and *every*
  /// avatar misses on frame 1 — the visible "settling" on launch.
  ///
  /// The disk filename IS the cache key ([_name] → `<safe>_<px>.img`), so one
  /// directory listing reconstructs the whole index with no parsing and no
  /// per-file async work.
  ///
  /// Uses SYNCHRONOUS I/O (`listSync`/`statSync`). That is deliberate and is
  /// acceptable exactly ONCE, at boot, off the widget path — never per build and
  /// never per avatar. Call it from boot only; do not call it from a widget.
  ///
  /// MUST be called AFTER any cache purge (`DiskCache.flushImageCachesOnce`,
  /// `DiskCache.purgeAllCaches`) — warming first would index files that are
  /// about to be deleted. Idempotent: a second call is a no-op. Never throws.
  static Future<void> warm() async {
    if (_warmed) return;
    _warmed = true;
    try {
      final d = await _dir();
      _ensureScope();
      // Cap the scan so a pathological directory can't stall boot.
      final entries = d.listSync(followLinks: false).take(2000).toList();
      final files = <MapEntry<String, File>>[];
      final stamps = <String, DateTime>{};
      for (final e in entries) {
        if (e is! File) continue;
        final name = e.uri.pathSegments.isNotEmpty ? e.uri.pathSegments.last : '';
        if (name.isEmpty || !name.endsWith('.img')) continue;
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
        // Keep the most recently used entries; the rest fall back to the async path.
        files.sort((a, b) => (stamps[b.key] ?? DateTime(0)).compareTo(stamps[a.key] ?? DateTime(0)));
      }
      for (final e in files.take(_memCap)) {
        _mem.putIfAbsent(e.key, () => e.value);
      }
    } catch (_) {/* never block boot on a cache warm */}
  }

  /// [AVATAR-WARM-1] Now that [_dir] is memoised it no longer re-creates the
  /// directory on every call, so a cache purge (which deletes `avatars/`
  /// recursively) can leave us holding a handle to a directory that no longer
  /// exists — and every subsequent write would fail silently, permanently
  /// disabling the avatar cache. Costs nothing on the happy path: only a failed
  /// write drops the memo, re-creates the directory and retries once.
  static Future<void> _write(File f, Uint8List bytes) async {
    try {
      await f.writeAsBytes(bytes, flush: true);
    } catch (_) {
      _dirFut = null;
      await (await _dir()).create(recursive: true);
      await f.writeAsBytes(bytes, flush: true);
    }
  }

  /// Drop the synchronous index and the memoised directory future. Call after a
  /// cache purge or a sign-out so nothing stale is served from memory.
  static void reset() {
    _mem.clear();
    _memScope = null;
    _warmed = false;
    _dirFut = null;
  }

  /// [AVA-MEDIA-AUTHZ-1] [keyOverride], when given, replaces the URL-derived
  /// name entirely — for a caller with a STABLE content id whose URL is a
  /// presigned link that re-mints (and rotates its signature) on every fetch,
  /// keying on the url would make every re-render a cache MISS + full
  /// re-download, and the rotating signature would otherwise land in a disk
  /// filename. See [getAny]'s `cacheKey` param.
  static String _name(String url, int px, {String? keyOverride}) {
    final seg = (keyOverride != null && keyOverride.isNotEmpty)
        ? keyOverride
        : (Uri.parse(url).pathSegments.isNotEmpty ? Uri.parse(url).pathSegments.last : url);
    final safe = seg.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    return '${safe}_$px.img';
  }

  /// Cloudflare Image Transformation URL (enabled on the avatok.ai zone).
  /// https://<host>/cdn-cgi/image/<opts>/<path>
  ///
  /// ⚠️ [LIB-READABLE-1 2026-08-21] RETURNS THE URL UNCHANGED WHEN IT HAS A
  /// QUERY STRING. This transform rebuilds the URL from scheme + host + PATH
  /// only, which silently DROPS `?…`. That is harmless for a public blossom
  /// CDN object (no query) and destructive for a SIGNED url: the worker's
  /// private-read fallback is `…/api/media/private-read?key=…&exp=…&sig=…` on
  /// an `api.avatok.ai` host, so `sizedUrl` matched it, stripped the entire
  /// signature, and the request came back 404 "Not found" — one of the ways
  /// the owner's library tiles rendered blank.
  ///
  /// A signed URL cannot be transformed without re-signing, so the correct
  /// answer is to leave it alone and pay for the full-size download.
  static String transformUrl(String rawUrl, int px) {
    final u = Uri.parse(rawUrl);
    if (u.hasQuery) return rawUrl;
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
      await _write(f, bytes);
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
        await _write(f, res.bodyBytes);
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
  ///
  /// [AVA-MEDIA-AUTHZ-1] [cacheKey] — pass a stable id (e.g.
  /// `AiMediaJob.artifactMediaId`) when [rawUrl] is a presigned URL whose
  /// signature rotates on every mint: the disk (and in-memory) cache is then
  /// keyed on the id, so re-rendering the SAME artifact is a cache hit even
  /// though the fetched URL differs byte-for-byte each time. [rawUrl] is
  /// still what's actually fetched on a miss. Omit for ordinary stable URLs
  /// (unchanged behavior).
  static Future<File?> getAny(String rawUrl, int px, {String? cacheKey, bool transform = true}) async {
    if (rawUrl.isEmpty) return null;
    try {
      final name = _name(rawUrl, px, keyOverride: cacheKey);
      final f = File('${(await _dir()).path}/$name');
      if (await f.exists() && await f.length() > 0) { _remember(name, f); return f; }
      final host = Uri.parse(rawUrl).host;
      final fetchUrl = transform && host.endsWith('avatok.ai') ? transformUrl(rawUrl, px) : rawUrl;
      final res = await http.get(Uri.parse(fetchUrl)).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && _looksLikeImage(res.bodyBytes)) {
        await _write(f, res.bodyBytes);
        _remember(name, f);
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
