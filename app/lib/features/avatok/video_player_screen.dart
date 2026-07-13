import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:video_player/video_player.dart';

import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import 'media.dart';

/// Plays a chat video: fetches the encrypted blob, decrypts it to a temp file,
/// and plays it fullscreen. [bytes] is used directly if already decrypted.
class VideoPlayerScreen extends StatefulWidget {
  final ChatMedia media;
  final Uint8List? bytes;
  const VideoPlayerScreen({super.key, required this.media, this.bytes});
  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  VideoPlayerController? _ctrl;
  String _status = 'Loading…';
  File? _tmp;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = widget.bytes ?? await MediaService.downloadAndDecrypt(widget.media);
      final dir = await getTemporaryDirectory();
      _tmp = File('${dir.path}/v_${DateTime.now().millisecondsSinceEpoch}.mp4');
      await _tmp!.writeAsBytes(data, flush: true);
      final c = VideoPlayerController.file(_tmp!);
      await c.initialize();
      c.setLooping(true);
      await c.play();
      if (!mounted) return;
      setState(() { _ctrl = c; _status = 'playing'; });
    } catch (_) {
      if (mounted) setState(() => _status = "Couldn't play this video");
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    _tmp?.delete().ignore();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = _ctrl;
    final ready = c != null && c.value.isInitialized;
    // Video is content — ink letterbox; chrome = flat ink-alpha bands + zine
    // bordered circles (no gradients, no blurred shadows).
    return Scaffold(
      backgroundColor: AD.bg,
      body: Stack(children: [
        Positioned.fill(
          child: Center(
            child: ready
                ? GestureDetector(
                    onTap: () => setState(() => c.value.isPlaying ? c.pause() : c.play()),
                    child: AspectRatio(aspectRatio: c.value.aspectRatio, child: VideoPlayer(c)),
                  )
                : Column(mainAxisSize: MainAxisSize.min, children: [
                    const CircularProgressIndicator(color: AD.primaryBadge),
                    const SizedBox(height: 14),
                    Text(_status.toUpperCase(),
                        textAlign: TextAlign.center,
                        // White text only inside dark bands over video areas.
                        style: ADText.sectionLabel(c: AD.textPrimary)),
                  ]),
          ),
        ),
        // Top band: flat ink-alpha, zine back circle + mono tag.
        Positioned(
          top: 0, left: 0, right: 0,
          child: Container(
            color: Colors.black.withValues(alpha: 0.45),
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 18, 10),
                child: Row(children: [
                  const AdBackButton(),
                  const Spacer(),
                  Text('VIDEO', style: ADText.sectionLabel(c: AD.textPrimary)),
                ]),
              ),
            ),
          ),
        ),
        // Bottom band: play/pause bordered circle + flat lime scrub bar.
        if (ready)
          Positioned(
            left: 0, right: 0, bottom: 0,
            child: Container(
              color: Colors.black.withValues(alpha: 0.45),
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                  child: Row(children: [
                    ZinePressable(
                      onTap: () => setState(() => c.value.isPlaying ? c.pause() : c.play()),
                      color: AD.card,
                      pressedColor: AD.primaryBadge,
                      borderColor: AD.borderControl,
                      radius: BorderRadius.circular(100),
                      boxShadow: const [],
                      child: SizedBox(
                        width: 46, height: 46,
                        child: Center(
                          child: PhosphorIcon(
                              c.value.isPlaying
                                  ? PhosphorIcons.pause(PhosphorIconsStyle.fill)
                                  : PhosphorIcons.play(PhosphorIconsStyle.fill),
                              size: 20, color: AD.textPrimary),
                        ),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: SizedBox(
                          height: 8,
                          child: VideoProgressIndicator(
                            c,
                            allowScrubbing: true,
                            padding: EdgeInsets.zero,
                            colors: VideoProgressColors(
                              playedColor: AD.primaryBadge,
                              bufferedColor: Colors.white.withValues(alpha: 0.35),
                              backgroundColor: Colors.white.withValues(alpha: 0.18),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}
