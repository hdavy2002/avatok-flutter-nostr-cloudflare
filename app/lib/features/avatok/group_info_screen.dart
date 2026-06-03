import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/group_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import 'contacts.dart';

/// Group details + member management: add from contacts, remove, leave.
/// Membership changes re-broadcast a NIP-17 ginfo to members (and gkick to
/// anyone removed). Pops `true` if you left the group.
class GroupInfoScreen extends StatefulWidget {
  final Group group;
  const GroupInfoScreen({super.key, required this.group});
  @override
  State<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends State<GroupInfoScreen> {
  late Group _group;
  Identity? _id;
  final Map<String, String> _names = {}; // hex → display name
  List<Contact> _contacts = [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _group = widget.group;
    _load();
  }

  Future<void> _load() async {
    final id = await IdentityStore().load();
    final contacts = await ContactsStore().load();
    final names = <String, String>{};
    for (final c in contacts) {
      final h = c.npub.startsWith('npub1') ? NostrKeys.npubToHex(c.npub) : null;
      if (h != null) names[h] = c.name;
    }
    if (id != null) names[id.pubHex] = 'You';
    if (mounted) setState(() { _id = id; _contacts = contacts; _names.addAll(names); });
  }

  String _label(String hex) => _names[hex] ?? '${hex.substring(0, 6)}…';

  Future<void> _broadcast(List<String> recipients, Map<String, dynamic> payload) async {
    final id = _id;
    if (id == null) return;
    try {
      final client = NostrClient(kNostrRelayUrl)..connect();
      final (gifts, _) = Nip17.wrapMany(
          senderPriv: id.privHex, senderPub: id.pubHex,
          recipientPubs: recipients, payload: jsonEncode(payload));
      for (final g in gifts) {
        client.publish(g);
      }
      Future.delayed(const Duration(seconds: 2), client.dispose);
    } catch (_) {/* best effort */}
  }

  Map<String, dynamic> _ginfo(List<String> members) =>
      {'t': 'ginfo', 'gid': _group.id, 'name': _group.name, 'members': members};

  Future<void> _addMember(String hex) async {
    if (_group.members.contains(hex)) return;
    setState(() => _busy = true);
    final members = [..._group.members, hex];
    final g2 = Group(id: _group.id, name: _group.name, members: members);
    await GroupStore().upsert(g2);
    await _broadcast(members, _ginfo(members));
    if (mounted) setState(() { _group = g2; _busy = false; });
  }

  Future<void> _removeMember(String hex) async {
    setState(() => _busy = true);
    final members = _group.members.where((m) => m != hex).toList();
    final g2 = Group(id: _group.id, name: _group.name, members: members);
    await GroupStore().upsert(g2);
    await _broadcast(members, _ginfo(members));        // remaining members
    await _broadcast([hex], {'t': 'gkick', 'gid': _group.id}); // tell the removed one
    if (mounted) setState(() { _group = g2; _busy = false; });
  }

  Future<void> _leave() async {
    final id = _id;
    if (id == null) return;
    setState(() => _busy = true);
    final members = _group.members.where((m) => m != id.pubHex).toList();
    await _broadcast(members, _ginfo(members));
    await GroupStore().remove(_group.id);
    if (mounted) Navigator.pop(context, true);
  }

  void _pickToAdd() {
    final candidates = _contacts.where((c) {
      final h = c.npub.startsWith('npub1') ? NostrKeys.npubToHex(c.npub) : null;
      return h != null && !_group.members.contains(h);
    }).toList();
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Add members', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 8),
          if (candidates.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 20),
                child: Text('All your contacts are already in this group', style: TextStyle(color: AvaColors.sub)))
          else
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 340), child: ListView(shrinkWrap: true, children: [
              for (final c in candidates)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Avatar(seed: c.seed, name: c.name, size: 40),
                  title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                  trailing: const Icon(Icons.add_circle, color: AvaColors.brand),
                  onTap: () { Navigator.pop(ctx); _addMember(NostrKeys.npubToHex(c.npub)!); },
                ),
            ])),
        ]),
      )),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink, title: const Text('Group info')),
      body: ListView(children: [
        const SizedBox(height: 12),
        Center(child: Avatar(seed: 'group-${_group.id}', name: _group.name, size: 84)),
        const SizedBox(height: 10),
        Center(child: Text(_group.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
        Center(child: Text('${_group.members.length} members', style: const TextStyle(color: AvaColors.sub))),
        const SizedBox(height: 16),
        ListTile(
          leading: const Icon(Icons.person_add_alt_1, color: AvaColors.brand),
          title: const Text('Add members', style: TextStyle(fontWeight: FontWeight.w700, color: AvaColors.brand)),
          onTap: _busy ? null : _pickToAdd,
        ),
        const Divider(height: 1),
        for (final m in _group.members)
          ListTile(
            leading: Avatar(seed: m, name: _label(m), size: 42),
            title: Text(_label(m), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: m == _id?.pubHex ? const Text('You', style: TextStyle(color: AvaColors.sub, fontSize: 12)) : null,
            trailing: (m == _id?.pubHex)
                ? null
                : IconButton(
                    icon: const Icon(Icons.remove_circle_outline, color: AvaColors.danger),
                    onPressed: _busy ? null : () => _removeMember(m)),
          ),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.all(16),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
                foregroundColor: AvaColors.danger,
                side: const BorderSide(color: Color(0xFFE0E2E6)),
                padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _busy ? null : _leave,
            icon: const Icon(Icons.logout),
            label: const Text('Leave group'),
          ),
        ),
      ]),
    );
  }
}
