import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/profile_store.dart';
import '../../core/status_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
import '../../sync/dm.dart';
import '../avatok/contacts.dart';
import 'status_viewer_screen.dart';
import '../avatok/media.dart';
import '../avatok/video_player_screen.dart';

/// Status / Stories — ephemeral 24h posts, fan-out gift-wrapped to your contacts.
///
/// [AVATOK-DARK-V2 catch-up 2026-07-14] Re-skinned from the light Zine theme to
/// the dark v2 tokens (owner screenshot: this screen missed the makeover).
/// Mirrors the inline dark header used by number_settings_screen / chat_list.
class StatusScreen extends StatefulWidget {
  final Identity? identity;
  final List<Contact> contacts;
  /// [STATUS-FANOUT-1] When set (a contact's uid), skip the list and open that
  /// author's status full-screen immediately — the ring-tap path from a chat row.
  final String? focusAuthor;
  const StatusScreen({super.key, this.identity, this.contacts = const [], this.focusAuthor});
  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  List<StatusPost> _posts = [];
  String _myName = 'You';

  @override
  void initState() {
    super.initState();
    StatusStore().load().then((l) {
      if (!mounted) return;
      setState(() => _posts = l);
      _maybeOpenFocused(l);
    });
    ProfileStore().load().then((p) {
      if (mounted && p.displayName.isNotEmpty) setState(() => _myName = p.displayName);
    });
  }

