import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
import 'contacts.dart';

/// Group details + member management: add from contacts, remove, promote/demote
/// admins, archive, leave, and (owner) delete. Membership changes go through the
/// server (`GroupApi`), which fans out + notifies. Pops `true` if you left/deleted.
class GroupInfoScreen extends StatefulWidget {
  final Group group;
  const GroupInfoScreen({super.key, required this.group});
  @override
  State<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends State<GroupInfoScreen> {
  late Group _group;
  Identity? _id;
  final Map<String, String> _names = {};   // uid → display name
  final Map<String, String> _avatars = {}; // uid → photo URL (from contacts)
  Map<String, String> _roles = {};         // uid → owner|admin|member (server truth)
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
      if (c.npub.isEmpty) continue;
      names[c.npub] = c.name;
      if (c.avatarUrl.isNotEmpty) avatars[c.npub] = c.avatarUrl;
    }
    if (id != null) names[id.uid] = 'You';
    if (mounted) setState(() { _id = id; _contacts = contacts; _names.addAll(names); _avatars.addAll(avatars); });
    // Pull authoritative members + roles from the server (this also refreshes the
    // local group), so admin controls and the member list reflect reality.
    final r = await GroupApi.rolesOf(_group.id);
    if (r != null && mounted) {
      final g = await GroupStore().byId(_group.id);
      setState(() {
        _roles = r.roles;
        if (g != null) _group = g;
      });
    }
    Analytics.capture('group_info_opened', {
      'gid': _group.id,
      'member_count': _group.members.length,
      'am_admin': _amAdmin,
      'am_owner': _amOwner,
      'server_backed': r != null,
    });
  }

  String _label(String uid) =>
      _names[uid] ?? (uid.length > 8 ? '${uid.substring(0, 8)}…' : uid);

  String? get _myUid => _id?.uid;
  String _roleOf(String uid) => _roles[uid] ?? (_group.admins.contains(uid) ? 'admin' : 'member');
  bool get _amAdmin {
    final me = _myUid;
    if (me == null) return false;
    final r = _roleOf(me);
    return r == 'owner' || r == 'admin' || _group.admins.contains(me);
  }
  bool get _amOwner => _myUid != null && _roleOf(_myUid!) == 'owner';

  /// Re-pull roles + members after a server mutation.
  Future<void> _refresh() async {
    final r = await GroupApi.rolesOf(_group.id);
    final g = await GroupStore().byId(_group.id);
    if (mounted) setState(() {
      if (r != null) _roles = r.roles;
      if (g != null) _group = g;
      _busy = false;
    });
  }

  void _toast(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _addMember(String uid) async {
    if (_group.members.contains(uid)) return;
    setState(() => _busy = true);
    final ok = await GroupApi.addMembers(_group.id, [uid]);
    if (ok) {
      // Announce so the added member is notified (chat line + offline banner).
      // (GroupApi.addMembers already emits the group_members_added telemetry.)
      GroupApi.announce(_group.id, 'added ${_label(uid)} to the group');
    } else {
      _toast('Could not add member');
    }
    await _refresh();
  }

  Future<void> _removeMember(String uid) async {
    setState(() => _busy = true);
    final ok = await GroupApi.removeMember(_group.id, uid);
    if (!ok) _toast('Could not remove member'); // telemetry emitted in GroupApi
    await _refresh();
  }

  Future<void> _toggleAdmin(String uid) async {
    setState(() => _busy = true);
    final makeAdmin = _roleOf(uid) == 'member';
    final ok = await GroupApi.setRole(_group.id, uid, makeAdmin ? 'admin' : 'member');
    if (!ok) _toast('Could not update admin'); // telemetry emitted in GroupApi
    await _refresh();
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
    // Description is local-only metadata for now (no server column).
    final g2 = _group.copyWith(description: v);
    await GroupStore().upsert(g2);
    if (mounted) setState(() => _group = g2);
  }

  void _memberActions(String uid) {
    final isAdmin = _roleOf(uid) == 'admin' || _roleOf(uid) == 'owner';
    final canManageAdmin = _amOwner; // only the owner promotes/demotes admins
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        if (canManageAdmin && _roleOf(uid) != 'owner')
          ListTile(
            leading: PhosphorIcon(
                isAdmin
                    ? PhosphorIcons.shieldSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
                color: Zine.blueInk),
            title: Text(isAdmin ? 'Dismiss as admin' : 'Make admin',
                style: ZineText.value(size: 15)),
            onTap: () { Navigator.pop(ctx); _toggleAdmin(uid); },
          ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), color: Zine.coral),
          title: Text('Remove from group', style: ZineText.value(size: 15, color: Zine.coral)),
          onTap: () { Navigator.pop(ctx); _removeMember(uid); },
        ),
      ])),
    );
  }

  Future<void> _leave() async {
    setState(() => _busy = true);
    await GroupApi.leave(_group.id); // telemetry emitted in GroupApi
    await GroupStore().remove(_group.id);
    if (mounted) Navigator.pop(context, true);
  }

  Future<void> _archive() async {
    await ChatFlagsStore().toggle('archived', 'g:${_group.id}');
    Analytics.capture('group_archived', {'gid': _group.id});
    if (mounted) { _toast('Group archived'); Navigator.pop(context, true); }
  }

  Future<void> _confirmDelete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete group?'),
        content: const Text('This permanently deletes the group for everyone. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ZineText.value(color: Zine.coral))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    // Delete server-side; other members' devices drop the group on their next
    // conversation sync (it stops appearing in their list).
    final done = await GroupApi.deleteGroup(_group.id); // telemetry emitted in GroupApi
    if (done) {
      await GroupStore().remove(_group.id);
      if (mounted) Navigator.pop(context, true);
    } else {
      _toast('Could not delete the group');
      if (mounted) setState(() => _busy = false);
    }
  }

  void _pickToAdd() {
    final candidates = _contacts.where((c) =>
        !c.isPhoneOnly && c.npub.isNotEmpty && !_group.members.contains(c.npub)).toList();
    Analytics.capture('group_add_picker_opened', {'gid': _group.id, 'candidate_count': candidates.length});
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
                  onTap: () { Navigator.pop(ctx); _addMember(c.npub); },
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
            subtitle: m == _myUid ? Text('You', style: ZineText.sub(size: 12)) : null,
            trailing: (_amAdmin && m != _myUid)
                ? IconButton(
                    icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), color: Zine.inkSoft),
                    onPressed: _busy ? null : () => _memberActions(m))
                : null,
          ),
        const SizedBox(height: 16),
        // Archive (anyone) — hides the group from your list without leaving it.
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: ZineButton(
            label: 'Archive group',
            variant: ZineButtonVariant.ghost,
            fullWidth: true,
            icon: PhosphorIcons.archive(PhosphorIconsStyle.bold),
            trailingIcon: false,
            onPressed: _busy ? null : _archive,
          ),
        ),
        // Delete (owner only) — removes the group for everyone.
        if (_amOwner)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: ZineButton(
              label: 'Delete group',
              variant: ZineButtonVariant.coral,
              fullWidth: true,
              icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _busy ? null : _confirmDelete,
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
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
