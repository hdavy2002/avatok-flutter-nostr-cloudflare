import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'analytics.dart';
import 'avatar_cache.dart';

// ─────────────────────────────────────────────────────────────────────────────
// [PUBLIC-IMG-PEEK-1] THE PUBLIC-IMAGE TIER.
//
// Everything in this file serves PUBLIC http(s) images: og:image link-preview
// heroes, site favicons, YouTube posters, AI-generated artifacts, public post
// and listing media.
//
// PUBLIC vs DM MEDIA — deliberately DIFFERENT subsystems, and the choice is not
// an accident:
//   * DM attachments are per-account ENCRYPTED media and live under
//     `media/<AccountScope.id>/` via `MediaService`. A parent and a child share
//     one phone and must never be served each other's files.
//   * Everything here carries no per-user secret and is content-addressed, so it
//     lives in the SHARED `avatars/` pool and is correctly NOT account-scoped —
//     the same og:image fetched by two accounts on one device IS the same bytes,
//     and duplicating it per account would just double the disk and the
//     downloads. `AvatarCache` still drops its in-memory index on an account
//     switch, so nothing stale stays resident across a switch.
//
// Therefore an og:image must never be routed through `MediaService`, and a DM
// attachment must never be routed through `AvatarCache`.
// ─────────────────────────────────────────────────────────────────────────────

/// [PUBLIC-IMG-PEEK-1] FIRE-AND-FORGET cache signal for the PUBLIC image tier.
///
/// Deliberately the SAME `cache_event` shape the chat-media tier uses
/// (`MediaService.noteCacheEvent`), so ONE PostHog query covers every media tier
/// and `store` is the only discriminator. `account_scoped: false` is the honest
/// answer: this pool is content-addressed and shared by every account on the
/// device (see the [CachedImage] class doc for why that is correct).
void notePublicImageCache(String result, String source, {int? ms}) {
  unawaited(Analytics.cacheEvent('public_image', result,
      renderMs: ms, accountScoped: false, extra: {'source': source}));
}

/// [PUBLIC-IMG-PEEK-1] Shared resolution for a public image: synchronous
/// [AvatarCache.peek] FIRST, async [AvatarCache.getAny] only on a genuine miss.
///
/// [onFile] is called exactly once. Its `sync` flag is true when the answer came
/// from the in-memory index during the caller's own `initState` — in that case
/// the caller must assign the field directly and MUST NOT call `setState`.
/// Never throws.
void resolvePublicImage(
    String url, int px, void Function(File? file, bool sync) onFile,
    {String? cacheKey}) {
  if (url.isEmpty) {
    onFile(null, true);
    return;
  }
  final hit = AvatarCache.peek(url, px, cacheKey: cacheKey);
  if (hit != null) {
    notePublicImageCache('hit', 'memory');
    onFile(hit, true);
    return;
  }
  final t0 = DateTime.now().millisecondsSinceEpoch;
  unawaited(() async {
    File? f;
    try {
      f = await AvatarCache.getAny(url, px, cacheKey: cacheKey);
    } catch (_) {
      f = null;
    }
    notePublicImageCache(f != null ? 'miss' : 'stale', 'network',
        ms: DateTime.now().millisecondsSinceEpoch - t0);
    onFile(f, false);
  }());
}

/// [PUBLIC-IMG-PEEK-1] A public image that fills whatever box it is given
/// (unlike [CachedImage], which pins its own width/height) — for a thumbnail
/// inside an `AspectRatio`/`Stack(fit: expand)`: a link-preview favicon, a
/// compose-bar thumbnail, a YouTube poster.
///
/// Peeks the shared disk cache synchronously and only falls back to the network
/// on a genuine miss, so a previously-seen image paints on the FIRST frame
/// instead of re-downloading. [fallback] is rendered when the image cannot be
/// shown at all, so a dead favicon degrades to a glyph, never to a broken tile.
class CachedThumb extends StatefulWidget {
  const CachedThumb({
    super.key,
    required this.url,
    required this.px,
    required this.fallback,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
  });

  final String url;

  /// Long-edge pixel target: bounds the DECODE (and the Cloudflare transform
  /// width, when the host is ours).
  final int px;
  final Widget fallback;
  final double? width;
  final double? height;
  final BoxFit fit;

  @override
  State<CachedThumb> createState() => _CachedThumbState();
}

