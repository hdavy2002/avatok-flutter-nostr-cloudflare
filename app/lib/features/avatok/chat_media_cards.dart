import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:video_player/video_player.dart';
import 'package:video_thumbnail/video_thumbnail.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/ui/avatok_dark.dart';
import '../messaging/widgets/media_download_placeholder.dart';
import 'media.dart';

/// Rich in-chat preview cards (Issue: attachments rendered as bare filenames).
///
/// Every file type now renders a real preview INSIDE the chat bubble instead of
/// a plain icon + name chip:
///   • Video  → first-frame thumbnail + play overlay; tap plays inline.
///   • PDF    → first-page raster thumbnail + type badge.
///   • Other files → typed card (coloured extension badge + name + size).
///   • YouTube links → a card with the video thumbnail + title; tap plays the
///     clip inline (youtube_player_iframe) without leaving the chat.
///   • Plain links in text → tappable.
///
/// All renderers are best-effort and NEVER throw into the chat. Every failure is
/// reported to PostHog via [Analytics] (email/phone ride in the standard
/// envelope) so a blank preview is diagnosable remotely.

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Human-readable byte size (e.g. "2.4 MB").
String prettySize(int bytes) {
  if (bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  var b = bytes.toDouble();
  var u = 0;
  while (b >= 1024 && u < units.length - 1) {
    b /= 1024;
    u++;
  }
  final s = b >= 100 || u == 0 ? b.toStringAsFixed(0) : b.toStringAsFixed(1);
  return '$s ${units[u]}';
}

/// File extension (UPPERCASE, no dot) from a filename. '' when none.
String extOf(String name) {
  final i = name.lastIndexOf('.');
  if (i < 0 || i == name.length - 1) return '';
  return name.substring(i + 1).toUpperCase();
}

/// First YouTube video id found in [text], or null. Handles youtu.be/<id>,
/// youtube.com/watch?v=<id>, /shorts/<id>, /embed/<id>, /live/<id>.
String? firstYouTubeId(String text) {
  final re = RegExp(
    r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})',
    caseSensitive: false,
  );
  final m = re.firstMatch(text);
  return m?.group(1);
}

/// All http(s) URLs in [text], in order, with their [start]/[end] offsets.
List<({int start, int end, String url})> urlSpans(String text) {
  final re = RegExp(r'https?://[^\s<>()]+', caseSensitive: false);
  return re
      .allMatches(text)
      .map((m) => (start: m.start, end: m.end, url: m.group(0)!))
      .toList();
}

