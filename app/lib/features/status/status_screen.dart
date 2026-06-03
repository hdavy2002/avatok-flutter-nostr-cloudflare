import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/profile_store.dart';
import '../../core/status_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import '../avatok/contacts.dart';
import '../avatok/media.dart';

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

  Future<void> _addText() async {
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Text status'),
        content: TextField(controller: ctrl, autofocus: true, maxLines: 3,
            decoration: const InputDecoration(hintText: "What's on your mind?")),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Post')),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    final id = widget.identity;
    final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    await _post(
      {'t': 'status', 'kind': 'text', 'text': text, 'who': _myName},
      StatusPost(id: 's$ts', authorPub: id?.pubHex ?? 'me', authorName: _myName, kind: 'text', text: text, ts: ts),
    );
  }

  Future<void> _addImage() async {
    final x = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 85);
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

  void _addSheet() {
    showModalBottomSheet(
      context: context, backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(leading: const Icon(Icons.text_fields, color: AvaColors.brand), title: const Text('Text status'),
            onTap: () { Navigator.pop(ctx); _addText(); }),
        ListTile(leading: const Icon(Icons.photo_outlined, color: AvaColors.brand), title: const Text('Photo status'),
            onTap: () { Navigator.pop(ctx); _addImage(); }),
      ])),
    );
  }

  void _view(StatusPost p) {
    showDialog(context: context, builder: (_) => Dialog(
      backgroundColor: Colors.black,
      insetPadding: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(p.authorName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          if (p.kind == 'image' && p.media != null)
            FutureBuilder<Uint8List>(
              future: MediaService.downloadAndDecrypt(ChatMedia.fromEnvelope(p.media!)),
              builder: (_, s) => s.hasData
                  ? Image.memory(s.data!, fit: BoxFit.contain)
                  : const Padding(padding: EdgeInsets.all(30), child: CircularProgressIndicator(color: AvaColors.brand)),
            )
          else
            Text(p.text ?? '', style: const TextStyle(color: Colors.white, fontSize: 18)),
        ]),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink, title: const Text('Status')),
      body: ListView(children: [
        ListTile(
          leading: Stack(children: [
            Avatar(seed: widget.identity?.npub ?? 'me', name: 'You', size: 48),
            const Positioned(right: 0, bottom: 0, child: Icon(Icons.add_circle, color: AvaColors.brand, size: 18)),
          ]),
          title: const Text('My status', style: TextStyle(fontWeight: FontWeight.w700)),
          subtitle: const Text('Tap to add to your status (24h)', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
          onTap: _addSheet,
        ),
        const Divider(),
        const Padding(padding: EdgeInsets.fromLTRB(16, 6, 16, 6),
            child: Text('RECENT', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700))),
        if (_posts.isEmpty)
          const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('No status updates yet', style: TextStyle(color: AvaColors.sub)))),
        for (final p in _posts)
          ListTile(
            leading: Avatar(seed: p.authorPub, name: p.authorName, size: 48),
            title: Text(p.authorName, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(p.kind == 'image' ? '📷 Photo' : (p.text ?? ''),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AvaColors.sub)),
            onTap: () => _view(p),
          ),
      ]),
    );
  }
}
