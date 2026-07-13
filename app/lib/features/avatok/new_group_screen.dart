import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
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
      widget.contacts.where((c) => !c.isPhoneOnly && c.uid.isNotEmpty).toList();

  bool _creating = false;

  Future<void> _create() async {
    if (_creating) return;
    setState(() => _creating = true);
    // Members are Clerk uids (Contact.uid). Phone-only callers have no account
    // and can't be group members, so they're excluded.
    final memberUids = widget.contacts
        .where((c) => _picked.contains(c.uid) && !c.isPhoneOnly && c.uid.isNotEmpty)
        .map((c) => c.uid)
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
    final canCreate = _canCreate && !_creating;
    return Scaffold(
      backgroundColor: AD.bg,
      body: Column(
        children: [
          // Inline dark v2 header: back button + title + the ONE primary
          // (teal) Create action.
          Container(
            decoration: const BoxDecoration(
              color: AD.headerFooter,
              border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 16, 12),
                child: Row(children: [
                  GestureDetector(
                    onTap: () => Navigator.of(context).maybePop(),
                    child: Container(
                      width: 42, height: 42,
                      decoration: BoxDecoration(
                        color: AD.card,
                        shape: BoxShape.circle,
                        border: Border.all(color: AD.borderControl, width: 1),
                      ),
                      child: Center(child: PhosphorIcon(
                          PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                          size: 20, color: AD.textPrimary)),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(child: Text('New group', style: ADText.appTitle())),
                  _createButton(canCreate),
                ]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: _nameField(),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 4),
              child: Text('ADD MEMBERS', style: ADText.sectionLabel()),
            ),
          ),
          Expanded(
            child: _selectable.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Container(
                          width: 72, height: 72,
                          decoration: BoxDecoration(
                            color: AD.card,
                            borderRadius: BorderRadius.circular(AD.rListCard),
                            border: Border.all(color: AD.borderControl, width: 1),
                          ),
                          child: Center(child: PhosphorIcon(
                              PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                              size: 32, color: AD.textTertiary)),
                        ),
                        const SizedBox(height: 14),
                        Text('Add contacts first to build a group',
                            textAlign: TextAlign.center,
                            style: ADText.preview(c: AD.textSecondary)),
                      ]),
                    ),
                  )
                : ListView.builder(
                    itemCount: _selectable.length,
                    itemBuilder: (_, i) {
                      final c = _selectable[i];
                      final on = _picked.contains(c.uid);
                      return CheckboxListTile(
                        value: on,
                        activeColor: AD.newGroup,
                        checkColor: Colors.white,
                        side: const BorderSide(color: AD.borderControl, width: 2),
                        controlAffinity: ListTileControlAffinity.trailing,
                        onChanged: (v) => setState(() =>
                            v == true ? _picked.add(c.uid) : _picked.remove(c.uid)),
                        secondary: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: AD.borderAvatar, width: 2),
                          ),
                          child: Avatar(seed: c.seed, name: c.name, size: 42),
                        ),
                        title: Text(c.name, style: ADText.rowName()),
                        subtitle: c.handle.isNotEmpty
                            ? Text(c.atHandle, style: ADText.preview())
                            : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  /// The primary teal "Create" pill; disabled = card fill + faint label.
  Widget _createButton(bool enabled) {
    final fill = enabled ? AD.newGroup : AD.card;
    final fg = enabled ? Colors.white : AD.textTertiary;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: enabled ? _create : null,
        borderRadius: BorderRadius.circular(100),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(100),
            border: enabled ? null : Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text(_creating ? '…' : 'Create', style: ADText.rowName(c: fg)),
        ),
      ),
    );
  }

  /// White dark-v2 input field with a leading teal glyph cell.
  Widget _nameField() => Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          Container(
            width: 48,
            constraints: const BoxConstraints(minHeight: 52),
            color: AD.newGroup,
            alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                size: 20, color: Colors.white),
          ),
          Expanded(
            child: TextField(
              controller: _name,
              onChanged: (_) => setState(() {}),
              cursorColor: AD.newGroup,
              style: ADText.rowName(c: AD.textOnInput),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Group name',
                hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              ),
            ),
          ),
        ]),
      );
}
