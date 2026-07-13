import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
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
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.headerFooter,
          elevation: 0,
          scrolledUnderElevation: 0,
          surfaceTintColor: Colors.transparent,
          foregroundColor: AD.textPrimary,
          shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          leading: const Padding(
            padding: EdgeInsets.only(left: 10),
            child: Center(child: AdBackButton()),
          ),
          leadingWidth: 60,
          title: Text(title, style: ADText.appTitle()),
          bottom: TabBar(
            labelColor: AD.textPrimary,
            unselectedLabelColor: AD.textTertiary,
            indicatorColor: AD.textPrimary,
            indicatorWeight: 3,
            dividerColor: Colors.transparent,
            labelStyle: ADText.tabLabel(),
            unselectedLabelStyle: ADText.tabLabel(c: AD.textTertiary),
            tabs: [
              Tab(text: 'MEDIA (${media.length})'),
              Tab(text: 'LINKS (${links.length})'),
              Tab(text: 'DOCS (${docs.length})'),
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

  Widget _empty(IconData icon, String label) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 40, color: AD.textFaint),
          const SizedBox(height: 14),
          Text(label, textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textTertiary)),
        ]),
      );

  Widget _mediaGrid(BuildContext context) {
    if (media.isEmpty) {
      return _empty(PhosphorIcons.images(PhosphorIconsStyle.bold), 'No photos or videos yet');
    }
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3, crossAxisSpacing: 10, mainAxisSpacing: 10),
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
          // Grid tile: ink border + radius 14 (tiles range per §4).
          child: Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: BorderRadius.circular(AD.rListCard),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Stack(fit: StackFit.expand, children: [
              if (isVideo)
                Center(child: PhosphorIcon(
                    PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), color: AD.textSecondary, size: 26))
              else
                FutureBuilder<Uint8List>(
                  future: MediaService.downloadAndDecrypt(m),
                  builder: (_, s) => s.hasData
                      ? Image.memory(s.data!, fit: BoxFit.cover)
                      : Center(child: PhosphorIcon(
                          PhosphorIcons.image(PhosphorIconsStyle.bold), color: AD.textTertiary)),
                ),
              if (isVideo)
                Center(child: PhosphorIcon(
                    PhosphorIcons.playCircle(PhosphorIconsStyle.fill), color: AD.textPrimary, size: 32)),
            ]),
          ),
        );
      },
    );
  }

  Widget _linksList(BuildContext context) {
    if (links.isEmpty) {
      return _empty(PhosphorIcons.link(PhosphorIconsStyle.bold), 'No links yet');
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      itemCount: links.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        final l = links[i];
        return Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(AD.rListCard),
            onTap: () => launchUrl(Uri.parse(l.url), mode: LaunchMode.externalApplication),
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(AD.rListCard),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Row(children: [
                ZineIconBadge(icon: PhosphorIcons.link(PhosphorIconsStyle.bold),
                    color: Zine.accents[i % Zine.accents.length]),
                const SizedBox(width: 11),
                Expanded(child: Text(l.url, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.iconSearch))),
              ]),
            ),
          ),
        );
      },
    );
  }

  Widget _docsList(BuildContext context) {
    if (docs.isEmpty) {
      return _empty(PhosphorIcons.fileText(PhosphorIconsStyle.bold), 'No documents yet');
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      itemCount: docs.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        final d = docs[i];
        final isAudio = d.kind == MediaKind.audio;
        return Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(AD.rListCard),
            onTap: () => launchUrl(Uri.parse(d.downloadUrl), mode: LaunchMode.externalApplication),
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(AD.rListCard),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Row(children: [
                ZineIconBadge(
                  icon: isAudio
                      ? PhosphorIcons.microphone(PhosphorIconsStyle.bold)
                      : PhosphorIcons.file(PhosphorIconsStyle.bold),
                  color: Zine.accents[i % Zine.accents.length],
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(d.name.isNotEmpty ? d.name : (isAudio ? 'Voice note' : 'File'),
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ADText.rowName()),
                    if (_fmtSize(d.size).isNotEmpty)
                      Text(_fmtSize(d.size).toUpperCase(), style: ADText.statCaption(c: AD.textSecondary)),
                  ]),
                ),
                PhosphorIcon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
                    size: 18, color: AD.textSecondary),
              ]),
            ),
          ),
        );
      },
    );
  }

  void _openImage(BuildContext context, ChatMedia m) {
    showDialog(context: context, builder: (_) => Dialog(
      // Image lightbox sits on a warm-ink scrim (allowed as an overlay dim).
      backgroundColor: AD.scrim,
      insetPadding: const EdgeInsets.all(10),
      child: FutureBuilder<Uint8List>(
        future: MediaService.downloadAndDecrypt(m),
        builder: (_, s) => s.hasData
            ? InteractiveViewer(child: Image.memory(s.data!, fit: BoxFit.contain))
            : const Padding(padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator(color: AD.primaryBadge))),
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
