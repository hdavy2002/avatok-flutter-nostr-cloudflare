import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';
import 'group_invites_api.dart';
import 'new_group_screen.dart';

/// Groups tab — surfaces the user's group chats top-level (they used to be
/// reachable only via the chat list + New Group). Tapping a group opens its
/// thread (where group A/V calling lives); the FAB starts a new group.
///
/// NOTE: distinct from Communities (a hub that contains multiple groups as
/// channels). This tab is the flat list of group chats themselves.
class GroupsTab extends StatefulWidget {
  final Identity? identity;
  final List<Contact> contacts;
  /// Opens the app sidebar (the parent shell owns the Drawer). When provided, a
  /// hamburger button is shown in the app bar in place of the back arrow.
  final VoidCallback? onMenu;
  const GroupsTab({super.key, this.identity, this.contacts = const [], this.onMenu});

  @override
  State<GroupsTab> createState() => _GroupsTabState();
}

class _GroupsTabState extends State<GroupsTab> {
  final _store = GroupStore();
  List<Group> _groups = [];
  List<GroupInvite> _invites = []; // pending group invites (Accept/Decline)
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Paint the local list first, then reconcile with the server so groups the
    // user was ADDED to (on this or another device) show up here. (The old
    // one-time local wipe, GroupApi.resetLocalOnce, was removed in the
    // group-safety fix — local-only groups are now ADOPTED by sync, not wiped.)
    final local = await _store.load();
    final archived = (await ChatFlagsStore().load())['archived'] ?? <String>{};
    List<Group> visible(List<Group> gs) =>
        gs.where((g) => !archived.contains('g:${g.id}')).toList();
    if (mounted) setState(() { _groups = visible(local); _loading = false; });
    final synced = await GroupApi.sync();
    final invites = await GroupInvitesApi.list(); // empty unless server flag is on
    if (mounted) setState(() { _groups = visible(synced); _invites = invites; });
    Analytics.capture('groups_tab_viewed',
        {'group_count': _groups.length, 'invite_count': _invites.length, 'archived_count': archived.length});
  }

  Future<void> _respondInvite(GroupInvite inv, bool accept) async {
    final ok = await GroupInvitesApi.respond(conv: inv.conv, accept: accept);
    if (!ok) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't respond — try again.")));
      return;
    }
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(accept ? 'Joined ${inv.groupName}' : 'Invite declined')));
    await _load();
    if (accept && mounted) {
      final match = _groups.where((g) => g.id == inv.conv).toList();
      if (match.isNotEmpty) _openGroup(match.first);
    }
  }

  Future<void> _newGroup() async {
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => NewGroupScreen(contacts: widget.contacts)));
    _load(); // a group may have been created
  }

  void _openGroup(Group g) {
    Analytics.capture('group_opened', {'gid': g.id, 'member_count': g.members.length});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => ChatThreadScreen(
        chat: Chat(
          name: g.name,
          seed: 'group-${g.id}',
          last: 'Group · ${g.members.length} members',
          time: '',
          group: true,
          members: g.members.length,
          gid: g.id,
        ),
      ),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: AD.bg,
      floatingActionButton: _fab(
        icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
        label: 'New group',
        onTap: _newGroup,
      ),
      body: Column(children: [
        // Inline dark v2 header band: near-black header fill + hairline bottom
        // border (mirrors chat_list). Leading = menu (opens sidebar) or back.
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
                if (widget.onMenu != null) ...[
                  _hdrBtn(PhosphorIcons.list(PhosphorIconsStyle.bold), widget.onMenu!),
                  const SizedBox(width: 14),
                ] else if (canPop) ...[
                  _hdrBtn(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                      () => Navigator.of(context).maybePop()),
                  const SizedBox(width: 14),
                ],
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Groups', style: ADText.appTitle()),
                    const SizedBox(height: 2),
                    Text('YOUR GROUP CHATS', style: ADText.sectionLabel()),
                  ],
                ),
              ]),
            ),
          ),
        ),
        Expanded(
          child: _loading
              ? const Center(
                  child: CircularProgressIndicator(color: AD.iconSearch))
              : (_groups.isEmpty && _invites.isEmpty)
                  ? _empty()
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 110),
                      children: [
                        if (_invites.isNotEmpty) ...[
                          Text('PENDING INVITES', style: ADText.sectionLabel()),
                          const SizedBox(height: 10),
                          for (final inv in _invites)
                            Padding(padding: const EdgeInsets.only(bottom: 12), child: _inviteCard(inv)),
                          const SizedBox(height: 4),
                          if (_groups.isNotEmpty) Text('YOUR GROUPS', style: ADText.sectionLabel()),
                          if (_groups.isNotEmpty) const SizedBox(height: 10),
                        ],
                        for (int i = 0; i < _groups.length; i++)
                          Padding(padding: const EdgeInsets.only(bottom: 12), child: _groupCard(_groups[i], i)),
                      ],
                    ),
        ),
      ]),
    );
  }

  /// Circular header icon button (card fill + hairline control border).
  Widget _hdrBtn(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 42, height: 42,
          decoration: BoxDecoration(
            color: AD.card,
            shape: BoxShape.circle,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Center(child: PhosphorIcon(icon, size: 20, color: AD.textPrimary)),
        ),
      );

  /// The primary teal pill (group actions) — replaces the light lime ZineButton.
  Widget _fab({required IconData icon, required String label, required VoidCallback onTap}) =>
      Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(100),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            decoration: BoxDecoration(
              color: AD.newGroup,
              borderRadius: BorderRadius.circular(100),
              boxShadow: AD.overlayShadow,
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 19, color: Colors.white),
              const SizedBox(width: 10),
              Text(label, style: ADText.rowName(c: Colors.white)),
            ]),
          ),
        ),
      );

  /// Rounded-square glyph badge in an AD accent (replaces ZineIconBadge).
  Widget _badge(IconData icon, Color fill, {double size = 48}) => Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(AD.rBadge),
        ),
        child: Center(child: PhosphorIcon(icon, size: size * 0.5, color: Colors.white)),
      );

  /// A dark card surface with an optional tap (replaces ZineCard).
  Widget _card({required Widget child, EdgeInsetsGeometry? padding, VoidCallback? onTap}) {
    final content = Container(
      padding: padding ?? const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AD.rListCard),
        child: content,
      ),
    );
  }

  Widget _groupCard(Group g, int i) => _card(
        onTap: () => _openGroup(g),
        child: Row(children: [
          _badge(PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
              AD.family('${g.id}$i').solid, size: 48),
          const SizedBox(width: 13),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(g.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.threadName()),
            const SizedBox(height: 3),
            Text(g.description.isNotEmpty ? g.description : 'Tap to open · calls inside',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview()),
          ])),
          const SizedBox(width: 10),
          Text('${g.members.length} MEMBERS', style: ADText.statCaption()),
        ]),
      );

  /// A pending group invite with Accept / Decline (Phase D — true pending
  /// membership; only shown when the server flag is on).
  Widget _inviteCard(GroupInvite inv) => _card(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            _badge(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), AD.newGroup, size: 44),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(inv.groupName, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.threadName()),
              const SizedBox(height: 3),
              Text("You've been invited to join${inv.memberCount > 0 ? ' · ${inv.memberCount} members' : ''}",
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview()),
            ])),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: _pillButton(
              label: 'Accept', fill: AD.newGroup, labelColor: Colors.white,
              onTap: () => _respondInvite(inv, true))),
            const SizedBox(width: 10),
            Expanded(child: _pillButton(
              label: 'Decline', fill: AD.card, labelColor: AD.textPrimary,
              borderColor: AD.borderControl, onTap: () => _respondInvite(inv, false))),
          ]),
        ]),
      );

  /// Full-width pill button (solid or ghost/secondary variant).
  Widget _pillButton({
    required String label,
    required Color fill,
    required Color labelColor,
    Color? borderColor,
    required VoidCallback onTap,
  }) =>
      Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(100),
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 12),
            decoration: BoxDecoration(
              color: fill,
              borderRadius: BorderRadius.circular(100),
              border: borderColor == null ? null : Border.all(color: borderColor, width: 1),
            ),
            child: Text(label, style: ADText.rowName(c: labelColor)),
          ),
        ),
      );

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Inline dark empty tile (replaces ZineEmptyState).
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
            Text(
              'No groups yet — start a group chat with a few people. '
              'Up to 5 can be on a free call; paid plans unlock larger calls.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: 20),
            _fab(
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              label: 'New group',
              onTap: _newGroup,
            ),
          ]),
        ),
      );
}
