import 'dart:io';

import 'package:flutter/material.dart';

import 'avatar_cache.dart';

/// Disk-cached remote image for content-addressed public URLs (AI-generated
/// images, post media). Downloads the Cloudflare-transformed variant ONCE via
/// [AvatarCache] and then serves it from disk on every reopen — so an image
/// never re-downloads each time the chat is opened (the bug raw `Image.network`
/// caused: it only keeps an in-memory cache that's lost on screen rebuild).
///
/// Falls back to a direct network load on a cache miss/failure so the image
/// still shows; on a hard failure it shows a broken-image placeholder.
class CachedImage extends StatelessWidget {
  final String url;
  final double width;
  final double? height;
  final BoxFit fit;
  final BorderRadius? radius;

  /// Cloudflare transform width to fetch + cache. Defaults to ~2x the display
  /// width (retina-crisp) clamped to a sane range.
  final int? cachePx;

  const CachedImage(
    this.url, {
    super.key,
    this.width = 240,
    this.height,
    this.fit = BoxFit.cover,
    this.radius,
    this.cachePx,
  });

  Widget _wrap(Widget child) =>
      radius != null ? ClipRRect(borderRadius: radius!, child: child) : child;

  Widget _spinner() => SizedBox(
        width: width,
        height: height ?? 200,
        child: const Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );

  Widget _broken() => SizedBox(
        width: width,
        height: height ?? 120,
        child: const Center(child: Icon(Icons.broken_image_outlined)),
      );

  Widget _network() => Image.network(
        url,
        width: width,
        height: height,
        fit: fit,
        loadingBuilder: (c, child, progress) =>
            progress == null ? child : _spinner(),
        errorBuilder: (_, __, ___) => _broken(),
      );

  @override
  Widget build(BuildContext context) {
    if (url.isEmpty) return _wrap(_broken());
    final safeW = (width.isFinite ? width : 240);
    final px = (cachePx ?? (safeW * 2).round()).clamp(64, 2048);
    return _wrap(FutureBuilder<File?>(
      // getAny is host-aware: avatok.ai images use the CF transform, other hosts
      // (e.g. placeholders/test images) are cached raw — so EVERY image is
      // cached on disk and never re-downloads on reopen.
      future: AvatarCache.getAny(url, px),
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return _spinner();
        final f = snap.data;
        if (f != null) {
          return Image.file(
            f,
            width: width,
            height: height,
            fit: fit,
            errorBuilder: (_, __, ___) => _network(),
          );
        }
        // Cache miss/failure → direct network (shows, just not cached this time).
        return _network();
      },
    ));
  }
}
