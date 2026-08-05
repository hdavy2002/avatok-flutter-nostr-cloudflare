import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/community_store.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
import '../avatok/chat_thread.dart';
import '../avatok/contacts.dart';
import '../avatok/data.dart';

/// Dialog / card title — the dark-system stand-in for the old
/// `ZineText.cardTitle(...)`.
TextStyle _cardTitle(double size) =>
    ADText.threadName().copyWith(fontSize: size, height: 1.1, letterSpacing: -0.2);

/// A single community: its channels (each a real AvaTok group), members,
/// and management (add channel / add members / share code / leave).
class CommunityDetailScreen extends StatefulWidget {
  final Community community;
  final Identity? identity;
  final List<Contact> contacts;
  const CommunityDetailScreen({super.key, required this.community, this.identity, this.contacts = const []});
  @override
  State<CommunityDetailScreen> createState() => _CommunityDetailScreenState();
}

class _CommunityDetailScreenState extends State<CommunityDetailScreen> {
  final _store = CommunityStore();
  final _groupStore = GroupStore();
  late Community _c;
  List<Group> _channels = [];

  @override
  void initState() {
    super.initState();
    _c = widget.community;
    _loadChannels();
  }

  Future<void> _loadChannels() async {
    final all = await _groupStore.load();
    final mine = all.where((g) => _c.groups.contains(g.id)).toList();
    if (mounted) setState(() => _channels = mine);
  }

  /// Community members resolved to Clerk uids (the addressing id). Phone-only and
  /// the legacy self-as-uid entry are skipped; GroupApi adds me as owner.
  List<String> get _memberUids =>
      _c.members.where((m) => m.startsWith('user_')).toList();

