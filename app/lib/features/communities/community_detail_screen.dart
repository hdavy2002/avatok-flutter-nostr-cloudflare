import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/community_store.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
import '../avatok/chat_thread.dart';
import '../avatok/contacts.dart';
import '../avatok/data.dart';

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
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zine.r), side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('New channel', style: ZineText.cardTitle(size: 21)),
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
      backgroundColor: Zine.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        side: BorderSide(color: Zine.ink, width: Zine.bw),
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
      backgroundColor: Zine.card,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zine.r), side: const BorderSide(color: Zine.ink, width: Zine.bw)),
      title: Text('Community code', style: ZineText.cardTitle(size: 21)),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Share this code so others can join:', style: ZineText.sub(size: 14)),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: Zine.paper2,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
          ),
          child: SelectableText(_c.id, style: ZineText.tag(size: 13)),
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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: _c.name,
        tag: '${_c.members.length} members · ${_c.groups.length} channels',
        actions: [
          PopupMenuButton<String>(
            color: Zine.card,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Zine.rSm),
              side: const BorderSide(color: Zine.ink, width: 2),
            ),
            onSelected: (v) {
              if (v == 'code') _shareCode();
              if (v == 'members') _addMembers();
              if (v == 'leave') _leave();
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'members', child: Text('Add members', style: ZineText.value(size: 14))),
              PopupMenuItem(value: 'code', child: Text('Share code', style: ZineText.value(size: 14))),
              PopupMenuItem(value: 'leave', child: Text('Leave community', style: ZineText.value(size: 14, color: Zine.coral))),
            ],
            child: Container(
              width: 42, height: 42,
              decoration: BoxDecoration(
                color: Zine.card,
                shape: BoxShape.circle,
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              child: Center(
                child: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: ZinePressable(
        onTap: _addChannel,
        color: Zine.lime,
        radius: BorderRadius.circular(100),
        child: SizedBox(
          width: 56, height: 56,
          child: Center(
            child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 24, color: Zine.ink),
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
        children: [
          // Community header card — zine band: blue fill, ink border, hard shadow.
          ZineCard(
            color: Zine.blue,
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold), color: Zine.card, size: 52),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(_c.name, style: ZineText.cardTitle(size: 20)),
                const SizedBox(height: 4),
                Text(_c.about.isNotEmpty ? _c.about : '${_c.members.length} members',
                    style: ZineText.sub(size: 13.5, color: Zine.ink)),
              ])),
            ]),
          ),
          const SizedBox(height: 18),
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 9),
            child: Text('CHANNELS', style: ZineText.kicker()),
          ),
          for (var i = 0; i < _channels.length; i++) ...[
            ZineCard(
              radius: Zine.rSm,
              padding: const EdgeInsets.all(12),
              boxShadow: Zine.shadowXs,
              onTap: () => _openChannel(_channels[i]),
              child: Row(children: [
                ZineIconBadge(
                  icon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
                  color: Zine.accents[i % Zine.accents.length],
                  size: 40,
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(
                    _channels[i].name.contains(' · ') ? _channels[i].name.split(' · ').last : _channels[i].name,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.cardTitle(size: 16))),
                const SizedBox(width: 8),
                Text('${_channels[i].members.length} MEMBERS', style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
              ]),
            ),
            const SizedBox(height: 11),
          ],
          if (_channels.isEmpty)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Center(child: ZineEmptyState(
                icon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
                text: 'No channels yet — tap + to start one.',
              )),
            ),
          const SizedBox(height: 8),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(12),
            boxShadow: Zine.shadowXs,
            onTap: _addMembers,
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.mint, size: 40),
              const SizedBox(width: 12),
              Expanded(child: Text('Add members', style: ZineText.cardTitle(size: 16))),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
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
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Text('Add members', style: ZineText.cardTitle(size: 19)),
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
            padding: const EdgeInsets.all(24),
            child: Text('No more contacts to add', style: ZineText.sub(size: 14)),
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
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
                  child: Avatar(seed: c.seed, name: c.name, size: 42),
                ),
                title: Text(c.name, style: ZineText.value(size: 15)),
                subtitle: c.subtitle.isNotEmpty ? Text(c.subtitle, style: ZineText.sub(size: 12.5)) : null,
                trailing: Container(
                  width: 26, height: 26,
                  decoration: BoxDecoration(
                    color: on ? Zine.lime : Zine.card,
                    shape: BoxShape.circle,
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: on ? Zine.shadowXs : null,
                  ),
                  child: on
                      ? Center(child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 14, color: Zine.ink))
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