Future<void> _open(String url) async {
  try {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (e) {
    AvaLog.I.log('media', 'launch failed $url: $e');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linkified message text — URLs become tappable; everything else plain.
// ─────────────────────────────────────────────────────────────────────────────

class ChatLinkText extends StatelessWidget {
  const ChatLinkText({super.key, required this.text, required this.style});
  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final spans = urlSpans(text);
    if (spans.isEmpty) return Text(text, style: style);
    final linkStyle = style.copyWith(
      color: AD.iconSearch,
      decoration: TextDecoration.underline,
    );
    final children = <InlineSpan>[];
    var cursor = 0;
    for (final s in spans) {
      if (s.start > cursor) {
        children.add(TextSpan(text: text.substring(cursor, s.start)));
      }
      final url = s.url;
      children.add(TextSpan(
        text: url,
        style: linkStyle,
        recognizer: TapGestureRecognizer()..onTap = () => _open(url),
      ));
      cursor = s.end;
    }
    if (cursor < text.length) children.add(TextSpan(text: text.substring(cursor)));
    return Text.rich(TextSpan(style: style, children: children));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [UI-BUBBLE-3] Voice-note bubble — LARGE circular play button (>=44dp touch
// target), a static waveform bar (progress-tinted while playing), a live
// duration on the right, and a playback-speed chip (1x/1.5x/2x) that appears
// once playback has started. Same 78% max-width rule (governed by the parent
// bubble's BoxConstraints). Playback itself is owned by the parent (one shared
// AudioPlayer); this widget is pure presentation + callbacks.
// ─────────────────────────────────────────────────────────────────────────────

class VoiceNoteBubble extends StatefulWidget {
  const VoiceNoteBubble({
    super.key,
    required this.playing,
    required this.speed,
    required this.onPlayPause,
    required this.onCycleSpeed,
    this.onRight = false,
  });

  final bool playing;
  final double speed; // 1.0 | 1.5 | 2.0
  final VoidCallback onPlayPause;
  final VoidCallback onCycleSpeed;
  final bool onRight; // my message (lime) vs theirs (card) — tints the bars

  @override
  State<VoiceNoteBubble> createState() => _VoiceNoteBubbleState();
}

class _VoiceNoteBubbleState extends State<VoiceNoteBubble> {
  // A stable, deterministic-looking waveform so the same note always draws the
  // same shape (no random reshuffle on rebuild). 26 bars.
  static const List<double> _bars = [
    0.30, 0.55, 0.42, 0.78, 0.62, 0.90, 0.48, 0.70, 0.35, 0.60,
    0.85, 0.52, 0.40, 0.72, 0.95, 0.58, 0.44, 0.66, 0.38, 0.80,
    0.50, 0.68, 0.34, 0.74, 0.46, 0.88,
  ];
  Timer? _tick;
  int _elapsed = 0; // seconds, live while playing (we don't store true duration)

  @override
  void didUpdateWidget(VoiceNoteBubble old) {
    super.didUpdateWidget(old);
    if (widget.playing && !old.playing) {
      _elapsed = 0;
      _tick?.cancel();
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => _elapsed++);
      });
    } else if (!widget.playing && old.playing) {
      _tick?.cancel();
      _tick = null;
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  String get _durLabel {
    final m = _elapsed ~/ 60, s = _elapsed % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final active = widget.playing;
    final barPlayed = widget.onRight ? AD.bubbleOutPlay : AD.bubbleInPlay;
    final barIdle =
        (widget.onRight ? AD.bubbleOutMeta : AD.bubbleInMeta).withValues(alpha: 0.4);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      // LARGE circular play/pause — 44dp touch target.
      GestureDetector(
        onTap: widget.onPlayPause,
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: widget.onRight ? AD.bubbleOutPlay : AD.bubbleInPlay,
            shape: BoxShape.circle,
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: const [],
          ),
          child: Center(
            child: PhosphorIcon(
              active
                  ? PhosphorIcons.pause(PhosphorIconsStyle.fill)
                  : PhosphorIcons.play(PhosphorIconsStyle.fill),
              size: 20,
              color: Colors.white,
            ),
          ),
        ),
      ),
      const SizedBox(width: 10),
      // Waveform — bars tint to `barPlayed` while playing, idle otherwise.
      SizedBox(
        width: 128,
        height: 30,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (final h in _bars)
              Container(
                width: 2.6,
                height: 6 + h * 22,
                decoration: BoxDecoration(
                  color: active ? barPlayed : barIdle,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
          ],
        ),
      ),
      const SizedBox(width: 10),
      Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(active ? _durLabel : 'Voice',
              style: ADText.bubbleMeta(
                  c: widget.onRight ? AD.bubbleOutMeta : AD.bubbleInMeta)),
          // Speed chip — only after playback has started.
          if (active) ...[
            const SizedBox(height: 3),
            GestureDetector(
              onTap: widget.onCycleSpeed,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: (widget.onRight ? AD.bubbleOutInk : AD.bubbleInInk)
                      .withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(
                      color: (widget.onRight ? AD.bubbleOutInk : AD.bubbleInInk)
                          .withValues(alpha: 0.30),
                      width: 1),
                ),
                child: Text(
                  widget.speed == 1.0
                      ? '1x'
                      : (widget.speed == 1.5 ? '1.5x' : '2x'),
                  style: ADText.bubbleMeta(
                      c: widget.onRight ? AD.bubbleOutInk : AD.bubbleInInk),
                ),
              ),
            ),
          ],
        ],
      ),
    ]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [UI-BUBBLE-2] Shared overlay pieces so media (image/video) can be THE bubble:
// a bottom gradient scrim carrying the timestamp/status bottom-right, and a
// "↪ Forwarded" label top-left. Compose these over any edge-to-edge media clip.
// Other streams (I forwarded-label, C link-preview) reuse the same scrim idiom.
// ─────────────────────────────────────────────────────────────────────────────

/// A bottom-right timestamp/status chip on a subtle dark gradient scrim, meant to
/// be the last child of a Stack over an image/video. [trailing] is the caller's
/// timestamp + delivery-status row (built with its own logic).
class MediaTimestampScrim extends StatelessWidget {
  const MediaTimestampScrim({super.key, required this.trailing});
  final Widget trailing;
  @override
  Widget build(BuildContext context) => Positioned(
        left: 0,
        right: 0,
        bottom: 0,
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 16, 8, 6),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Colors.transparent, Colors.black.withValues(alpha: 0.55)],
            ),
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [trailing]),
        ),
      );
}