  Future<void> _addChannel() async {
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl, width: 1)),
        title: Text('New channel', style: _cardTitle(21)),
        content: ZineField(controller: ctrl, autofocus: true, hint: 'Channel name (e.g. General)'),
        actions: [
          ZineButton(label: 'Cancel', variant: ZineButtonVariant.ghost, fontSize: 15, onPressed: () => Navigator.pop(ctx)),
          ZineButton(label: 'Create', variant: ZineButtonVariant.blue, fontSize: 15, onPressed: () => Navigator.pop(ctx, ctrl.text.trim())),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    // Channels are real server-backed groups (so members are notified + receive
    // messages) — created via GroupApi, same path as AvaTOK groups.
    final g = await GroupApi.create('${_c.name} · $name', _memberUids);
    if (g == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not create the channel — try again')));
      }
      return;
    }
    GroupApi.announce(g.id, 'started the “$name” channel');
    final updated = _c.copyWith(groups: [..._c.groups, g.id]);
    await _store.upsert(updated);
    await CommunityStore.publish(updated);
    if (mounted) setState(() => _c = updated);
    _loadChannels();
  }

  Future<void> _addMembers() async {
    final picked = await showModalBottomSheet<Set<String>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: Msg.brSheetTop,
        side: BorderSide(color: AD.borderHairline, width: 1),
      ),
      builder: (ctx) => _MemberPicker(contacts: widget.contacts, already: _c.members.toSet()),
    );
    if (picked == null || picked.isEmpty) return;
    final newMembers = {..._c.members, ...picked}.toList();
    final pickedUids = picked.where((m) => m.startsWith('user_')).toList();

    // Add the new members to every channel server-side (notifies them) + refresh.
    for (final ch in _channels) {
      if (await GroupApi.addMembers(ch.id, pickedUids)) {
        GroupApi.announce(ch.id, 'added new members to the channel');
        await GroupApi.refresh(ch.id);
      }
    }
    final updated = _c.copyWith(members: newMembers);
    await _store.upsert(updated);
    await CommunityStore.publish(updated);
    if (mounted) setState(() => _c = updated);
    _loadChannels();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Added ${picked.length} member(s)')));
    }
  }

  void _shareCode() {
    showDialog(context: context, builder: (ctx) => AlertDialog(
      backgroundColor: AD.card,
      shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderControl, width: 1)),
      title: Text('Community code', style: _cardTitle(21)),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Share this code so others can join:',
            style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
        const SizedBox(height: Msg.s3),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
          decoration: BoxDecoration(
            // A slot INSIDE a card, so it sits a step darker than the card.
            color: AD.headerFooter,
            borderRadius: Msg.brMd,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: SelectableText(_c.id,
              style: ADText.tabLabel().copyWith(fontSize: 13, letterSpacing: 0.5)),
        ),
      ]),
      actions: [
        ZineButton(label: 'Done', variant: ZineButtonVariant.ghost, fontSize: 15, onPressed: () => Navigator.pop(ctx)),
      ],
    ));
  }

  Future<void> _leave() async {
    await _store.remove(_c.id);
    if (mounted) Navigator.pop(context);
  }

  void _openChannel(Group g) {
    final chat = Chat(
      name: g.name, seed: 'group-${g.id}',
      last: 'Channel · ${g.members.length} members', time: '',
      group: true, members: g.members.length, gid: g.id,
    );
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: _c.name,
        tag: '${_c.members.length} members · ${_c.groups.length} channels',
        actions: [
          PopupMenuButton<String>(
            color: AD.menu,
            shape: RoundedRectangleBorder(
              borderRadius: Msg.brMd,
              side: const BorderSide(color: AD.borderControl, width: 1),
            ),
            onSelected: (v) {
              if (v == 'code') _shareCode();
              if (v == 'members') _addMembers();
              if (v == 'leave') _leave();
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'members', child: Text('Add members', style: ADText.rowName().copyWith(fontSize: 14))),
              PopupMenuItem(value: 'code', child: Text('Share code', style: ADText.rowName().copyWith(fontSize: 14))),
              PopupMenuItem(value: 'leave', child: Text('Leave community', style: ADText.rowName(c: AD.danger).copyWith(fontSize: 14))),
            ],
            child: Container(
              width: 42, height: 42,
              decoration: const BoxDecoration(
                color: AD.card,
                shape: BoxShape.circle,
                border: Border.fromBorderSide(
                    BorderSide(color: AD.borderControl, width: 1)),
                boxShadow: Msg.none,
              ),
              child: Center(
                child: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.regular),
                    size: 20, color: AD.textPrimary),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: ZinePressable(
        onTap: _addChannel,
        // Accent fill carries a WHITE glyph — the old dark ink on lime would
        // have been invisible here.
        color: Msg.accent,
        radius: Msg.brPill,
        child: SizedBox(
          width: 56, height: 56,
          child: Center(
            child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 24, color: Colors.white),
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, 96),
        children: [
          // Community header card. The old version was a pale-BLUE band with
          // dark ink on it and a near-WHITE icon badge inside. Inverting that
          // literally would have put white paragraph text on a bright pastel,
          // so the card is a normal dark surface and the colour moved onto the
          // badge, which is the only thing that needs to carry it.
          ZineCard(
            child: Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.usersThree(PhosphorIconsStyle.regular),
                  color: AD.family(_c.id).solid,
                  size: 52),
              const SizedBox(width: Msg.s4),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(_c.name, style: _cardTitle(20)),
                const SizedBox(height: Msg.s1),
                Text(_c.about.isNotEmpty ? _c.about : '${_c.members.length} members',
                    style: ADText.preview().copyWith(fontSize: 14)),
              ])),
            ]),
          ),
          const SizedBox(height: Msg.s4),
          Padding(
            padding: const EdgeInsets.only(left: Msg.s1, bottom: Msg.s2),
            child: Text('Channels', style: ADText.sectionLabel()),
          ),
          for (var i = 0; i < _channels.length; i++) ...[
            ZineCard(
              radius: Msg.rLg,
              padding: const EdgeInsets.all(Msg.s3),
              boxShadow: Msg.none,
              onTap: () => _openChannel(_channels[i]),
              child: Row(children: [
                ZineIconBadge(
                  icon: PhosphorIcons.hash(PhosphorIconsStyle.regular),
                  // Deterministic per channel, so a channel keeps its colour.
                  color: AD.family(_channels[i].id).solid,
                  size: 40,
                ),
                const SizedBox(width: Msg.s3),
                Expanded(child: Text(
                    _channels[i].name.contains(' · ') ? _channels[i].name.split(' · ').last : _channels[i].name,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: _cardTitle(16))),
                const SizedBox(width: Msg.s2),
                Text('${_channels[i].members.length} members',
                    style: ADText.statCaption(c: AD.textSecondary)),
              ]),
            ),
            const SizedBox(height: Msg.s3),
          ],
          if (_channels.isEmpty)
            Padding(
              padding: const EdgeInsets.all(Msg.s5),
              child: Center(child: ZineEmptyState(
                icon: PhosphorIcons.hash(PhosphorIconsStyle.regular),
                text: 'No channels yet — tap + to start one.',
              )),
            ),
          const SizedBox(height: Msg.s2),
          ZineCard(
            radius: Msg.rLg,
            padding: const EdgeInsets.all(Msg.s3),
            boxShadow: Msg.none,
            onTap: _addMembers,
            child: Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.userPlus(PhosphorIconsStyle.regular),
                  color: AD.newGroup,
                  size: 40),
              const SizedBox(width: Msg.s3),
              Expanded(child: Text('Add members', style: _cardTitle(16))),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
                  size: 16, color: AD.textSecondary),
            ]),
          ),
        ],
      ),
    );
  }
}

