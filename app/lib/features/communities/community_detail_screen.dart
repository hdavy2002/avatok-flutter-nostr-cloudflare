import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/community_store.dart';
import '../../core/config.dart';
import '../../core/group_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../sync/legacy_stubs.dart';
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

  void _publishGinfo(Group g) {
    final id = widget.identity;
    if (id == null) return;
    try {
      final client = NostrClient(kNostrRelayUrl)..connect();
      final ginfo = jsonEncode({'t': 'ginfo', 'gid': g.id, 'name': g.name, 'members': g.members, 'admins': g.admins});
      final (gifts, _) = Nip17.wrapMany(
          senderPriv: id.privHex, senderPub: id.pubHex, recipientPubs: g.members, payload: ginfo);
      for (final gift in gifts) {
        client.publish(gift);
      }
      Future.delayed(const Duration(seconds: 2), client.dispose);
    } catch (_) {/* best effort */}
  }

  List<String> get _memberHexes => _c.members
      .map((n) => n.startsWith('npub1') ? NostrKeys.npubToHex(n) : null)
      .whereType<String>()
      .toList();

  Future<void> _addChannel() async {
    final id = widget.identity;
    if (id == null) return;
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New channel'),
        content: TextField(controller: ctrl, autofocus: true,
            decoration: const InputDecoration(hintText: 'Channel name (e.g. General)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Create')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    final members = <String>{id.pubHex, ..._memberHexes}.toList();
    final g = Group(
        id: Group.newId(), name: '${_c.name} · $name', members: members, admins: [id.pubHex]);
    await _groupStore.upsert(g);
    _publishGinfo(g);
    final updated = _c.copyWith(groups: [..._c.groups, g.id]);
    await _store.upsert(updated);
    await CommunityStore.publish(updated);
    if (mounted) setState(() => _c = updated);
    _loadChannels();
  }

  Future<void> _addMembers() async {
    final id = widget.identity;
    if (id == null) return;
    final picked = await showModalBottomSheet<Set<String>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => _MemberPicker(contacts: widget.contacts, already: _c.members.toSet()),
    );
    if (picked == null || picked.isEmpty) return;
    final newMembers = {..._c.members, ...picked}.toList();
    final newHexes = <String>{id.pubHex, ...newMembers.map((n) => NostrKeys.npubToHex(n)).whereType<String>()}.toList();

    // Add the new members to every channel and re-announce.
    for (final ch in _channels) {
      final merged = {...ch.members, ...newHexes}.toList();
      final updatedG = ch.copyWith(members: merged);
      await _groupStore.upsert(updatedG);
      _publishGinfo(updatedG);
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
      title: const Text('Community code'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('Share this code so others can join:'),
        const SizedBox(height: 10),
        SelectableText(_c.id, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700)),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done'))],
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
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(_c.name, style: const TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'code') _shareCode();
              if (v == 'members') _addMembers();
              if (v == 'leave') _leave();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'members', child: Text('Add members')),
              PopupMenuItem(value: 'code', child: Text('Share code')),
              PopupMenuItem(value: 'leave', child: Text('Leave community')),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AvaColors.brand,
        onPressed: _addChannel,
        child: const Icon(Icons.add, color: Colors.white),
      ),
      body: ListView(
        children: [
          Container(
            margin: const EdgeInsets.all(16),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(18)),
            child: Row(children: [
              Container(
                width: 56, height: 56,
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
                child: const Icon(Icons.groups_2, color: AvaColors.brand, size: 30),
              ),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_c.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                const SizedBox(height: 4),
                Text(_c.about.isNotEmpty ? _c.about : '${_c.members.length} members',
                    style: const TextStyle(color: AvaColors.sub)),
              ])),
            ]),
          ),
          const Padding(padding: EdgeInsets.fromLTRB(20, 4, 20, 6),
              child: Text('CHANNELS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700))),
          for (final g in _channels)
            ListTile(
              leading: Container(
                width: 44, height: 44,
                decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(12)),
                child: const Icon(Icons.tag, color: AvaColors.brand),
              ),
              title: Text(g.name.contains(' · ') ? g.name.split(' · ').last : g.name,
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text('${g.members.length} members', style: const TextStyle(color: AvaColors.sub)),
              onTap: () => _openChannel(g),
            ),
          if (_channels.isEmpty)
            const Padding(padding: EdgeInsets.all(20),
                child: Center(child: Text('No channels yet — tap + to add one', style: TextStyle(color: AvaColors.sub)))),
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.person_add_alt_1, color: AvaColors.brand),
            title: const Text('Add members', style: TextStyle(fontWeight: FontWeight.w700)),
            onTap: _addMembers,
          ),
          const SizedBox(height: 80),
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
    final selectable = widget.contacts.where((c) => !widget.already.contains(c.npub)).toList();
    return SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            const Text('Add members', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const Spacer(),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AvaColors.brand),
              onPressed: _picked.isEmpty ? null : () => Navigator.pop(context, _picked),
              child: Text('Add (${_picked.length})'),
            ),
          ]),
        ),
        if (selectable.isEmpty)
          const Padding(padding: EdgeInsets.all(24),
              child: Text('No more contacts to add', style: TextStyle(color: AvaColors.sub))),
        Flexible(
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: selectable.length,
            itemBuilder: (_, i) {
              final c = selectable[i];
              final on = _picked.contains(c.npub);
              return CheckboxListTile(
                value: on,
                activeColor: AvaColors.brand,
                controlAffinity: ListTileControlAffinity.trailing,
                onChanged: (v) => setState(() => v == true ? _picked.add(c.npub) : _picked.remove(c.npub)),
                secondary: Avatar(seed: c.seed, name: c.name, size: 42),
                title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: c.subtitle.isNotEmpty ? Text(c.subtitle, style: const TextStyle(color: AvaColors.sub)) : null,
              );
            },
          ),
        ),
      ]),
    );
  }
}