  /// [STATUS-FANOUT-1] Ring-tap entry: push the viewer for [focusAuthor] over this
  /// list, then pop the list too when it closes — so "back" from the status lands
  /// on the chat threads, exactly as the owner specced, rather than dumping the
  /// user on a status list they never asked to see.
  void _maybeOpenFocused(List<StatusPost> all) {
    final who = widget.focusAuthor;
    if (who == null || who.isEmpty) return;
    final mine = all.where((p) => p.authorPub == who && !p.expired).toList()
      ..sort((a, b) => b.ts.compareTo(a.ts));
    if (mine.isEmpty) return; // expired between the tap and the push — show the list
    final c = widget.contacts.where((x) => x.uid == who);
    final contact = c.isEmpty ? null : c.first;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => StatusViewerScreen(
            posts: mine,
            authorName: contact?.name ?? mine.first.authorName,
            authorUid: who,
            authorAvatarUrl: contact?.avatarUrl,
            me: widget.identity,
          ),
        ),
      ).then((_) { if (mounted) Navigator.of(context).maybePop(); });
    });
  }

  /// [STATUS-FANOUT-1] (owner request 2026-07-15) Persist my status locally AND
  /// fan it out to my contacts.
  ///
  /// This used to be local-only. The old comment here read: "the previous Nostr
  /// fan-out was a dead no-op (relay removed in the Cloudflare pivot) and has been
  /// removed; a real status transport will replace it" — and nothing ever did. The
  /// result was a feature that looked fine on your own phone and was invisible to
  /// everyone else: a status could never reach another user, so the status ring
  /// could never light up for anyone but yourself.
  ///
  /// The receive half never went away (chat_list._startInbox handles `t == 'status'`
  /// off SyncHub), so this needed no new transport — just an actual send, over the
  /// same durable outbox the DMs use.
  Future<void> _post(Map<String, dynamic> payload, StatusPost mine) async {
    final id = widget.identity;
    if (id == null) return;
    final list = await StatusStore().add(mine);
    if (mounted) setState(() => _posts = list);
    // Only real AvaTOK accounts have an inbox — `tel:` ids are receptionist/PSTN
    // placeholders and are filtered out inside fanOutStatus.
    final uids = widget.contacts.map((c) => c.uid).toSet().toList();
    AvaDm.fanOutStatus(payload, uids);
    Analytics.capture('status_posted', {
      'kind': mine.kind,
      'contact_count': uids.length,
      'fanout_targets': uids.where((u) => u.startsWith('user_')).length,
    });
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

  /// Dark v2 sheet row — 40px tinted round icon + label (+ optional sub line).
  Widget _sheetTile(BuildContext ctx, {required IconData icon, required Color tint,
      required String title, String? subtitle, required VoidCallback onTap}) {
    return ListTile(
      leading: Container(
        width: 40, height: 40,
        decoration: BoxDecoration(
          color: tint.withValues(alpha: 0.16),
          shape: BoxShape.circle,
        ),
        child: Center(child: PhosphorIcon(icon, size: 19, color: tint)),
      ),
      title: Text(title, style: ADText.rowName()),
      subtitle: subtitle == null
          ? null
          : Text(subtitle, style: ADText.preview(c: AD.textTertiary)),
      onTap: onTap,
    );
  }

  void _addSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        side: BorderSide(color: AD.borderHairline, width: 1),
      ),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 12),
        _sheetTile(ctx,
            icon: PhosphorIcons.camera(PhosphorIconsStyle.bold), tint: AD.iconSearch,
            title: 'Take photo',
            onTap: () { Navigator.pop(ctx); _addImage(ImageSource.camera); }),
        _sheetTile(ctx,
            icon: PhosphorIcons.image(PhosphorIconsStyle.bold), tint: AD.iconVideo,
            title: 'Photo from gallery',
            onTap: () { Navigator.pop(ctx); _addImage(ImageSource.gallery); }),
        _sheetTile(ctx,
            icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), tint: AD.iconShield,
            title: 'Record video', subtitle: 'Up to 10 seconds',
            onTap: () { Navigator.pop(ctx); _addVideo(ImageSource.camera); }),
        _sheetTile(ctx,
            icon: PhosphorIcons.filmStrip(PhosphorIconsStyle.bold), tint: AD.iconBell,
            title: 'Video from gallery', subtitle: 'Trimmed to 10 seconds',
            onTap: () { Navigator.pop(ctx); _addVideo(ImageSource.gallery); }),
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
      backgroundColor: AD.popover,
      insetPadding: const EdgeInsets.all(14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AD.rDialog),
        side: const BorderSide(color: AD.borderCard, width: 1),
      ),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(p.authorName, style: ADText.threadName().copyWith(fontSize: 18)),
          const SizedBox(height: 14),
          if (p.kind == 'image' && p.media != null)
            FutureBuilder<Uint8List>(
              future: MediaService.downloadAndDecrypt(ChatMedia.fromEnvelope(p.media!)),
              builder: (_, s) => s.hasData
                  ? ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.memory(s.data!, fit: BoxFit.contain),
                    )
                  : const Padding(padding: EdgeInsets.all(30),
                      child: CircularProgressIndicator(color: AD.iconSearch)),
            )
          else
            Text(p.text ?? '', style: ADText.bubbleBody().copyWith(fontSize: 17)),
        ]),
      ),
    ));
  }

  /// Inline dark v2 header (mirrors number_settings_screen / chat_list) —
  /// replaces the light ZineAppBar this screen shipped with.
  PreferredSizeWidget _header() {
    final showBack = Navigator.of(context).canPop();
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
            child: Row(children: [
              if (showBack) ...[
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 42, height: 42,
                    decoration: BoxDecoration(
                      color: AD.card,
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderControl, width: 1),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                          size: 20, color: AD.textPrimary),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Updates', style: ADText.appTitle(),
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    Text('24H STATUS FROM YOUR PEOPLE', style: ADText.sectionLabel()),
                  ],
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _header(),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          // "My status" — white-ring avatar + orange add circle (dark v2 accent).
          AdCard(
            radius: 16,
            padding: const EdgeInsets.all(13),
            onTap: _addSheet,
            child: Row(children: [
              Stack(clipBehavior: Clip.none, children: [
                Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderAvatar, width: 2),
                  ),
                  child: Avatar(seed: widget.identity?.uid ?? 'me', name: 'You', size: 46),
                ),
                Positioned(
                  right: -4, bottom: -4,
                  child: Container(
                    width: 22, height: 22,
                    decoration: BoxDecoration(
                      color: AD.primaryBadge,
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.bg, width: 2),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold),
                          size: 12, color: Colors.white),
                    ),
                  ),
                ),
              ]),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text('My status', style: ADText.threadName().copyWith(fontSize: 17)),
                const SizedBox(height: 3),
                Text('Tap to add to your status (24h)', style: ADText.preview(c: AD.textTertiary)),
              ])),
            ]),
          ),
          const SizedBox(height: 18),
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 9),
            child: Text('RECENT', style: ADText.sectionLabel()),
          ),
          if (_posts.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 72, height: 72,
                    decoration: BoxDecoration(
                      color: AD.card,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: AD.borderControl, width: 1),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.clockCountdown(PhosphorIconsStyle.bold),
                          size: 30, color: AD.textTertiary),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text('No updates yet — share your first one.',
                      textAlign: TextAlign.center,
                      style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
                ]),
              ),
            ),
          for (final p in _posts) ...[
            AdCard(
              radius: 16,
              padding: const EdgeInsets.all(12),
              onTap: () => _view(p),
              child: Row(children: [
                // Story ring: 2px orange (unseen) ring — dark v2 unread accent.
                Container(
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.unreadAccent, width: 2),
                  ),
                  child: Avatar(seed: p.authorPub, name: p.authorName, size: 42),
                ),
                const SizedBox(width: 13),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(p.authorName, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.rowName().copyWith(fontSize: 14.5)),
                  const SizedBox(height: 3),
                  Text(p.kind == 'image' ? '📷 Photo' : p.kind == 'video' ? '🎬 Video' : (p.text ?? ''),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.preview(c: AD.textTertiary)),
                ])),
                const SizedBox(width: 8),
                PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                    size: 15, color: AD.textFaint),
              ]),
            ),
            const SizedBox(height: 11),
          ],
        ],
      ),
    );
  }
}
