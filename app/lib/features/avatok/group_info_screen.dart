import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../sync/legacy_stubs.dart';
import 'contacts.dart';

/// Group details + member management: add from contacts, remove, leave.
/// Membership changes re-broadcast a ginfo to members (and gkick to
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
  final Map<String, String> _avatars = {}; // hex → photo URL (from contacts)
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
    final avatars = <String, String>{};
    for (final c in contacts) {
      final h = c.npub.startsWith('npub1') ? NostrKeys.npubToHex(c.npub) : null;
      if (h != null) { names[h] = c.name; if (c.avatarUrl.isNotEmpty) avatars[h] = c.avatarUrl; }
    }
    if (id != null) names[id.pubHex] = 'You';
    if (mounted) setState(() { _id = id; _contacts = contacts; _names.addAll(names); _avatars.addAll(avatars); });
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

  bool get _amAdmin => _id != null && _group.admins.contains(_id!.pubHex);

  Map<String, dynamic> _ginfo(Group g) =>
      {'t': 'ginfo', 'gid': g.id, 'name': g.name, 'members': g.members, 'admins': g.admins, 'description': g.description};

  Future<void> _commit(Group g2, {List<String>? extraTo, Map<String, dynamic>? extraMsg}) async {
    await GroupStore().upsert(g2);
    await _broadcast(g2.members, _ginfo(g2));
    if (extraTo != null && extraMsg != null) await _broadcast(extraTo, extraMsg);
    if (mounted) setState(() { _group = g2; _busy = false; });
  }

  Future<void> _addMember(String hex) async {
    if (_group.members.contains(hex)) return;
    setState(() => _busy = true);
    await _commit(_group.copyWith(members: [..._group.members, hex]));
  }

  Future<void> _removeMember(String hex) async {
    setState(() => _busy = true);
    await _commit(
      _group.copyWith(
        members: _group.members.where((m) => m != hex).toList(),
        admins: _group.admins.where((m) => m != hex).toList()),
      extraTo: [hex], extraMsg: {'t': 'gkick', 'gid': _group.id});
  }

  Future<void> _toggleAdmin(String hex) async {
    setState(() => _busy = true);
    final admins = _group.admins.contains(hex)
        ? _group.admins.where((m) => m != hex).toList()
        : [..._group.admins, hex];
    await _commit(_group.copyWith(admins: admins));
  }

  Future<void> _editDescription() async {
    final ctrl = TextEditingController(text: _group.description);
    final v = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Group description'),
        content: TextField(controller: ctrl, maxLines: 3, autofocus: true,
            decoration: const InputDecoration(hintText: 'What is this group about?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (v == null) return;
    setState(() => _busy = true);
    await _commit(_group.copyWith(description: v));
  }

  void _memberActions(String hex) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(
          leading: PhosphorIcon(
              _group.admins.contains(hex)
                  ? PhosphorIcons.shieldSlash(PhosphorIconsStyle.bold)
                  : PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
              color: Zine.blueInk),
          title: Text(_group.admins.contains(hex) ? 'Dismiss as admin' : 'Make admin',
              style: ZineText.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _toggleAdmin(hex); },
        ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), color: Zine.coral),
          title: Text('Remove from group', style: ZineText.value(size: 15, color: Zine.coral)),
          onTap: () { Navigator.pop(ctx); _removeMember(hex); },
        ),
      ])),
    );
  }

  Future<void> _leave() async {
    final id = _id;
    if (id == null) return;
    setState(() => _busy = true);
    final g2 = _group.copyWith(
      members: _group.members.where((m) => m != id.pubHex).toList(),
      admins: _group.admins.where((m) => m != id.pubHex).toList());
    await _broadcast(g2.members, _ginfo(g2));
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Add members', style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 8),
          if (candidates.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 20),
                child: Text('All your contacts are already in this group', style: ZineText.sub()))
          else
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 340), child: ListView(shrinkWrap: true, children: [
              for (final c in candidates)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: Zine.ink, width: 2),
                    ),
                    child: Avatar(seed: c.seed, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                  ),
                  title: Text(c.name, style: ZineText.value(size: 15)),
                  trailing: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.fill), color: Zine.blueInk),
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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Group info', markWord: 'Group'),
      body: ListView(children: [
        const SizedBox(height: 16),
        Center(
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Zine.border,
              boxShadow: Zine.shadowSm,
            ),
            child: Avatar(seed: 'group-${_group.id}', name: _group.name, size: 84),
          ),
        ),
        const SizedBox(height: 12),
        Center(child: Text(_group.name, style: ZineText.cardTitle(size: 22))),
        const SizedBox(height: 4),
        Center(child: Text('${_group.members.length} MEMBERS', style: ZineText.kicker())),
        const SizedBox(height: 14),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: ZineCard(
            color: Zine.paper2,
            radius: Zine.rSm,
            boxShadow: Zine.shadowXs,
            padding: const EdgeInsets.all(14),
            onTap: _amAdmin ? _editDescription : null,
            child: Row(children: [
              Expanded(child: Text(
                  _group.description.isEmpty ? (_amAdmin ? 'Add a group description' : 'No description') : _group.description,
                  style: ZineText.sub(size: 13.5,
                      color: _group.description.isEmpty ? Zine.inkMute : Zine.inkSoft))),
              if (_amAdmin)
                PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
            ]),
          ),
        ),
        const SizedBox(height: 8),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.link(PhosphorIconsStyle.bold), color: Zine.blue),
          title: Text('Copy invite link', style: ZineText.value(size: 15)),
          subtitle: Text('Share so others can ask to join', style: ZineText.sub(size: 12.5)),
          onTap: () {
            Clipboard.setData(ClipboardData(text: 'https://avatok.ai/g/${_group.id}'));
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invite link copied')));
          },
        ),
        if (_amAdmin)
          ListTile(
            leading: ZineIconBadge(icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.lime),
            title: Text('Add members', style: ZineText.value(size: 15)),
            onTap: _busy ? null : _pickToAdd,
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 4),
          child: Text('MEMBERS', style: ZineText.kicker()),
        ),
        for (final m in _group.members)
          ListTile(
            leading: Container(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: Avatar(seed: m, name: _label(m), size: 42, avatarUrl: _avatars[m]),
            ),
            title: Row(children: [
              Flexible(child: Text(_label(m), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 15))),
              if (_group.admins.contains(m)) ...[
                const SizedBox(width: 6),
                const ZineSticker('admin', kind: ZineStickerKind.ok),
              ],
            ]),
            subtitle: m == _id?.pubHex ? Text('You', style: ZineText.sub(size: 12)) : null,
            trailing: (_amAdmin && m != _id?.pubHex)
                ? IconButton(
                    icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), color: Zine.inkSoft),
                    onPressed: _busy ? null : () => _memberActions(m))
                : null,
          ),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.all(16),
          child: ZineButton(
            label: 'Leave group',
            variant: ZineButtonVariant.coral,
            fullWidth: true,
            icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
            onPressed: _busy ? null : _leave,
          ),
        ),
      ]),
    );
  }
}
