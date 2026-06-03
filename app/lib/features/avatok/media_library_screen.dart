import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme.dart';
import 'media.dart';
import 'video_player_screen.dart';

/// One shared link found in the conversation.
class LinkItem {
  final String url;
  final int ts;
  final bool me;
  const LinkItem({required this.url, this.ts = 0, this.me = false});
}

/// The chat "library": everything ever sent in a conversation, grouped into
/// Media (photos + videos), Links, and Docs (files + voice notes). Built from
/// the messages currently loaded in the thread.
class MediaLibraryScreen extends StatelessWidget {
  final String title;
  final List<ChatMedia> media; // images + videos
  final List<ChatMedia> docs; // files + audio/voice
  final List<LinkItem> links;
  const MediaLibraryScreen({
    super.key,
    required this.title,
    this.media = const [],
    this.docs = const [],
    this.links = const [],
  });

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(
          backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          bottom: TabBar(
            labelColor: AvaColors.brand,
            unselectedLabelColor: AvaColors.sub,
            indicatorColor: AvaColors.brand,
            tabs: [
              Tab(text: 'Media (${media.length})'),
              Tab(text: 'Links (${links.length})'),
              Tab(text: 'Docs (${docs.length})'),
            ],
          ),
        ),
        body: TabBarView(children: [
          _mediaGrid(context),
          _linksList(context),
          _docsList(context),
        ]),
      ),
    );
  }

  Widget _empty(String label) =>
      Center(child: Text(label, style: const TextStyle(color: AvaColors.sub)));

  Widget _mediaGrid(BuildContext context) {
    if (media.isEmpty) return _empty('No photos or videos yet');
    return GridView.builder(
      padding: const EdgeInsets.all(3),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3, crossAxisSpacing: 3, mainAxisSpacing: 3),
      itemCount: media.length,
      itemBuilder: (_, i) {
        final m = media[i];
        final isVideo = m.kind == MediaKind.video;
        return GestureDetector(
          onTap: () {
            if (isVideo) {
              Navigator.push(context, MaterialPageRoute(builder: (_) => VideoPlayerScreen(media: m)));
            } else {
              _openImage(context, m);
            }
          },
          child: Container(
            color: AvaColors.soft,
            child: Stack(fit: StackFit.expand, children: [
              if (isVideo)
                const Center(child: Icon(Icons.videocam, color: AvaColors.sub, size: 28))
              else
                FutureBuilder<Uint8List>(
                  future: MediaService.downloadAndDecrypt(m),
                  builder: (_, s) => s.hasData
                      ? Image.memory(s.data!, fit: BoxFit.cover)
                      : const Center(child: Icon(Icons.image_outlined, color: AvaColors.sub)),
                ),
              if (isVideo)
                const Center(child: Icon(Icons.play_circle_fill, color: Colors.white70, size: 34)),
            ]),
          ),
        );
      },
    );
  }

  Widget _linksList(BuildContext context) {
    if (links.isEmpty) return _empty('No links yet');
    return ListView.separated(
      itemCount: links.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final l = links[i];
        return ListTile(
          leading: const CircleAvatar(backgroundColor: AvaColors.soft, child: Icon(Icons.link, color: AvaColors.brand)),
          title: Text(l.url, maxLines: 2, overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w600)),
          onTap: () => launchUrl(Uri.parse(l.url), mode: LaunchMode.externalApplication),
        );
      },
    );
  }

  Widget _docsList(BuildContext context) {
    if (docs.isEmpty) return _empty('No documents yet');
    return ListView.separated(
      itemCount: docs.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final d = docs[i];
        final isAudio = d.kind == MediaKind.audio;
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: AvaColors.soft,
            child: Icon(isAudio ? Icons.mic : Icons.insert_drive_file_outlined, color: AvaColors.brand),
          ),
          title: Text(d.name.isNotEmpty ? d.name : (isAudio ? 'Voice note' : 'File'),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text(_fmtSize(d.size), style: const TextStyle(color: AvaColors.sub)),
          trailing: const Icon(Icons.download_rounded, color: AvaColors.sub),
          onTap: () => launchUrl(Uri.parse(d.downloadUrl), mode: LaunchMode.externalApplication),
        );
      },
    );
  }

  void _openImage(BuildContext context, ChatMedia m) {
    showDialog(context: context, builder: (_) => Dialog(
      backgroundColor: Colors.black,
      insetPadding: const EdgeInsets.all(10),
      child: FutureBuilder<Uint8List>(
        future: MediaService.downloadAndDecrypt(m),
        builder: (_, s) => s.hasData
            ? InteractiveViewer(child: Image.memory(s.data!, fit: BoxFit.contain))
            : const Padding(padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator(color: AvaColors.brand))),
      ),
    ));
  }

  static String _fmtSize(int bytes) {
    if (bytes <= 0) return '';
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}
