// NOTE: `dart:async` was dropped with [VOICE-SCRUB-1] — the voice bubble's local
// 1s Timer is gone, replaced by real position/duration streamed from the parent's
// AudioPlayer, and nothing else in this file needs it.
import 'dart:collection';
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
import '../../core/ui/bubble_theme.dart';
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
  const ChatLinkText({super.key, required this.text, required this.style, this.theme});
  final String text;
  final TextStyle style;

  /// Resolved bubble theme (see `core/ui/bubble_theme.dart`). Null keeps the
  /// original hardcoded link-accent colour (pre-[AVAGRP-CARDS-1] callers).
  final BubbleTheme? theme;

  @override
  Widget build(BuildContext context) {
    final spans = urlSpans(text);
    if (spans.isEmpty) return Text(text, style: style);
    // Link accent: [theme.play] is the closest role to "tappable accent" the
    // contract defines (play/waveform/progress) — reuse it here rather than
    // adding a new BubbleTheme field for a single hyperlink colour.
    final linkStyle = style.copyWith(
      color: theme?.play ?? AD.iconSearch,
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
// [CHAT-UI-MEDIA-1] Fixed-size shimmer placeholder — swapped in wherever media
// is loading/decrypting/downloading in place of a bare `CircularProgressIndicator`
// so a media-heavy thread reads as "content incoming" rather than "stuck", and
// (paired with a fixed-size box at every call site) the row never resizes when
// the real media lands. No new package — a small AnimatedBuilder gradient sweep.
// ─────────────────────────────────────────────────────────────────────────────

class MediaShimmerPlaceholder extends StatefulWidget {
  const MediaShimmerPlaceholder({super.key, required this.width, required this.height, this.borderRadius = 14});
  final double width;
  final double height;
  final double borderRadius;

  @override
  State<MediaShimmerPlaceholder> createState() => _MediaShimmerPlaceholderState();
}

class _MediaShimmerPlaceholderState extends State<MediaShimmerPlaceholder>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.borderRadius),
      child: SizedBox(
        width: widget.width,
        height: widget.height,
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) {
            final t = _c.value; // 0..1 sweep
            return DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment(-1 + 2 * t - 0.6, 0),
                  end: Alignment(-1 + 2 * t + 0.6, 0),
                  colors: const [Color(0xFFE7E7EC), Color(0xFFF4F4F7), Color(0xFFE7E7EC)],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [VOICE-SCRUB-1] (owner report 2026-07-16, pic 5) Voice-note bubble — a LARGE
// circular play button (>=44dp touch target), a WIDE **scrubbable** waveform
// timeline with a red playhead, the real clip duration, and a playback-speed
// chip (1x/1.5x/2x). Playback itself is owned by the parent (one shared
// AudioPlayer); this widget is presentation + callbacks, and the parent feeds
// it real `position`/`duration` from the player's streams.
//
// What changed and why (all four were the same root cause — the widget knew
// nothing about the audio, so it could only mime playback):
//
//  1. WIDTH. The waveform was a hardcoded `SizedBox(width: 128)`, which left a
//     ~2.6px-wide bar per 4 seconds of a long note. It now `Expanded`s to fill
//     the bubble, so there is enough travel for a thumb to land on a moment.
//  2. SCRUBBING. There was no gesture but `onTap` on the play circle — you
//     could not jump to the end of a 3-minute note without listening to it.
//     Tap-anywhere and drag now seek, via `onSeek`.
//  3. PLAYHEAD. Nothing marked "you are here": bars only flat-swapped colour
//     for the whole clip. There is now a red line + red dot riding the
//     position, video-editor style, as the owner asked for.
//  4. DURATION. `_elapsed` was a local 1s Timer started on play, i.e. an
//     invented number that always began at 0:00 and never knew the clip's real
//     length. Both sides of `0:07 / 0:40` are now the player's own truth.
// ─────────────────────────────────────────────────────────────────────────────

class VoiceNoteBubble extends StatefulWidget {
  const VoiceNoteBubble({
    super.key,
    required this.playing,
    required this.speed,
    required this.onPlayPause,
    required this.onCycleSpeed,
    this.position = Duration.zero,
    this.duration,
    this.onSeek,
    this.onRight = false,
    this.theme,
  });

  final bool playing;
  final double speed; // 1.0 | 1.5 | 2.0
  final VoidCallback onPlayPause;
  final VoidCallback onCycleSpeed;

  /// Live playhead position from the parent's AudioPlayer.
  final Duration position;

  /// True clip length — null until the player has decoded the header (or for a
  /// note that has never been opened), which is why the label falls back to
  /// 'Voice' rather than inventing a number.
  final Duration? duration;

  /// Seek request from a tap/drag on the timeline. Null → not scrubbable yet
  /// (nothing loaded), and the timeline renders as a plain waveform.
  final void Function(Duration to)? onSeek;

  final bool onRight; // my message (lime) vs theirs (card) — tints the bars

  /// Resolved bubble theme. Non-null → ALL colours below come from it (play
  /// button, active bars, meta label, speed-chip ink); null falls back to the
  /// original [onRight]-derived colours exactly, so any caller that hasn't
  /// migrated yet keeps its old look.
  final BubbleTheme? theme;

  @override
  State<VoiceNoteBubble> createState() => _VoiceNoteBubbleState();
}

class _VoiceNoteBubbleState extends State<VoiceNoteBubble> {
  // A stable, deterministic-looking waveform so the same note always draws the
  // same shape (no random reshuffle on rebuild). 40 bars — more than the old 26
  // because the timeline is now full-width and 26 bars would look sparse.
  //
  // NOTE: this is still a decorative shape, not the note's real amplitude
  // envelope — rendering a true envelope means decoding the whole clip on
  // receive, which is a separate piece of work. It is honest about position
  // (the playhead and the progress tint are real), just not about loudness.
  static const List<double> _bars = [
    0.30, 0.55, 0.42, 0.78, 0.62, 0.90, 0.48, 0.70, 0.35, 0.60,
    0.85, 0.52, 0.40, 0.72, 0.95, 0.58, 0.44, 0.66, 0.38, 0.80,
    0.50, 0.68, 0.34, 0.74, 0.46, 0.88, 0.56, 0.36, 0.82, 0.64,
    0.44, 0.76, 0.32, 0.68, 0.54, 0.86, 0.40, 0.60, 0.48, 0.70,
  ];

  /// While the thumb is down we render THIS fraction instead of
  /// `widget.position`, so the playhead tracks the finger at 60fps instead of
  /// waiting for the player's ~200ms position callbacks to catch up (which
  /// feels like dragging a rubber band).
  double? _dragFrac;

  static String _fmt(Duration d) {
    final m = d.inMinutes, s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  bool get _scrubbable =>
      widget.onSeek != null &&
      widget.duration != null &&
      widget.duration!.inMilliseconds > 0;

  double get _frac {
    if (_dragFrac != null) return _dragFrac!;
    final total = widget.duration?.inMilliseconds ?? 0;
    if (total <= 0) return 0;
    return (widget.position.inMilliseconds / total).clamp(0.0, 1.0);
  }

  void _seekTo(double frac, {required bool commit}) {
    final total = widget.duration;
    if (total == null || widget.onSeek == null) return;
    final f = frac.clamp(0.0, 1.0);
    setState(() => _dragFrac = commit ? null : f);
    widget.onSeek!(Duration(milliseconds: (total.inMilliseconds * f).round()));
  }

  @override
  Widget build(BuildContext context) {
    final active = widget.playing;
    final t = widget.theme;
    final barPlayed = t?.play ?? (widget.onRight ? AD.bubbleOutPlay : AD.bubbleInPlay);
    final barIdle =
        (t?.meta ?? (widget.onRight ? AD.bubbleOutMeta : AD.bubbleInMeta)).withValues(alpha: 0.4);
    final metaC = t?.meta ?? (widget.onRight ? AD.bubbleOutMeta : AD.bubbleInMeta);
    final inkC = t?.ink ?? (widget.onRight ? AD.bubbleOutInk : AD.bubbleInInk);
    final borderC = t?.border ?? AD.borderControl;

    final dur = widget.duration;
    // Show 'Voice' only while we genuinely don't know the length; never invent
    // a counter that starts at 0:00 regardless of the clip (the old behaviour).
    final label = dur == null
        ? 'Voice'
        : (active || _dragFrac != null || widget.position > Duration.zero
            ? '${_fmt(widget.position)} / ${_fmt(dur)}'
            : _fmt(dur));

    return Row(mainAxisSize: MainAxisSize.min, children: [
      // LARGE circular play/pause — 44dp touch target.
      GestureDetector(
        onTap: widget.onPlayPause,
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: barPlayed,
            shape: BoxShape.circle,
            border: Border.all(color: borderC, width: 1),
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
      // Scrubbable waveform timeline. `Expanded` (not a fixed 128px) is the
      // point of the fix: the bubble's own 78% max-width constraint decides how
      // wide this gets, so a voice note now spans the bubble left-to-right.
      Expanded(
        child: LayoutBuilder(builder: (context, box) {
          final w = box.maxWidth;
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            // Generous vertical slop: the visible bars are 30px tall but the
            // gesture area is padded to a 44dp-ish target so scrubbing doesn't
            // demand surgical precision.
            onTapDown: _scrubbable
                ? (d) => _seekTo(d.localPosition.dx / w, commit: true)
                : null,
            onHorizontalDragStart: _scrubbable
                ? (d) => _seekTo(d.localPosition.dx / w, commit: false)
                : null,
            onHorizontalDragUpdate: _scrubbable
                ? (d) => _seekTo(d.localPosition.dx / w, commit: false)
                : null,
            onHorizontalDragEnd:
                _scrubbable ? (_) => _seekTo(_frac, commit: true) : null,
            child: SizedBox(
              height: 40,
              child: Stack(alignment: Alignment.center, children: [
                // Bars — everything left of the playhead is "played".
                //
                // The bar's tint threshold is its CENTRE as a fraction of the
                // laid-out width, matching how the playhead's x is computed
                // (`_frac * w`). Using the naive `i / length` instead would
                // measure from each bar's left edge and drift out of step with
                // the playhead by up to a full bar under `spaceBetween` — the
                // red line would sit visibly off the colour boundary it's
                // supposed to be drawing.
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    for (var i = 0; i < _bars.length; i++)
                      Container(
                        width: 2.6,
                        height: 6 + _bars[i] * 22,
                        decoration: BoxDecoration(
                          color: ((i + 0.5) / _bars.length) <= _frac
                              ? barPlayed
                              : barIdle,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                  ],
                ),
                // The red playhead the owner asked for: a full-height line with
                // a dot on top, so you can see exactly where you're scrubbing to
                // and drop back onto an exact moment. Only drawn once we know
                // the duration — a playhead with nothing to point at is a lie.
                if (_scrubbable)
                  Positioned(
                    left: (_frac * w).clamp(0.0, w) - 5,
                    top: 0,
                    bottom: 0,
                    child: SizedBox(
                      width: 10,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.start,
                        children: [
                          Container(
                            width: 10,
                            height: 10,
                            decoration: const BoxDecoration(
                              color: AD.danger,
                              shape: BoxShape.circle,
                            ),
                          ),
                          Expanded(
                            child: Container(width: 2, color: AD.danger),
                          ),
                        ],
                      ),
                    ),
                  ),
              ]),
            ),
          );
        }),
      ),
      const SizedBox(width: 10),
      Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(label, style: ADText.bubbleMeta(c: metaC)),
          // Speed chip — only after playback has started.
          if (active) ...[
            const SizedBox(height: 3),
            GestureDetector(
              onTap: widget.onCycleSpeed,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: inkC.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(
                      color: inkC.withValues(alpha: 0.30), width: 1),
                ),
                child: Text(
                  widget.speed == 1.0
                      ? '1x'
                      : (widget.speed == 1.5 ? '1.5x' : '2x'),
                  style: ADText.bubbleMeta(c: inkC),
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
// [AVAVM-PLAYER-1] Posting feedback for a voice note.
//
// Root cause (owner report, 2026-07-16, pic2 point 2): while a voice note
// uploads, `m.media` is null and only `m.localBytes` (the raw .m4a) is set.
// `_mediaContent` used to GUESS the kind from that state alone —
// `m.localBytes != null ? MediaKind.image : MediaKind.file` — so a
// mid-upload voice note was rendered as `Image.memory()` on raw audio bytes,
// which fails to decode and falls through `errorBuilder` to
// `SizedBox.shrink()`: an EMPTY bubble next to the sender's avatar, with
// nothing to tell the owner his note was even sent. `_Msg.pendingKind`
// (stamped at optimistic-bubble creation, see `_sendMedia`) fixes the
// guessing bug at the source; these two widgets give the audio case
// something honest to show instead of trying to play/preview bytes that
// aren't a real bubble yet.
// ─────────────────────────────────────────────────────────────────────────────

/// Shown in place of [VoiceNoteBubble] while a voice note is still uploading.
/// An indeterminate ring in the same 44dp play-button slot + a plain "posting"
/// label reads as "this is on its way", not "did it disappear?".
class PendingVoiceNoteBubble extends StatelessWidget {
  final bool onRight;

  /// Resolved bubble theme; null keeps the original [onRight]-derived colours.
  final BubbleTheme? theme;
  const PendingVoiceNoteBubble({super.key, this.onRight = false, this.theme});

  @override
  Widget build(BuildContext context) {
    final metaC = theme?.meta ?? (onRight ? AD.bubbleOutMeta : AD.bubbleInMeta);
    final playC = theme?.play ?? (onRight ? AD.bubbleOutPlay : AD.bubbleInPlay);
    final borderC = theme?.border ?? AD.borderControl;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: playC.withValues(alpha: 0.5),
          shape: BoxShape.circle,
          border: Border.all(color: borderC, width: 1),
        ),
        child: const Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
          ),
        ),
      ),
      const SizedBox(width: 10),
      Text('Posting your voice note…', style: ADText.bubbleMeta(c: metaC)),
    ]);
  }
}

/// Shown in place of [VoiceNoteBubble] when the upload FAILED — an explicit
/// error beats a bubble that spins forever. The message's own status row
/// ("Not sent · tap to retry") already re-runs the upload for any media kind;
/// [onRetry] is an extra, more discoverable tap target on the bubble itself.
class FailedVoiceNoteBubble extends StatelessWidget {
  final bool onRight;
  final VoidCallback? onRetry;

  /// Accepted for signature parity with the other voice-bubble states, but
  /// deliberately UNUSED for colour: a failed upload is a universal error
  /// state (red), not a per-sender tint — theming it would make a failure
  /// blend into whichever pale colour the sender happens to have.
  final BubbleTheme? theme;
  const FailedVoiceNoteBubble({super.key, this.onRight = false, this.onRetry, this.theme});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onRetry,
      behavior: HitTestBehavior.opaque,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: AD.danger.withValues(alpha: 0.16),
            shape: BoxShape.circle,
            border: Border.all(color: AD.danger, width: 1),
          ),
          child: Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold), size: 20, color: AD.danger),
        ),
        const SizedBox(width: 10),
        Text("Couldn't send · tap to retry", style: ADText.bubbleMeta(c: AD.danger)),
      ]),
    );
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
  const MediaTimestampScrim({super.key, required this.trailing, this.theme});
  final Widget trailing;

  /// Accepted for signature parity but deliberately UNUSED: this scrim paints
  /// OVER the photo/video pixels, not the bubble fill, so it must stay a
  /// black gradient + white text regardless of the bubble's pale tint — the
  /// underlying media can be any colour, and a themed (pale) scrim would be
  /// unreadable over a bright frame. See report for the full reasoning: the
  /// owner's "every message needs a date+time" requirement is satisfied by
  /// keeping this scrim exactly as-is; only Agent A's day/thread-level meta
  /// row (for kinds with no scrim, e.g. file cards) needed a new visible
  /// timestamp.
  final BubbleTheme? theme;
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
  const MediaForwardedLabel({super.key, this.theme});

  /// Accepted for signature parity but deliberately UNUSED — same reasoning
  /// as [MediaTimestampScrim]: this badge sits on top of the media pixels,
  /// not the bubble fill, so it stays a fixed black/white badge.
  final BubbleTheme? theme;
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
    this.theme,
    this.heroTag,
  });
  final Uint8List bytes;
  final VoidCallback? onTap;
  final List<Widget> overlays; // forwarded label, timestamp scrim
  final double maxHeight;

  /// Accepted for signature parity but deliberately UNUSED — the image IS the
  /// bubble (no inner fill/ink of its own to theme); the pale bubble fill and
  /// border are painted by the caller's outer bubble container.
  final BubbleTheme? theme;

  /// [CHAT-UI-VIEWER-1] When set, wraps the image in a `Hero` with this tag so
  /// tapping through to the fullscreen viewer (which must use the SAME tag)
  /// animates instead of hard-cutting. Null keeps the old plain `Image.memory`
  /// (e.g. any caller that hasn't wired a matching fullscreen Hero yet).
  final Object? heroTag;
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(children: [
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: _maybeHero(Image.memory(
              bytes,
              // Fill the bubble width; cover-crop only the vertical excess.
              width: double.infinity,
              fit: BoxFit.cover,
              // [MEDIA-RETRY-KIND-1] A failed decode used to render as
              // literally nothing (`SizedBox.shrink()`) — confirmed in prod as
              // "the message vanished". Show a broken-image placeholder and
              // report it instead of silently dropping the bubble's content.
              errorBuilder: (_, __, ___) {
                Analytics.capture('chat_media_load_failed', {
                  'kind': 'image', 'reason': 'decode_failed', 'stage': 'bubble_card',
                });
                return Container(
                  color: Colors.black12,
                  alignment: Alignment.center,
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    PhosphorIcon(PhosphorIcons.imageBroken(PhosphorIconsStyle.bold),
                        size: 26, color: Colors.white70),
                    const SizedBox(height: 6),
                    const Text("Couldn't load", style: TextStyle(color: Colors.white70, fontSize: 12)),
                  ]),
                );
              },
            )),
          ),
          ...overlays,
        ]),
      ),
    );
  }

  Widget _maybeHero(Widget child) =>
      heroTag == null ? child : Hero(tag: heroTag!, child: child);
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
    this.theme,
  });

  final ChatMedia? media;
  final Uint8List? localBytes;
  final double width;
  /// STREAM J (D17): when false, the card does NOT eagerly download to build the
  /// thumbnail — it shows a tap-to-download placeholder instead. A manual tap
  /// (play / download) still fetches. Once bytes are fetched they are cached.
  final bool autoFetch;
  final VoidCallback? onFullscreen;

  /// Resolved bubble theme. Used for the play-glyph accent and the pre-thumb
  /// loading square; null keeps the original hardcoded colours.
  final BubbleTheme? theme;

  @override
  State<ChatVideoCard> createState() => _ChatVideoCardState();
}