/// "↪ Forwarded" label overlaid top-left on media (render when envelope fwd:true).
class MediaForwardedLabel extends StatelessWidget {
  const MediaForwardedLabel({super.key});
  @override
  Widget build(BuildContext context) => Positioned(
        left: 6,
        top: 6,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
                size: 11, color: Colors.white),
            const SizedBox(width: 3),
            Text('FORWARDED', style: ADText.statCaption(c: Colors.white)),
          ]),
        ),
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// [UI-BUBBLE-2] Image card — the media IS the bubble: fills the bubble width
// edge-to-edge, aspect-fits within a 320dp height cap (cover-crops extreme
// sources), rounded clip, NO inner padding. Timestamp + forwarded overlays are
// composed by the caller via the Stack children passed in [overlays].
// ─────────────────────────────────────────────────────────────────────────────

class ChatImageCard extends StatelessWidget {
  const ChatImageCard({
    super.key,
    required this.bytes,
    this.onTap,
    this.overlays = const [],
    this.maxHeight = 320,
  });
  final Uint8List bytes;
  final VoidCallback? onTap;
  final List<Widget> overlays; // forwarded label, timestamp scrim
  final double maxHeight;
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(children: [
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: Image.memory(
              bytes,
              // Fill the bubble width; cover-crop only the vertical excess.
              width: double.infinity,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          ),
          ...overlays,
        ]),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Video card — first-frame thumbnail + tap-to-play inline.
// ─────────────────────────────────────────────────────────────────────────────

class ChatVideoCard extends StatefulWidget {
  const ChatVideoCard({
    super.key,
    required this.media,
    this.localBytes,
    this.width = 220,
    this.autoFetch = true,
    this.onFullscreen,
  });

  final ChatMedia? media;
  final Uint8List? localBytes;
  final double width;
  /// STREAM J (D17): when false, the card does NOT eagerly download to build the
  /// thumbnail — it shows a tap-to-download placeholder instead. A manual tap
  /// (play / download) still fetches. Once bytes are fetched they are cached.
  final bool autoFetch;
  final VoidCallback? onFullscreen;

  @override
  State<ChatVideoCard> createState() => _ChatVideoCardState();
}

class _ChatVideoCardState extends State<ChatVideoCard> {
  Uint8List? _thumb;
  bool _thumbTried = false;
  VideoPlayerController? _ctrl;
  bool _starting = false;
  File? _tmp;

  bool _needsDownload = false; // STREAM J: auto-download off & nothing cached yet

