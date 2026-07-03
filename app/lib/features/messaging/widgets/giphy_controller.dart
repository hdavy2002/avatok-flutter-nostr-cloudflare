// GIPHY picker controller (STREAM E — Tenor→GIPHY migration).
//
// Wraps the official `giphy_flutter_sdk` GiphyDialog so a chat can open the full
// GIPHY experience — GIFs, Stickers, GIPHY Text (with dynamic on-demand text
// creation), Emoji, and Clips (GIFs WITH SOUND / short video) — in ONE line:
//
//     GiphyController.instance.open(context, onPick: (g) => _sendGif(g));
//
// On selection we map the native GiphyMedia to our compact [GifResult] (picking
// the best CDN URL for the send + a small preview URL) and tag its
// [GifContentType] so the send pipeline routes clips as a video message,
// stickers/text/emoji as bubble-less stickers, and gifs as animated media. The
// selected item is then downloaded → encrypted → uploaded to R2 by the EXISTING
// pipeline (_sendGif → _sendMedia → MediaService.encryptAndUpload), so recipients
// fetch from R2 and never hit GIPHY, and the local-first cache keeps working.
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'package:giphy_flutter_sdk/giphy_flutter_sdk.dart';
import 'package:giphy_flutter_sdk/giphy_dialog.dart';
import 'package:giphy_flutter_sdk/dto/giphy_media.dart';
import 'package:giphy_flutter_sdk/dto/giphy_media_type.dart';
import 'package:giphy_flutter_sdk/dto/giphy_settings.dart';
import 'package:giphy_flutter_sdk/dto/giphy_content_type.dart';

import 'gif_api.dart';
import 'giphy_config.dart';

/// Singleton bridge to the GIPHY dialog. Lazily configures the SDK (with the
/// client SDK key) on first open, then routes the one active media-selection
/// callback back to the chat that opened it.
class GiphyController implements GiphyMediaSelectionListener {
  GiphyController._();
  static final GiphyController instance = GiphyController._();

  bool _configured = false;
  ValueChanged<GifResult>? _onPick;
  VoidCallback? _onDismiss;

  /// Configure the GIPHY SDK once (per-platform SDK key). Safe to call repeatedly.
  void ensureConfigured() {
    if (_configured) return;
    try {
      final String key = Platform.isIOS ? kGiphyIosSdkKey : kGiphyAndroidSdkKey;
      // videoCacheMaxBytes defaults to 100MB — REQUIRED (>0) for Clips playback.
      GiphyFlutterSDK.configure(apiKey: key);
      GiphyDialog.instance.addListener(this);
      _configured = true;
    } catch (e) {
      if (kDebugMode) debugPrint('GIPHY configure failed: $e');
    }
  }

  /// Open the full GIPHY picker with ALL content types enabled: recents, gif,
  /// sticker, GIPHY Text (dynamic text creation ON), emoji, and clips.
  void open(
    BuildContext context, {
    required ValueChanged<GifResult> onPick,
    VoidCallback? onDismiss,
  }) {
    ensureConfigured();
    _onPick = onPick;
    _onDismiss = onDismiss;
    const settings = GiphySettings(
      mediaTypeConfig: [
        GiphyContentType.recents,
        GiphyContentType.gif,
        GiphyContentType.sticker,
        GiphyContentType.text,
        GiphyContentType.emoji,
        GiphyContentType.clips,
      ],
      selectedContentType: GiphyContentType.gif,
      // GIPHY Text: generate animated text stickers on demand when a search has
      // no library match. This is the "dynamic text creation" experience.
      enableDynamicText: true,
      showConfirmationScreen: true,
      showCheckeredBackground: true,
    );
    GiphyDialog.instance.configure(settings: settings);
    GiphyDialog.instance.show();
  }

  @override
  void onMediaSelect(GiphyMedia media) {
    GiphyDialog.instance.hide();
    final cb = _onPick;
    _onPick = null;
    if (cb == null) return;
    final mapped = _map(media);
    if (mapped != null) cb(mapped);
  }

