
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verse_api.dart';
import '../../identity/identity.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import 'listing_detail.dart';
import 'widgets.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';

/// Creator channel page (Phase 6): profile card, public details, listings grid,
/// all reviews, Follow + Message buttons, A7 polish (banner, link chips, pinned).
class CreatorChannelScreen extends StatefulWidget {
  final String creatorUid;
  const CreatorChannelScreen({super.key, required this.creatorUid});
  @override
  State<CreatorChannelScreen> createState() => _CreatorChannelScreenState();
}

class _CreatorChannelScreenState extends State<CreatorChannelScreen> {
  CreatorChannel? _c;
  bool _loading = true, _followBusy = false;

  bool get _isSelf => AccountScope.id != null && AccountScope.id == widget.creatorUid;

  @override
  void initState() {
    super.initState();
    _load();
    Analytics.capture('creator_channel_viewed', {'creator': widget.creatorUid});
  }

  Future<void> _load() async {
    final c = await ListingsApi.creator(widget.creatorUid);
    if (!mounted) return;
    setState(() { _c = c; _loading = false; });
  }

  Future<void> _toggleFollow() async {
    final c = _c;
    if (c == null || _followBusy) return;
    setState(() => _followBusy = true);
    final ok = c.following
        ? await ListingsApi.unfollow(c.uid)
        : await ListingsApi.follow(c.uid);
    if (ok) await _load();
    if (mounted) setState(() => _followBusy = false);
  }

  Future<void> _toggleMute() async {
    final c = _c;
    if (c == null || !c.following) return;
    await ListingsApi.follow(c.uid, notify: !c.notify); // same endpoint toggles notify
    _load();
  }

