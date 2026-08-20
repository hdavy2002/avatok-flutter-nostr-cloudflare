import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart'; // [RAJ-SEAMS-1]
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/illustrations.dart'; // [RAJ-SEAMS-1]
import '../../core/ui/messenger_theme.dart';
// [RAJ-SINGLEWAVE-1] `core/ui/rajasthani_motifs.dart` import removed with the
// header band — this file no longer draws a seam of its own. The one above it,
// in chat_list, is now the only wave on the Groups tab.
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
  /// ⚠️ [RAJ-SINGLEWAVE-1 2026-08-21] NO LONGER RENDERS ANYTHING.
  ///
  /// This used to put a hamburger (or a back arrow) in GroupsTab's own header
  /// band. That whole band is gone — owner request, pic 1/2: "remove the
  /// entire section with the hamburger menu also… once this area is removed
  /// then we will get a single wave on top." GroupsTab is only ever a tab body
  /// inside `chat_list.dart`, whose shared header already carries the
  /// hamburger, so the second one was a duplicate control under a duplicate
  /// wave.
  ///
  /// The parameter is KEPT rather than deleted because `chat_list.dart:2591`
  /// still passes it and removing it is a separate, mechanical change with no
  /// local compiler to catch a miss. If GroupsTab ever becomes a pushed route
  /// again it will need its own back affordance and this is the hook for it.
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

  // [ISSUE-GROUPS-SEARCH-1] Instant name filter over groups + pending invites.
  // No debounce; filters from the first character typed.
  final _searchCtl = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtl.dispose(); // [ISSUE-GROUPS-SEARCH-1]
    super.dispose();
  }

  /// [ISSUE-GROUPS-SEARCH-1] Case-insensitive substring match on a group name.
  bool _nameMatches(String name) =>
      _query.isEmpty || name.toLowerCase().contains(_query.toLowerCase());

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
          // [AVAGRP-ICON-1] Without this the thread header (chat_thread.dart,
          // which DOES render Avatar(avatarUrl: c.avatarUrl)) always fell back to
          // initials for groups, even when an admin had set a group photo.
          avatarUrl: g.avatarUrl,
        ),
      ),
      // Re-run _load() on return so a photo set/changed from Group info (which
      // mutates GroupStore via GroupApi.setAvatar) is reflected here immediately.
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    // [ISSUE-GROUPS-SEARCH-1] Derived views; both sections narrow under a query.
    final visibleGroups = _groups.where((g) => _nameMatches(g.name)).toList();
    final visibleInvites = _invites.where((i) => _nameMatches(i.groupName)).toList();
    final noResults =
        _query.isNotEmpty && visibleGroups.isEmpty && visibleInvites.isEmpty;
    return Scaffold(
      backgroundColor: AD.bg,
      floatingActionButton: _fab(
        icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
        label: 'New group',
        onTap: _newGroup,
      ),
      // [RAJ-SINGLEWAVE-1 2026-08-21] THE SECOND HEADER AND THE SECOND WAVE ARE
      // GONE. Owner, pic 1/2: "see double waves — can you remove the second
      // wave where it says Group chat. In fact remove the entire section with
      // the hamburger menu also. Once this area is removed then we will get a
      // single wave on top."
      //
      // What used to be here: a full band Container ("Groups / YOUR GROUP
      // CHATS" + a hamburger) followed by its own `SquiggleSeam`. GroupsTab is
      // ONLY ever a tab body inside `chat_list.dart`'s IndexedStack — never a
      // pushed route (verified: one construction site, chat_list.dart:2591, and
      // it passes `onMenu`) — so that band sat directly under chat_list's own
      // header + tab strip + seam. Two headers, two hamburgers, two waves, on a
      // screen that already told you it was the Groups tab.
      //
      // ⚠️ Do NOT "restore the Groups title for clarity". The tab strip
      // immediately above is the title. If GroupsTab is ever pushed as a real
      // route it needs a header again — see the note on `GroupsTab.onMenu` —
      // but adding one back while it is a tab body re-creates the double wave.
      body: Column(children: [
        // [ISSUE-GROUPS-SEARCH-1] Search dock, pinned under the header and outside
        // the ListView so it stays put while the list scrolls. Hidden when there is
        // nothing to search; never autofocused (would pop the keyboard on tab open).
        if (!_loading && (_groups.isNotEmpty || _invites.isNotEmpty))
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
            child: AdSearchDock(
              controller: _searchCtl,
              hint: 'Search groups',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
        Expanded(
          child: _loading
              ? const Center(
                  child: CircularProgressIndicator(color: AD.iconSearch))
              : (_groups.isEmpty && _invites.isEmpty)
                  ? _empty()
                  : noResults
                      ? _noResults()
                      : ListView(
                      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, 110),
                      children: [
                        // Section headers are tied to their FILTERED section, so a
                        // header never survives alone when its rows are filtered out.
                        if (visibleInvites.isNotEmpty) ...[
                          Text('PENDING INVITES', style: ADText.sectionLabel()),
                          const SizedBox(height: Msg.s2),
                          for (final inv in visibleInvites)
                            Padding(padding: const EdgeInsets.only(bottom: 12), child: _inviteCard(inv)),
                          const SizedBox(height: 4),
                          if (visibleGroups.isNotEmpty) Text('YOUR GROUPS', style: ADText.sectionLabel()),
                          if (visibleGroups.isNotEmpty) const SizedBox(height: Msg.s2),
                        ],
                        // NOTE: _groupCard's index seeds its badge colour
                        // (AD.family('${g.id}$i')). Pass the index in _groups, not in
                        // the filtered list, or every badge would change colour as
                        // the user types.
                        for (final g in visibleGroups)
                          Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _groupCard(g, _groups.indexOf(g))),
                      ],
                    ),
        ),
      ]),
    );
  }

  // [RAJ-SINGLEWAVE-1] `_hdrBtn` (the circular hamburger/back button) was
  // deleted with the header band above. It had no other call site, and
  // `flutter analyze` fails the build on an unused private element.

  /// The primary teal pill (group actions) — replaces the light lime ZineButton.
  Widget _fab({required IconData icon, required String label, required VoidCallback onTap}) =>
      Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: Msg.brMd,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s4),
            decoration: BoxDecoration(
              color: AD.newGroup,
              borderRadius: Msg.brMd,
              boxShadow: AD.overlayShadow,
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 19, color: Colors.white),
              const SizedBox(width: Msg.s3),
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

  /// [AVAGRP-ICON-1] Group icon for a list row: the admin-set group photo (a
  /// ROUND avatar with a white circular border ring, per owner request 2026-07-17)
  /// when [avatarUrl] is set, else the existing rounded-square glyph badge.
  /// `seed`/`name` mirror the convention used by the group-info header
  /// (group_info_screen.dart: `Avatar(seed: 'group-${_group.id}', name: _group.name, ...)`).
  Widget _groupIcon({required String id, required String name, required String avatarUrl,
      required Color fallbackFill, required IconData fallbackIcon, double size = 48}) {
    if (avatarUrl.isEmpty) return _badge(fallbackIcon, fallbackFill, size: size);
    return Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: AD.borderAvatar, width: 2), // white ring
      ),
      child: Avatar(seed: 'group-$id', name: name, size: size, avatarUrl: avatarUrl),
    );
  }

  /// A dark card surface with an optional tap (replaces ZineCard).
  Widget _card({required Widget child, EdgeInsetsGeometry? padding, VoidCallback? onTap}) {
    final content = Container(
      padding: padding ?? const EdgeInsets.all(Msg.s4),
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
          _groupIcon(
            id: g.id,
            name: g.name,
            avatarUrl: g.avatarUrl,
            fallbackFill: AD.family('${g.id}$i').solid,
            fallbackIcon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
            size: 48,
          ),
          const SizedBox(width: Msg.s3),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(g.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.threadName()),
            const SizedBox(height: Msg.s1),
            Text(g.description.isNotEmpty ? g.description : 'Tap to open · calls inside',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview()),
          ])),
          const SizedBox(width: Msg.s2),
          Text('${g.members.length} MEMBERS', style: ADText.statCaption()),
        ]),
      );

  /// A pending group invite with Accept / Decline (Phase D — true pending
  /// membership; only shown when the server flag is on).
  ///
  /// [AVAGRP-ICON-1] Still glyph-only, unlike _groupIcon above: `GroupInvite`
  /// (group_invites_api.dart, not owned by this file) has no `avatarUrl` field —
  /// `GET /conversations/invites` doesn't return one. Wiring a real photo in here
  /// needs that payload extended first; out of scope for this fix.
  Widget _inviteCard(GroupInvite inv) => _card(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            _badge(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), AD.newGroup, size: 44),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(inv.groupName, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.threadName()),
              const SizedBox(height: Msg.s1),
              Text("You've been invited to join${inv.memberCount > 0 ? ' · ${inv.memberCount} members' : ''}",
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview()),
            ])),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: _pillButton(
              label: 'Accept', fill: AD.newGroup, labelColor: Colors.white,
              onTap: () => _respondInvite(inv, true))),
            const SizedBox(width: Msg.s2),
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
          borderRadius: Msg.brMd,
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: Msg.s3),
            decoration: BoxDecoration(
              color: fill,
              borderRadius: Msg.brMd,
              border: borderColor == null ? null : Border.all(color: borderColor, width: 1),
            ),
            child: Text(label, style: ADText.rowName(c: labelColor)),
          ),
        ),
      );

  /// [ISSUE-GROUPS-SEARCH-1] Shown when a query matches no group/invite — distinct
  /// from _empty(), which means "you have no groups at all".
  Widget _noResults() => Center(
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
                  PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                  size: 32, color: AD.textTertiary)),
            ),
            const SizedBox(height: Msg.s3),
            Text('No groups match "$_query"',
                textAlign: TextAlign.center,
                style: ADText.preview(c: AD.textSecondary)),
          ]),
        ),
      );

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // [RAJ-SEAMS-1] Rajasthani flower medallion replaces the icon-tile
            // for the Groups empty state — decorative, next to the copy below.
            SvgPicture.asset(
              Illustrations.groupsMotif,
              width: 108,
              height: 108,
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            ),
            const SizedBox(height: Msg.s3),
            Text(
              'No groups yet — start a group chat with a few people. '
              'Up to 5 can be on a free call; paid plans unlock larger calls.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: Msg.s4),
            _fab(
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              label: 'New group',
              onTap: _newGroup,
            ),
          ]),
        ),
      );
}
