import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/account_gate.dart';
import '../../core/avatar.dart';
import '../../core/avatar_viewer.dart';
import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/api_auth.dart';
import '../../core/chat_state.dart';
import '../../core/chat_list_snapshot.dart';
import '../../core/db.dart';
import '../../core/device_contacts.dart';
import '../../core/filter_store.dart';
import '../../core/group_store.dart';
import '../../core/profile_store.dart';
import '../../core/status_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/onboarding_store.dart';
import '../../core/admin_tools.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../sync/group_api.dart';
import '../../sync/legacy_stubs.dart';
import '../../sync/sync_hub.dart';
import '../../sync/presence.dart';
import '../../push/push_service.dart';
import '../../shell/ava_sidebar.dart';
import '../ava_companion/companion_home.dart';
import '../../core/notifications_api.dart';
import '../notifications/notifications_screen.dart';
import 'groups_tab.dart';
import '../status/status_screen.dart';
import 'add_contact_sheet.dart';
import 'calls_screen.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';
import 'media.dart';
import 'new_group_screen.dart';
import 'search_screen.dart';
import 'unknown_caller.dart';
import '../avaphone/ava_phone_screen.dart';

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
  StreamSubscription? _inboxSub; // our listener on the shared client (cancel on dispose, don't kill the socket)
  int _tab = 0; // 0 = Chats, 1 = Updates, 2 = Groups, 3 = Calls
  int _notifUnread = 0;  // header bell badge (system + group-invite notifications)
  int _groupInvites = 0; // pending group invites → red count on the Groups footer icon

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
  // x-only hex pubkeys of contacts who currently have a live (unexpired) status,
  // so their avatar gets the green glowing ring.
  final Set<String> _statusAuthorHex = {};
  // My own latest live status → drives the header STATUS thumbnail + glow ring.
  bool _iHaveStatus = false;
  Map<String, dynamic>? _myStatusMedia; // envelope of my latest image status
  String _myStatusSig = '';             // memo key so the thumbnail future is built once
  Future<Uint8List>? _myStatusThumb;    // decrypted bytes for the header thumbnail
  bool _showArchived = false;
  Map<String, String> _drafts = {};
  final _previewStore = ChatPreviewStore();
  Map<String, ({String text, int ts, bool me})> _previews = {};

  // Cold start paints from a SINGLE indexed SQLite query over the persisted chat
  // -list projection (Db.chatsOnce) — instant on any phone, nothing pre-loaded
  // into memory (that wouldn't scale across many AvaVerse apps). Within a session
  // the tiny ChatListSnapshot makes navigate-away-and-back repaint synchronously.
  // _booted gates the "No chats yet" empty state so it only shows once a load is
  // done; _authoritativeLoaded guards the async projection paint from clobbering
  // the fresher store-backed data if it happens to resolve later.
  bool _booted = false;
  bool _authoritativeLoaded = false;
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  Set<String> _enabledApps = {};
  AccountKind _accountKind = AccountKind.personal;

  // Chat-list filter chips: 'all' | 'fav' | 'unread' | 'groups' | 'c:<keyword>'.
  String _filter = 'all';
  final _filterStore = FilterStore();
  List<ChatFilter> _customFilters = [];
  String? _clerkName; // real name from Clerk → drawer header

  String _keyOf(Chat c) {
    if (c.gid != null) return 'g:${c.gid}';
    // Unknown-number receptionist threads key by the caller's phone, NOT by an
    // npub (they have no AvaTOK account). Must match SyncHub's `g:recept_…` key.
    final tel = telPhone(c.seed);
    if (tel != null) return receptTelConvKey(_id?.uid ?? '', tel);
    return '1:${NostrKeys.npubToHex(c.seed) ?? c.seed}';
  }

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

  /// Recompute the status count + the set of authors with a live status (drives
  /// the green glowing ring). Call inside setState.
  void _setStatuses(List<StatusPost> list) {
    _statusCount = list.length;
    _statusAuthorHex
      ..clear()
      ..addAll(list.map((p) => p.authorPub).where((h) => h.isNotEmpty));
    // Find MY own live statuses (newest first). If the latest is an image, show
    // its thumbnail on the header STATUS avatar; otherwise just glow the ring.
    final myHex = _id?.pubHex;
    final mine = myHex == null
        ? const <StatusPost>[]
        : (list.where((p) => p.authorPub == myHex && !p.expired).toList()
          ..sort((a, b) => b.ts.compareTo(a.ts)));
    _iHaveStatus = mine.isNotEmpty;
    final imgs = mine.where((p) => p.kind == 'image' && p.media != null);
    _myStatusMedia = imgs.isEmpty ? null : imgs.first.media;
    // Only (re)build the decrypt future when the underlying media changes — this
    // keeps the thumbnail from re-fetching (and flickering) on every setState.
    final sig = _myStatusMedia == null ? '' : jsonEncode(_myStatusMedia);
    if (sig != _myStatusSig) {
      _myStatusSig = sig;
      _myStatusThumb = _myStatusMedia == null
          ? null
          : MediaService.downloadAndDecrypt(ChatMedia.fromEnvelope(_myStatusMedia!));
    }
  }

  /// True if [npub] (a contact's npub) currently has a live status.
  bool _hasStatus(String npub) {
    final hex = NostrKeys.npubToHex(npub);
    return hex != null && _statusAuthorHex.contains(hex);
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(
            leading: PhosphorIcon(
                PhosphorIcons.pushPin(has('pinned') ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                color: Zine.blueInk),
            title: Text(has('pinned') ? 'Unpin' : 'Pin to top', style: ZineText.value(size: 15)),
            onTap: () { Navigator.pop(ctx); _toggleFlag('pinned', k); }),
        ListTile(
            leading: PhosphorIcon(
                has('muted')
                    ? PhosphorIcons.bellSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.bell(PhosphorIconsStyle.bold),
                color: Zine.ink),
            title: Text(has('muted') ? 'Unmute' : 'Mute', style: ZineText.value(size: 15)),
            onTap: () { Navigator.pop(ctx); _toggleFlag('muted', k); }),
        ListTile(
            leading: PhosphorIcon(PhosphorIcons.archive(PhosphorIconsStyle.bold), color: Zine.ink),
            title: Text(has('archived') ? 'Unarchive' : 'Archive', style: ZineText.value(size: 15)),
            onTap: () { Navigator.pop(ctx); _toggleFlag('archived', k); }),
        if (c.gid == null)
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: Zine.coral),
              title: Text(has('blocked') ? 'Unblock' : 'Block', style: ZineText.value(size: 15, color: Zine.coral)),
              onTap: () { Navigator.pop(ctx); _toggleFlag('blocked', k); }),
        if (c.gid == null)
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.userMinus(PhosphorIconsStyle.bold), color: Zine.coral),
              title: Text('Remove contact', style: ZineText.value(size: 15, color: Zine.coral)),
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
    // Paint the last-known list immediately (no blank "No chats yet" flash when
    // returning to AvaTok); _bootstrap then refreshes from disk + relay.
    if (ChatListSnapshot.has) {
      _contacts = ChatListSnapshot.contacts;
      _groups = ChatListSnapshot.groups;
      _previews = ChatListSnapshot.previews;
      _lastRead = ChatListSnapshot.lastRead;
      if (ChatListSnapshot.flags.isNotEmpty) _flags = ChatListSnapshot.flags;
      _booted = true;
    } else {
      // True cold start (no in-session snapshot): paint from the local DB with
      // one query before the slower store reads in _bootstrap finish.
      _paintFromProjection();
    }
    _bootstrap();
    _loadNotifCounts();
  }

  /// Load the bell badge + pending group-invite count (Phase D). Best-effort —
  /// network failure just leaves the last-known counts.
  Future<void> _loadNotifCounts() async {
    try {
      final unread = await NotificationsApi.unreadCount();
      int invites = 0;
      try {
        final items = await NotificationsApi.list();
        invites = items.where((n) => n.type == 'group_invite' && !n.read).length;
      } catch (_) {}
      if (!mounted) return;
      setState(() { _notifUnread = unread; _groupInvites = invites; });
    } catch (_) {/* keep last-known counts */}
  }

  /// A small red count/dot badge overlaid on a footer/header icon.
  Widget _badged(Widget child, {int count = 0, bool dot = false}) {
    if (count <= 0 && !dot) return child;
    final label = count > 99 ? '99+' : '$count';
    return Stack(clipBehavior: Clip.none, children: [
      child,
      Positioned(
        right: -6, top: -4,
        child: Container(
          padding: dot ? const EdgeInsets.all(4) : const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
          constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
          decoration: BoxDecoration(
            color: Zine.coral,
            borderRadius: BorderRadius.circular(100),
            border: Border.all(color: Zine.paper2, width: 1.5),
          ),
          alignment: Alignment.center,
          child: dot ? null : Text(label,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 9.5, fontWeight: FontWeight.w800, height: 1.0)),
        ),
      ),
    ]);
  }

  /// Open the notification center (bell) and refresh counts on return.
  void _openNotifications() {
    Analytics.capture('notifications_opened', {'unread': _notifUnread, 'group_invites': _groupInvites});
    Navigator.push(context, MaterialPageRoute(builder: (_) => const NotificationsScreen()))
        .then((_) => _loadNotifCounts());
  }

  /// Cold-start fast path: read the persisted chat-list projection (ONE indexed
  /// query) and paint immediately. Reconstructs just enough of the in-memory maps
  /// for build() to render; _bootstrap then overwrites them with the
  /// authoritative store data and rewrites the projection.
  Future<void> _paintFromProjection() async {
    List<ChatRow> rows;
    try {
      rows = await Db.I.chatsOnce();
    } catch (_) {
      return; // no projection yet → _bootstrap will load + paint as usual
    }
    if (rows.isEmpty || _authoritativeLoaded || !mounted) return;
    final contacts = <Contact>[];
    final groups = <Group>[];
    final previews = <String, ({String text, int ts, bool me})>{};
    final unread = <String, int>{};
    final flags = {'blocked': <String>{}, 'archived': <String>{}, 'muted': <String>{}, 'pinned': <String>{}};
    for (final r in rows) {
      if (r.json.isEmpty) continue;
      try {
        final m = jsonDecode(r.json) as Map<String, dynamic>;
        final k = (m['k'] ?? '').toString();
        if (k.isEmpty) continue;
        final pv = (m['pv'] ?? '').toString();
        previews[k] = (text: pv, ts: (m['ts'] as num?)?.toInt() ?? 0, me: m['me'] == true);
        final u = (m['u'] as num?)?.toInt() ?? 0;
        if (u > 0) unread[k] = u;
        for (final f in ((m['f'] as List?) ?? const [])) {
          flags[f.toString()]?.add(k);
        }
        if (m['g'] == true) {
          groups.add(Group(
              id: (m['gid'] ?? '').toString(),
              name: (m['n'] ?? 'Group').toString(),
              members: List.filled((m['mc'] as num?)?.toInt() ?? 0, '')));
        } else {
          contacts.add(Contact(
              npub: (m['s'] ?? '').toString(),
              name: (m['n'] ?? '').toString(),
              avatarUrl: (m['a'] ?? '').toString()));
        }
      } catch (_) {/* skip a bad row */}
    }
    if (_authoritativeLoaded || !mounted) return;
    setState(() {
      _contacts = contacts;
      _groups = groups;
      _previews = previews;
      _unread..clear()..addAll(unread);
      _flags = flags;
      _booted = true;
    });
  }

  /// Serialize the current chat list into the persisted projection (one row per
  /// conversation). Mirrors exactly what build() renders, so the next cold start
  /// repaints identically from a single query.
  void _saveProjection(List<Contact> contacts, List<Group> groups,
      Map<String, ({String text, int ts, bool me})> previews, Map<String, Set<String>> flags) {
    List<String> flagsFor(String k) => [for (final f in flags.keys) if (flags[f]!.contains(k)) f];
    final rows = <({String convKey, int ts, String json})>[];
    for (final g in groups) {
      final k = 'g:${g.id}';
      final pv = previews[k];
      final ts = pv?.ts ?? 0;
      rows.add((convKey: k, ts: ts, json: jsonEncode({
        'k': k, 'g': true, 'n': g.name, 'a': '', 's': 'group-${g.id}',
        'gid': g.id, 'mc': g.members.length,
        'pv': pv?.text ?? '', 'ts': ts, 'me': pv?.me ?? false,
        'u': _unread[k] ?? 0, 'f': flagsFor(k),
      })));
    }
    for (final c in contacts) {
      final tel = telPhone(c.npub);
      final k = tel != null
          ? receptTelConvKey(_id?.uid ?? '', tel)
          : '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
      final pv = previews[k];
      final ts = pv?.ts ?? 0;
      rows.add((convKey: k, ts: ts, json: jsonEncode({
        'k': k, 'g': false, 'n': c.name, 'a': c.avatarUrl, 's': c.npub,
        'gid': '', 'mc': 0,
        'pv': pv?.text ?? '', 'ts': ts, 'me': pv?.me ?? false,
        'u': _unread[k] ?? 0, 'f': flagsFor(k),
      })));
    }
    Db.I.replaceChatList(rows).catchError((Object _) {}); // fire-and-forget
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Coming back to the foreground: a suspended app's relay socket was likely
      // torn down by the OS — reconnect immediately (don't wait out the backoff)
      // so live delivery resumes at once, and clear the unread badge.
      _inbox?.ensureConnected();
      PushService.clearMessageBadge();
      // Re-sync the address book on every resume so newly-added phone contacts
      // (and people who just joined AvaTOK) show up immediately. Throttled inside
      // the service so it won't hammer the OS book on rapid foreground/background.
      DeviceContactsService.refresh(source: 'resume')
          .then((_) => _reconcileTelContacts());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _inboxSub?.cancel(); // stop listening, but leave the shared SyncHub socket alive
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final bootT0 = DateTime.now(); // measure how long the local reads actually take
    // Kick EVERY local read off concurrently. These were 11 sequential awaits,
    // which on a slower phone (Samsung secure-storage/disk reads) serialised into
    // a ~10-second BLANK chat list on every cold start. They're independent, so
    // overlapping them makes the cached list appear in roughly one read instead
    // of eleven.
    final fId = _store.load();
    final fContacts = _contactsStore.load();
    final fGroups = _groupStore.load();
    final fLastRead = _readStore.load();
    final fFlags = _flagsStore.load();
    final fStatus = _statusStore.load();
    final fDrafts = DraftStore().load();
    final fPreviews = _previewStore.load();
    final fEnabled = OnboardingStore().enabledApps();
    final fKind = AccountKindStore().load();
    final fFilters = _filterStore.load();
    var id = await fId;
    id ??= await _store.createAndStore();
    final contacts = await fContacts;
    final groups = await fGroups;
    final lastRead = await fLastRead;
    final flags = await fFlags;
    final status = await fStatus;
    final drafts = await fDrafts;
    final previews = await fPreviews;
    final enabled = await fEnabled;
    final kind = await fKind;
    final customFilters = await fFilters;
    if (mounted) {
      setState(() {
        _id = id; _contacts = contacts; _groups = groups;
        _lastRead = lastRead; _flags = flags; _setStatuses(status); _drafts = drafts;
        _previews = previews;
        _enabledApps = enabled; _accountKind = kind; _customFilters = customFilters;
        _booted = true; // loading done → safe to show the empty state if truly empty
        _authoritativeLoaded = true; // store data wins over the projection paint
      });
    } else {
      _authoritativeLoaded = true;
    }
    // Refresh the shared snapshot so the next open (or a recreated screen) paints
    // instantly from memory.
    ChatListSnapshot.update(
        contacts: contacts, groups: groups, previews: previews, flags: flags, lastRead: lastRead);
    // Persist the chat-list projection so the NEXT cold start paints from a single
    // SQLite query (no in-memory pre-warm). Built from the authoritative stores;
    // fire-and-forget background write.
    _saveProjection(contacts, groups, previews, flags);
    // Cold-start cache health: if these are 0 for a user who clearly has chats,
    // the local cache isn't surviving restarts (the blank-list bug). Compare in
    // PostHog against the relay re-sync that follows.
    AvaLog.I.log('cache',
        'cold-start scope=${AccountScope.id ?? "null"} contacts=${contacts.length} previews=${previews.length} groups=${groups.length} loadMs=${DateTime.now().difference(bootT0).inMilliseconds}');
    // Reconcile server-side group memberships so any group the user was ADDED to
    // (here or on another device) shows up in the Groups tab — best-effort.
    GroupApi.sync().then((gs) { if (mounted) setState(() => _groups = gs); });
    // Backfill profile photos for contacts saved before avatars existed — silent.
    _contactsStore.refreshMissingAvatars().then((list) {
      if (mounted) setState(() => _contacts = list);
    });
    // Sync the phone address book to our backend (per-user storage, reused by
    // AvaContacts) and resolve who's already on AvaTok — best-effort, silent.
    DeviceContactsService.syncAndMatch(id.npub)
        .then((_) => _reconcileTelContacts());
    // Register this device for incoming-call wake pushes (npub hashed at rest).
    Analytics.identify(id.npub); // attribute diagnostics/events to this npub every app open
    await PushService.registerToken(id.npub);
    // Email is the human-facing id: publish email → npub so others find me by email.
    try {
      final cu = await widget.clerk.currentUser();
      final prof = await ProfileStore().load();
      // Phone + email are the human-facing ids — attach them to telemetry so this
      // user's errors / slow loads / log lines are retrievable by phone or email.
      Analytics.setUserKeys(email: cu?.email, phone: prof.phone);
      if (cu != null && cu.label.isNotEmpty && mounted) setState(() => _clerkName = cu.label);
      if (cu?.email != null && cu!.email!.isNotEmpty) {
        await Directory.registerProfile(
            npub: id.npub, email: cu.email!, name: cu.label, phone: prof.phone);
      }
    } catch (_) {/* not signed in / offline */}
    _startInbox(id);
    // Handles are retired (owner decision 2026-06-27): we no longer prompt for a
    // @handle. Tagging in groups uses the name you saved the contact under.
  }

  /// Global inbox: surface incoming messages/status/receipts even with no thread
  /// open. (Group membership now syncs via GroupApi — the old Nostr `ginfo`/`gkick`
  /// invite handlers were dead no-ops and have been removed.)
  void _startInbox(Identity id) {
    _inbox = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client + inbox sub (survives navigation)
    // Consume the hub's already-unwrapped stream (HubEvent). No crypto here.
    _inboxSub = SyncHub.I.incoming.listen((u) {
      if (_seenInbox.contains(u.rumorId)) return;
      _seenInbox.add(u.rumorId);
      try {
        final env = jsonDecode(u.payload);
        if (env is! Map) return;
        final t = env['t'];
        if (t == 'status' && u.senderPub != id.uid) {
          final post = StatusPost(
            id: u.rumorId, authorPub: u.senderPub,
            authorName: (env['who'] ?? 'Someone').toString(),
            kind: (env['kind'] ?? 'text').toString(),
            text: env['text']?.toString(),
            media: (env['media'] as Map?)?.cast<String, dynamic>(),
            ts: u.createdAt,
          );
          _statusStore.add(post).then((list) { if (mounted) setState(() => _setStatuses(list)); });
        } else if (t == 'receipt') {
          // A peer's delivery/read receipt for one of MY messages — persist it
          // globally so the ticks are right even if this thread is closed.
          if (u.senderPub != id.uid) {
            final rts = (env['ts'] as num?)?.toInt() ?? 0;
            final read = (env['status'] ?? '').toString() == 'read';
            if (rts > 0) ReceiptStore().bump('1:${u.senderPub}', delivered: read ? 0 : rts, read: read ? rts : 0);
          }
        } else if (t == 'read') {
          // MY server-authoritative read high-water for this conv (from another
          // device or restored on login) — advance the local marker and clear
          // this conv's unread badge. Arrives before message replays on sync.
          final key = u.convKey;
          final ts = (env['read_ts'] as num?)?.toInt() ?? 0;
          if (ts > (_lastRead[key] ?? 0)) {
            _lastRead[key] = ts;
            if (mounted) setState(() => _unread.remove(key));
          }
        } else if (t == 'recept') {
          // The AI Receptionist took a message. For a phone-only caller (no
          // AvaTOK account) the hub key is `g:recept_<me>__tel:<phone>` and there
          // is no contact yet — materialise a provisional `tel:` contact so the
          // thread appears in the list titled by the number, and the owner can
          // Save it from inside the thread. Known callers already have a tile.
          final key = u.convKey;
          if (u.createdAt > (_lastRead[key] ?? 0) && mounted) {
            setState(() => _unread[key] = (_unread[key] ?? 0) + 1);
          }
          if (u.createdAt >= (_previews[key]?.ts ?? 0)) {
            final preview = (env['text'] ?? '📞 Ava took a message').toString();
            _previewStore.record(key, preview, u.createdAt, false).then((_) {
              if (mounted) _previewStore.load().then((p) { if (mounted) setState(() => _previews = p); });
            });
          }
          if (isReceptTelConv(key)) {
            final phone = phoneFromReceptConv(key) ?? (env['caller_phone'] ?? '').toString();
            if (phone.isNotEmpty) _ensureTelContact(phone, env['caller_name']?.toString());
          }
        } else if (t == 'text' || t == 'media' || t == 'gtext' || t == 'gmedia') {
          if (u.senderPub == id.uid) return; // my own message
          final key = env['gid'] != null ? 'g:${env['gid']}' : '1:${u.senderPub}';
          // A group message for a group we don't have locally yet (e.g. we were
          // just added) → fetch it from the server so it appears in the Groups tab.
          if (env['gid'] != null) _ensureGroup(env['gid'].toString());
          if (_flags['blocked']!.contains(key)) return;
          // Durable, gift-wrapped DELIVERED receipt — fires from the global inbox
          // so it works with no thread open, and (unlike the ephemeral presence
          // one) reaches the sender even if they were offline. One per peer per
          // session high-water, so history replays don't spam receipts.
          if (env['gid'] == null && (_deliveredAckHW[u.senderPub] ?? 0) < u.createdAt) {
            _deliveredAckHW[u.senderPub] = u.createdAt;
            try {
              ApiAuth.postJson(kMsgReceiptUrl, {
                'conv': dmConvId(id.uid, u.senderPub), 'peer': u.senderPub, 'delivered_id': u.createdAt,
              }).then((_) {}, onError: (_) {});
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
            final pres = PresenceChannel(PresenceChannel.roomFor1on1(id.uid, u.senderPub), 'inbox',
                convKey: '1:${u.senderPub}', peerUid: u.senderPub)..connect();
            pres.sendDelivered(u.createdAt);
            Future.delayed(const Duration(milliseconds: 900), pres.dispose);
          }
        }
      } catch (_) {/* ignore */}
    });
    // No subscribe here — SyncHub already holds the single 'inbox' subscription
    // for all my 1059 wraps; we just listen to the shared stream above.
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
  /// Materialise a group we don't have locally (we were just added to it) by
  /// pulling its members from the server. De-duped so a burst of group messages
  /// only triggers one fetch.
  final Set<String> _syncingGroups = {};
  Future<void> _ensureGroup(String gid) async {
    if (gid.isEmpty || _groups.any((g) => g.id == gid) || !_syncingGroups.add(gid)) return;
    final g = await GroupApi.refresh(gid);
    if (g != null) {
      final list = await _groupStore.load();
      if (mounted) setState(() => _groups = list);
      // The user was added to a group and it just surfaced on this device.
      Analytics.capture('group_materialized',
          {'gid': gid, 'member_count': g.members.length, 'source': 'incoming_message'});
    }
    _syncingGroups.remove(gid);
  }

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

  /// Materialise a PROVISIONAL phone-only contact for an unknown caller the AI
  /// Receptionist took a message from, so their thread shows up titled by the
  /// number. Keyed by a synthetic `tel:<E.164>` id; de-dupes on that id. The
  /// owner turns this into a real saved contact (with a name) from inside the
  /// thread via "Save to contacts". No-op if already present.
  Future<void> _ensureTelContact(String phone, String? callerName) async {
    final e164 = DeviceContactsService.normPhone(phone);
    final npub = telNpub(e164);
    if (e164.isEmpty || _contacts.any((c) => c.npub == npub) || !_autoAdding.add(npub)) return;
    final name = (callerName != null && callerName.trim().isNotEmpty)
        ? callerName.trim()
        : formatTelDisplay(e164);
    final list = await _contactsStore.add(
        Contact(npub: npub, name: name, phone: e164, handle: kProvisionalContactHandle));
    if (mounted) setState(() => _contacts = list);
  }

  /// Auto-promote provisional `tel:<E.164>` receptionist contacts to real AvaTOK
  /// accounts once the device-contacts match sync discovers that number IS on
  /// AvaTOK (i.e. the caller is in the owner's address book and has since joined,
  /// or was already a user). Folds the synthetic row into the real npub via
  /// [ContactsStore.mergeTel] and moves the voicemail history into the proper DM
  /// thread so nothing is lost. Privacy-safe: it only acts on numbers the match
  /// endpoint already returned (never probes arbitrary numbers). Called after a
  /// match sync completes.
  Future<void> _reconcileTelContacts() async {
    final myUid = _id?.uid;
    if (myUid == null || myUid.isEmpty) return;
    final provisional = _contacts.where((c) => c.isPhoneOnly).toList();
    if (provisional.isEmpty) return;
    List<DeviceContact> dev;
    try { dev = await DeviceContactsService.cached(); } catch (_) { return; }
    final matched = <String, DeviceContact>{
      for (final d in dev) if (d.onAvatok && d.phoneNorm.isNotEmpty) d.phoneNorm: d,
    };
    if (matched.isEmpty) return;
    var changed = false;
    for (final c in provisional) {
      final e164 = telPhone(c.npub);
      if (e164 == null) continue;
      final d = matched[e164];
      if (d == null || d.uid == myUid) continue;
      // Preserve a name the owner explicitly saved; otherwise take the matched
      // profile/device name.
      final namedByUser = !isProvisionalContact(c) && c.name.trim().isNotEmpty;
      final name = namedByUser
          ? c.name
          : (d.displayName.isNotEmpty ? d.displayName : formatTelDisplay(e164));
      final real = Contact(npub: d.uid, name: name, handle: d.handle,
          avatarUrl: d.avatarUrl, phone: e164);
      final list = await _contactsStore.mergeTel(e164, real);
      // Move the voicemail cards into the real DM thread.
      final from = receptTelConvKey(myUid, e164);
      final to = '1:${NostrKeys.npubToHex(d.uid) ?? d.uid}';
      final hadHistory = _previews[from] != null;
      try {
        await Db.I.rekeyConversation(from, to);
        final pv = _previews[from];
        if (pv != null) await _previewStore.record(to, pv.text, pv.ts, pv.me);
      } catch (_) {/* history move is best-effort */}
      if (mounted) setState(() => _contacts = list);
      Analytics.capture('unknown_caller_promoted', {
        'named_by_user': namedByUser,
        'had_history': hadHistory,
      });
      changed = true;
    }
    if (changed && mounted) {
      _previewStore.load().then((p) { if (mounted) setState(() => _previews = p); });
    }
  }

  Future<void> _openAddContact() async {
    // Adding an AvaTok contact needs a real, recoverable account: an L0 guest
    // is routed to AvaIdentity to become an L1 member first (email + password).
    final ok = await AccountGate.ensureMember(context, reason: 'add a contact');
    if (!ok || !mounted) return;
    // Ensure add-contact telemetry is attributable to this user's email/phone
    // (so their contact errors are pullable by email in PostHog).
    try {
      final cu = await widget.clerk.currentUser();
      final prof = await ProfileStore().load();
      Analytics.setUserKeys(email: cu?.email, phone: prof.phone);
    } catch (_) {}
    if (!mounted) return;
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

  /// Open a fresh companion chat with Ava (persona picker → free-form chat).
  /// Runs entirely through the existing Ava endpoints (no new worker route).
  void _openAvaChat() {
    Analytics.capture('ava_session_opened', const {'source': 'messenger_pinned'});
    Navigator.push(context, MaterialPageRoute(builder: (_) => const CompanionHome()));
  }

  /// The pinned, clearly-marked PRIVATE Ava session at the top of the chat list —
  /// green so it's never confused with a real person. Tapping opens the Ava chat.
  Widget _avaSessionRow() => InkWell(
        onTap: _openAvaChat,
        child: Container(
          margin: const EdgeInsets.fromLTRB(10, 8, 10, 4),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: Zine.lime.withValues(alpha: 0.20),
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Border.all(color: Zine.mintInk.withValues(alpha: 0.55), width: 1.5),
          ),
          child: Row(children: [
            Container(
              width: 50, height: 50,
              decoration: BoxDecoration(
                shape: BoxShape.circle, color: Zine.lilac,
                border: Border.all(color: Zine.ink, width: 2)),
              child: Center(child: PhosphorIcon(
                  PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.ink, size: 24)),
            ),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text('Ava', style: ZineText.value(size: 15.5)),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: Zine.mint, borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 1.5)),
                  child: Text('PRIVATE', style: ZineText.tag(size: 9, color: Zine.mintInk)),
                ),
              ]),
              const SizedBox(height: 3),
              Text('Your private AI — brainstorm, practise a language, or just talk',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 13)),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
          ]),
        ),
      );

  /// New-chat menu (the green FAB): chat with Ava, message, group, or invite.
  void _openNewChatMenu() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 8),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac),
          title: Text('Chat with Ava', style: ZineText.value(size: 15)),
          subtitle: Text('Brainstorm, practise a language, or just talk', style: ZineText.sub(size: 12.5)),
          onTap: () { Navigator.pop(ctx); _openAvaChat(); }),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold), color: Zine.blue),
          title: Text('New chat', style: ZineText.value(size: 15)),
          subtitle: Text('Find someone by email or AvaTOK number', style: ZineText.sub(size: 12.5)),
          onTap: () { Navigator.pop(ctx); _openAddContact(); }),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold), color: Zine.lime),
          title: Text('New group', style: ZineText.value(size: 15)),
          onTap: () { Navigator.pop(ctx); _openNewGroup(); }),
        ListTile(
          leading: ZineIconBadge(icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), color: Zine.mint),
          title: Text('Invite friends to AvaTok', style: ZineText.value(size: 15)),
          subtitle: Text('Find people from your phone contacts', style: ZineText.sub(size: 12.5)),
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

  /// Open the AvaPhone dialer (PSTN-style calling/SMS over AvaTOK numbers).
  void _openAvaPhone() {
    Analytics.capture('avaphone_opened', const {'source': 'chat_list_header'});
    Navigator.push(context, MaterialPageRoute(builder: (_) => const AvaPhoneScreen()));
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
    // Groups are surfaced ONLY in the dedicated Groups tab (owner decision
    // 2026-06-28) — they no longer appear in the main Chats thread list.
    String contactKey(Contact c) {
      final tel = telPhone(c.npub);
      if (tel != null) return receptTelConvKey(_id?.uid ?? '', tel);
      return '1:${NostrKeys.npubToHex(c.npub) ?? ''}';
    }
    final contactChats = _contacts.where((c) {
      final k = contactKey(c);
      return !blocked.contains(k) && (_showArchived || !archived.contains(k));
    }).map((c) {
      final k = contactKey(c);
      // Phone-only callers can't be greeted with "Say hi" — their thread is a
      // one-way voicemail record, so fall back to the formatted number.
      final empty = c.isPhoneOnly ? c.subtitle : 'Say hi 👋';
      return Chat(name: c.name, seed: c.seed, avatarUrl: c.avatarUrl,
          last: draftOr(k, previewOr(k, c.subtitle.isNotEmpty ? c.subtitle : empty)),
          time: timeOf(k), unread: _unread[k] ?? 0);
    }).toList();
    final realRows = [...contactChats];
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
      backgroundColor: Zine.paper,
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
      // New-chat FAB — 52px lime circle, ink border, hard shadow (the ONE lime
      // primary action on this screen).
      floatingActionButton: _tab == 0
          ? ZinePressable(
              onTap: _openNewChatMenu,
              color: Zine.lime,
              radius: BorderRadius.circular(100),
              child: SizedBox(
                width: 52, height: 52,
                child: Center(child: PhosphorIcon(
                    PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 24, color: Zine.ink)),
              ),
            )
          : null,
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        child: NavigationBar(
          selectedIndex: _tab,
          // The Dialpad slot (index 1) opens the AvaPhone dialer on top instead of
          // being a tab body — so selection stays on the current tab.
          onDestinationSelected: (i) { if (i == 1) { _openAvaPhone(); return; } setState(() => _tab = i); },
          backgroundColor: Zine.paper2,
          surfaceTintColor: Colors.transparent,
          indicatorColor: Zine.lime,
          destinations: [
            NavigationDestination(
                // Red dot on Chats when there are unread messages.
                icon: _badged(PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold)),
                    dot: _unread.values.fold<int>(0, (a, b) => a + b) > 0),
                selectedIcon: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.fill)),
                label: 'Chats'),
            NavigationDestination(
                icon: PhosphorIcon(PhosphorIcons.gridFour(PhosphorIconsStyle.bold)),
                selectedIcon: PhosphorIcon(PhosphorIcons.gridFour(PhosphorIconsStyle.fill)),
                label: 'Dialpad'),
            NavigationDestination(
                // Red count on Groups = pending group invites waiting.
                icon: _badged(PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.bold)),
                    count: _groupInvites),
                selectedIcon: PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.fill)),
                label: 'Groups'),
            NavigationDestination(
                icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold)),
                selectedIcon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.fill)),
                label: 'Calls'),
          ],
        ),
      ),
      body: IndexedStack(index: _tab, children: [
        SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Appbar band (§8): paper-2 fill, ink bottom border. Everything the
            // old body strip held (search, status, filters) now lives up here so
            // the chat list itself is uncluttered: menu · Messenger · status
            // avatar · filter dropdown · Chat-with-Ava · search.
            Container(
              padding: const EdgeInsets.fromLTRB(10, 10, 8, 12),
              decoration: const BoxDecoration(
                color: Zine.paper2,
                border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
              ),
              child: Row(
                children: [
                  // Left control — opens the app sidebar (this Scaffold hosts the
                  // main nav drawer). The oversized "Messenger" title was removed
                  // to free space; the icons now sit evenly on the right.
                  ZineBackButton(
                      onTap: () => _scaffoldKey.currentState?.openDrawer(),
                      icon: PhosphorIcons.list(PhosphorIconsStyle.bold)),
                  const Spacer(),
                  // Status avatar — opens the status viewer; shows my latest photo
                  // status as a thumbnail (glows when I have a live status).
                  _headerStatusButton(),
                  const SizedBox(width: 10),
                  // Filters collapsed into a single dropdown (active label shown).
                  _filterMenuButton(),
                  const SizedBox(width: 10),
                  // (Header "Chat with Ava" sparkle icon removed — owner request
                  // 2026-06-28. Ava is still reachable via the pinned PRIVATE Ava
                  // session at the top of the chat list and the new-chat menu.)
                  _hdrIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), _openSearch,
                      color: Zine.blueInk, bg: Zine.blue),
                  const SizedBox(width: 10),
                  // Notification bell + red unread count → the notification center.
                  _badged(
                    _hdrIcon(PhosphorIcons.bell(PhosphorIconsStyle.bold), _openNotifications,
                        color: Zine.ink, bg: Zine.lime),
                    count: _notifUnread),
                ],
              ),
            ),
            // chats
            Expanded(
              child: ListView(
                children: [
                  // Ava lives INSIDE Messenger as a pinned, clearly-marked PRIVATE
                  // session (green) so it's never confused with a real contact
                  // (owner decision 2026-06-27). Tapping opens the Ava chat.
                  if (_filter == 'all' || _filter == 'fav') _avaSessionRow(),
                  if (archivedCount > 0)
                    InkWell(
                      onTap: () => setState(() => _showArchived = !_showArchived),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                        decoration: BoxDecoration(
                            border: Border(bottom: BorderSide(
                                color: Zine.ink.withValues(alpha: 0.25), width: 2))),
                        child: Row(children: [
                          PhosphorIcon(PhosphorIcons.archive(PhosphorIconsStyle.bold),
                              size: 20, color: Zine.inkSoft),
                          const SizedBox(width: 16),
                          Text('Archived', style: ZineText.value(size: 15)),
                          const Spacer(),
                          Text(_showArchived ? 'HIDE' : '$archivedCount',
                              style: ZineText.tag(size: 12, color: Zine.blueInk)),
                        ]),
                      ),
                    ),
                  if (rows.isEmpty && !_booted)
                    const Padding(
                      padding: EdgeInsets.only(top: 60),
                      child: Center(
                          child: SizedBox(width: 24, height: 24,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))),
                    ),
                  if (rows.isEmpty && _booted)
                    Padding(
                      padding: const EdgeInsets.only(top: 60),
                      child: Center(child: ZineEmptyState(
                          icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
                          text: _filter == 'all' ? 'No chats yet — tap + to start one' : 'Nothing here')),
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
        GroupsTab(
            identity: _id,
            contacts: _contacts,
            onMenu: () => _scaffoldKey.currentState?.openDrawer()),
        const CallsScreen(),
      ]),
    );
  }

  /// Compact circular header icon button (smaller than ZineBackButton so the
  /// fuller header row — title + 4 trailing controls — fits on narrow phones).
  Widget _hdrIcon(IconData icon, VoidCallback onTap, {Color color = Zine.ink, Color? bg}) => ZinePressable(
        onTap: onTap,
        // Pale, flat header chips (owner feedback 2026-06-27): a soft tinted fill,
        // a thin matching border and NO hard shadow — not dark circles.
        color: bg == null ? Zine.card : bg.withValues(alpha: 0.14),
        pressedColor: bg?.withValues(alpha: 0.30) ?? Zine.lime,
        radius: BorderRadius.circular(100),
        boxShadow: const <BoxShadow>[],
        // Black (ink) border on each header icon (owner request 2026-06-27).
        borderWidth: 2,
        borderColor: Zine.ink,
        padding: EdgeInsets.zero,
        child: SizedBox(
          width: 38, height: 38,
          child: Center(child: PhosphorIcon(icon, size: 19, color: color)),
        ),
      );

  /// Header STATUS avatar. Shows my latest photo-status thumbnail when I have
  /// one (so posting a pic is reflected here), else my generated avatar. Glows
  /// when I have any live status. Tap → status viewer.
  Widget _headerStatusButton() {
    const sz = 32.0;
    Widget inner;
    if (_myStatusThumb != null) {
      inner = ClipOval(
        child: SizedBox(
          width: sz, height: sz,
          child: FutureBuilder<Uint8List>(
            future: _myStatusThumb,
            builder: (_, s) => s.hasData
                ? Image.memory(s.data!, width: sz, height: sz, fit: BoxFit.cover)
                : Avatar(seed: _id?.npub ?? 'me', name: 'You', size: sz),
          ),
        ),
      );
    } else {
      inner = Avatar(seed: _id?.npub ?? 'me', name: 'You', size: sz);
    }
    return GestureDetector(
      onTap: _openStatuses,
      child: _iHaveStatus ? _glowRing(inner) : _ring(inner),
    );
  }

  /// Short label for the active filter, shown next to the dropdown caret.
  String _filterLabel() {
    switch (_filter) {
      case 'all': return 'All';
      case 'fav': return 'Favs';
      case 'unread': return 'Unread';
      case 'groups': return 'Groups';
      default: return _filter.startsWith('c:') ? _filter.substring(2) : 'All';
    }
  }

  PopupMenuItem<String> _fItem(String value, String label) => PopupMenuItem<String>(
        value: value,
        child: Row(children: [
          SizedBox(
            width: 24,
            child: _filter == value
                ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 16, color: Zine.blueInk)
                : null,
          ),
          Text(label, style: ZineText.value(size: 14.5)),
        ]),
      );

  /// Filters collapsed into one dropdown: a pill showing the active filter +
  /// caret; tapping opens the full list (with a check on the active one) plus
  /// "New filter". Long-press isn't available in a menu, so custom filters get
  /// a trailing ✕ to delete.
  Widget _filterMenuButton() {
    return PopupMenuButton<String>(
      tooltip: 'Filter chats',
      color: Zine.paper,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: Zine.ink, width: Zine.bw),
        borderRadius: BorderRadius.circular(Zine.rSm),
      ),
      onSelected: (v) async {
        if (v == '__add') { _addCustomFilter(); return; }
        if (v.startsWith('del:')) {
          final name = v.substring(4);
          final list = await _filterStore.remove(name);
          if (mounted) setState(() { _customFilters = list; if (_filter == 'c:$name') _filter = 'all'; });
          return;
        }
        Analytics.capture('messenger_filter_changed', {'filter': v});
        setState(() => _filter = v);
      },
      itemBuilder: (_) => [
        _fItem('all', 'All'),
        _fItem('fav', 'Favourites'),
        _fItem('unread', 'Unread'),
        // 'Groups' filter removed — groups now live in the Groups tab, never the
        // Chats list (owner decision 2026-06-28).
        for (final f in _customFilters) _fItem('c:${f.name}', f.name),
        for (final f in _customFilters)
          PopupMenuItem<String>(
            value: 'del:${f.name}',
            child: Row(children: [
              const SizedBox(width: 24),
              PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14, color: Zine.coral),
              const SizedBox(width: 8),
              Text('Delete "${f.name}"', style: ZineText.sub(size: 13, color: Zine.coral)),
            ]),
          ),
        const PopupMenuDivider(),
        PopupMenuItem<String>(
          value: '__add',
          child: Row(children: [
            SizedBox(width: 24, child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 15, color: Zine.ink)),
            Text('New filter', style: ZineText.value(size: 14.5)),
          ]),
        ),
      ],
      child: Container(
        padding: const EdgeInsets.fromLTRB(11, 8, 8, 8),
        decoration: BoxDecoration(
          color: _filter == 'all' ? Zine.card : Zine.lime,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(_filterLabel(), style: ZineText.tag(size: 11, color: Zine.ink)),
          const SizedBox(width: 3),
          PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 12, color: Zine.ink),
        ]),
      ),
    );
  }

  /// Bordered-circle avatar — zine avatars always sit inside an ink ring.
  Widget _ring(Widget avatar) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: avatar,
      );

  /// Avatar in a green glowing story ring — shown when the person has a live
  /// (unexpired) status. Tapping it opens the status viewer.
  Widget _glowRing(Widget avatar) => Container(
        padding: const EdgeInsets.all(2.5),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Zine.lime,
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: [
            BoxShadow(color: Zine.lime.withValues(alpha: 0.75), blurRadius: 11, spreadRadius: 1),
          ],
        ),
        child: avatar,
      );

  void _openStatuses() {
    Analytics.capture('messenger_status_opened', {'has_photo': _myStatusMedia != null});
    Navigator.push(context,
            MaterialPageRoute(builder: (_) => StatusScreen(identity: _id, contacts: _contacts)))
        .then((_) => _statusStore.load().then((l) { if (mounted) setState(() => _setStatuses(l)); }));
  }

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
              // Bordered circle avatar (zine §6). Tapping the photo itself opens
              // the enlarged, screenshot-guarded viewer (not the chat).
              GestureDetector(
                onTap: () => showAvatarViewer(context,
                    seed: chat.seed, name: chat.name,
                    avatarUrl: chat.avatarUrl.isEmpty ? null : chat.avatarUrl),
                child: Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                  child: Avatar(seed: chat.seed, name: chat.name, size: 54,
                      avatarUrl: chat.avatarUrl.isEmpty ? null : chat.avatarUrl),
                ),
              ),
              if (chat.online)
                Positioned(
                  bottom: 1, right: 1,
                  child: Container(
                    width: 13, height: 13,
                    decoration: BoxDecoration(
                        color: Zine.mint, shape: BoxShape.circle,
                        border: Border.all(color: Zine.ink, width: 2)),
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
                        style: ZineText.value(size: 15.5))),
                    if (muted) Padding(padding: const EdgeInsets.only(left: 4),
                        child: PhosphorIcon(PhosphorIcons.bellSlash(PhosphorIconsStyle.bold),
                            size: 13, color: Zine.inkSoft)),
                    if (pinned) Padding(padding: const EdgeInsets.only(left: 4),
                        child: PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.fill),
                            size: 13, color: Zine.inkSoft)),
                  ]),
                  const SizedBox(height: 3),
                  Text(chat.last,
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.sub(size: 13.5,
                          color: chat.unread > 0 ? Zine.ink : Zine.inkSoft)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // Mono timestamp.
                Text(chat.time.toUpperCase(),
                    style: ZineText.tag(size: 10,
                        color: chat.unread > 0 ? Zine.blueInk : Zine.inkSoft)),
                const SizedBox(height: 6),
                if (chat.unread > 0)
                  // Unread badge — lime circle with ink border + ink count.
                  Container(
                    padding: const EdgeInsets.all(4),
                    constraints: const BoxConstraints(minWidth: 22, minHeight: 22),
                    decoration: BoxDecoration(
                        color: Zine.lime, shape: BoxShape.circle,
                        border: Border.all(color: Zine.ink, width: 2)),
                    child: Center(
                      widthFactor: 1,
                      child: Text('${chat.unread}',
                          textAlign: TextAlign.center,
                          style: ZineText.tag(size: 10)),
                    ),
                  )
                else
                  const SizedBox(height: 22),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