class _ChatVideoCardState extends State<ChatVideoCard> {
  // [CHAT-UI-MEDIA-1] In-memory LRU cache for generated first-frame thumbnails,
  // keyed by media id (falls back to a cheap content fingerprint for a
  // not-yet-uploaded local send). Before this, EVERY card mount — i.e. every
  // scroll back onto a video bubble — rewrote a temp .mp4 and re-ran the native
  // thumbnail decode from scratch (audit finding D6). Process-lifetime only;
  // deliberately small so it never competes meaningfully with real media memory.
  static final LinkedHashMap<String, Uint8List> _thumbCache = LinkedHashMap();
  static const int _thumbCacheMax = 40;

  static void _thumbCachePut(String key, Uint8List bytes) {
    _thumbCache.remove(key);
    _thumbCache[key] = bytes;
    while (_thumbCache.length > _thumbCacheMax) {
      _thumbCache.remove(_thumbCache.keys.first);
    }
  }

  String? get _thumbKey {
    final id = widget.media?.id;
    if (id != null && id.isNotEmpty) return 'm_$id';
    final lb = widget.localBytes;
    if (lb != null && lb.isNotEmpty) {
      return 'lb_${lb.length}_${lb.first}_${lb[lb.length ~/ 2]}_${lb.last}';
    }
    return null;
  }

