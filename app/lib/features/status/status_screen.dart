import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/profile_store.dart';
import '../../core/status_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../sync/legacy_stubs.dart';
import '../avatok/contacts.dart';
import '../avatok/media.dart';
import '../avatok/video_player_screen.dart';

/// Status / Stories — ephemeral 24h posts, fan-out gift-wrapped to your contacts.
class StatusScreen extends StatefulWidget {
  final Identity? identity;
  final List<Contact> contacts;
  const StatusScreen({super.key, this.identity, this.contacts = const []});
  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  List<StatusPost> _posts = [];
  String _myName = 'You';

  @override
  void initState() {
    super.initState();
    StatusStore().load().then((l) { if (mounted) setState(() => _posts = l); });
    ProfileStore().load().then((p) {
      if (mounted && p.displayName.isNotEmpty) setState(() => _myName = p.displayName);
    });
  }

  List<String> get _recipientHexes => widget.contacts
      .map((c) => c.npub.startsWith('npub1') ? NostrKeys.npubToHex(c.npub) : null)
      .whereType<String>()
      .toList();

  Future<void> _post(Map<String, dynamic> payload, StatusPost mine) async {
    final id = widget.identity;
    if (id == null) return;
    try {
      final client = NostrClient(kNostrRelayUrl)..connect();
      final (gifts, _) = Nip17.wrapMany(
          senderPriv: id.privHex, senderPub: id.pubHex,
          recipientPubs: _recipientHexes, payload: jsonEncode(payload));
      for (final g in gifts) {
        client.publish(g);
      }
      Future.delayed(const Duration(seconds: 2), client.dispose);
    } catch (_) {/* best effort */}
    final list = await StatusStore().add(mine);
    if (mounted) setState(() => _posts = list);
  }

  Future<void> _addImage(ImageSource source) async {
    final x = await ImagePicker().pickImage(source: source, imageQuality: 85);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    final m = await MediaService.encryptAndUpload(bytes, kind: MediaKind.image, contentType: 'image/jpeg', name: x.name);
    final id = widget.identity;
    final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    await _post(
      {'t': 'status', 'kind': 'image', 'media': m.toEnvelope(), 'who': _myName},
      StatusPost(id: 's$ts', authorPub: id?.pubHex ?? 'me', authorName: _myName, kind: 'image', media: m.toEnvelope(), ts: ts),
    );
  }

  /// Status videos are capped at 10 seconds (story-style clips).
  Future<void> _addVideo(ImageSource source) async {
    final x = await ImagePicker().pickVideo(source: source, maxDuration: const Duration(seconds: 10));
    if (x == null) return;
    final bytes = await x.readAsBytes();
    final m = await MediaService.encryptAndUpload(bytes, kind: MediaKind.video, contentType: 'video/mp4', name: x.name);
    final id = widget.identity;
    final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    await _post(
      {'t': 'status', 'kind': 'video', 'media': m.toEnvelope(), 'who': _myName},
      StatusPost(id: 's$ts', authorPub: id?.pubHex ?? 'me', authorName: _myName, kind: 'video', media: m.toEnvelope(), ts: ts),
    );
  }

