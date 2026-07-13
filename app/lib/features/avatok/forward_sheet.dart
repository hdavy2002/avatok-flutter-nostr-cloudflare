import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
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
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
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
          width: 44,
          height: 5,
          decoration: BoxDecoration(
              color: AD.textFaint,
              borderRadius: BorderRadius.circular(100)),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Row(children: [
            Text('Forward to', style: ADText.threadName()),
            const Spacer(),
            if (n > 0)
              Text('$n selected',
                  style: ADText.preview(c: AD.textTertiary)),
          ]),
        ),
        // Search bar — white dark-v2 field.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Container(
            decoration: BoxDecoration(
              color: AD.inputField,
              borderRadius: BorderRadius.circular(AD.rInput),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                  size: 18, color: AD.placeholderOnWhite),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _search,
                  cursorColor: AD.primaryBadge,
                  style: ADText.rowName(c: AD.textOnInput),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 13),
                    hintText: 'Search groups and contacts',
                    hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
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
                  child: CircularProgressIndicator(color: AD.iconSearch))
              : (groups.isEmpty && contacts.isEmpty)
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 30),
                      child: Text(
                          _query.isEmpty
                              ? 'No groups or contacts yet'
                              : 'No matches',
                          style: ADText.preview(c: AD.textSecondary)))
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
                  style: ADText.preview(c: AD.textTertiary),
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
            style: ADText.sectionLabel()),
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
                      style: ADText.rowName()),
                  if (subtitle.isNotEmpty)
                    Text(subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.preview(c: AD.textTertiary)),
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
              color: on ? AD.online : Colors.transparent,
              border: Border.all(color: on ? AD.online : AD.borderControl, width: 2),
            ),
            child: on
                ? const Icon(Icons.check_rounded,
                    size: 15, color: Colors.white)
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
            color: AD.primaryBadge,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text('Send',
                style: ADText.rowName(c: Colors.white)),
            const SizedBox(width: 6),
            Icon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                size: 17, color: Colors.white),
          ]),
        ),
      ),
    );
  }
}
