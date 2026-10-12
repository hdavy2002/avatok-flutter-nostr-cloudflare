import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:video_player/video_player.dart';
import '../../../core/storage/account_storage.dart';
import '../data/selfie_recorder.dart';

final selfieReviewBuilderProvider = Provider<Widget Function(SelfieClip)>(
  (ref) => (clip) => SelfieReviewPlayer(clip: clip),
);

/// A private, account-scoped temporary copy exists only while reviewing. The
/// original camera file is removed by the recorder after reading its bytes.
class SelfieReviewPlayer extends StatefulWidget {
  const SelfieReviewPlayer({super.key, required this.clip});
  final SelfieClip clip;
  @override
  State<SelfieReviewPlayer> createState() => _SelfieReviewPlayerState();
}

class _SelfieReviewPlayerState extends State<SelfieReviewPlayer> {
  VideoPlayerController? _player;
  Directory? _directory;
  bool _failed = false;

  @override
  void initState() { super.initState(); unawaited(_open()); }

  Future<void> _open() async {
    final uid = AccountScope.id;
    if (uid == null) { setState(() => _failed = true); return; }
    Directory? directory;
    VideoPlayerController? player;
    try {
      directory = await Directory.systemTemp.createTemp('hf-selfie-${Uri.encodeComponent(uid)}-');
      final extension = widget.clip.mime == 'video/webm' ? 'webm' : widget.clip.mime == 'video/quicktime' ? 'mov' : 'mp4';
      final file = File('${directory.path}/review.$extension');
      await file.writeAsBytes(widget.clip.bytes, flush: true);
      player = VideoPlayerController.file(file);
      await player.initialize();
      if (!mounted || AccountScope.id != uid) {
        await player.dispose(); await directory.delete(recursive: true); return;
      }
      _directory = directory;
      setState(() => _player = player);
    } catch (_) {
      await player?.dispose();
      if (directory != null) { try { await directory.delete(recursive: true); } catch (_) {} }
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    final player = _player;
    final directory = _directory;
    unawaited(() async {
      await player?.dispose();
      if (directory != null) { try { await directory.delete(recursive: true); } catch (_) {} }
    }());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final player = _player;
    if (_failed) return const Padding(padding: EdgeInsets.all(24),
      child: Text('The video preview could not open. You can record again before submitting.'));
    if (player == null) return const SizedBox(height: 240, child: Center(child: CircularProgressIndicator()));
    return ClipRRect(borderRadius: BorderRadius.circular(20), child: ColoredBox(color: Colors.black,
      child: ValueListenableBuilder<VideoPlayerValue>(valueListenable: player, builder: (_, value, __) =>
        Stack(alignment: Alignment.center, children: [
          AspectRatio(aspectRatio: value.aspectRatio, child: VideoPlayer(player)),
          IconButton.filled(tooltip: value.isPlaying ? 'Pause video' : 'Play video',
            iconSize: 42, icon: Icon(value.isPlaying ? Icons.pause : Icons.play_arrow), onPressed: () async {
              if (value.isPlaying) { await player.pause(); }
              else { if (value.position >= value.duration) await player.seekTo(Duration.zero); await player.play(); }
            }),
          Positioned(bottom: 8, right: 12, child: Text('00:${widget.clip.seconds.toString().padLeft(2, '0')}',
            style: const TextStyle(color: Colors.white))),
        ]))));
  }
}
