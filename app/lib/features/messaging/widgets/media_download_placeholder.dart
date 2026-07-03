import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../avatok/media.dart';

/// Human-readable byte size (e.g. "2.4 MB"). Local copy so this widget has no
/// dependency on chat_media_cards.dart's helper (which Stream K/others may move).
String _prettySize(int bytes) {
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

/// A tap-to-download placeholder shown INSTEAD of a media bubble when auto-
/// download is off for this thread/network (STREAM J). Renders a blurred/frosted
/// panel with a size label + a download control. Tapping fetches the real bytes
/// via [MediaService.downloadAndDecrypt] (a manual fetch is ALWAYS allowed,
/// bypassing the auto-download gate) and calls [onFetched] with the plaintext so
/// the caller can swap in the real preview.
///
/// This is a self-contained widget added by Stream J — it does NOT restructure
/// Stream C's `link_preview_card.dart` or Stream K's bubble-geometry files; call
/// sites insert it via a minimal guarded branch.
class MediaDownloadPlaceholder extends StatefulWidget {
  const MediaDownloadPlaceholder({
    super.key,
    required this.media,
    required this.onFetched,
    this.width = 220,
    this.height,
    this.compact = false,
  });

  /// The attachment envelope (holds the R2 key + per-blob AES material + size).
  final ChatMedia media;

  /// Called with the decrypted plaintext once the user taps to download.
  final ValueChanged<Uint8List> onFetched;

  final double width;

  /// Optional fixed height. Defaults to a 4:3-ish panel for image/video/file;
  /// ignored when [compact] (voice-note row).
  final double? height;

  /// Compact layout for voice notes: a short row with a small download button
  /// instead of a full frosted panel.
  final bool compact;

  @override
  State<MediaDownloadPlaceholder> createState() => _MediaDownloadPlaceholderState();
}

class _MediaDownloadPlaceholderState extends State<MediaDownloadPlaceholder> {
  bool _busy = false;

  MediaKind get _kind => widget.media.kind;

  IconData _kindIcon() => switch (_kind) {
        MediaKind.image => PhosphorIcons.image(PhosphorIconsStyle.fill),
        MediaKind.video => PhosphorIcons.videoCamera(PhosphorIconsStyle.fill),
        MediaKind.audio => PhosphorIcons.microphone(PhosphorIconsStyle.fill),
        MediaKind.file => PhosphorIcons.file(PhosphorIconsStyle.fill),
      };

  Future<void> _download() async {
    if (_busy) return;
    setState(() => _busy = true);
    // A manual fetch bypasses the auto-download gate entirely (always allowed).
    // Telemetry: which kind + how many bytes the user chose to pull manually.
    Analytics.capture('media_manual_download', {
      'kind': _kind.name,
      'bytes': widget.media.size,
    });
    try {
      final bytes = await MediaService.downloadAndDecrypt(widget.media);
      if (!mounted) return;
      widget.onFetched(bytes);
    } catch (_) {
      // downloadAndDecrypt already reports chat_media_load_failed with the
      // failing stage; just release the spinner so the user can retry.
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sizeLabel = _prettySize(widget.media.size);
    if (widget.compact) {
      // Voice note: small inline download button + label.
      return GestureDetector(
        onTap: _download,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: Zine.lime,
              shape: BoxShape.circle,
              border: Border.all(color: Zine.ink, width: 1.8),
            ),
            child: Center(
              child: _busy
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                  : PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
                      size: 15, color: Zine.ink),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            sizeLabel.isEmpty ? 'Voice message' : 'Voice message · $sizeLabel',
            style: ZineText.value(size: 14),
          ),
        ]),
      );
    }

    final h = widget.height ?? widget.width * 3 / 4;
    return GestureDetector(
      onTap: _download,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: widget.width,
          height: h,
          decoration: BoxDecoration(
            // Frosted / blurred-look placeholder (a muted gradient stands in for
            // the hidden content; no plaintext is fetched until tapped).
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                Zine.placeholder.withValues(alpha: 0.55),
                Zine.inkSoft.withValues(alpha: 0.65),
              ],
            ),
          ),
          child: Stack(alignment: Alignment.center, children: [
            // Faint kind glyph behind the button.
            Positioned(
              right: 10,
              top: 10,
              child: PhosphorIcon(_kindIcon(),
                  size: 20, color: Colors.white.withValues(alpha: 0.85)),
            ),
            Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.92),
                  shape: BoxShape.circle,
                  border: Border.all(color: Zine.ink, width: 2),
                  boxShadow: Zine.shadowXs,
                ),
                child: Center(
                  child: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.ink))
                      : PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.fill),
                          size: 22, color: Zine.ink),
                ),
              ),
              if (sizeLabel.isNotEmpty) ...[
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Zine.ink.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(100),
                  ),
                  child: Text(sizeLabel,
                      style: ZineText.tag(size: 10, color: Colors.white)),
                ),
              ],
            ]),
          ]),
        ),
      ),
    );
  }
}