  @override
  void initState() {
    super.initState();
    // STREAM J (D17): only eagerly fetch (to build the first-frame thumbnail)
    // when auto-download is on or we already have local bytes. Otherwise show a
    // tap-to-download placeholder; a tap fetches and then plays.
    if (widget.autoFetch || widget.localBytes != null) {
      _makeThumb();
    } else {
      _needsDownload = true;
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    _tmp?.delete().ignore();
    super.dispose();
  }

  Future<Uint8List?> _bytes() async {
    if (widget.localBytes != null) return widget.localBytes;
    if (widget.media != null) {
      return MediaService.downloadAndDecrypt(widget.media!);
    }
    return null;
  }

  Future<File?> _file() async {
    if (_tmp != null) return _tmp;
    final data = await _bytes();
    if (data == null) return null;
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/cv_${DateTime.now().microsecondsSinceEpoch}.mp4');
    await f.writeAsBytes(data, flush: true);
    _tmp = f;
    return f;
  }

  Future<void> _makeThumb() async {
    try {
      final f = await _file();
      if (f == null) {
        _thumbDone(null, 'no_bytes');
        return;
      }
      final bytes = await VideoThumbnail.thumbnailData(
        video: f.path,
        imageFormat: ImageFormat.JPEG,
        maxWidth: (widget.width * 2).round(),
        quality: 70,
      );
      _thumbDone(bytes, bytes == null || bytes.isEmpty ? 'empty' : null);
    } catch (e) {
      _thumbDone(null, e.toString());
    }
  }

  void _thumbDone(Uint8List? bytes, String? err) {
    if (!mounted) return;
    setState(() {
      _thumb = (bytes != null && bytes.isNotEmpty) ? bytes : null;
      _thumbTried = true;
    });
    if (err != null) {
      Analytics.capture('chat_media_preview_failed', {
        'kind': 'video',
        'stage': 'thumbnail',
        'err': err,
      });
    } else {
      Analytics.capture('chat_media_preview_rendered', {'kind': 'video'});
    }
  }

  Future<void> _playInline() async {
    if (_starting || _ctrl != null) return;
    setState(() => _starting = true);
    Analytics.capture('chat_video_play_inline', {});
    try {
      final f = await _file();
      if (f == null) throw 'no_bytes';
      final c = VideoPlayerController.file(f);
      await c.initialize();
      c.setLooping(true);
      await c.play();
      if (!mounted) {
        c.dispose();
        return;
      }
      setState(() {
        _ctrl = c;
        _starting = false;
      });
    } catch (e) {
      if (mounted) setState(() => _starting = false);
      Analytics.capture('chat_media_preview_failed', {
        'kind': 'video',
        'stage': 'inline_play',
        'err': e.toString(),
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // STREAM J (D17): auto-download off & nothing cached yet → tap-to-download.
    // Tapping fetches the bytes, then builds the thumbnail + plays inline.
    if (_needsDownload && widget.media != null) {
      return MediaDownloadPlaceholder(
        media: widget.media!,
        width: widget.width,
        height: widget.width * 9 / 16,
        onFetched: (_) {
          if (!mounted) return;
          setState(() => _needsDownload = false);
          _makeThumb();
        },
      );
    }
    final c = _ctrl;
    if (c != null && c.value.isInitialized) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(alignment: Alignment.center, children: [
          GestureDetector(
            onTap: () => setState(
                () => c.value.isPlaying ? c.pause() : c.play()),
            child: SizedBox(
              width: widget.width,
              child: AspectRatio(
                aspectRatio: c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
                child: VideoPlayer(c),
              ),
            ),
          ),
          if (!c.value.isPlaying)
            _playGlyph(),
          Positioned(
            right: 6,
            bottom: 6,
            child: GestureDetector(
              onTap: widget.onFullscreen,
              child: _pill(PhosphorIcons.arrowsOut(PhosphorIconsStyle.bold)),
            ),
          ),
        ]),
      );
    }

    // Thumbnail (or a placeholder while it renders / after a failure).
    return GestureDetector(
      onTap: _playInline,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(alignment: Alignment.center, children: [
          if (_thumb != null)
            Image.memory(_thumb!, width: widget.width, fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink())
          else
            Container(
              width: widget.width,
              height: widget.width * 9 / 16,
              color: AD.card,
              alignment: Alignment.center,
              child: _thumbTried
                  ? PhosphorIcon(PhosphorIcons.filmSlate(PhosphorIconsStyle.fill),
                      color: Colors.white, size: 34)
                  : const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
            ),
          if (_starting)
            const SizedBox(
                width: 30,
                height: 30,
                child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
          else
            _playGlyph(),
          Positioned(
            left: 6,
            bottom: 6,
            child: _pill(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), label: 'VIDEO'),
          ),
        ]),
      ),
    );
  }

  Widget _playGlyph() => Container(
        width: 52,
        height: 52,
        decoration: BoxDecoration(
          color: AD.bubbleOutPlay,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 2),
          boxShadow: const [],
        ),
        child: Center(
          child: PhosphorIcon(PhosphorIcons.play(PhosphorIconsStyle.fill),
              size: 22, color: Colors.white),
        ),
      );

  Widget _pill(IconData icon, {String? label}) => Container(
        padding: EdgeInsets.symmetric(horizontal: label == null ? 6 : 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.6),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 13, color: Colors.white),
          if (label != null) ...[
            const SizedBox(width: 4),
            Text(label, style: ADText.statCaption(c: Colors.white)),
          ],
        ]),
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// File card — PDF first-page thumbnail, or a typed card for any other file.
// ─────────────────────────────────────────────────────────────────────────────

class ChatFileCard extends StatefulWidget {
  const ChatFileCard({
    super.key,
    required this.media,
    this.localBytes,
    required this.name,
    this.mime = '',
    this.size = 0,
    this.width = 240,
    this.autoFetch = true,
    this.onOpen,
  });

  final ChatMedia? media;
  final Uint8List? localBytes;
  final String name;
  final String mime;
  final int size;
  final double width;
  /// STREAM J (D17): when false, the card does NOT eagerly download to render a
  /// PDF first-page thumbnail — it shows the typed card (name + size + OPEN),
  /// which itself is the tap-to-download affordance (onOpen fetches). A manual
  /// tap always fetches; fetched bytes are cached.
  final bool autoFetch;
  final VoidCallback? onOpen;