/// Bottom-sheet multi-select over contacts (excludes those already in).
class _MemberPicker extends StatefulWidget {
  final List<Contact> contacts;
  final Set<String> already;
  const _MemberPicker({required this.contacts, required this.already});
  @override
  State<_MemberPicker> createState() => _MemberPickerState();
}

class _MemberPickerState extends State<_MemberPicker> {
  final Set<String> _picked = {};
  @override
  Widget build(BuildContext context) {
    final selectable = widget.contacts.where((c) => !widget.already.contains(c.uid)).toList();
    return SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(
          padding: const EdgeInsets.all(Msg.s4),
          child: Row(children: [
            Text('Add members', style: _cardTitle(19)),
            const Spacer(),
            ZineButton(
              label: 'Add (${_picked.length})',
              fontSize: 15,
              onPressed: _picked.isEmpty ? null : () => Navigator.pop(context, _picked),
            ),
          ]),
        ),
        if (selectable.isEmpty)
          Padding(
            padding: const EdgeInsets.all(Msg.s5),
            child: Text('No more contacts to add',
                style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
          ),
        Flexible(
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: selectable.length,
            itemBuilder: (_, i) {
              final c = selectable[i];
              final on = _picked.contains(c.uid);
              return ListTile(
                onTap: () => setState(() => on ? _picked.remove(c.uid) : _picked.add(c.uid)),
                leading: Container(
                  decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderControl, width: 1)),
                  child: Avatar(seed: c.seed, name: c.name, size: 42),
                ),
                title: Text(c.name, style: ADText.rowName()),
                subtitle: c.subtitle.isNotEmpty
                    ? Text(c.subtitle, style: ADText.preview().copyWith(fontSize: 13))
                    : null,
                trailing: Container(
                  width: 26, height: 26,
                  decoration: BoxDecoration(
                    color: on ? Msg.accent : AD.card,
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: on ? Msg.accent : AD.borderControl, width: 1),
                  ),
                  child: on
                      // White check on the accent fill — a dark ink here would
                      // sit at ~2.5:1 on orange.
                      ? Center(child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 14, color: Colors.white))
                      : null,
                ),
              );
            },
          ),
        ),
      ]),
    );
  }
}