  @override
  void onDismiss() {
    _onPick = null;
    final cb = _onDismiss;
    _onDismiss = null;
    cb?.call();
  }

  /// Classify a GiphyMedia into our content-type + pick the best URLs.
  GifResult? _map(GiphyMedia media) {
    final images = media.images;

    // Preview: a small, cheap looping rendition for grids / recents.
    final preview = _firstUrl([
      images.fixedWidthDownsampled?.webPUrl,
      images.fixedWidthDownsampled?.gifUrl,
      images.fixedWidthSmall?.webPUrl,
      images.fixedWidthSmall?.gifUrl,
      images.fixedWidth?.webPUrl,
      images.fixedWidth?.gifUrl,
      images.downsized?.gifUrl,
      images.original?.webPUrl,
      images.original?.gifUrl,
    ]);

    // Dimensions from a representative rendition.
    final dim = images.fixedWidth ?? images.original ?? images.downsized;
    final width = dim?.width ?? 0;
    final height = dim?.height ?? 0;
    final desc = (media.title ?? media.altText ?? '').trim();

    // CLIPS (GIFs with sound / short video): send the mp4 video WITH audio.
    if (media.isVideo ||
        media.type == GiphyMediaType.video ||
        media.video != null) {
      final v = media.video;
      final videoUrl = _firstUrl([
        v?.assets?.size480p?.url,
        v?.assets?.size360p?.url,
        v?.assets?.size720p?.url,
        v?.assets?.source?.url,
        v?.assets?.size1080p?.url,
        // Fall back to the mp4 rendition of the still preview if no clip asset.
        images.original?.mp4Url,
        images.fixedWidth?.mp4Url,
      ]);
      if (videoUrl != null) {
        final a = v?.assets?.size480p ?? v?.assets?.size360p ?? v?.assets?.source;
        return GifResult(
          id: media.id,
          preview: preview ?? videoUrl,
          url: videoUrl,
          width: a?.width ?? width,
          height: a?.height ?? height,
          desc: desc,
          contentType: GifContentType.clip,
        );
      }
      // No playable video URL — fall through and treat as a gif.
    }

    // STICKER / TEXT / EMOJI → send a transparent WebP so it renders bubble-less.
    // Dynamic (GIPHY Text) and stickers keep transparency best as WebP/GIF.
    final bool stickerish =
        media.isSticker || media.isDynamic || media.type == GiphyMediaType.sticker;
    if (stickerish) {
      final url = _firstUrl([
        images.original?.webPUrl,
        images.original?.gifUrl,
        images.fixedWidth?.webPUrl,
        images.fixedWidth?.gifUrl,
        images.downsized?.gifUrl,
      ]);
      if (url != null) {
        return GifResult(
          id: media.id,
          preview: preview ?? url,
          url: url,
          width: width,
          height: height,
          desc: desc,
          contentType:
              media.isDynamic ? GifContentType.text : GifContentType.sticker,
        );
      }
    }

    if (media.type == GiphyMediaType.emoji) {
      final url = _firstUrl([
        images.original?.webPUrl,
        images.original?.gifUrl,
        images.fixedWidth?.gifUrl,
      ]);
      if (url != null) {
        return GifResult(
          id: media.id,
          preview: preview ?? url,
          url: url,
          width: width,
          height: height,
          desc: desc,
          contentType: GifContentType.emoji,
        );
      }
    }

    // Default: an animated GIF. Prefer a compact GIF for the send.
    final gifUrl = _firstUrl([
      images.downsized?.gifUrl,
      images.downsizedMedium?.gifUrl,
      images.fixedWidth?.gifUrl,
      images.original?.gifUrl,
      images.original?.webPUrl,
    ]);
    if (gifUrl == null) return null;
    return GifResult(
      id: media.id,
      preview: preview ?? gifUrl,
      url: gifUrl,
      width: width,
      height: height,
      desc: desc,
      contentType: GifContentType.gif,
    );
  }

  String? _firstUrl(List<String?> candidates) {
    for (final c in candidates) {
      if (c != null && c.isNotEmpty) return c;
    }
    return null;
  }
}