  @override
  State<ChatFileCard> createState() => _ChatFileCardState();
}

class _ChatFileCardState extends State<ChatFileCard> {
  Uint8List? _pdfThumb;

  bool get _isPdf =>
      widget.mime == 'application/pdf' || widget.name.toLowerCase().endsWith('.pdf');

  @override
  void initState() {
    super.initState();
    // STREAM J (D17): only pre-render the PDF thumbnail (which requires a
    // download) when auto-download is on or the bytes are already local.
    if (_isPdf && (widget.autoFetch || widget.localBytes != null)) _makePdfThumb();
  }

  Future<Uint8List?> _bytes() async {
    if (widget.localBytes != null) return widget.localBytes;
    if (widget.media != null) return MediaService.downloadAndDecrypt(widget.media!);
    return null;
  }

  Future<void> _makePdfThumb() async {
    PdfDocument? doc;
    PdfPage? page;
    try {
      final data = await _bytes();
      if (data == null || data.isEmpty) return;
      doc = await PdfDocument.openData(data);
      page = await doc.getPage(1);
      final w = (widget.width * 1.5);
      final h = page.width > 0 ? page.height / page.width * w : w;
      final img = await page.render(
          width: w, height: h, format: PdfPageImageFormat.png);
      if (!mounted) return;
      if (img != null) {
        setState(() => _pdfThumb = img.bytes);
        Analytics.capture('chat_media_preview_rendered', {'kind': 'pdf'});
      }
    } catch (e) {
      Analytics.capture('chat_media_preview_failed', {
        'kind': 'pdf',
        'stage': 'render',
        'err': e.toString(),
      });
    } finally {
      try { await page?.close(); } catch (_) {}
      try { await doc?.close(); } catch (_) {}
    }
  }

  ({IconData icon, Color color, String label}) _typeInfo() {
    final ext = extOf(widget.name);
    final n = widget.name.toLowerCase();
    final m = widget.mime.toLowerCase();
    if (_isPdf) return (icon: PhosphorIcons.filePdf(PhosphorIconsStyle.fill), color: const Color(0xFFE8553B), label: 'PDF');
    if (n.endsWith('.doc') || n.endsWith('.docx') || m.contains('word')) {
      return (icon: PhosphorIcons.fileDoc(PhosphorIconsStyle.fill), color: const Color(0xFF2B6CB0), label: ext.isEmpty ? 'DOC' : ext);
    }
    if (n.endsWith('.xls') || n.endsWith('.xlsx') || n.endsWith('.csv') || m.contains('sheet')) {
      return (icon: PhosphorIcons.fileXls(PhosphorIconsStyle.fill), color: const Color(0xFF2F855A), label: ext.isEmpty ? 'XLS' : ext);
    }
    if (n.endsWith('.ppt') || n.endsWith('.pptx') || m.contains('presentation')) {
      return (icon: PhosphorIcons.filePpt(PhosphorIconsStyle.fill), color: const Color(0xFFDD6B20), label: ext.isEmpty ? 'PPT' : ext);
    }
    if (n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z') || n.endsWith('.tar') || n.endsWith('.gz')) {
      return (icon: PhosphorIcons.fileZip(PhosphorIconsStyle.fill), color: const Color(0xFF6B46C1), label: ext.isEmpty ? 'ZIP' : ext);
    }
    if (n.endsWith('.mp3') || n.endsWith('.wav') || n.endsWith('.m4a') || m.startsWith('audio/')) {
      return (icon: PhosphorIcons.fileAudio(PhosphorIconsStyle.fill), color: const Color(0xFFB83280), label: ext.isEmpty ? 'AUDIO' : ext);
    }
    if (n.endsWith('.txt') || n.endsWith('.md') || m.startsWith('text/')) {
      return (icon: PhosphorIcons.fileText(PhosphorIconsStyle.fill), color: AD.textSecondary, label: ext.isEmpty ? 'TXT' : ext);
    }
    return (icon: PhosphorIcons.file(PhosphorIconsStyle.fill), color: AD.textSecondary, label: ext.isEmpty ? 'FILE' : ext);
  }

