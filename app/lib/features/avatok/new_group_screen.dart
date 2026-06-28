import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../sync/group_api.dart';
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

  /// Only real AvaTOK accounts can be group members — phone-only receptionist
  /// contacts (no account) are excluded from the picker.
  List<Contact> get _selectable =>
      widget.contacts.where((c) => !c.isPhoneOnly && c.npub.isNotEmpty).toList();

  bool _creating = false;

  Future<void> _create() async {
    if (_creating) return;
    setState(() => _creating = true);
    // Members are Clerk uids (Contact.npub). Phone-only callers have no account
    // and can't be group members, so they're excluded.
    final memberUids = widget.contacts
        .where((c) => _picked.contains(c.npub) && !c.isPhoneOnly && c.npub.isNotEmpty)
        .map((c) => c.npub)
        .toList();
    // Create the group SERVER-SIDE so membership exists in D1 — this is what makes
    // messages fan out to everyone and makes the group appear (with an offline
    // push) for the people just added.
    final g = await GroupApi.create(_name.text.trim(), memberUids);
    if (g == null) {
      if (mounted) {
        setState(() => _creating = false);
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not create the group — try again')));
      }
      return;
    }
    // Announce so every added member is notified (chat line + offline banner) and
    // the group surfaces on their device.
    final myName = (await ProfileStore().load()).displayName;
    GroupApi.announce(g.id, myName.isEmpty ? 'created the group' : '$myName created the group');

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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'New group',
        markWord: 'group',
        actions: [
          // The ONE lime primary action on this screen.
          ZineButton(
            label: _creating ? '…' : 'Create',
            fontSize: 16,
            onPressed: _canCreate && !_creating ? _create : null,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: ZineField(
              controller: _name,
              hint: 'Group name',
              leadIcon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
              onChanged: (_) => setState(() {}),
            ),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 4),
              child: Text('ADD MEMBERS', style: ZineText.kicker()),
            ),
          ),
          Expanded(
            child: _selectable.isEmpty
                ? Center(
                    child: ZineEmptyState(
                        icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                        text: 'Add contacts first to build a group'))
                : ListView.builder(
                    itemCount: _selectable.length,
                    itemBuilder: (_, i) {
                      final c = _selectable[i];
                      final on = _picked.contains(c.npub);
                      return CheckboxListTile(
                        value: on,
                        activeColor: Zine.ink,
                        checkColor: Zine.lime,
                        side: const BorderSide(color: Zine.ink, width: 2),
                        controlAffinity: ListTileControlAffinity.trailing,
                        onChanged: (v) => setState(() =>
                            v == true ? _picked.add(c.npub) : _picked.remove(c.npub)),
                        secondary: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: Zine.ink, width: 2),
                          ),
                          child: Avatar(seed: c.seed, name: c.name, size: 42),
                        ),
                        title: Text(c.name, style: ZineText.value(size: 15)),
                        subtitle: c.handle.isNotEmpty
                            ? Text(c.atHandle, style: ZineText.sub(size: 12.5))
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
