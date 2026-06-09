import 'dart:convert';

import 'package:flutter/material.dart';

import '../../auth/clerk_client.dart';
import '../../core/avatar.dart';
import '../../core/analytics.dart';
import '../../core/config.dart';
import '../../core/chat_state.dart';
import '../../core/device_contacts.dart';
import '../../core/filter_store.dart';
import '../../core/group_store.dart';
import '../../core/profile_store.dart';
import '../../core/status_store.dart';
import '../../core/theme.dart';
import '../../core/onboarding_store.dart';
import '../../core/admin_tools.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import '../../nostr/presence.dart';
import '../../push/push_service.dart';
import '../../shell/ava_sidebar.dart';
import '../communities/communities_tab.dart';
import '../status/status_screen.dart';
import 'add_contact_sheet.dart';
import 'calls_screen.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';
import 'new_group_screen.dart';
import 'search_screen.dart';

/// AvaTok home — chat + calls list (the AvaChat "ChatList" design).
class ChatListScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  final void Function(String dest)? onSwitchApp;
  const ChatListScreen({super.key, required this.clerk, required this.onSignOut, this.onSwitchApp});
  @override
  State<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends State<ChatListScreen> with WidgetsBindingObserver {
  final _store = IdentityStore();
  final _contactsStore = ContactsStore();
  final _groupStore = GroupStore();
  Identity? _id;
  List<Contact> _contacts = [];
  List<Group> _groups = [];
  NostrClient? _inbox;
  int _tab = 0; // 0 = Chats, 1 = Updates, 2 = Communities, 3 = Calls

  // Unread badges + chat flags + status.
  final _readStore = ReadStateStore();
  final _flagsStore = ChatFlagsStore();
  final _statusStore = StatusStore();
  Map<String, int> _lastRead = {};
  final Map<String, int> _unread = {};
  final Set<String> _seenInbox = {};
  final Map<String, int> _deliveredAckHW = {}; // peerHex → newest msg ts I've sent a delivered receipt for
  Map<String, Set<String>> _flags = {'blocked': {}, 'archived': {}, 'muted': {}, 'pinned': {}};
  int _statusCount = 0;
  bool _showArchived = false;
  Map<String, String> _drafts = {};
  final _previewStore = ChatPreviewStore();
  Map<String, ({String text, int ts, bool me})> _previews = {};
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  Set<String> _enabledApps = {};
  AccountKind _accountKind = AccountKind.personal;

  // Chat-list filter chips: 'all' | 'fav' | 'unread' | 'groups' | 'c:<keyword>'.
  String _filter = 'all';
  final _filterStore = FilterStore();
  List<ChatFilter> _customFilters = [];
  String? _clerkName; // real name from Clerk → drawer header

  String _keyOf(Chat c) =>
      c.gid != null ? 'g:${c.gid}' : '1:${NostrKeys.npubToHex(c.seed) ?? c.seed}';

  /// Chat-list timestamp: HH:mm today, 'Yesterday', else d/m.
  String _fmtListTime(int epochSecs) {
    final now = DateTime.now();
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    final today = DateTime(now.year, now.month, now.day);
    final that = DateTime(d.year, d.month, d.day);
    final days = today.difference(that).inDays;
    if (days <= 0) return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    if (days == 1) return 'Yesterday';
    return '${d.day}/${d.month}';
  }

  void _openChat(Chat c) {
    final k = _keyOf(c);
    setState(() => _unread.remove(k));
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: c)))
        .then((_) async {
      // Refresh read-state AND the last-message preview so the row reflects what
      // was just said in the thread we returned from.
      final read = await _readStore.load();
      final previews = await _previewStore.load();
      if (mounted) setState(() { _lastRead = read; _previews = previews; });
    });
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
        if (c.gid == null)
          ListTile(leading: const Icon(Icons.person_remove_outlined, color: AvaColors.danger),
              title: const Text('Remove contact', style: TextStyle(color: AvaColors.danger)),
              onTap: () { Navigator.pop(ctx); _removeContact(c); }),
      ])),
    );
  }

  Future<void> _removeContact(Chat c) async {
    final list = await _contactsStore.remove(c.seed); // Contact.seed == npub
    if (mounted) setState(() => _contacts = list);
  }

  Future<void> _toggleFlag(String flag, String key) async {
    await _flagsStore.toggle(flag, key);
    final flags = await _flagsStore.load();
    if (mounted) setState(() => _flags = flags);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    PushService.clearMessageBadge(); // landing on the inbox clears the unread badge
    _bootstrap();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Coming back to the foreground: a suspended app's relay socket was likely
      // torn down by the OS — reconnect immediately (don't wait out the backoff)
      // so live delivery resumes at once, and clear the unread badge.
      _inbox?.ensureConnected();
      PushService.clearMessageBadge();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
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
    final drafts = await DraftStore().load();
    final previews = await _previewStore.load();
    final enabled = await OnboardingStore().enabledApps();
    final kind = await AccountKindStore().load();
    final customFilters = await _filterStore.load();
    if (mounted) {
      setState(() {
        _id = id; _contacts = contacts; _groups = groups;
        _lastRead = lastRead; _flags = flags; _statusCount = status.length; _drafts = drafts;
        _previews = previews;
        _enabledApps = enabled; _accountKind = kind; _customFilters = customFilters;
      });
    }
    // Backfill profile photos for contacts saved before avatars existed — silent.
    _contactsStore.refreshMissingAvatars().then((list) {
      if (mounted) setState(() => _contacts = list);
    });
    // Sync the phone address book to our backend (per-user storage, reused by
    // AvaContacts) and resolve who's already on AvaTok — best-effort, silent.
    DeviceContactsService.syncAndMatch(id.npub);
    // Register this device for incoming-call wake pushes (npub hashed at rest).
    Analytics.identify(id.npub); // attribute diagnostics/events to this npub every app open
    await PushService.registerToken(id.npub);
    // Email is the human-facing id: publish email → npub so others find me by email.
    try {
      final cu = await widget.clerk.currentUser();
      final prof = await ProfileStore().load();
      if (cu != null && cu.label.isNotEmpty && mounted) setState(() => _clerkName = cu.label);
      if (cu?.email != null && cu!.email!.isNotEmpty) {
        await Directory.registerProfile(
            npub: id.npub, email: cu.email!, name: cu.label, phone: prof.phone);
      }
    } catch (_) {/* not signed in / offline */}
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
        } else if (t == 'receipt') {
          // A peer's delivery/read receipt for one of MY messages — persist it
          // globally so the ticks are right even if this thread is closed.
          if (u.senderPub != id.pubHex) {
            final rts = (env['ts'] as num?)?.toInt() ?? 0;
            final read = (env['status'] ?? '').toString() == 'read';
            if (rts > 0) ReceiptStore().bump('1:${u.senderPub}', delivered: read ? 0 : rts, read: read ? rts : 0);
          }
        } else if (t == 'text' || t == 'media' || t == 'gtext' || t == 'gmedia') {
          if (u.senderPub == id.pubHex) return; // my own message
          final key = env['gid'] != null ? 'g:${env['gid']}' : '1:${u.senderPub}';
          if (_flags['blocked']!.contains(key)) return;
          // Durable, gift-wrapped DELIVERED receipt — fires from the global inbox
          // so it works with no thread open, and (unlike the ephemeral presence
          // one) reaches the sender even if they were offline. One per peer per
          // session high-water, so history replays don't spam receipts.
          if (env['gid'] == null && (_deliveredAckHW[u.senderPub] ?? 0) < u.createdAt) {
            _deliveredAckHW[u.senderPub] = u.createdAt;
            try {
              final (g, _) = Nip17.wrapTo(
                  senderPriv: id.privHex, senderPub: id.pubHex, recipientPub: u.senderPub,
                  payload: jsonEncode({'t': 'receipt', 'status': 'delivered', 'ts': u.createdAt}));
              _inbox?.publish(g);
            } catch (_) {}
          }
          if (u.createdAt > (_lastRead[key] ?? 0) && mounted) {
            setState(() => _unread[key] = (_unread[key] ?? 0) + 1);
          }
          // Surface the message in the chat list even when its thread isn't open:
          // record the preview (drives the subtitle + recency order) and, for a
          // 1:1 from someone not yet in contacts, materialise a chat row so the
          // message can't silently vanish ("No chats yet" despite a delivery).
          // Skip stale history replays we already reflect to avoid storage churn.
          if (u.createdAt >= (_previews[key]?.ts ?? 0)) {
            _previewStore.record(key, _previewFor(env), u.createdAt, false).then((_) {
              if (mounted) _previewStore.load().then((p) { if (mounted) setState(() => _previews = p); });
            });
          }
          if (env['gid'] == null) _ensureContact(NostrKeys.npub(u.senderPub));
          // Send a delivered receipt for recent 1:1 messages (not history replays).
          final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          if (env['gid'] == null && u.createdAt > nowSec - 300) {
            final pres = PresenceChannel(PresenceChannel.roomFor1on1(id.pubHex, u.senderPub), 'inbox')..connect();
            pres.sendDelivered(u.createdAt);
            Future.delayed(const Duration(milliseconds: 900), pres.dispose);
          }
        }
      } catch (_) {/* ignore */}
    });
    _inbox!.subscribe('inbox', [
      {'kinds': [1059], '#p': [id.pubHex], 'limit': 200},
    ]);
  }

  /// A short, content-free-ish preview line for an incoming message envelope.
  String _previewFor(Map env) {
    final t = env['t'];
    if (t == 'text' || t == 'gtext') return (env['body'] ?? '').toString();
    if (t == 'media' || t == 'gmedia') {
      switch ((env['kind'] ?? '').toString()) {
        case 'image': return '📷 Photo';
        case 'video': return '🎬 Video';
        case 'audio': return '🎙️ Voice message';
        default: return '📎 ${env['name'] ?? 'File'}';
      }
    }
    return 'New message';
  }

  /// Make sure a 1:1 sender has a chat row. Adds a lightweight placeholder
  /// immediately (so the message appears at once), then enriches name/avatar
  /// from the directory in the background. No-op if already a contact / me.
  final Set<String> _autoAdding = {}; // npubs currently being auto-added (dedupe)
  Future<void> _ensureContact(String npub) async {
    if (npub.isEmpty || npub == _id?.npub) return;
    if (_contacts.any((c) => c.npub == npub) || !_autoAdding.add(npub)) return;
    final placeholder = Contact(
        npub: npub,
        name: npub.length > 14 ? '${npub.substring(0, 10)}…${npub.substring(npub.length - 4)}' : npub);
    var list = await _contactsStore.add(placeholder);
    if (mounted) setState(() => _contacts = list);
    try {
      final resolved = await Directory.resolve(npub);
      if (resolved != null && resolved.npub == npub) {
        list = await _contactsStore.add(resolved); // de-dupes on npub
        if (mounted) setState(() => _contacts = list);
      }
    } catch (_) {/* placeholder stands */}
  }

  Future<void> _openAddContact() async {
    final c = await showAddContactSheet(context);
    if (c == null || !mounted) return;
    // Don't let someone add their own account (e.g. their other email).
    if (c.npub.isEmpty || c.npub == _id?.npub) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("That's your own account — you can't add yourself")));
      return;
    }
    final list = await _contactsStore.add(c);
    if (mounted) {
      setState(() => _contacts = list);
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Added ${c.name.isNotEmpty ? c.name : c.subtitle}')));
    }
  }

  Future<void> _openNewGroup() async {
    await Navigator.push(context,
        MaterialPageRoute(builder: (_) => NewGroupScreen(contacts: _contacts)));
  }

  /// New-chat menu (the green FAB): message, group, community, or invite.
  void _openNewChatMenu() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(
          leading: const Icon(Icons.person_add_alt_1, color: AvaColors.brand),
          title: const Text('New chat'),
          subtitle: const Text('Add someone by email, phone or @handle'),
          onTap: () { Navigator.pop(ctx); _openAddContact(); }),
        ListTile(
          leading: const Icon(Icons.groups_outlined, color: AvaColors.brand),
          title: const Text('New group'),
          onTap: () { Navigator.pop(ctx); _openNewGroup(); }),
        ListTile(
          leading: const Icon(Icons.diversity_3, color: AvaColors.brand),
          title: const Text('New community'),
          onTap: () { Navigator.pop(ctx); setState(() => _tab = 2); }),
        ListTile(
          leading: const Icon(Icons.share_outlined, color: Color(0xFF25D366)),
          title: const Text('Invite friends to AvaTok'),
          subtitle: const Text('Find people from your phone contacts'),
          onTap: () { Navigator.pop(ctx); _openSearch(); }),
        const SizedBox(height: 8),
      ])),
    );
  }

  void _openSearch() {
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => SearchScreen(identity: _id, contacts: _contacts, groups: _groups)))
        .then((_) => _flagsStore.load().then((f) { if (mounted) setState(() => _flags = f); }));
  }

  /// Create a custom filter chip (the "+" chip).
  Future<void> _addCustomFilter() async {
    final nameCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New filter'),
        content: TextField(controller: nameCtrl, autofocus: true,
            decoration: const InputDecoration(hintText: 'Keyword (matches chat names)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
        ],
      ),
    );
    if (ok != true) return;
    final kw = nameCtrl.text.trim();
    if (kw.isEmpty) return;
    final list = await _filterStore.add(ChatFilter(name: kw, query: kw.toLowerCase()));
    if (mounted) setState(() { _customFilters = list; _filter = 'c:$kw'; });
  }

  @override
  Widget build(BuildContext context) {
    final blocked = _flags['blocked']!, archived = _flags['archived']!, pinned = _flags['pinned']!;
    String draftOr(String k, String fallback) =>
        (_drafts[k] ?? '').isNotEmpty ? '✏️ ${_drafts[k]}' : fallback;
    // Real last message wins over the static subtitle; a draft still trumps both.
    String previewOr(String k, String fallback) {
      final pv = _previews[k];
      if (pv != null && pv.text.isNotEmpty) return pv.me ? 'You: ${pv.text}' : pv.text;
      return fallback;
    }
    String timeOf(String k) {
      final pv = _previews[k];
      return pv != null && pv.ts > 0 ? _fmtListTime(pv.ts) : '';
    }
    final groupChats = _groups
        .where((g) => _showArchived || !archived.contains('g:${g.id}'))
        .map((g) => Chat(
            name: g.name, seed: 'group-${g.id}',
            last: draftOr('g:${g.id}', previewOr('g:${g.id}', 'Group · ${g.members.length} members')),
            time: timeOf('g:${g.id}'),
            group: true, members: g.members.length, gid: g.id,
            unread: _unread['g:${g.id}'] ?? 0))
        .toList();
    final contactChats = _contacts.where((c) {
      final k = '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
      return !blocked.contains(k) && (_showArchived || !archived.contains(k));
    }).map((c) {
      final k = '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
      return Chat(name: c.name, seed: c.seed, avatarUrl: c.avatarUrl,
          last: draftOr(k, previewOr(k, c.subtitle.isNotEmpty ? c.subtitle : 'Say hi 👋')),
          time: timeOf(k), unread: _unread[k] ?? 0);
    }).toList();
    final realRows = [...groupChats, ...contactChats];
    // Pinned chats first, then most-recently-active by last-message time.
    int tsOf(Chat c) => _previews[_keyOf(c)]?.ts ?? 0;
    realRows.sort((a, b) {
      final pa = pinned.contains(_keyOf(a)) ? 1 : 0;
      final pb = pinned.contains(_keyOf(b)) ? 1 : 0;
      if (pa != pb) return pb - pa;
      return tsOf(b).compareTo(tsOf(a));
    });
    final archivedCount = archived.length;

    // Apply the active filter chip.
    bool keep(Chat c) {
      switch (_filter) {
        case 'fav':
          return pinned.contains(_keyOf(c));
        case 'unread':
          return c.unread > 0;
        case 'groups':
          return c.gid != null;
        case 'all':
          return true;
        default:
          if (_filter.startsWith('c:')) {
            return c.name.toLowerCase().contains(_filter.substring(2).toLowerCase());
          }
          return true;
      }
    }
    final rows = realRows.where(keep).toList();

    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: Colors.white,
      drawer: AvaSidebar(
        enabledApps: _enabledApps,
        accountKind: _accountKind,
        name: (_clerkName?.isNotEmpty ?? false) ? _clerkName! : (_id?.shortNpub ?? 'Account'),
        seed: _id?.npub ?? 'avatok',
        current: 'avatok',
        onSelect: (d) {
          Navigator.pop(context); // close drawer
          if (d == 'avatok') return; // already here
          widget.onSwitchApp?.call(d);
        },
        onSignOut: () { Navigator.pop(context); widget.onSignOut(); },
      ),
      floatingActionButton: _tab == 0
          ? FloatingActionButton(
              backgroundColor: AvaColors.brand,
              onPressed: _openNewChatMenu,
              child: const Icon(Icons.edit_square, color: Colors.white),
            )
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: 'Chats'),
          NavigationDestination(
              icon: Badge(
                isLabelVisible: _statusCount > 0,
                child: const Icon(Icons.donut_large_outlined),
              ),
              selectedIcon: const Icon(Icons.donut_large), label: 'Updates'),
          const NavigationDestination(
              icon: Icon(Icons.groups_2_outlined), selectedIcon: Icon(Icons.groups_2), label: 'Communities'),
          const NavigationDestination(
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
                    onTap: () => _scaffoldKey.currentState?.openDrawer(),
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
                  _circleBtn(Icons.search, _openSearch),
                  const SizedBox(width: 8),
                  _circleBtn(Icons.person_add_alt_1, _openAddContact),
                ],
              ),
            ),
            // tappable search bar → full search screen
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: GestureDetector(
                onTap: _openSearch,
                child: Container(
                  height: 42,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(
                      color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
                  child: const Row(children: [
                    Icon(Icons.search, size: 18, color: Color(0xFF9AA1AC)),
                    SizedBox(width: 8),
                    Text('Search by name, email or phone',
                        style: TextStyle(color: Color(0xFF9AA1AC), fontSize: 14)),
                  ]),
                ),
              ),
            ),
            // filter chips
            _filterChips(),
            // status / active-now strip
            SizedBox(
              height: 92,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: [
                  _statusItem(),
                  _activeAdd(),
                  for (final c in contactChats) _activeAvatar(context, c),
                ],
              ),
            ),
            // chats
            Expanded(
              child: ListView(
                children: [
                  if (archivedCount > 0)
                    InkWell(
                      onTap: () => setState(() => _showArchived = !_showArchived),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                        decoration: const BoxDecoration(
                            border: Border(bottom: BorderSide(color: AvaColors.line))),
                        child: Row(children: [
                          const Icon(Icons.archive_outlined, size: 22, color: AvaColors.sub),
                          const SizedBox(width: 16),
                          const Text('Archived',
                              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                          const Spacer(),
                          Text(_showArchived ? 'Hide' : '$archivedCount',
                              style: const TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w700)),
                        ]),
                      ),
                    ),
                  if (rows.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 60),
                      child: Center(child: Text(
                          _filter == 'all' ? 'No chats yet — tap ✎ to start one' : 'Nothing here',
                          style: const TextStyle(color: AvaColors.sub))),
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
        StatusScreen(identity: _id, contacts: _contacts),
        CommunitiesTab(identity: _id, contacts: _contacts),
        const CallsScreen(),
      ]),
    );
  }

  Widget _filterChips() {
    Widget chip(String label, String value) {
      final on = _filter == value;
      return Padding(
        padding: const EdgeInsets.only(right: 8),
        child: GestureDetector(
          onLongPress: value.startsWith('c:')
              ? () async {
                  final list = await _filterStore.remove(value.substring(2));
                  if (mounted) setState(() { _customFilters = list; if (_filter == value) _filter = 'all'; });
                }
              : null,
          child: ChoiceChip(
            label: Text(label),
            selected: on,
            showCheckmark: false,
            selectedColor: AvaColors.brand,
            backgroundColor: AvaColors.soft,
            side: BorderSide.none,
            labelStyle: TextStyle(color: on ? Colors.white : AvaColors.ink, fontWeight: FontWeight.w700, fontSize: 13),
            onSelected: (_) => setState(() => _filter = value),
          ),
        ),
      );
    }

    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        children: [
          chip('All', 'all'),
          chip('Favourites', 'fav'),
          chip('Unread', 'unread'),
          chip('Groups', 'groups'),
          for (final f in _customFilters) chip(f.name, 'c:${f.name}'),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: ActionChip(
              label: const Icon(Icons.add, size: 18, color: AvaColors.ink),
              backgroundColor: AvaColors.soft,
              side: BorderSide.none,
              onPressed: _addCustomFilter,
            ),
          ),
        ],
      ),
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
                Avatar(seed: c.seed, name: c.name, size: 56, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
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
              Avatar(seed: chat.seed, name: chat.name, size: 54, avatarUrl: chat.avatarUrl.isEmpty ? null : chat.avatarUrl),
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