  @override
  Widget build(BuildContext context) {
    final info = _typeInfo();
    final sizeLabel = prettySize(widget.size);

    // PDF with a rendered first page → image-forward card.
    if (_isPdf && _pdfThumb != null) {
      return GestureDetector(
        onTap: widget.onOpen,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: Stack(children: [
            Image.memory(_pdfThumb!, width: widget.width, fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink()),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                color: Colors.black.withValues(alpha: 0.62),
                child: Row(children: [
                  Icon(info.icon, size: 16, color: Colors.white),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(widget.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.preview(c: Colors.white)),
                  ),
                  if (sizeLabel.isNotEmpty) ...[
                    const SizedBox(width: 6),
                    Text(sizeLabel, style: ADText.statCaption(c: Colors.white)),
                  ],
                ]),
              ),
            ),
          ]),
        ),
      );
    }

    // Typed card: coloured square badge (extension) + name + size.
    return GestureDetector(
      onTap: widget.onOpen,
      child: Container(
        width: widget.width,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(children: [
          Container(
            width: 46,
            height: 52,
            decoration: BoxDecoration(
              color: info.color.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(AD.rBadge),
              border: Border.all(color: info.color, width: 1),
            ),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(info.icon, size: 22, color: info.color),
              const SizedBox(height: 2),
              Text(info.label,
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: ADText.statCaption(c: info.color)),
            ]),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(widget.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.rowName()),
                const SizedBox(height: 3),
                Row(children: [
                  if (sizeLabel.isNotEmpty)
                    Text(sizeLabel, style: ADText.statCaption(c: AD.textSecondary)),
                  if (sizeLabel.isNotEmpty) const SizedBox(width: 8),
                  PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
                      size: 13, color: AD.iconSearch),
                  const SizedBox(width: 3),
                  Text('OPEN', style: ADText.statCaption(c: AD.iconSearch)),
                ]),
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube card — thumbnail + title; tap plays inline.
// ─────────────────────────────────────────────────────────────────────────────

class YouTubeCard extends StatefulWidget {
  const YouTubeCard({
    super.key,
    required this.videoId,
    required this.url,
    this.width = 260,
  });

  final String videoId;
  final String url;
  final double width;

  @override
  State<YouTubeCard> createState() => _YouTubeCardState();
}

class _YouTubeCardState extends State<YouTubeCard> {
  YoutubePlayerController? _ctrl;
  String? _title;
  String? _author;
  bool _loadingMeta = true;

  @override
  void initState() {
    super.initState();
    _fetchMeta();
  }

  @override
  void dispose() {
    _ctrl?.close();
    super.dispose();
  }

  Future<void> _fetchMeta() async {
    try {
      final res = await http
          .get(Uri.parse(
              'https://www.youtube.com/oembed?url=${Uri.encodeComponent(widget.url)}&format=json'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        if (mounted) {
          setState(() {
            _title = (j['title'] ?? '').toString();
            _author = (j['author_name'] ?? '').toString();
            _loadingMeta = false;
          });
          return;
        }
      }
    } catch (_) {/* fall through to no-meta card */}
    if (mounted) setState(() => _loadingMeta = false);
  }

  void _play() {
    Analytics.capture('chat_youtube_play', {'video_id': widget.videoId});
    setState(() {
      _ctrl = YoutubePlayerController.fromVideoId(
        videoId: widget.videoId,
        autoPlay: true,
        params: const YoutubePlayerParams(
          showControls: true,
          showFullscreenButton: true,
          enableCaption: true,
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = _ctrl;
    return Container(
      width: widget.width,
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (c != null)
          YoutubePlayer(controller: c, aspectRatio: 16 / 9)
        else
          GestureDetector(
            onTap: _play,
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: Stack(fit: StackFit.expand, alignment: Alignment.center, children: [
                Image.network(
                  'https://img.youtube.com/vi/${widget.videoId}/hqdefault.jpg',
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => Container(color: AD.card),
                ),
                Container(color: Colors.black.withValues(alpha: 0.12)),
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: AD.brandYoutube,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 2),
                    boxShadow: const [],
                  ),
                  child: const Icon(Icons.play_arrow, color: Colors.white, size: 30),
                ),
                Positioned(
                  left: 8,
                  top: 8,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(100),
                    ),
                    child: Text('YOUTUBE', style: ADText.statCaption(c: Colors.white)),
                  ),
                ),
              ]),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(
              _loadingMeta ? 'YouTube video' : (_title?.isNotEmpty == true ? _title! : 'YouTube video'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: ADText.rowName(),
            ),
            if (_author?.isNotEmpty == true) ...[
              const SizedBox(height: 2),
              Text(_author!, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption(c: AD.textSecondary)),
            ],
          ]),
        ),
      ]),
    );
  }
}
