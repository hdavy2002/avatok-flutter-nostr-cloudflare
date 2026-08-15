import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

import '../../core/library_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../avatok/media.dart';

/// In-app viewer for library-owned audio and video. It intentionally receives
/// bytes through MediaService.downloadLibraryItem so private E2E files follow
/// the same account-scoped cache/decrypt path as chat attachments.
class LibraryMediaViewer extends StatefulWidget {
  final LibraryItem item;
  const LibraryMediaViewer({super.key, required this.item});

  @override
  State<LibraryMediaViewer> createState() => _LibraryMediaViewerState();
}

class _LibraryMediaViewerState extends State<LibraryMediaViewer> {
  VideoPlayerController? _video;
  AudioPlayer? _audio;
  File? _file;
  String _status = 'Opening…';
  bool _playing = false;

  bool get _isVideo => widget.item.category == 'video' || widget.item.mime.startsWith('video/');

  @override
  void initState() {
    super.initState();
    _open();
  }

  Future<void> _open() async {
    try {
      final bytes = await MediaService.downloadLibraryItem(widget.item);
      final dir = await getTemporaryDirectory();
      _file = File('${dir.path}/library_${widget.item.key.hashCode}_${widget.item.name}');
      await _file!.writeAsBytes(bytes, flush: true);
      if (_isVideo) {
        final c = VideoPlayerController.file(_file!);
        await c.initialize();
        await c.play();
        c.setLooping(true);
        if (!mounted) return;
        setState(() { _video = c; _playing = true; _status = ''; });
      } else {
        final p = AudioPlayer();
        await p.play(DeviceFileSource(_file!.path));
        if (!mounted) return;
        setState(() { _audio = p; _playing = true; _status = ''; });
      }
    } catch (_) {
      if (mounted) setState(() => _status = 'Could not open this file');
    }
  }

  Future<void> _toggle() async {
    if (_video != null) {
      if (_video!.value.isPlaying) {
        await _video!.pause();
      } else {
        await _video!.play();
      }
    } else if (_audio != null) {
      if (_playing) {
        await _audio!.pause();
      } else {
        await _audio!.resume();
      }
    }
    if (mounted) setState(() => _playing = !_playing);
  }

  @override
  void dispose() {
    _video?.dispose();
    _audio?.dispose();
    _file?.delete().ignore();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final video = _video;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.textPrimary,
        title: Text(widget.item.name, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.threadName(c: AD.textPrimary)),
      ),
      body: Center(
        child: video != null && video.value.isInitialized
            ? Column(mainAxisSize: MainAxisSize.min, children: [
                AspectRatio(aspectRatio: video.value.aspectRatio, child: VideoPlayer(video)),
                _controls(),
              ])
            : _audio != null
                ? _controls()
                : Text(_status, style: ADText.preview(c: AD.textPrimary)),
      ),
    );
  }

  Widget _controls() => Padding(
        padding: const EdgeInsets.all(Msg.s5),
        child: Column(children: [
          IconButton(
            iconSize: 56,
            color: AD.primaryBadge,
            onPressed: _toggle,
            icon: Icon(_playing ? Icons.pause_circle_filled : Icons.play_circle_fill),
          ),
          if (_video != null)
            VideoProgressIndicator(_video!, allowScrubbing: true,
                colors: VideoProgressColors(playedColor: AD.primaryBadge)),
        ]),
      );
}
