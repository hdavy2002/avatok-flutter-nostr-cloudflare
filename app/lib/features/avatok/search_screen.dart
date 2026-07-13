import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/config.dart';
import '../../core/db.dart';
import '../../core/device_contacts.dart';
import '../../core/remote_config.dart';
import '../../sync/sync_hub.dart';
import '../../core/group_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
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
  // Global message search hits across ALL my conversations (on-device).
  List<({Chat chat, String snippet, int ts, bool mine})> _msgHits = [];

  @override
  void initState() {
    super.initState();
    _flagsStore.load().then((f) { if (mounted) setState(() => _flags = f); });
    // Load cached device contacts instantly, then refresh + match in background.
    // The cache stream repaints the list when device rows land. No full address-
    // book read is triggered here — directory search is email/AvaTOK-number only,
    // and the address book is read lazily only on the Invite screen.
    DeviceContactsService.cached().then((c) { if (mounted) setState(() => _device = c); });
    _deviceSub = DeviceContactsService.watch().listen((c) { if (mounted) setState(() => _device = c); });
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
    _debounce = Timer(const Duration(milliseconds: 320), () { _runDirectory(); _runMessages(); });
  }

  Future<void> _runDirectory() async {
    final q = _q;
    if (q.length < 2) { setState(() => _directory = []); return; }
    setState(() => _searchingDir = true);
    // PARITY WITH "ADD A NEW CHAT" (owner report 2026-07-01): the header search
    // used to come back empty for an exact email or AvaTOK number — only the
    // private-number path resolved. Mirror the add-contact sheet's rule exactly:
    // resolve a complete email OR an AvaTOK/phone number to the account, and merge
    // that hit with any directory matches. Same `Directory.resolve` the new-chat
    // sheet uses, so both surfaces now find people by email + AvaTOK number.
    final isEmail = Directory.isCompleteEmail(q);
    // [SEARCH-PHONE-RESTORE 2026-07-12] Phone-number search restored alongside
    // email (owner request). Search by AvaTOK/phone number resolves a directory
    // hit again regardless of the businessCallUx channel-split flag — number
    // *dialing* still lives on the dialpad, but number *search* now works here
    // too, matching the pre-split legacy behaviour (email OR number both resolve).
    final isNumber = RegExp(r'^[+\d][\d\s()-]{3,}$').hasMatch(q);
    final results = <Contact>[];
    if (isEmail || isNumber) {
      final hit = await Directory.resolve(q);
      if (hit != null && hit.uid.isNotEmpty) results.add(hit);
    }
    // Any other directory matches (exact-key search; names removed server-side).
    for (final c in await Directory.search(q)) {
      if (!results.any((x) => x.uid == c.uid)) results.add(c);
    }
    if (!mounted) return;
    setState(() { _directory = results; _searchingDir = false; });
    Analytics.capture('people_search',
        {'q_len': q.length, 'results': results.length, 'email': isEmail, 'number': isNumber});
  }

  // GLOBAL message search — LOCAL first (instant), then ONLINE (fills what this
  // device is missing from your other devices). Both isolated to your own data.
  Future<void> _runMessages() async {
    final q = _q;
    if (q.length < 2) { setState(() => _msgHits = []); return; }
    final ql = q.toLowerCase();
    final hits = <({Chat chat, String snippet, int ts, bool mine})>[];
    final seen = <String>{};
    void addHit(String convKey, String? text, int ts, bool mine) {
      if (text == null || !text.toLowerCase().contains(ql)) return;
      final chat = _chatForConv(convKey);
      if (chat == null) return;
      if (!seen.add('$convKey|$ts|$text')) return; // dedup local vs online
      hits.add((chat: chat, snippet: text, ts: ts, mine: mine));
    }

    // 1) LOCAL — instant.
    final localRows = await Db.I.searchMessages(q);
    for (final r in localRows) { addHit(r.convKey, _extractText(r.payload), r.createdAt, r.mine); }
    if (mounted) {
      setState(() => _msgHits = (List.of(hits)..sort((a, b) => b.ts.compareTo(a.ts))).take(50).toList());
    }

    // 2) ONLINE — best-effort top-up from the server (your other devices' history).
    final myUid = widget.identity?.uid ?? '';
    final online = await SyncHub.I.searchOnline(q);
    for (final r in online) {
      final convKey = _serverConvToKey((r['conv'] ?? '').toString(), myUid);
      if (convKey == null) continue;
      final rawTs = (r['created_at'] as num?)?.toInt() ?? 0;
      final ts = rawTs > 2000000000 ? rawTs ~/ 1000 : rawTs;
      addHit(convKey, _extractText((r['body'] ?? '').toString()), ts, (r['sender'] ?? '').toString() == myUid);
    }
    if (!mounted) return;
    setState(() => _msgHits = (hits..sort((a, b) => b.ts.compareTo(a.ts))).take(50).toList());
    Analytics.capture('message_search', {
      'q_len': q.length, 'local': localRows.length, 'online': online.length, 'shown': _msgHits.length,
    });
  }

  // Map a server conversation id ('dm_a__b' / group) to the local convKey.
  String? _serverConvToKey(String conv, String myUid) {
    if (conv.startsWith('dm_')) {
      final peer = dmPeer(conv, myUid);
      return peer == null ? null : '1:$peer';
    }
    if (conv.startsWith('g')) return 'g:${conv.replaceFirst(RegExp(r'^g[_:]'), '')}';
    return null;
  }

  // Pull the human-readable line out of a stored message envelope; null for
  // control/edit/delete/hidden envelopes (never a search result).
  String? _extractText(String payload) {
    const skip = {'receipt', 'read', 'delivered', 'typing', 'ack', 'seen',
      'edit', 'gedit', 'del', 'gdel', 'hide', 'deleted', 'vote'};
    try {
      final e = jsonDecode(payload);
      if (e is Map) {
        if (skip.contains(e['t'])) return null;
        final b = (e['body'] ?? e['caption'] ?? '').toString().trim();
        return b.isEmpty ? null : b;
      }
    } catch (_) { /* not JSON → raw text */ }
    final t = payload.trim();
    return t.isEmpty ? null : t;
  }

  // Map a stored convKey back to an openable Chat (group or 1:1 peer).
  Chat? _chatForConv(String convKey) {
    if (convKey.startsWith('g:')) {
      final gid = convKey.substring(2);
      for (final g in widget.groups) {
        if (g.id == gid) {
          return Chat(name: g.name, seed: 'group-${g.id}', last: '', time: '',
              group: true, members: g.members.length, gid: g.id);
        }
      }
      return null;
    }
    if (convKey.startsWith('1:')) {
      final hex = convKey.substring(2);
      for (final c in widget.contacts) {
        if (c.uid == hex) {
          return Chat(name: c.name.isEmpty ? 'Contact' : c.name, seed: c.seed, last: '', time: '');
        }
      }
      return Chat(name: 'Chat', seed: hex, last: '', time: '');
    }
    return null;
  }

  String _hexKey(String uid) => '1:$uid';

  void _openContactChat(String uid, String name, String seed) {
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
        _matches(c.name) || _matches(c.email) || _matches(c.handle) || _matches(c.uid)).toList();

    // --- Groups ---
    final groupHits = widget.groups.where((g) => _matches(g.name)).toList();

    // --- Device contacts (phone address book) ---
    final knownUids = widget.contacts.map((c) => c.uid).toSet();
    final deviceHits = _device.where((d) {
      if (_q.isEmpty) return true;
      final nameHit = d.name.toLowerCase().contains(ql);
      final phoneHit = qDigits.length >= 3 &&
          d.phoneNorm.replaceAll(RegExp(r'[^0-9]'), '').contains(qDigits);
      return nameHit || phoneHit;
    }).toList();
    // Split into on-AvaTok (already a contact?) vs invitable.
    final onAvatok = deviceHits.where((d) => d.onAvatok && !knownUids.contains(d.uid)).toList();
    final invitable = deviceHits.where((d) => !d.onAvatok).toList();

    final showChats = _scope == _Scope.all || _scope == _Scope.chats;
    final showContacts = _scope == _Scope.all || _scope == _Scope.contacts;
    final showGroups = _scope == _Scope.all || _scope == _Scope.groups;

    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          // Search band — header/footer fill with hairline bottom border.
          Container(
            decoration: const BoxDecoration(
              color: AD.headerFooter,
              border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
            child: Column(children: [
              Row(children: [
                GestureDetector(
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 38, height: 38,
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(AD.rIconButton)),
                    child: const Icon(Icons.arrow_back_rounded, size: 22, color: AD.textPrimary),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: _searchDock(
                    controller: _ctrl,
                    autofocus: true,
                    hint: 'Search name, email or phone',
                    onChanged: _onChanged,
                    trailing: _q.isEmpty
                        ? null
                        : GestureDetector(
                            onTap: () { _ctrl.clear(); _onChanged(''); },
                            child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                                size: 18, color: AD.placeholderOnWhite),
                          ),
                  ),
                ),
              ]),
              // [DIALPAD-BIZ-CALLS] Channel-split hint: email is the friend
              // channel; the AvaTOK number/dialpad is the business channel.
              // Flag-gated — invisible while businessCallUx is off.
              if (RemoteConfig.businessCallUx) ...[
                const SizedBox(height: 8),
                Text(
                  'Find people by email or AvaTOK number. To call a business, dial their AvaTOK number.',
                  style: ADText.preview(c: AD.textSecondary),
                ),
              ],
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
                      title: Text(g.name, style: ADText.rowName()),
                      subtitle: Text('${g.members.length} members', style: ADText.preview(c: AD.textSecondary)),
                      onTap: () => _openGroup(g),
                    ),
                ],
                if (showChats && _msgHits.isNotEmpty) ...[
                  _section('Messages'),
                  for (final h in _msgHits)
                    ListTile(
                      leading: _ring(Avatar(seed: h.chat.seed, name: h.chat.name, size: 46)),
                      title: Text(h.chat.name, style: ADText.rowName()),
                      subtitle: Text('${h.mine ? "You: " : ""}${h.snippet}',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textSecondary)),
                      trailing: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
                          size: 16, color: AD.textTertiary),
                      onTap: () => Navigator.push(context,
                          MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: h.chat))),
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
                        child: LinearProgressIndicator(color: AD.iconSearch, backgroundColor: AD.card)),
                  for (final c in _directory.where((c) => !knownUids.contains(c.uid))) _avatokRow(c),
                ],
                if (showContacts && invitable.isNotEmpty) ...[
                  _section('Invite to AvaTok'),
                  for (final d in invitable) _inviteRow(d),
                ],
                if (_q.isNotEmpty &&
                    contactHits.isEmpty && groupHits.isEmpty && onAvatok.isEmpty &&
                    _directory.isEmpty && invitable.isEmpty && _msgHits.isEmpty && !_searchingDir)
                  Padding(padding: const EdgeInsets.all(28),
                      child: Center(child: _emptyState(
                          icon: PhosphorIcons.binoculars(PhosphorIconsStyle.bold),
                          text: 'No matches.\nFind people by their full email address or AvaTOK number.'))),
                if (_q.isEmpty && _device.isEmpty)
                  Padding(padding: const EdgeInsets.all(28),
                      child: Center(child: _emptyState(
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

  // Bordered-circle avatar ring (white hairline ring on dark).
  Widget _ring(Widget avatar) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: AD.borderAvatar, width: 2),
        ),
        child: avatar,
      );

  /// White search dock — dark ink text on white, mirrors the dark v2 idiom.
  /// Keeps controller / autofocus / onChanged / trailing wiring intact.
  Widget _searchDock({
    required TextEditingController controller,
    required String hint,
    required ValueChanged<String> onChanged,
    bool autofocus = false,
    Widget? trailing,
  }) =>
      Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
              size: 18, color: AD.iconSearch),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              autofocus: autofocus,
              onChanged: onChanged,
              cursorColor: AD.iconSearch,
              style: ADText.rowName(c: AD.textOnInput),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(vertical: 13),
                hintText: hint,
                hintStyle: ADText.preview(c: AD.placeholderOnWhite),
              ),
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 6), trailing],
        ]),
      );

  /// Inline dark v2 empty state (replaces ZineEmptyState).
  Widget _emptyState({required IconData icon, required String text}) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 56, height: 56,
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: BorderRadius.circular(AD.rListCard),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: PhosphorIcon(icon, size: 24, color: AD.textTertiary),
          ),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary)),
        ],
      );

  Widget _chip(String label, _Scope scope) {
    final active = _scope == scope;
    return Padding(
      padding: const EdgeInsets.only(right: 9),
      child: GestureDetector(
        onTap: () => setState(() => _scope = scope),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: active ? AD.primaryBadge : AD.card,
            borderRadius: BorderRadius.circular(AD.rTab),
            border: Border.all(color: active ? AD.primaryBadge : AD.borderControl, width: 1),
          ),
          child: Text(label,
              style: ADText.tabLabel(c: active ? AD.textPrimary : AD.textSecondary)),
        ),
      ),
    );
  }

  Widget _section(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 6),
        child: Text(label.toUpperCase(), style: ADText.sectionLabel()),
      );

  // An AvaTok contact (local or directory) row with status badges.
  Widget _avatokRow(Contact c) {
    final k = _hexKey(c.uid);
    final blocked = _flags['blocked']!.contains(k);
    final archived = _flags['archived']!.contains(k);
    final muted = _flags['muted']!.contains(k);
    return ListTile(
      leading: _ring(Avatar(seed: c.seed, name: c.name, size: 46, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl)),
      title: Text(c.name.isNotEmpty ? c.name : c.subtitle, style: ADText.rowName()),
      subtitle: Text(c.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textSecondary)),
      trailing: _badges(blocked: blocked, archived: archived, muted: muted),
      onTap: () => _openContactChat(c.uid, c.name, c.seed),
    );
  }

  // A phone contact that turns out to already be on AvaTok.
  Widget _deviceOnAvatokRow(DeviceContact d) {
    final k = d.uid.isEmpty ? '' : _hexKey(d.uid);
    return ListTile(
      leading: _ring(Avatar(
          seed: d.uid.isNotEmpty ? d.uid : d.name, name: d.displayName, size: 46,
          avatarUrl: d.avatarUrl.isEmpty ? null : d.avatarUrl)),
      title: Text(d.displayName, style: ADText.rowName()),
      subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textSecondary)),
      trailing: _badges(
        blocked: _flags['blocked']!.contains(k),
        archived: _flags['archived']!.contains(k),
        muted: _flags['muted']!.contains(k),
      ),
      onTap: () => _openContactChat(d.uid, d.displayName, d.uid),
    );
  }

  // A phone contact NOT on AvaTok → green invite action (positive/group accent).
  Widget _inviteRow(DeviceContact d) => ListTile(
        leading: _ring(Avatar(seed: d.name, name: d.name, size: 46)),
        title: Text(d.name.isNotEmpty ? d.name : d.subtitle, style: ADText.rowName()),
        subtitle: Text(d.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textSecondary)),
        trailing: GestureDetector(
          onTap: () => DeviceContactsService.invite(d),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
            decoration: BoxDecoration(
              color: AD.newGroup,
              borderRadius: BorderRadius.circular(100),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 14, color: AD.textPrimary),
              const SizedBox(width: 5),
              Text('INVITE', style: ADText.statCaption(c: AD.textPrimary)),
            ]),
          ),
        ),
      );

  Widget? _badges({required bool blocked, required bool archived, required bool muted}) {
    final icons = <Widget>[
      if (muted) PhosphorIcon(PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
      if (blocked) PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), size: 16, color: AD.danger),
      if (archived)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: BorderRadius.circular(AD.rBadge),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text('Archived', style: ADText.statCaption(c: AD.textSecondary)),
        ),
    ];
    if (icons.isEmpty) return null;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      for (int i = 0; i < icons.length; i++) ...[if (i > 0) const SizedBox(width: 6), icons[i]],
    ]);
  }
}
