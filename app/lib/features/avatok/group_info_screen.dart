import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
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
      if (c.uid.isEmpty) continue;
      names[c.uid] = c.name;
      if (c.avatarUrl.isNotEmpty) avatars[c.uid] = c.avatarUrl;
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
        backgroundColor: AD.menu,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Group description', style: ADText.threadName()),
        content: TextField(
          controller: ctrl, maxLines: 3, autofocus: true,
          cursorColor: AD.newGroup,
          style: ADText.rowName(),
          decoration: InputDecoration(
            hintText: 'What is this group about?',
            hintStyle: ADText.preview(),
            enabledBorder: const OutlineInputBorder(
                borderSide: BorderSide(color: AD.borderControl)),
            focusedBorder: const OutlineInputBorder(
                borderSide: BorderSide(color: AD.newGroup)),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text('Save', style: ADText.rowName(c: AD.newGroup))),
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
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        if (canManageAdmin && _roleOf(uid) != 'owner')
          ListTile(
            leading: PhosphorIcon(
                isAdmin
                    ? PhosphorIcons.shieldSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
                color: AD.iconSearch),
            title: Text(isAdmin ? 'Dismiss as admin' : 'Make admin',
                style: ADText.rowName()),
            onTap: () { Navigator.pop(ctx); _toggleAdmin(uid); },
          ),
        ListTile(
          leading: PhosphorIcon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), color: AD.danger),
          title: Text('Remove from group', style: ADText.rowName(c: AD.danger)),
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
        backgroundColor: AD.menu,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Delete group?', style: ADText.threadName()),
        content: Text('This permanently deletes the group for everyone. This cannot be undone.',
            style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ADText.rowName(c: AD.danger))),
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
        !c.isPhoneOnly && c.uid.isNotEmpty && !_group.members.contains(c.uid)).toList();
    Analytics.capture('group_add_picker_opened', {'gid': _group.id, 'candidate_count': candidates.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderHairline, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (ctx) => SafeArea(child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Add members', style: ADText.threadName()),
          const SizedBox(height: 8),
          if (candidates.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 20),
                child: Text('All your contacts are already in this group',
                    style: ADText.preview(c: AD.textSecondary)))
          else
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 340), child: ListView(shrinkWrap: true, children: [
              for (final c in candidates)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 2),
                    ),
                    child: Avatar(seed: c.seed, name: c.name, size: 40, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                  ),
                  title: Text(c.name, style: ADText.rowName()),
                  trailing: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.fill), color: AD.newGroup),
                  onTap: () { Navigator.pop(ctx); _addMember(c.uid); },
                ),
            ])),
        ]),
      )),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      body: Column(children: [
        // Inline dark v2 header: back button + title.
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
                Text('Group info', style: ADText.appTitle()),
              ]),
            ),
          ),
        ),
        Expanded(
          child: ListView(children: [
            const SizedBox(height: 16),
            Center(
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.borderAvatar, width: 2),
                  boxShadow: AD.overlayShadow,
                ),
                child: Avatar(seed: 'group-${_group.id}', name: _group.name, size: 84),
              ),
            ),
            const SizedBox(height: 12),
            Center(child: Text(_group.name, style: ADText.appTitle())),
            const SizedBox(height: 4),
            Center(child: Text('${_group.members.length} MEMBERS', style: ADText.sectionLabel())),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Material(
                color: Colors.transparent,
                child: InkWell(
                  onTap: _amAdmin ? _editDescription : null,
                  borderRadius: BorderRadius.circular(AD.rListCard),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AD.card,
                      borderRadius: BorderRadius.circular(AD.rListCard),
                      border: Border.all(color: AD.borderCard, width: 1),
                    ),
                    child: Row(children: [
                      Expanded(child: Text(
                          _group.description.isEmpty ? (_amAdmin ? 'Add a group description' : 'No description') : _group.description,
                          style: ADText.preview(
                              c: _group.description.isEmpty ? AD.textTertiary : AD.textSecondary))),
                      if (_amAdmin)
                        PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
                    ]),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            ListTile(
              leading: _badge(PhosphorIcons.link(PhosphorIconsStyle.bold), AD.iconSearch),
              title: Text('Copy invite link', style: ADText.rowName()),
              subtitle: Text('Share so others can ask to join', style: ADText.preview()),
              onTap: () {
                Clipboard.setData(ClipboardData(text: 'https://avatok.ai/g/${_group.id}'));
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invite link copied')));
              },
            ),
            if (_amAdmin)
              ListTile(
                leading: _badge(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), AD.newGroup),
                title: Text('Add members', style: ADText.rowName()),
                onTap: _busy ? null : _pickToAdd,
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 4),
              child: Text('MEMBERS', style: ADText.sectionLabel()),
            ),
            for (final m in _group.members)
              ListTile(
                leading: Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: AD.borderAvatar, width: 2),
                  ),
                  child: Avatar(seed: m, name: _label(m), size: 42, avatarUrl: _avatars[m]),
                ),
                title: Row(children: [
                  Flexible(child: Text(_label(m), maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ADText.rowName())),
                  if (_group.admins.contains(m)) ...[
                    const SizedBox(width: 6),
                    _adminPill(),
                  ],
                ]),
                subtitle: m == _myUid ? Text('You', style: ADText.preview()) : null,
                trailing: (_amAdmin && m != _myUid)
                    ? IconButton(
                        icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), color: AD.textSecondary),
                        onPressed: _busy ? null : () => _memberActions(m))
                    : null,
              ),
            const SizedBox(height: 16),
            // Archive (anyone) — hides the group from your list without leaving it.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: _actionButton(
                label: 'Archive group',
                icon: PhosphorIcons.archive(PhosphorIconsStyle.bold),
                fill: AD.card, labelColor: AD.textPrimary, borderColor: AD.borderControl,
                onTap: _busy ? null : _archive,
              ),
            ),
            // Delete (owner only) — removes the group for everyone.
            if (_amOwner)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: _actionButton(
                  label: 'Delete group',
                  icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
                  fill: AD.destructiveBg, labelColor: AD.destructiveInk,
                  onTap: _busy ? null : _confirmDelete,
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: _actionButton(
                label: 'Leave group',
                icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
                fill: AD.destructiveBg, labelColor: AD.destructiveInk,
                onTap: _busy ? null : _leave,
              ),
            ),
          ]),
        ),
      ]),
    );
  }

  /// Rounded-square glyph badge in an AD accent (replaces ZineIconBadge).
  Widget _badge(IconData icon, Color fill, {double size = 34}) => Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(AD.rIconButton),
        ),
        child: Center(child: PhosphorIcon(icon, size: size * 0.53, color: Colors.white)),
      );

  /// Small "admin" pill (replaces ZineSticker).
  Widget _adminPill() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: AD.newGroup.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(AD.rChip),
        ),
        child: Text('ADMIN', style: ADText.statCaption(c: AD.newGroup)),
      );

  /// Full-width action pill; solid (destructive) or ghost/secondary variant.
  Widget _actionButton({
    required String label,
    required IconData icon,
    required Color fill,
    required Color labelColor,
    Color? borderColor,
    required VoidCallback? onTap,
  }) {
    final enabled = onTap != null;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(100),
        child: Opacity(
          opacity: enabled ? 1 : 0.5,
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 14),
            decoration: BoxDecoration(
              color: fill,
              borderRadius: BorderRadius.circular(100),
              border: borderColor == null ? null : Border.all(color: borderColor, width: 1),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 18, color: labelColor),
              const SizedBox(width: 10),
              Text(label, style: ADText.rowName(c: labelColor)),
            ]),
          ),
        ),
      ),
    );
  }
}
