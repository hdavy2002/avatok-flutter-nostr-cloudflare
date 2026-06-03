import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/community_store.dart';
import '../../core/config.dart';
import '../../core/group_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import '../avatok/contacts.dart';
import 'community_detail_screen.dart';

/// Communities tab — list of communities you belong to + create new ones.
/// A community is a hub of channels (each channel is a real AvaTok group).
class CommunitiesTab extends StatefulWidget {
  final Identity? identity;
  final List<Contact> contacts;
  const CommunitiesTab({super.key, this.identity, this.contacts = const []});
  @override
  State<CommunitiesTab> createState() => _CommunitiesTabState();
}

class _CommunitiesTabState extends State<CommunitiesTab> {
  final _store = CommunityStore();
  List<Community> _communities = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final local = await _store.load();
    if (mounted) setState(() { _communities = local; _loading = false; });
    // Reconcile with the backend (other devices may have added me).
    final id = widget.identity;
    if (id != null) {
      final remote = await CommunityStore.fetchForMember(id.npub);
      if (remote.isNotEmpty) {
        final byId = {for (final c in local) c.id: c};
        for (final r in remote) {
          byId[r.id] = r;
          await _store.upsert(r);
        }
        if (mounted) setState(() => _communities = byId.values.toList());
      }
    }
  }

  Future<void> _createCommunity() async {
    final id = widget.identity;
    if (id == null) return;
    final nameCtrl = TextEditingController();
    final aboutCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New community'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: nameCtrl, autofocus: true,
              decoration: const InputDecoration(hintText: 'Community name')),
          const SizedBox(height: 10),
          TextField(controller: aboutCtrl,
              decoration: const InputDecoration(hintText: 'What is it about? (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
        ],
      ),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;

    // Every community starts with an "Announcements" channel (a real group).
    final ann = Group(
      id: Group.newId(),
      name: '${nameCtrl.text.trim()} · Announcements',
      members: [id.pubHex],
      admins: [id.pubHex],
    );
    await GroupStore().upsert(ann);

    final comm = Community(
      id: Community.newId(),
      name: nameCtrl.text.trim(),
      about: aboutCtrl.text.trim(),
      owner: id.npub,
      members: [id.npub],
      groups: [ann.id],
    );
    await _store.upsert(comm);
    await CommunityStore.publish(comm);

    // Tell the (empty for now) member set about the announcement channel.
    _broadcastGinfo(ann);

    if (mounted) setState(() => _communities = [comm, ..._communities.where((c) => c.id != comm.id)]);
    if (mounted) {
      _openDetail(comm);
    }
  }

  void _broadcastGinfo(Group g) {
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
    } catch (_) {/* members can be re-invited later */}
  }

  Future<void> _joinByCode() async {
    final id = widget.identity;
    if (id == null) return;
    final ctrl = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Join a community'),
        content: TextField(controller: ctrl, autofocus: true,
            decoration: const InputDecoration(hintText: 'Community code')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Join')),
        ],
      ),
    );
    if (code == null || code.isEmpty) return;
    final joined = await CommunityStore.join(code, id.npub);
    if (joined != null) {
      await _store.upsert(joined);
      if (mounted) setState(() => _communities = [joined, ..._communities.where((c) => c.id != joined.id)]);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Community not found')));
    }
  }

  void _openDetail(Community c) {
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => CommunityDetailScreen(community: c, identity: widget.identity, contacts: widget.contacts)))
        .then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Communities', style: TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          IconButton(onPressed: _joinByCode, icon: const Icon(Icons.login), tooltip: 'Join with code'),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.brand,
        onPressed: _createCommunity,
        icon: const Icon(Icons.group_add, color: Colors.white),
        label: const Text('New community', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AvaColors.brand))
          : _communities.isEmpty
              ? _empty()
              : ListView.builder(
                  padding: const EdgeInsets.only(top: 6, bottom: 90),
                  itemCount: _communities.length,
                  itemBuilder: (_, i) {
                    final c = _communities[i];
                    return ListTile(
                      leading: Container(
                        width: 52, height: 52,
                        decoration: BoxDecoration(
                            color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
                        child: const Icon(Icons.groups_2, color: AvaColors.brand),
                      ),
                      title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w800)),
                      subtitle: Text(
                          c.about.isNotEmpty ? c.about : '${c.members.length} members · ${c.groups.length} channels',
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: AvaColors.sub)),
                      onTap: () => _openDetail(c),
                    );
                  },
                ),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.groups_2_outlined, size: 64, color: AvaColors.sub),
            const SizedBox(height: 16),
            const Text('No communities yet',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 8),
            const Text(
                'Communities keep related groups together — like a school, a team, or a neighbourhood.',
                textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub)),
            const SizedBox(height: 20),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: AvaColors.brand),
              onPressed: _createCommunity,
              icon: const Icon(Icons.group_add),
              label: const Text('Start a community'),
            ),
          ]),
        ),
      );
}
