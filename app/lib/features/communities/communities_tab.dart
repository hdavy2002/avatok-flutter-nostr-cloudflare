import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/community_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
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
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zine.r), side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('New community', style: ZineText.cardTitle(size: 21)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineField(controller: nameCtrl, autofocus: true, hint: 'Community name'),
          const SizedBox(height: 12),
          ZineField(controller: aboutCtrl, hint: 'What is it about? (optional)'),
        ]),
        actions: [
          ZineButton(label: 'Cancel', variant: ZineButtonVariant.ghost, fontSize: 15, onPressed: () => Navigator.pop(ctx, false)),
          ZineButton(label: 'Create', fontSize: 15, onPressed: () => Navigator.pop(ctx, true)),
        ],
      ),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;

    // Every community starts with an "Announcements" channel — a real server-backed
    // group (so members are notified + receive messages), created via GroupApi.
    final ann = await GroupApi.create('${nameCtrl.text.trim()} · Announcements', const []);
    if (ann == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not create the community — try again')));
      }
      return;
    }

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
    GroupApi.announce(ann.id, 'created the community');

    if (mounted) setState(() => _communities = [comm, ..._communities.where((c) => c.id != comm.id)]);
    if (mounted) {
      _openDetail(comm);
    }
  }

  Future<void> _joinByCode() async {
    final id = widget.identity;
    if (id == null) return;
    final ctrl = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zine.r), side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Join a community', style: ZineText.cardTitle(size: 21)),
        content: ZineField(controller: ctrl, autofocus: true, hint: 'Community code'),
        actions: [
          ZineButton(label: 'Cancel', variant: ZineButtonVariant.ghost, fontSize: 15, onPressed: () => Navigator.pop(ctx)),
          ZineButton(label: 'Join', variant: ZineButtonVariant.blue, fontSize: 15, onPressed: () => Navigator.pop(ctx, ctrl.text.trim())),
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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Communities',
        markWord: 'Communities',
        tag: 'groups that belong together',
        showBack: Navigator.of(context).canPop(),
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.signIn(PhosphorIconsStyle.bold),
            onTap: _joinByCode,
          ),
        ],
      ),
      floatingActionButton: ZineButton(
        label: 'New community',
        fontSize: 17,
        icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _createCommunity,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : _communities.isEmpty
              ? _empty()
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 110),
                  itemCount: _communities.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (_, i) {
                    final c = _communities[i];
                    return ZineCard(
                      radius: Zine.rSm,
                      padding: const EdgeInsets.all(13),
                      onTap: () => _openDetail(c),
                      child: Row(children: [
                        ZineIconBadge(
                          icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                          color: Zine.accents[i % Zine.accents.length],
                          size: 48,
                        ),
                        const SizedBox(width: 13),
                        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                          Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.cardTitle(size: 17)),
                          const SizedBox(height: 3),
                          Text(c.about.isNotEmpty ? c.about : 'A place for your people',
                              maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.sub(size: 13)),
                        ])),
                        const SizedBox(width: 10),
                        Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
                          Text('${c.members.length} MEMBERS', style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
                          const SizedBox(height: 3),
                          Text('${c.groups.length} CHANNELS', style: ZineText.tag(size: 9.5, color: Zine.inkMute)),
                        ]),
                      ]),
                    );
                  },
                ),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineEmptyState(
              icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
              text: 'No communities yet — communities keep related groups together, like a school, a team, or a neighbourhood.',
            ),
            const SizedBox(height: 20),
            ZineButton(
              label: 'Start a community',
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              fontSize: 17,
              onPressed: _createCommunity,
            ),
          ]),
        ),
      );
}
