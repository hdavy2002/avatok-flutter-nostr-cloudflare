import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../../auth/clerk_client.dart';
import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/chat_state.dart';
import '../../core/group_store.dart';
import '../../core/status_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import '../../push/push_service.dart';
import '../status/status_screen.dart';
import '../avalive/live_screen.dart';
import 'add_contact_sheet.dart';
import 'call_screen.dart';
import 'calls_screen.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';
import 'new_group_screen.dart';

/// AvaTok home — chat + calls list (the AvaChat "ChatList" design).
class ChatListScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  const ChatListScreen({super.key, required this.clerk, required this.onSignOut});
  @override
  State<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends State<ChatListScreen> {
  final _store = IdentityStore();
  final _contactsStore = ContactsStore();
  final _groupStore = GroupStore();
  Identity? _id;
  List<Contact> _contacts = [];
  List<Group> _groups = [];
  NostrClient? _inbox;
  int _tab = 0; // 0 = Chats, 1 = Calls

  // Unread badges + chat flags + status.
  final _readStore = ReadStateStore();
  final _flagsStore = ChatFlagsStore();
  final _statusStore = StatusStore();
  Map<String, int> _lastRead = {};
  final Map<String, int> _unread = {};
  final Set<String> _seenInbox = {};
  Map<String, Set<String>> _flags = {'blocked': {}, 'archived': {}, 'muted': {}, 'pinned': {}};
  int _statusCount = 0;
  bool _showArchived = false;

  String _keyOf(Chat c) =>
      c.gid != null ? 'g:${c.gid}' : '1:${NostrKeys.npubToHex(c.seed) ?? c.seed}';

  void _openChat(Chat c) {
    final k = _keyOf(c);
    setState(() => _unread.remove(k));
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: c)))
        .then((_) => _readStore.load().then((m) { if (mounted) setState(() => _lastRead = m); }));
  }

  void _chatRowFlags(Chat c) {
    final k = _keyOf(c);
    bool has(String f) => _flags[f]!.contains(k);
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(leading: Icon(has('pinned') ? Icons.push_pin : Icons.push_pin_outlined, color: AvaColors.brand),
            title: Text(has('pinned') ? 'Unpin' : 'Pin to top'),
            onTap: () { Navigator.pop(ctx); _toggleFlag('pinned', k); }),
        ListTile(leading: Icon(has('muted') ? Icons.notifications_off : Icons.notifications_outlined, color: AvaColors.ink),
            title: Text(has('muted') ? 'Unmute' : 'Mute'),
            onTap: () { Navigator.pop(ctx); _toggleFlag('muted', k); }),
        ListTile(leading: const Icon(Icons.archive_outlined, color: AvaColors.ink),
            title: Text(has('archived') ? 'Unarchive' : 'Archive'),
            onTap: () { Navigator.pop(ctx); _toggleFlag('archived', k); }),
        if (c.gid == null)
          ListTile(leading: const Icon(Icons.block, color: AvaColors.danger),
              title: Text(has('blocked') ? 'Unblock' : 'Block', style: const TextStyle(color: AvaColors.danger)),
              onTap: () { Navigator.pop(ctx); _toggleFlag('blocked', k); }),
      ])),
    );
  }

  Future<void> _toggleFlag(String flag, String key) async {
    await _flagsStore.toggle(flag, key);
    final flags = await _flagsStore.load();
    if (mounted) setState(() => _flags = flags);
  }

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _inbox?.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    var id = await _store.load();
    id ??= await _store.createAndStore();
    final contacts = await _contactsStore.load();
    final groups = await _groupStore.load();
    final lastRead = await _readStore.load();
    final flags = await _flagsStore.load();
    final status = await _statusStore.load();
    if (mounted) {
      setState(() {
        _id = id; _contacts = contacts; _groups = groups;
        _lastRead = lastRead; _flags = flags; _statusCount = status.length;
      });
    }
    // Register this device for incoming-call wake pushes (npub hashed at rest).
    await PushService.registerToken(id.npub);
    _startInbox(id);
    // Directory listing is opt-in: we only publish a profile when the user
    // sets a @handle (privacy default — don't auto-index every npub).
  }

  /// Global inbox: receive group invites (ginfo) even when no thread is open.
  void _startInbox(Identity id) {
    _inbox = NostrClient(kNostrRelayUrl)..connect();
    _inbox!.events.listen((rec) {
      final (_, ev) = rec;
      if (ev.kind != 1059) return;
      final u = Nip17.unwrap(id.privHex, ev);
      if (u == null || _seenInbox.contains(u.rumorId)) return;
      _seenInbox.add(u.rumorId);
      try {
        final env = jsonDecode(u.payload);
        if (env is! Map) return;
        final t = env['t'];
        if (t == 'ginfo') {
          final g = Group(
            id: env['gid'].toString(),
            name: (env['name'] ?? 'Group').toString(),
            members: ((env['members'] as List?) ?? []).map((e) => e.toString()).toList(),
            admins: ((env['admins'] as List?) ?? []).map((e) => e.toString()).toList(),
          );
          _groupStore.upsert(g).then((list) { if (mounted) setState(() => _groups = list); });
        } else if (t == 'gkick' && u.senderPub != id.pubHex) {
          _groupStore.remove(env['gid'].toString())
              .then((_) => _groupStore.load())
              .then((list) { if (mounted) setState(() => _groups = list); });
        } else if (t == 'status' && u.senderPub != id.pubHex) {
          final post = StatusPost(
            id: u.rumorId, authorPub: u.senderPub,
            authorName: (env['who'] ?? 'Someone').toString(),
            kind: (env['kind'] ?? 'text').toString(),
            text: env['text']?.toString(),
            media: (env['media'] as Map?)?.cast<String, dynamic>(),
            ts: u.createdAt,
          );
          _statusStore.add(post).then((list) { if (mounted) setState(() => _statusCount = list.length); });
        } else if (t == 'text' || t == 'media' || t == 'gtext' || t == 'gmedia') {
          if (u.senderPub == id.pubHex) return; // my own message
          final key = env['gid'] != null ? 'g:${env['gid']}' : '1:${u.senderPub}';
          if (_flags['blocked']!.contains(key)) return;
          if (u.createdAt > (_lastRead[key] ?? 0) && mounted) {
            setState(() => _unread[key] = (_unread[key] ?? 0) + 1);
          }
        }
      } catch (_) {/* ignore */}
    });
    _inbox!.subscribe('inbox', [
      {'kinds': [1059], '#p': [id.pubHex], 'limit': 200},
    ]);
  }

  Future<void> _openAddContact() async {
    final c = await showAddContactSheet(context);
    if (c == null) return;
    final list = await _contactsStore.add(c);
    if (mounted) setState(() => _contacts = list);
  }

  Future<void> _openNewGroup() async {
    await Navigator.push(context,
        MaterialPageRoute(builder: (_) => NewGroupScreen(contacts: _contacts)));
  }

  Future<void> _ringDialog() async {
    final npubCtrl = TextEditingController();
    bool video = false;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) => AlertDialog(
          title: const Text('Ring a device'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: npubCtrl,
                decoration: const InputDecoration(hintText: 'Recipient npub'),
              ),
              const SizedBox(height: 12),
              Row(children: [
                const Text('Video'),
                const Spacer(),
                Switch(value: video, activeColor: AvaColors.brand,
                    onChanged: (v) => setD(() => video = v)),
              ]),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                _ring(npubCtrl.text.trim(), video);
              },
              child: const Text('Call'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _ring(String npub, bool video) async {
    if (npub.isEmpty) return;
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    // Wake the callee's phone.
    try {
      final res = await http.post(Uri.parse(kCallUrl),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'to': npub,
            'from': _id?.npub ?? '',
            'fromName': 'AvaTOK',
            'callId': room,
            'kind': video ? 'video' : 'audio',
          }));
      if (res.statusCode == 404 && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('That npub has no registered devices')));
      }
    } catch (_) {}
    if (!mounted) return;
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => CallScreen(room: room, title: 'Calling…', seed: npub, video: video)));
  }

  void _openMenu() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Your identity', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 12),
            const Text('Nostr key (npub)',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
            const SizedBox(height: 4),
            SelectableText(_id?.npub ?? 'generating…',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () {
                  Navigator.pop(ctx);
                  _ringDialog();
                },
                icon: const Icon(Icons.phone_in_talk),
                label: const Text('Ring a device (by npub)'),
              ),
            ),
            const Divider(height: 28),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                    foregroundColor: AvaColors.danger,
                    side: const BorderSide(color: Color(0xFFE0E2E6)),
                    padding: const EdgeInsets.symmetric(vertical: 14)),
                onPressed: () async {
                  Navigator.pop(ctx);
                  await widget.clerk.signOut();
                  widget.onSignOut();
                },
                icon: const Icon(Icons.logout),
                label: const Text('Sign out'),
              ),
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final blocked = _flags['blocked']!, archived = _flags['archived']!, pinned = _flags['pinned']!;
    final groupChats = _groups
        .where((g) => _showArchived || !archived.contains('g:${g.id}'))
        .map((g) => Chat(
            name: g.name, seed: 'group-${g.id}',
            last: 'Group · ${g.members.length} members', time: '',
            group: true, members: g.members.length, gid: g.id,
            unread: _unread['g:${g.id}'] ?? 0))
        .toList();
    final contactChats = _contacts.where((c) {
      final k = '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
      return !blocked.contains(k) && (_showArchived || !archived.contains(k));
    }).map((c) {
      final k = '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
      return Chat(name: c.name, seed: c.seed, last: c.atHandle.isNotEmpty ? c.atHandle : 'Say hi 👋',
          time: '', unread: _unread[k] ?? 0);
    }).toList();
    final realRows = [...groupChats, ...contactChats];
    realRows.sort((a, b) => (pinned.contains(_keyOf(a)) ? 0 : 1) - (pinned.contains(_keyOf(b)) ? 0 : 1));
    final archivedCount = archived.length;
    final rows = [...realRows, ...kChats];
    final online = kChats.where((c) => c.online).toList();
    return Scaffold(
      backgroundColor: Colors.white,
      floatingActionButton: _tab == 0
          ? FloatingActionButton(
              backgroundColor: AvaColors.danger,
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const LiveScreen())),
              child: const Icon(Icons.sensors, color: Colors.white),
            )
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: 'Chats'),
          NavigationDestination(
              icon: Icon(Icons.call_outlined), selectedIcon: Icon(Icons.call), label: 'Calls'),
        ],
      ),
      body: IndexedStack(index: _tab, children: [
        SafeArea(
        bottom: false,
        child: Column(
          children: [
            // header
            Container(
              height: 56,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: const BoxDecoration(
                  border: Border(bottom: BorderSide(color: AvaColors.line))),
              child: Row(
                children: [
                  GestureDetector(
                    onTap: _openMenu,
                    child: const Icon(Icons.menu, size: 24)),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text('AvaTOK',
                        style: TextStyle(
                            color: AvaColors.brand,
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            letterSpacing: -0.5)),
                  ),
                  _circleBtn(Icons.person_add_alt_1, _openAddContact),
                  const SizedBox(width: 8),
                  _circleBtn(Icons.edit_outlined, _openNewGroup),
                ],
              ),
            ),
            // search
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Container(
                height: 42,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                    color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
                child: const Row(children: [
                  Icon(Icons.search, size: 18, color: Color(0xFF9AA1AC)),
                  SizedBox(width: 8),
                  Text('Search people on AvaTOK',
                      style: TextStyle(color: Color(0xFF9AA1AC), fontSize: 14)),
                ]),
              ),
            ),
            // active now
            SizedBox(
              height: 92,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: [
                  _statusItem(),
                  _activeAdd(),
                  for (final c in contactChats) _activeAvatar(context, c),
                  for (final c in online) _activeAvatar(context, c),
                ],
              ),
            ),
            // chats
            Expanded(
              child: ListView(
                children: [
                  if (archivedCount > 0)
                    ListTile(
                      leading: const Icon(Icons.archive_outlined, color: AvaColors.sub),
                      title: Text(_showArchived ? 'Hide archived' : 'Archived ($archivedCount)',
                          style: const TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w600)),
                      onTap: () => setState(() => _showArchived = !_showArchived),
                    ),
                  for (final c in rows)
                    _ChatRow(
                      chat: c,
                      pinned: pinned.contains(_keyOf(c)),
                      muted: _flags['muted']!.contains(_keyOf(c)),
                      onTap: () => _openChat(c),
                      onLongPress: () => _chatRowFlags(c),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
        const CallsScreen(),
      ]),
    );
  }

  Widget _circleBtn(IconData i, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 36, height: 36,
          decoration: const BoxDecoration(color: AvaColors.soft, shape: BoxShape.circle),
          child: Icon(i, size: 18, color: AvaColors.ink),
        ),
      );

  Widget _statusItem() => Padding(
        padding: const EdgeInsets.only(right: 14),
        child: GestureDetector(
          onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => StatusScreen(identity: _id, contacts: _contacts)))
              .then((_) => _statusStore.load().then((l) { if (mounted) setState(() => _statusCount = l.length); })),
          child: Column(children: [
            Stack(children: [
              Avatar(seed: _id?.npub ?? 'me', name: 'You', size: 56),
              if (_statusCount > 0)
                Positioned(right: 0, top: 0, child: Container(width: 14, height: 14,
                    decoration: BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 2)))),
              const Positioned(right: 0, bottom: 0, child: Icon(Icons.add_circle, color: AvaColors.brand, size: 18)),
            ]),
            const SizedBox(height: 6),
            const Text('Status', style: TextStyle(fontSize: 11, color: AvaColors.sub, fontWeight: FontWeight.w600)),
          ]),
        ),
      );

  Widget _activeAdd() => GestureDetector(
        onTap: _openAddContact,
        child: Padding(
        padding: const EdgeInsets.only(right: 14),
        child: Column(
          children: [
            Container(
              width: 56, height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: AvaColors.brand, width: 2, style: BorderStyle.solid),
              ),
              child: const Icon(Icons.add, color: AvaColors.brand, size: 24),
            ),
            const SizedBox(height: 6),
            const Text('Add', style: TextStyle(fontSize: 11, color: AvaColors.sub, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
      );

  Widget _activeAvatar(BuildContext context, Chat c) => Padding(
        padding: const EdgeInsets.only(right: 14),
        child: GestureDetector(
          onTap: () => _openChat(c),
          child: Column(
            children: [
              Stack(children: [
                Avatar(seed: c.seed, name: c.name, size: 56),
                Positioned(
                  bottom: 2, right: 2,
                  child: Container(
                    width: 14, height: 14,
                    decoration: BoxDecoration(
                        color: AvaColors.success, shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 2)),
                  ),
                ),
              ]),
              const SizedBox(height: 6),
              SizedBox(
                width: 60,
                child: Text(c.name.split(' ').first,
                    maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 11, color: AvaColors.sub, fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      );
}

class _ChatRow extends StatelessWidget {
  final Chat chat;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool pinned;
  final bool muted;
  const _ChatRow({required this.chat, this.onTap, this.onLongPress, this.pinned = false, this.muted = false});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap ?? () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat))),
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Stack(children: [
              Avatar(seed: chat.seed, name: chat.name, size: 54),
              if (chat.online)
                Positioned(
                  bottom: 1, right: 1,
                  child: Container(
                    width: 13, height: 13,
                    decoration: BoxDecoration(
                        color: AvaColors.success, shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 2)),
                  ),
                ),
            ]),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Flexible(child: Text(chat.name,
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5))),
                    if (muted) const Padding(padding: EdgeInsets.only(left: 4),
                        child: Icon(Icons.notifications_off, size: 13, color: AvaColors.sub)),
                    if (pinned) const Padding(padding: EdgeInsets.only(left: 4),
                        child: Icon(Icons.push_pin, size: 13, color: AvaColors.sub)),
                  ]),
                  const SizedBox(height: 3),
                  Text(chat.last,
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          color: chat.unread > 0 ? AvaColors.ink : AvaColors.sub,
                          fontSize: 13.5,
                          fontWeight: chat.unread > 0 ? FontWeight.w600 : FontWeight.w400)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(chat.time,
                    style: TextStyle(
                        fontSize: 11.5,
                        color: chat.unread > 0 ? AvaColors.brand : AvaColors.sub,
                        fontWeight: chat.unread > 0 ? FontWeight.w700 : FontWeight.w400)),
                const SizedBox(height: 6),
                if (chat.unread > 0)
                  Container(
                    padding: const EdgeInsets.all(6),
                    constraints: const BoxConstraints(minWidth: 20),
                    decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle),
                    child: Text('${chat.unread}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                  )
                else
                  const SizedBox(height: 20),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