class _CachedThumbState extends State<CachedThumb> {
  File? _file;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(CachedThumb old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url || old.px != widget.px) {
      _file = null;
      _resolve();
    }
  }

  void _resolve() {
    final src = widget.url;
    resolvePublicImage(src, widget.px, (f, sync) {
      if (f == null) return;
      if (sync) {
        _file = f;
        return;
      }
      if (!mounted || widget.url != src) return;
      setState(() => _file = f);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.url.isEmpty) return widget.fallback;
    final f = _file;
    if (f != null) {
      return Image.file(f,
          width: widget.width,
          height: widget.height,
          fit: widget.fit,
          gaplessPlayback: true,
          cacheWidth: widget.px,
          // A poisoned cache entry degrades to a live network load.
          errorBuilder: (_, __, ___) => _net());
    }
    return _net();
  }

  Widget _net() => Image.network(
        // Ask Cloudflare for a small variant when the host is ours; a no-op on
        // every third-party host (see [AvatarCache.sizedUrl]).
        AvatarCache.sizedUrl(widget.url, widget.px),
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        cacheWidth: widget.px,
        errorBuilder: (_, __, ___) => widget.fallback,
      );
}

/// Disk-cached remote image for content-addressed public URLs (AI-generated
/// images, post media, marketplace covers). Downloads the Cloudflare-transformed
/// variant ONCE via [AvatarCache] and then serves it from disk on every reopen —
/// so an image never re-downloads each time the screen is opened (the bug raw
/// `Image.network` caused: it only keeps an in-memory cache that's lost on
/// screen rebuild).
///
/// Falls back to a direct network load on a cache miss/failure so the image
/// still shows; on a hard failure it shows a broken-image placeholder.
///
/// [PUBLIC-IMG-PEEK-1] WHY THIS IS A StatefulWidget NOW (the defect this fixes).
/// It used to go through [AvatarCache.getAny] behind a `FutureBuilder` and NEVER
/// called the synchronous [AvatarCache.peek]. `getAny` is four async hops even
/// on a guaranteed hit (dir → exists → length → File), so:
///
///   * the FIRST frame was ALWAYS a spinner, for every image, on every rebuild
///     of the enclosing screen — including images the device demonstrably had on
///     disk, and
///   * a `FutureBuilder` restarts its future whenever it is rebuilt with a new
///     `future:` expression, so scrolling a list re-ran the whole lookup per row
///     per rebuild.
///
/// That is exactly the defect `Avatar` was fixed for in [AVATAR-MEM-CACHE]: peek
/// synchronously first, fall back to the async path only on a genuine miss. The
/// peek is resolved ONCE per mount (in [State.initState]) rather than in
/// `build()`, so telemetry fires once and the widget does no work per frame.
///
/// Use [CachedThumb] instead when the image must FILL its parent box (inside an
/// `AspectRatio` or a `Stack(fit: expand)`) rather than pin its own size.
class CachedImage extends StatefulWidget {
  final String url;
  final double width;
  final double? height;
  final BoxFit fit;
  final BorderRadius? radius;

  /// Cloudflare transform width to fetch + cache. Defaults to ~2x the display
  /// width (retina-crisp) clamped to a sane range.
  final int? cachePx;

  /// [AVA-MEDIA-AUTHZ-1] Stable id to key the disk cache on instead of [url]
  /// itself — for a presigned URL (e.g. an AI media job artifact) whose
  /// signature rotates on every mint, keying on the raw url makes every
  /// re-render a cache MISS + full re-download (and the rotating signature
  /// would land in the disk filename). Pass the artifact's stable media id;
  /// [url] is still what's fetched on a genuine cache miss. Omit for
  /// ordinary stable URLs (unchanged behavior).
  final String? cacheKey;

  /// [AVA-IMG-SELFHEAL-1] Optional, fired EXACTLY ONCE per [url]/[cacheKey]
  /// (re-armed on [didUpdateWidget] when either changes) with whether this
  /// image actually painted a real frame. `true` from either decode path's
  /// `frameBuilder` (first non-null frame); `false` only when this widget
  /// falls all the way through to the broken-image placeholder — a genuine
  /// dead link, not a transient loading frame. Lets a caller (e.g. a
  /// presigned-URL bubble whose link has a short server-side lifetime) react
  /// to a load failure by re-minting the URL and swapping it in. Omit for the
  /// default silent behavior (unchanged).
  final void Function(bool ok)? onResult;

  const CachedImage(
    this.url, {
    super.key,
    this.width = 240,
    this.height,
    this.fit = BoxFit.cover,
    this.radius,
    this.cachePx,
    this.cacheKey,
    this.onResult,
  });

  @override
  State<CachedImage> createState() => _CachedImageState();
}

class _CachedImageState extends State<CachedImage> {
  /// Resolved on-disk file. Set SYNCHRONOUSLY in [initState] on a warm cache, so
  /// the very first frame paints the real image with no spinner.
  File? _file;

  /// True once the async lookup has finished and produced nothing — only then do
  /// we fall through to a direct (uncached) network load.
  bool _missed = false;

  /// [AVA-IMG-SELFHEAL-1] Guards [widget.onResult] to fire at most once per
  /// [url]/[cacheKey] — reset in [didUpdateWidget] alongside [_file]/[_missed]
  /// so a caller that swaps in a re-minted URL gets a fresh success/failure
  /// signal for THAT url, not a stale guard left over from the old one.
  bool _reported = false;