  void _message() {
    final c = _c;
    if (c == null) return;
    // Existing messenger infra: a 1:1 thread keyed by the creator's uid —
    // lands in the creator's inbox (AvaInbox rides the same InboxDO in Phase 8).
    final chat = Chat(name: c.name ?? c.handle ?? 'Creator', seed: c.uid, last: '', time: '',
        avatarUrl: c.avatarUrl ?? '');
    VerseApi.tagThread(c.uid, 'channel:${c.uid}'); // Phase 8: AvaInbox source chip
    Analytics.capture('creator_message_tapped', {'creator': c.uid});
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  void _overflow() {
    final c = _c;
    if (c == null) return;
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
        shape: RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
        builder: (s) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (c.following) ListTile(
        leading: PhosphorIcon(
            c.notify ? PhosphorIcons.bellSlash(PhosphorIconsStyle.bold) : PhosphorIcons.bellRinging(PhosphorIconsStyle.bold),
            color: AD.textPrimary),
        title: Text(c.notify ? uiCopy(UiMessage.m_mute_notifications_from_this_creator_7d16f7d063) : uiCopy(UiMessage.m_unmute_notifications_217ae6a72b),
            style: ADText.rowName(c: AD.textPrimary)),
        onTap: () { Navigator.pop(s); _toggleMute(); },
      ),
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.flag(PhosphorIconsStyle.bold), color: AD.textPrimary),
        title: UiText(UiMessage.m_report_creator_9ce51a8050, style: ADText.rowName(c: AD.textPrimary)),
        onTap: () async {
          Navigator.pop(s);
          final ok = await ListingsApi.report('creator', c.uid, 'inappropriate');
          if (mounted && ok) showAdToast(context, message: uiCopy(UiMessage.m_report_submitted_thank_you_88593684e3));
        },
      ),
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: AD.danger),
        title: UiText(UiMessage.m_block_creator_24fdb02d92, style: ADText.rowName(c: AD.danger)),
        onTap: () async {
          Navigator.pop(s);
          final ok = await ListingsApi.blockCreator(c.uid);
          if (mounted && ok) { showAdToast(context, message: uiCopy(UiMessage.m_creator_blocked_1cf7d88adb)); Navigator.pop(context); }
        },
      ),
    ])));
  }

  Future<void> _editChannel() async {
    final c = _c;
    if (c == null) return;
    final saved = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => _ChannelEditorSheet(channel: c),
    );
    if (saved == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final c = _c;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(76),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s3),
              child: Row(children: [
                const AdBackButton(),
                const SizedBox(width: 4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(c?.name ?? uiCopy(UiMessage.m_channel_ce4683e701),
                          style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 2),
                      UiText(UiMessage.m_creator_channel_50a9478437, style: ADText.sectionLabel()),
                    ],
                  ),
                ),
                if (_isSelf) ...[
                  AdBackButton(onTap: _editChannel, icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold)),
                  const SizedBox(width: 4),
                ],
                AdBackButton(onTap: _overflow, icon: PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold)),
              ]),
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
          : c == null
              ? Center(child: ZineEmptyState(
                  icon: PhosphorIcons.userCircle(PhosphorIconsStyle.bold),
                  text: 'Creator not found.'))
              : RefreshIndicator(onRefresh: _load, color: AD.iconSearch, child: _body(c)),
    );
  }

  Widget _body(CreatorChannel c) {
    ListingCard? pinnedFound;
    for (final l in c.listings) {
      if (l.id == c.pinnedListingId) { pinnedFound = l; break; }
    }
    final pinned = pinnedFound;
    final rest = c.listings.where((l) => l.id != c.pinnedListingId).toList();
    return ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.only(bottom: 32), children: [
      if (c.bannerKey != null && c.bannerKey!.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, 0),
          child: CoverImage(url: c.bannerKey, seed: c.uid.hashCode, height: 130),
        ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Avatar(seed: c.uid, name: c.name ?? '?', size: 64, avatarUrl: c.avatarUrl),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(c.name ?? uiCopy(UiMessage.m_creator_88447b8309), maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.appTitle())),
                if (c.kycVerified) ...[
                  const SizedBox(width: Msg.s1),
                  Tooltip(message: 'ID verified',
                      child: PhosphorIcon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 19, color: AD.iconSearch)),
                ],
              ]),
              if (c.handle != null)
                Text('@${c.handle}', style: ADText.preview(c: AD.iconSearch)),
              const SizedBox(height: 4),
              Text(
                [
                  '${c.followerCount} followers',
                  if (c.ratingAvg != null && c.ratingCount > 0) '★ ${c.ratingAvg!.toStringAsFixed(1)} (${c.ratingCount})',
                ].join(' · '),
                style: ADText.sectionLabel(),
              ),
            ])),
          ]),
          if ((c.bio ?? '').isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(c.bio!, style: ADText.preview(c: AD.textPrimary)),
          ],
          if (c.links.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final li in c.links)
                if (li is Map && (li['url']?.toString().startsWith('https://') ?? false))
                  AdSticker(
                    '${li['label'] ?? Uri.tryParse(li['url'].toString())?.host ?? 'link'}',
                    icon: PhosphorIcons.linkSimple(PhosphorIconsStyle.bold),
                    onTap: () => launchUrl(Uri.parse(li['url'].toString()), mode: LaunchMode.externalApplication),
                  ),
            ]),
          ],
          if (!_isSelf) ...[
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: AdButton(
                label: c.following ? uiCopy(UiMessage.m_following_344b4271ca) : uiCopy(UiMessage.m_follow_641d1ef657),
                variant: c.following ? AdButtonVariant.ghost : AdButtonVariant.primary,
                icon: c.following
                    ? PhosphorIcons.check(PhosphorIconsStyle.bold)
                    : PhosphorIcons.plus(PhosphorIconsStyle.bold),
                trailingIcon: false,
                fontSize: 16,
                onPressed: _followBusy ? null : _toggleFollow,
              )),
              const SizedBox(width: Msg.s2),
              Expanded(child: AdButton(
                label: uiCopy(UiMessage.m_message_2f77668a9d),
                variant: AdButtonVariant.teal,
                icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
                trailingIcon: false,
                fontSize: 16,
                onPressed: _message,
              )),
            ]),
          ],
          const SizedBox(height: Msg.s5),
          if (pinned != null) ...[
            Row(children: [
              PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.fill),
                  size: 12, color: AD.textTertiary),
              const SizedBox(width: 4),
              UiText(UiMessage.m_pinned_f20c879465, style: ADText.sectionLabel()),
            ]),
            const SizedBox(height: Msg.s2),
            SizedBox(height: 250, child: Padding(
              padding: const EdgeInsets.only(right: 80),
              child: ListingCardTile(card: pinned, onTap: () => _open(pinned.id)),
            )),
            const SizedBox(height: Msg.s4),
          ],
          UiText(UiMessage.m_listings_5009238dba, style: ADText.appTitle()),
          const SizedBox(height: Msg.s2),
          if (rest.isEmpty && pinned == null)
            Padding(padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                child: UiText(UiMessage.m_no_listings_yet_check_back_278d484a3d, style: ADText.preview())),
          GridView.builder(
            shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2, crossAxisSpacing: 14, mainAxisSpacing: 16, childAspectRatio: 0.70),
            itemCount: rest.length,
            itemBuilder: (_, i) => ListingCardTile(card: rest[i], onTap: () => _open(rest[i].id)),
          ),
          const SizedBox(height: Msg.s5),
          UiText(UiMessage.m_reviews_84cb7871b7, style: ADText.appTitle()),
          if (c.reviews.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                child: UiText(UiMessage.m_no_reviews_yet_1e1bb23a19, style: ADText.preview())),
          for (final r in c.reviews) ReviewTile(review: r),
        ]),
      ),
    ]);
  }

  void _open(String id) =>
      Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: id)));
}

