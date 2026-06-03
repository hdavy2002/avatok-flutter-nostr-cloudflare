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
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';

/// Create a group: name it, pick members from contacts. Chat-only — AvaTok has
/// no group video calls (those live in AvaConsult).
class NewGroupScreen extends StatefulWidget {
  final List<Contact> contacts;
  const NewGroupScreen({super.key, required this.contacts});
  @override
  State<NewGroupScreen> createState() => _NewGroupScreenState();
}

class _NewGroupScreenState extends State<NewGroupScreen> {
  final _name = TextEditingController();
  final Set<String> _picked = {};

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  bool get _canCreate => _name.text.trim().isNotEmpty && _picked.isNotEmpty;

  bool _creating = false;

  Future<void> _create() async {
    if (_creating) return;
    setState(() => _creating = true);
    final id = await IdentityStore().load();
    if (id == null) { setState(() => _creating = false); return; }
    // Resolve members to x-only hex pubkeys (incl. me).
    final members = <String>[id.pubHex];
    for (final c in widget.contacts.where((c) => _picked.contains(c.npub))) {
      final h = c.npub.startsWith('npub1') ? NostrKeys.npubToHex(c.npub) : null;
      if (h != null && !members.contains(h)) members.add(h);
    }
    final g = Group(id: Group.newId(), name: _name.text.trim(), members: members, admins: [id.pubHex]);
    await GroupStore().upsert(g);
    // Notify members (gift-wrapped) so the group appears for them too.
    try {
      final client = NostrClient(kNostrRelayUrl)..connect();
      final ginfo = jsonEncode({'t': 'ginfo', 'gid': g.id, 'name': g.name, 'members': g.members, 'admins': g.admins});
      final (gifts, _) = Nip17.wrapMany(
          senderPriv: id.privHex, senderPub: id.pubHex, recipientPubs: g.members, payload: ginfo);
      for (final gift in gifts) {
        client.publish(gift);
      }
      Future.delayed(const Duration(seconds: 2), client.dispose);
    } catch (_) {/* members can still be invited later */}

    final chat = Chat(
      name: g.name, seed: 'group-${g.id}',
      last: 'Group created · ${g.members.length} members',
      time: 'now', group: true, members: g.members.length, gid: g.id,
    );
    if (!mounted) return;
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('New group'),
        actions: [
          TextButton(
            onPressed: _canCreate ? _create : null,
            child: Text('Create',
                style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: _canCreate ? AvaColors.brand : const Color(0xFFBFC4CC))),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                  color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
              child: TextField(
                controller: _name,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                    hintText: 'Group name', border: InputBorder.none,
                    icon: Icon(Icons.groups_outlined, color: AvaColors.sub)),
              ),
            ),
          ),
          const Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: EdgeInsets.fromLTRB(20, 8, 20, 4),
              child: Text('ADD MEMBERS',
                  style: TextStyle(color: AvaColors.sub, fontSize: 11,
                      letterSpacing: 1, fontWeight: FontWeight.w700)),
            ),
          ),
          Expanded(
            child: widget.contacts.isEmpty
                ? const Center(
                    child: Text('Add contacts first to build a group',
                        style: TextStyle(color: AvaColors.sub)))
                : ListView.builder(
                    itemCount: widget.contacts.length,
                    itemBuilder: (_, i) {
                      final c = widget.contacts[i];
                      final on = _picked.contains(c.npub);
                      return CheckboxListTile(
                        value: on,
                        activeColor: AvaColors.brand,
                        controlAffinity: ListTileControlAffinity.trailing,
                        onChanged: (v) => setState(() =>
                            v == true ? _picked.add(c.npub) : _picked.remove(c.npub)),
                        secondary: Avatar(seed: c.seed, name: c.name, size: 42),
                        title: Text(c.name,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: c.handle.isNotEmpty
                            ? Text(c.atHandle, style: const TextStyle(color: AvaColors.sub))
                            : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