  int get _px {
    final safeW = widget.width.isFinite ? widget.width : 240.0;
    return (widget.cachePx ?? (safeW * 2).round()).clamp(64, 2048);
  }

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(CachedImage old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url ||
        old.cacheKey != widget.cacheKey ||
        old.cachePx != widget.cachePx ||
        old.width != widget.width) {
      _file = null;
      _missed = false;
      _reported = false;
      _resolve();
    }
  }

  /// [AVA-IMG-SELFHEAL-1] Fire [widget.onResult] at most once for the current
  /// url/cacheKey. Scheduled via a post-frame callback since this can be
  /// invoked from a `frameBuilder`/an inline call during THIS widget's own
  /// build — calling straight into a caller's `setState` synchronously there
  /// would risk "setState during build".
  void _report(bool ok) {
    if (_reported) return;
    _reported = true;
    final cb = widget.onResult;
    if (cb == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => cb(ok));
  }

  void _resolve() {
    if (widget.url.isEmpty) {
      _missed = true;
      return;
    }
    final px = _px;
    // 1. SYNCHRONOUS in-memory index — no I/O, no await, no spinner.
    final hit = AvatarCache.peek(widget.url, px, cacheKey: widget.cacheKey);
    if (hit != null) {
      _file = hit;
      _note('hit', 'memory');
      return;
    }
    // 2. Genuine miss → disk/network, off the paint path. `getAny` populates the
    //    in-memory index on success, so every LATER mount takes branch 1.
    final t0 = DateTime.now().millisecondsSinceEpoch;
    unawaited(() async {
      File? f;
      try {
        f = await AvatarCache.getAny(widget.url, px, cacheKey: widget.cacheKey);
      } catch (_) {
        f = null;
      }
      if (!mounted) return;
      _note(f != null ? 'miss' : 'stale', 'network',
          ms: DateTime.now().millisecondsSinceEpoch - t0);
      setState(() {
        _file = f;
        _missed = f == null;
      });
    }());
  }

  /// FIRE-AND-FORGET, once per mount. Deliberately the SAME `cache_event` shape
  /// the chat-media tier uses (`MediaService.noteCacheEvent`) so one PostHog
  /// query covers every media tier; only `store` distinguishes them.
  /// `account_scoped: false` is the honest answer here — see the class doc.
  void _note(String result, String source, {int? ms}) {
    unawaited(Analytics.cacheEvent('public_image', result,
        renderMs: ms, accountScoped: false, extra: {'source': source}));
  }

  Widget _wrap(Widget child) => widget.radius != null
      ? ClipRRect(borderRadius: widget.radius!, child: child)
      : child;

  Widget _spinner() => SizedBox(
        width: widget.width,
        height: widget.height ?? 200,
        child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );

  Widget _broken() {
    // [AVA-IMG-SELFHEAL-1] Reaching the broken placeholder is the one honest
    // "this image did not load" signal — every other exit (file hit, network
    // hit) reports success via `frameBuilder` below instead.
    _report(false);
    return SizedBox(
      width: widget.width,
      height: widget.height ?? 120,
      child: Center(
          child: PhosphorIcon(PhosphorIcons.imageBroken(PhosphorIconsStyle.regular))),
    );
  }

  Widget _network() => Image.network(
        // Ask Cloudflare for a SMALL variant when the host is ours; a no-op on
        // every other host (see [AvatarCache.sizedUrl]).
        AvatarCache.sizedUrl(widget.url, _px),
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        cacheWidth: _px,
        loadingBuilder: (c, child, progress) =>
            progress == null ? child : _spinner(),
        // [AVA-IMG-SELFHEAL-1] First real decoded frame = success.
        frameBuilder: (_, child, frame, __) {
          if (frame != null) _report(true);
          return child;
        },
        errorBuilder: (_, __, ___) => _broken(),
      );

  @override
  Widget build(BuildContext context) {
    if (widget.url.isEmpty) return _wrap(_broken());
    final f = _file;
    if (f != null) {
      return _wrap(Image.file(
        f,
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        gaplessPlayback: true,
        // Bound the decode: the file may be a 2048px CF variant painted into a
        // 48dp list tile. Keyed consistently (ResizeImage folds the target width
        // into the image-cache key), and it never upscales.
        cacheWidth: _px,
        // [AVA-IMG-SELFHEAL-1] First real decoded frame = success.
        frameBuilder: (_, child, frame, __) {
          if (frame != null) _report(true);
          return child;
        },
        // A poisoned/corrupt cache entry degrades to a live network load, never
        // to a broken tile.
        errorBuilder: (_, __, ___) => _network(),
      ));
    }
    // Cache miss/failure → direct network (shows, just not cached this time).
    if (_missed) return _wrap(_network());
    return _wrap(_spinner());
  }
}