/// A7 — "My channel" editor: bio, https link chips, pinned listing id.
class _ChannelEditorSheet extends StatefulWidget {
  final CreatorChannel channel;
  const _ChannelEditorSheet({required this.channel});
  @override
  State<_ChannelEditorSheet> createState() => _ChannelEditorSheetState();
}

class _ChannelEditorSheetState extends State<_ChannelEditorSheet> {
  late final TextEditingController _bio;
  late final TextEditingController _links;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _bio = TextEditingController(text: widget.channel.bio ?? '');
    _links = TextEditingController(
        text: widget.channel.links
            .whereType<Map>()
            .map((l) => '${l['label'] ?? ''}|${l['url'] ?? ''}')
            .join('\n'));
  }

  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    final links = <Map<String, String>>[];
    for (final line in _links.text.split('\n')) {
      final t = line.trim();
      if (t.isEmpty) continue;
      final parts = t.split('|');
      final url = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (!url.startsWith('https://')) {
        setState(() { _busy = false; _error = 'Links must start with https://'; });
        return;
      }
      links.add({'label': parts.length > 1 ? parts[0].trim() : Uri.parse(url).host, 'url': url});
    }
    final ok = await ListingsApi.updateChannel({'bio': _bio.text.trim(), 'links': links});
    if (!mounted) return;
    if (ok) { Navigator.pop(context, true); return; }
    setState(() { _busy = false; _error = 'Could not save — try again.'; });
  }

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Container(
        decoration: BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: Msg.brSheetTop,
          border: const Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          UiText(UiMessage.m_my_channel_5727951b26, style: ADText.appTitle()),
          const SizedBox(height: Msg.s3),
          AdField(controller: _bio, maxLines: 3, label: uiCopy(UiMessage.m_bio_3933b18021), hint: uiCopy(UiMessage.m_tell_people_what_you_do_86e3212f89)),
          const SizedBox(height: Msg.s3),
          AdField(controller: _links, maxLines: 4,
              label: 'Links (one per line: Label|https://…)', hint: 'My site|https://…'),
          if (_error != null) AdErrorMsg(_error!),
          const SizedBox(height: 16),
          AdButton(
            label: uiCopy(UiMessage.m_save_1509f561f2),
            fullWidth: true,
            loading: _busy,
            onPressed: _busy ? null : _save,
          ),
        ]),
      ); }
}
