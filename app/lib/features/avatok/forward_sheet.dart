import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// STREAM I (FWD-1): a single multi-select Forward sheet.
///
/// Long-press / right-click any message → Forward → this sheet. It shows a
/// search bar, then a "Groups" section (the user's group chats + member counts)
/// followed by a "Contacts" section (recent chats / saved contacts). The user
/// ticks any number of targets and taps ONE Send.
///
/// It returns the chosen [ForwardTarget]s (or null if dismissed). The caller
/// (chat_thread `_forward`) is responsible for the actual fan-out send — this
/// widget is pure UI + selection so it stays independent of the message model
/// and Stream K's bubble geometry.
///
/// Privacy (FWD-1): this sheet knows NOTHING about the original sender. The
/// forwarded envelope the caller builds carries `fwd:true` and never the
/// original sender's identity.

/// One resolved forward destination — either a DM (contact) or a group.
class ForwardTarget {
  /// For a DM: the peer's uid (hex). Empty for a group.
  final String peerUid;

  /// For a group: the conversation/group id (`conv`). Empty for a DM.
  final String groupId;

  /// Display name (contact name or group name) — for the confirmation snackbar.
  final String label;

  /// Avatar seed (contact uid or group id) — display only.
  final String seed;

  const ForwardTarget._({
    this.peerUid = '',
    this.groupId = '',
    required this.label,
    required this.seed,
  });

  factory ForwardTarget.contact(Contact c) =>
      ForwardTarget._(peerUid: c.uid, label: c.name, seed: c.seed);

  factory ForwardTarget.group(Group g) =>
      ForwardTarget._(groupId: g.id, label: g.name, seed: g.id);

  bool get isGroup => groupId.isNotEmpty;

  String get _selKey => isGroup ? 'g:$groupId' : 'u:$peerUid';
}

/// Opens the forward sheet and returns the selected targets (empty/ null when
/// the user dismisses without sending). [msgKind] is used for the
/// `forward_opened` telemetry only.
Future<List<ForwardTarget>?> showForwardSheet(
  BuildContext context, {
  required String msgKind,
}) {
  Analytics.capture('forward_opened', {'msg_kind': msgKind});
  return showModalBottomSheet<List<ForwardTarget>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
    builder: (ctx) => const _ForwardSheet(),
  );
}

class _ForwardSheet extends StatefulWidget {
  const _ForwardSheet();

  @override
  State<_ForwardSheet> createState() => _ForwardSheetState();
}

class _ForwardSheetState extends State<_ForwardSheet> {
  final _search = TextEditingController();
  final _selected = <String, ForwardTarget>{}; // _selKey → target
  List<Group> _groups = [];
  List<Contact> _contacts = [];
  bool _loading = true;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
    _search.addListener(() {
      final q = _search.text.trim().toLowerCase();
      if (q != _query) setState(() => _query = q);
    });
  }

  Future<void> _load() async {
    final groups = await GroupStore().load();
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    setState(() {
      _groups = groups;
      _contacts = contacts;
      _loading = false;
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _toggle(ForwardTarget t) {
    setState(() {
      if (_selected.containsKey(t._selKey)) {
        _selected.remove(t._selKey);
      } else {
        _selected[t._selKey] = t;
      }
    });
  }

  List<Group> get _filteredGroups => _query.isEmpty
      ? _groups
      : _groups.where((g) => g.name.toLowerCase().contains(_query)).toList();

  List<Contact> get _filteredContacts => _query.isEmpty
      ? _contacts
      : _contacts
          .where((c) =>
              c.name.toLowerCase().contains(_query) ||
              c.subtitle.toLowerCase().contains(_query))
          .toList();

  @override
  Widget build(BuildContext context) {
    final groups = _filteredGroups;
    final contacts = _filteredContacts;
    final n = _selected.length;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        // Grab handle.
        Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
              color: Zine.inkMute.withValues(alpha: 0.3),
              borderRadius: BorderRadius.circular(2)),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Row(children: [
            Text('Forward to', style: ZineText.cardTitle(size: 18)),
            const Spacer(),
            if (n > 0)
              Text('$n selected',
                  style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ]),
        ),
        // Search bar.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Container(
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(Zine.rField),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                  size: 18, color: Zine.inkMute),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _search,
                  style: ZineText.input(size: 15),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: 'Search groups and contacts',
                    hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
                  ),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 6),
        Flexible(
          child: _loading
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: CircularProgressIndicator())
              : (groups.isEmpty && contacts.isEmpty)
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 30),
                      child: Text(
                          _query.isEmpty
                              ? 'No groups or contacts yet'
                              : 'No matches',
                          style: ZineText.sub()))
                  : ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      children: [
                        if (groups.isNotEmpty) _sectionHeader('Groups'),
                        for (final g in groups)
                          _row(
                            target: ForwardTarget.group(g),
                            title: g.name,
                            subtitle:
                                '${g.members.length} member${g.members.length == 1 ? '' : 's'}',
                            leading: Avatar(seed: g.id, name: g.name, size: 42),
                          ),
                        if (contacts.isNotEmpty) _sectionHeader('Contacts'),
                        for (final c in contacts)
                          _row(
                            target: ForwardTarget.contact(c),
                            title: c.name,
                            subtitle: c.subtitle,
                            leading: Avatar(
                                seed: c.seed,
                                name: c.name,
                                avatarUrl:
                                    c.avatarUrl.isEmpty ? null : c.avatarUrl,
                                size: 42),
                          ),
                      ],
                    ),
        ),
        // Send bar — single Send for the whole multi-select.
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
            child: Row(children: [
              Expanded(
                child: Text(
                  n == 0
                      ? 'Select recipients'
                      : 'Forwarding to $n recipient${n == 1 ? '' : 's'}',
                  style: ZineText.sub(size: 14, color: Zine.inkMute),
                ),
              ),
              _SendButton(
                enabled: n > 0,
                onTap: () =>
                    Navigator.pop(context, _selected.values.toList()),
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _sectionHeader(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 12, 0, 6),
        child: Text(label.toUpperCase(),
            style: ZineText.sub(size: 12, color: Zine.inkMute)),
      );

  Widget _row({
    required ForwardTarget target,
    required String title,
    required String subtitle,
    required Widget leading,
  }) {
    final on = _selected.containsKey(target._selKey);
    return InkWell(
      onTap: () => _toggle(target),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 15)),
                  if (subtitle.isNotEmpty)
                    Text(subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ZineText.sub(size: 12, color: Zine.inkMute)),
                ]),
          ),
          const SizedBox(width: 8),
          // Multi-select checkmark.
          AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            width: 24,
            height: 24,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: on ? Zine.ink : Colors.transparent,
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: on
                ? Icon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                    size: 15, color: Zine.paper)
                : null,
          ),
        ]),
      ),
    );
  }
}

class _SendButton extends StatelessWidget {
  final bool enabled;
  final VoidCallback onTap;
  const _SendButton({required this.enabled, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 120),
        opacity: enabled ? 1 : 0.4,
        child: Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 22),
          decoration: BoxDecoration(
            color: Zine.ink,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text('Send',
                style: ZineText.value(size: 15, color: Zine.paper)),
            const SizedBox(width: 6),
            Icon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                size: 17, color: Zine.paper),
          ]),
        ),
      ),
    );
  }
}
