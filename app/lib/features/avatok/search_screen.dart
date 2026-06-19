import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/device_contacts.dart';
import '../../core/group_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';

enum _Scope { all, chats, contacts, groups }

/// Global search — find people across your AvaTok contacts, your phone's
/// address book (by name / email / phone), the public directory, and your
/// groups. Non-AvaTok phone contacts get a one-tap "Invite" action.
class SearchScreen extends StatefulWidget {
  final Identity? identity;
  final List<Contact> contacts;
  final List<Group> groups;
  const SearchScreen({super.key, this.identity, this.contacts = const [], this.groups = const []});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _ctrl = TextEditingController();
  final _flagsStore = ChatFlagsStore();
  Timer? _debounce;
  StreamSubscription? _deviceSub;
  _Scope _scope = _Scope.all;
  String _q = '';
  Map<String, Set<String>> _flags = {'blocked': {}, 'archived': {}, 'muted': {}, 'pinned': {}};

  List<DeviceContact> _device = [];
  List<Contact> _directory = [];
  bool _searchingDir = false;

  @override
  void initState() {
    super.initState();
    _flagsStore.load().then((f) { if (mounted) setState(() => _flags = f); });
    // Load cached device contacts instantly, then refresh + match in background.
    // The cache stream repaints the list when freshly-synced rows / matches land.
    DeviceContactsService.cached().then((c) { if (mounted) setState(() => _device = c); });
    _deviceSub = DeviceContactsService.watch().listen((c) { if (mounted) setState(() => _device = c); });
    DeviceContactsService.refresh(force: true);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _deviceSub?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    setState(() => _q = v.trim());
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 320), _runDirectory);
  }

  Future<void> _runDirectory() async {
    final q = _q;
    if (q.length < 2) { setState(() => _directory = []); return; }
    setState(() => _searchingDir = true);
    final res = await Directory.search(q);
    if (!mounted) return;
    setState(() { _directory = res; _searchingDir = false; });
  }

  String _hexKey(String npub) => '1:${NostrKeys.npubToHex(npub) ?? npub}';

  void _openContactChat(String npub, String name, String seed) {
    final chat = Chat(name: name.isEmpty ? 'Contact' : name, seed: seed, last: '', time: '');
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  void _openGroup(Group g) {
    final chat = Chat(name: g.name, seed: 'group-${g.id}', last: '', time: '',
        group: true, members: g.members.length, gid: g.id);
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  bool _matches(String hay) => _q.isEmpty || hay.toLowerCase().contains(_q.toLowerCase());

  @override
  Widget build(BuildContext context) {
    final ql = _q.toLowerCase();
    final qDigits = _q.replaceAll(RegExp(r'[^0-9]'), '');

    // --- AvaTok contacts (local) ---
    final contactHits = widget.contacts.where((c) =>
        _matches(c.name) || _matches(c.email) || _matches(c.handle) || _matches(c.npub)).toList();

    // --- Groups ---
    final groupHits = widget.groups.where((g) => _matches(g.name)).toList();

    // --- Device contacts (phone address book) ---
    final knownNpubs = widget.contacts.map((c) => c.npub).toSet();
    final deviceHits = _device.where((d) {
      if (_q.isEmpty) return true;
      final nameHit = d.name.toLowerCase().contains(ql);
      final phoneHit = qDigits.length >= 3 &&
          d.phoneNorm.replaceAll(RegExp(r'[^0-9]'), '').contains(qDigits);
      return nameHit || phoneHit;
    }).toList();
    // Split into on-AvaTok (already a contact?) vs invitable.
    final onAvatok = deviceHits.where((d) => d.onAvatok && !knownNpubs.contains(d.uid)).toList();
    final invitable = deviceHits.where((d) => !d.onAvatok).toList();

    final showChats = _scope == _Scope.all || _scope == _Scope.chats;
    final showContacts = _scope == _Scope.all || _scope == _Scope.contacts;
    final showGroups = _scope == _Scope.all || _scope == _Scope.groups;

    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          // Search band — paper-2 fill with ink bottom border.
          Container(
            decoration: const BoxDecoration(
              color: Zine.paper2,
              border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
            child: Column(children: [
              Row(children: [
                const ZineBackButton(),
                const SizedBox(width: 12),
                Expanded(
                  child: ZineField(
                    controller: _ctrl,
                    autofocus: true,
                    hint: 'Search name, email or phone',
                    leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                    onChanged: _onChanged,
                    trailing: _q.isEmpty
                        ? null
                        : GestureDetector(
                            onTap: () { _ctrl.clear(); _onChanged(''); },
                            child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                                size: 18, color: Zine.inkSoft),
                          ),
                  ),
                ),
              ]),
              const SizedBox(height: 12),
              // Scope chips
              SizedBox(
                height: 38,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    _chip('All', _Scope.all),
                    _chip('Chats', _Scope.chats),
                    _chip('Contacts', _Scope.contacts),
                    _chip('Groups', _Scope.groups),
                  ],
                ),
              ),
            ]),
          ),
          Expanded(
            child: ListView(
              children: [
                if (showChats && contactHits.isNotEmpty) ...[
                  _section('Chats'),
                  for (final c in contactHits) _avatokRow(c),
                ],
                if (showGroups && groupHits.isNotEmpty) ...[
                  _section('Groups'),
                  for (final g in groupHits)
                    ListTile(
                      leading: _ring(Avatar(seed: 'group-${g.id}', name: g.name, size: 46)),
                      title: Text(g.name, style: ZineText.value(size: 15)),
                      subtitle: Text('${g.members.length} members', style: ZineText.sub(size: 12.5)),
                      onTap: () => _openGroup(g),
                    ),
                ],
                if (showContacts && onAvatok.isNotEmpty) ...[
                  _section('On AvaTok'),
                  for (final d in onAvatok) _deviceOnAvatokRow(d),
                ],
                if (showContacts && _directory.isNotEmpty) ...[
                  _section('Directory'),
                  if (_searchingDir)
                    const Padding(padding: EdgeInsets.all(12),
                        child: LinearProgressIndicator(color: Zine.blueInk, backgroundColor: Zine.paper2)),
                  for (final c in _directory.where((c) => !knownNpubs.contains(c.npub))) _avatokRow(c),
                ],
                if (showContacts && invitable.isNotEmpty) ...[
                  _section('Invite to AvaTok'),
                  for (final d in invitable) _inviteRow(d),
                ],
                if (_q.isNotEmpty &&
                    contactHits.isEmpty && groupHits.isEmpty && onAvatok.isEmpty &&
                    _directory.isEmpty && invitable.isEmpty && !_searchingDir)
                  Padding(padding: const EdgeInsets.all(28),
                      child: Center(child: ZineEmptyState(
                          icon: PhosphorIcons.binoculars(PhosphorIconsStyle.bold),
                          text: 'No matches.\nTo find someone by email, type their full email address.'))),
                if (_q.isEmpty && _device.isEmpty)
                  Padding(padding: const EdgeInsets.all(28),
                      child: Center(child: ZineEmptyState(
                          icon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                          text: 'Search your contacts, the directory and your phone book'))),
                const SizedBox(height: 20),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  // Bordered-circle avatar ring (zine avatars are bordered circles).
  Widget _ring(Widget avatar) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: avatar,
      );

  Widget _chip(String label, _Scope scope) => Padding(
        padding: const EdgeInsets.only(right: 9),
        child: ZineChip(
          label: label,
          active: _scope == scope,
          onTap: () => setState(() => _scope = scope),
        ),
      );

  Widget _section(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 6),
        child: Text(label.toUpperCase(), style: ZineText.kicker()),
      );

  // An AvaTok contact (local or directory) row with status badges.
  Widget _avatokRow(Contact c) {
    final k = _hexKey(c.npub);
    final blocked = _flags['blocked']!.contains(k);
    final archived = _flags['archived']!.contains(k);
    final muted = _flags['muted']!.contains(k);
    return ListTile(
      leading: _ring(Avatar(seed: c.seed, name: c.name, size: 46, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl)),
      title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ZineText.value(size: 15)),
      subtitle: Text(c.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
      trailing: _badges(blocked: blocked, archived: archived, muted: muted),
      onTap: () => _openContactChat(c.npub, c.name, c.seed),
    );
  }

  // A phone contact that turns out to already be on AvaTok.
  Widget _deviceOnAvatokRow(DeviceContact d) {
    final k = d.uid.isEmpty ? '' : _hexKey(d.uid);
    return ListTile(
      leading: _ring(Avatar(
          seed: d.uid.isNotEmpty ? d.uid : d.name, name: d.displayName, size: 46,
          avatarUrl: d.avatarUrl.isEmpty ? null : d.avatarUrl)),
      title: Text(d.displayName, style: ZineText.value(size: 15)),
      subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
      trailing: _badges(
        blocked: _flags['blocked']!.contains(k),
        archived: _flags['archived']!.contains(k),
        muted: _flags['muted']!.contains(k),
      ),
      onTap: () => _openContactChat(d.uid, d.displayName, d.uid),
    );
  }

  // A phone contact NOT on AvaTok → mint invite action (money/positive accent).
  Widget _inviteRow(DeviceContact d) => ListTile(
        leading: _ring(Avatar(seed: d.name, name: d.name, size: 46)),
        title: Text(d.name.isNotEmpty ? d.name : d.subtitle, style: ZineText.value(size: 15)),
        subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
        trailing: ZinePressable(
          onTap: () => DeviceContactsService.invite(d),
          color: Zine.mint,
          radius: BorderRadius.circular(100),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 14, color: Zine.ink),
            const SizedBox(width: 5),
            Text('INVITE', style: ZineText.tag(size: 11)),
          ]),
        ),
      );

  Widget? _badges({required bool blocked, required bool archived, required bool muted}) {
    final icons = <Widget>[
      if (muted) PhosphorIcon(PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
      if (blocked) PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), size: 16, color: Zine.coral),
      if (archived) const ZineSticker('Archived', kind: ZineStickerKind.hint),
    ];
    if (icons.isEmpty) return null;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      for (int i = 0; i < icons.length; i++) ...[if (i > 0) const SizedBox(width: 6), icons[i]],
    ]);
  }
}