  void _addSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        side: BorderSide(color: Zine.ink, width: Zine.bw),
      ),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 12),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.camera(PhosphorIconsStyle.bold), color: Zine.blue, size: 40),
          title: Text('Take photo', style: ZineText.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _addImage(ImageSource.camera); },
        ),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.image(PhosphorIconsStyle.bold), color: Zine.lilac, size: 40),
          title: Text('Photo from gallery', style: ZineText.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _addImage(ImageSource.gallery); },
        ),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), color: Zine.mint, size: 40),
          title: Text('Record video', style: ZineText.value(size: 15)),
          subtitle: Text('Up to 10 seconds', style: ZineText.sub(size: 12.5)),
          onTap: () { Navigator.pop(ctx); _addVideo(ImageSource.camera); },
        ),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.filmStrip(PhosphorIconsStyle.bold), color: Zine.coral, size: 40),
          title: Text('Video from gallery', style: ZineText.value(size: 15)),
          subtitle: Text('Trimmed to 10 seconds', style: ZineText.sub(size: 12.5)),
          onTap: () { Navigator.pop(ctx); _addVideo(ImageSource.gallery); },
        ),
        const SizedBox(height: 8),
      ])),
    );
  }

  void _view(StatusPost p) {
    // Video statuses play full-screen in the shared player.
    if (p.kind == 'video' && p.media != null) {
      Navigator.push(context, MaterialPageRoute(
          builder: (_) => VideoPlayerScreen(media: ChatMedia.fromEnvelope(p.media!))));
      return;
    }
    showDialog(context: context, builder: (_) => Dialog(
      backgroundColor: Zine.card,
      insetPadding: const EdgeInsets.all(14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Zine.r),
        side: const BorderSide(color: Zine.ink, width: Zine.bw),
      ),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(p.authorName, style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 14),
          if (p.kind == 'image' && p.media != null)
            FutureBuilder<Uint8List>(
              future: MediaService.downloadAndDecrypt(ChatMedia.fromEnvelope(p.media!)),
              builder: (_, s) => s.hasData
                  ? ClipRRect(
                      borderRadius: BorderRadius.circular(Zine.rSm),
                      child: Image.memory(s.data!, fit: BoxFit.contain),
                    )
                  : const Padding(padding: EdgeInsets.all(30), child: CircularProgressIndicator(color: Zine.blueInk)),
            )
          else
            Text(p.text ?? '', style: ZineText.value(size: 17)),
        ]),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Updates',
        markWord: 'Updates',
        tag: '24h status from your people',
        showBack: Navigator.of(context).canPop(),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          // "My status" — 2.5px ink-ring avatar + lime add circle (the ONE lime).
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(13),
            onTap: _addSheet,
            child: Row(children: [
              Stack(clipBehavior: Clip.none, children: [
                Container(
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Zine.border),
                  child: Avatar(seed: widget.identity?.npub ?? 'me', name: 'You', size: 46),
                ),
                Positioned(
                  right: -4, bottom: -4,
                  child: Container(
                    width: 22, height: 22,
                    decoration: const BoxDecoration(
                      color: Zine.lime,
                      shape: BoxShape.circle,
                      border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: 2)),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 12, color: Zine.ink),
                    ),
                  ),
                ),
              ]),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text('My status', style: ZineText.cardTitle(size: 17)),
                const SizedBox(height: 3),
                Text('Tap to add to your status (24h)', style: ZineText.sub(size: 12.5)),
              ])),
            ]),
          ),
          const SizedBox(height: 18),
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 9),
            child: Text('RECENT', style: ZineText.kicker()),
          ),
          if (_posts.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(child: ZineEmptyState(
                icon: PhosphorIcons.clockCountdown(PhosphorIconsStyle.bold),
                text: 'No updates yet — share your first one.',
              )),
            ),
          for (final p in _posts) ...[
            ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.all(12),
              boxShadow: Zine.shadowXs,
              onTap: () => _view(p),
              child: Row(children: [
                // Story ring: 2.5px lime (unseen) circle on ink — no gradients.
                Container(
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Zine.lime,
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                  child: Avatar(seed: p.authorPub, name: p.authorName, size: 42),
                ),
                const SizedBox(width: 13),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(p.authorName, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 14.5)),
                  const SizedBox(height: 3),
                  Text(p.kind == 'image' ? '📷 Photo' : p.kind == 'video' ? '🎬 Video' : (p.text ?? ''),
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
                ])),
                const SizedBox(width: 8),
                PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 15, color: Zine.inkMute),
              ]),
            ),
            const SizedBox(height: 11),
          ],
        ],
      ),
    );
  }
}
