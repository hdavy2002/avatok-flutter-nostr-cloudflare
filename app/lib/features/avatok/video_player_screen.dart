import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

import '../../core/theme.dart';
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
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, elevation: 0),
      body: Center(
        child: c != null && c.value.isInitialized
            ? GestureDetector(
                onTap: () => setState(() => c.value.isPlaying ? c.pause() : c.play()),
                child: AspectRatio(aspectRatio: c.value.aspectRatio, child: VideoPlayer(c)),
              )
            : Column(mainAxisSize: MainAxisSize.min, children: [
                const CircularProgressIndicator(color: AvaColors.brand),
                const SizedBox(height: 12),
                Text(_status, style: const TextStyle(color: Colors.white70)),
              ]),
      ),
    );
  }
}