  Uint8List? _thumb;
  bool _thumbTried = false;
  VideoPlayerController? _ctrl;
  bool _starting = false;
  File? _tmp;

  bool _needsDownload = false; // STREAM J: auto-download off & nothing cached yet

  @override
  void initState() {
    super.initState();
    final key = _thumbKey;
    final cached = key == null ? null : _thumbCache[key];
    if (cached != null) {
      _thumb = cached;
      _thumbTried = true;
      return;
    }
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
    final ok = bytes != null && bytes.isNotEmpty;
    setState(() {
      _thumb = ok ? bytes : null;
      _thumbTried = true;
    });
    if (ok) {
      final key = _thumbKey;
      if (key != null) _thumbCachePut(key, bytes);
    }
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
                // [CHAT-UI-MEDIA-1] cacheWidth bound, same reasoning as the
                // chat_thread.dart image bubble sites.
                cacheWidth: (widget.width * MediaQuery.of(context).devicePixelRatio * 2).round(),
                errorBuilder: (_, __, ___) => const SizedBox.shrink())
          else if (!_thumbTried)
            // [CHAT-UI-MEDIA-1] Fixed-size shimmer instead of a spinner-on-dark-
            // square while the thumbnail decodes — the box is already fixed
            // (widget.width x 9:16), so this never resizes the row.
            MediaShimmerPlaceholder(width: widget.width, height: widget.width * 9 / 16, borderRadius: 0)
          else
            Container(
              width: widget.width,
              height: widget.width * 9 / 16,
              // Themed → a neutral loading fill that reads on a pale bubble
              // (the old AD.card near-black square read as a hole punched in
              // the bubble once the canvas/bubbles went pale/white).
              color: widget.theme != null ? AD.mediaPlaceholderBg : AD.card,
              alignment: Alignment.center,
              child: PhosphorIcon(PhosphorIcons.filmSlate(PhosphorIconsStyle.fill),
                  color: widget.theme != null ? AD.mediaPlaceholderLabel : Colors.white,
                  size: 34),
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
          color: widget.theme?.play ?? AD.bubbleOutPlay,
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
    this.theme,
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

  /// Resolved bubble theme. Colours the TYPED card's fill/border/text (the
  /// file IS the bubble in that layout, like [ChatImageCard]); the PDF-thumb
  /// variant's black filename scrim is left alone for the same reason as
  /// [MediaTimestampScrim] — it paints over the rendered page pixels, not a
  /// themeable fill. Null keeps the original AD.card/dark-mode look.
  final BubbleTheme? theme;

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
                // [CHAT-UI-MEDIA-1] Same cacheWidth bound as the other list thumbs.
                cacheWidth: (widget.width * MediaQuery.of(context).devicePixelRatio * 2).round(),
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

    // Typed card: coloured square badge (extension) + name + size. The
    // extension badge (info.color) stays file-type-accented (PDF red, DOC
    // blue, ...) regardless of theme — that colour identifies the FILE KIND,
    // not the sender, and is meaningful across every bubble tint.
    final t = widget.theme;
    final cardBg = t?.bg ?? AD.card;
    final cardBorder = t?.border ?? AD.borderControl;
    final inkC = t?.ink;
    final metaC = t?.meta ?? AD.textSecondary;
    final accentC = t?.play ?? AD.iconSearch;
    return GestureDetector(
      onTap: widget.onOpen,
      child: Container(
        width: widget.width,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: cardBg,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: cardBorder, width: 1),
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
                    style: inkC != null ? ADText.rowName(c: inkC) : ADText.rowName()),
                const SizedBox(height: 3),
                Row(children: [
                  if (sizeLabel.isNotEmpty)
                    Text(sizeLabel, style: ADText.statCaption(c: metaC)),
                  if (sizeLabel.isNotEmpty) const SizedBox(width: 8),
                  PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
                      size: 13, color: accentC),
                  const SizedBox(width: 3),
                  Text('OPEN', style: ADText.statCaption(c: accentC)),
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
    this.theme,
  });

  final String videoId;
  final String url;
  final double width;

  /// Resolved bubble theme. Colours the card's fill/border/title/author text;
  /// the play-badge overlay (drawn on the video thumbnail pixels, not the
  /// card fill) is left as the fixed brand-red disc, same reasoning as
  /// [MediaTimestampScrim].
  final BubbleTheme? theme;

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
    final t = widget.theme;
    return Container(
      width: widget.width,
      decoration: BoxDecoration(
        color: t?.bg ?? AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: t?.border ?? AD.borderControl, width: 1),
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
              style: t != null ? ADText.rowName(c: t.ink) : ADText.rowName(),
            ),
            if (_author?.isNotEmpty == true) ...[
              const SizedBox(height: 2),
              Text(_author!, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption(c: t?.meta ?? AD.textSecondary)),
            ],
          ]),
        ),
      ]),
    );
  }
}
