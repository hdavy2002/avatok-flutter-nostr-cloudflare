import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/device_contacts.dart';
import '../../core/group_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';

enum _Scope { all, chats, contacts, groups }

/// Global search — find people across your AvaTok contacts, your phone's
/// address book (by name / email / phone), the public directory, and your
/// groups. Non-AvaTok phone contacts get a one-tap green "Invite" action.
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
    DeviceContactsService.cached().then((c) { if (mounted) setState(() => _device = c); });
    final id = widget.identity;
    if (id != null) {
      DeviceContactsService.syncAndMatch(id.npub).then((c) { if (mounted) setState(() => _device = c); });
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
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
      final emailHit = d.emails.any((e) => e.toLowerCase().contains(ql));
      final phoneHit = qDigits.length >= 3 &&
          d.phones.any((p) => p.replaceAll(RegExp(r'[^0-9]'), '').contains(qDigits));
      return nameHit || emailHit || phoneHit;
    }).toList();
    // Split into on-AvaTok (already a contact?) vs invitable.
    final onAvatok = deviceHits.where((d) => d.onAvatok && !knownNpubs.contains(d.npub)).toList();
    final invitable = deviceHits.where((d) => !d.onAvatok).toList();

    final showChats = _scope == _Scope.all || _scope == _Scope.chats;
    final showContacts = _scope == _Scope.all || _scope == _Scope.contacts;
    final showGroups = _scope == _Scope.all || _scope == _Scope.groups;

    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Column(children: [
          // Search bar
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 12, 6),
            child: Row(children: [
              IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.pop(context)),
              Expanded(
                child: Container(
                  height: 44,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(22)),
                  child: Row(children: [
                    const Icon(Icons.search, size: 20, color: Color(0xFF9AA1AC)),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(
                      controller: _ctrl, autofocus: true, onChanged: _onChanged,
                      decoration: const InputDecoration(
                          hintText: 'Search name, email or phone',
                          border: InputBorder.none, isDense: true,
                          hintStyle: TextStyle(color: Color(0xFF9AA1AC))),
                    )),
                    if (_q.isNotEmpty)
                      GestureDetector(
                        onTap: () { _ctrl.clear(); _onChanged(''); },
                        child: const Icon(Icons.close, size: 18, color: Color(0xFF9AA1AC))),
                  ]),
                ),
              ),
            ]),
          ),
          // Scope chips
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                _chip('All', _Scope.all),
                _chip('Chats', _Scope.chats),
                _chip('Contacts', _Scope.contacts),
                _chip('Groups', _Scope.groups),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView(
              children: [
                if (showChats && contactHits.isNotEmpty) ...[
                  _section('CHATS'),
                  for (final c in contactHits) _avatokRow(c),
                ],
                if (showGroups && groupHits.isNotEmpty) ...[
                  _section('GROUPS'),
                  for (final g in groupHits)
                    ListTile(
                      leading: Avatar(seed: 'group-${g.id}', name: g.name, size: 46),
                      title: Text(g.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text('${g.members.length} members', style: const TextStyle(color: AvaColors.sub)),
                      onTap: () => _openGroup(g),
                    ),
                ],
                if (showContacts && onAvatok.isNotEmpty) ...[
                  _section('ON AVATOK'),
                  for (final d in onAvatok) _deviceOnAvatokRow(d),
                ],
                if (showContacts && _directory.isNotEmpty) ...[
                  _section('DIRECTORY'),
                  if (_searchingDir)
                    const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator(color: AvaColors.brand)),
                  for (final c in _directory.where((c) => !knownNpubs.contains(c.npub))) _avatokRow(c),
                ],
                if (showContacts && invitable.isNotEmpty) ...[
                  _section('INVITE TO AVATOK'),
                  for (final d in invitable) _inviteRow(d),
                ],
                if (_q.isNotEmpty &&
                    contactHits.isEmpty && groupHits.isEmpty && onAvatok.isEmpty &&
                    _directory.isEmpty && invitable.isEmpty && !_searchingDir)
                  const Padding(padding: EdgeInsets.all(28),
                      child: Center(child: Text('No matches', style: TextStyle(color: AvaColors.sub)))),
                if (_q.isEmpty && _device.isEmpty)
                  const Padding(padding: EdgeInsets.all(28),
                      child: Center(child: Text('Search your contacts, the directory and your phone book',
                          textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub)))),
                const SizedBox(height: 20),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  Widget _chip(String label, _Scope scope) {
    final on = _scope == scope;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: on,
        showCheckmark: false,
        selectedColor: AvaColors.brand,
        labelStyle: TextStyle(color: on ? Colors.white : AvaColors.ink, fontWeight: FontWeight.w700),
        backgroundColor: AvaColors.soft,
        side: BorderSide.none,
        onSelected: (_) => setState(() => _scope = scope),
      ),
    );
  }

  Widget _section(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
        child: Text(label, style: const TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w700)),
      );

  // An AvaTok contact (local or directory) row with status badges.
  Widget _avatokRow(Contact c) {
    final k = _hexKey(c.npub);
    final blocked = _flags['blocked']!.contains(k);
    final archived = _flags['archived']!.contains(k);
    final muted = _flags['muted']!.contains(k);
    return ListTile(
      leading: Avatar(seed: c.seed, name: c.name, size: 46),
      title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(c.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AvaColors.sub)),
      trailing: _badges(blocked: blocked, archived: archived, muted: muted),
      onTap: () => _openContactChat(c.npub, c.name, c.seed),
    );
  }

  // A phone contact that turns out to already be on AvaTok.
  Widget _deviceOnAvatokRow(DeviceContact d) {
    final k = d.npub == null ? '' : _hexKey(d.npub!);
    return ListTile(
      leading: Avatar(seed: d.npub ?? d.name, name: d.name, size: 46),
      title: Text(d.name.isNotEmpty ? d.name : d.subtitle, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AvaColors.sub)),
      trailing: _badges(
        blocked: _flags['blocked']!.contains(k),
        archived: _flags['archived']!.contains(k),
        muted: _flags['muted']!.contains(k),
      ),
      onTap: () => _openContactChat(d.npub!, d.name, d.npub!),
    );
  }

  // A phone contact NOT on AvaTok → green invite action.
  Widget _inviteRow(DeviceContact d) => ListTile(
        leading: Avatar(seed: d.name, name: d.name, size: 46),
        title: Text(d.name.isNotEmpty ? d.name : d.subtitle, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AvaColors.sub)),
        trailing: GestureDetector(
          onTap: () => DeviceContactsService.invite(d),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
            decoration: BoxDecoration(color: const Color(0xFF25D366), borderRadius: BorderRadius.circular(20)),
            child: const Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.person_add_alt_1, size: 15, color: Colors.white),
              SizedBox(width: 5),
              Text('Invite', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
            ]),
          ),
        ),
      );

  Widget? _badges({required bool blocked, required bool archived, required bool muted}) {
    final icons = <Widget>[
      if (muted) const Icon(Icons.notifications_off, size: 16, color: AvaColors.sub),
      if (blocked) const Icon(Icons.block, size: 16, color: AvaColors.danger),
      if (archived) Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(border: Border.all(color: AvaColors.line), borderRadius: BorderRadius.circular(6)),
        child: const Text('Archived', style: TextStyle(fontSize: 10, color: AvaColors.sub)),
      ),
    ];
    if (icons.isEmpty) return null;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      for (int i = 0; i < icons.length; i++) ...[if (i > 0) const SizedBox(width: 6), icons[i]],
    ]);
  }
}
