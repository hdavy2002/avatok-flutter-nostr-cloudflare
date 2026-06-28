import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../sync/group_api.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';
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
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Paint the local list first, then reconcile with the server so groups the
    // user was ADDED to (on this or another device) show up here.
    final local = await _store.load();
    final archived = (await ChatFlagsStore().load())['archived'] ?? <String>{};
    List<Group> visible(List<Group> gs) =>
        gs.where((g) => !archived.contains('g:${g.id}')).toList();
    if (mounted) setState(() { _groups = visible(local); _loading = false; });
    final synced = await GroupApi.sync();
    if (mounted) setState(() => _groups = visible(synced));
  }

  Future<void> _newGroup() async {
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => NewGroupScreen(contacts: widget.contacts)));
    _load(); // a group may have been created
  }

  void _openGroup(Group g) {
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
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Groups',
        markWord: 'Groups',
        tag: 'your group chats',
        showBack: Navigator.of(context).canPop(),
        leading: widget.onMenu == null
            ? null
            : ZineBackButton(
                icon: PhosphorIcons.list(PhosphorIconsStyle.bold),
                onTap: widget.onMenu),
      ),
      floatingActionButton: ZineButton(
        label: 'New group',
        fontSize: 17,
        icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _newGroup,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : _groups.isEmpty
              ? _empty()
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 110),
                  itemCount: _groups.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (_, i) {
                    final g = _groups[i];
                    return ZineCard(
                      radius: Zine.rSm,
                      padding: const EdgeInsets.all(13),
                      onTap: () => _openGroup(g),
                      child: Row(children: [
                        ZineIconBadge(
                          icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                          color: Zine.accents[i % Zine.accents.length],
                          size: 48,
                        ),
                        const SizedBox(width: 13),
                        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                          Text(g.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.cardTitle(size: 17)),
                          const SizedBox(height: 3),
                          Text(g.description.isNotEmpty ? g.description : 'Tap to open · calls inside',
                              maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.sub(size: 13)),
                        ])),
                        const SizedBox(width: 10),
                        Text('${g.members.length} MEMBERS', style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
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
              text: 'No groups yet — start a group chat with a few people. '
                  'Up to 5 can be on a free call; paid plans unlock larger calls.',
            ),
            const SizedBox(height: 20),
            ZineButton(
              label: 'New group',
              variant: ZineButtonVariant.blue,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              fontSize: 17,
              onPressed: _newGroup,
            ),
          ]),
        ),
      );
}
