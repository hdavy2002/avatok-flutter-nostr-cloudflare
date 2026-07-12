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
import '../../core/remote_config.dart';
import '../../core/status_store.dart';
import '../../core/update_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/onboarding_store.dart';
import '../../core/admin_tools.dart';
import '../../identity/identity.dart';
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
import 'contact_actions.dart';
import 'contacts.dart';
import 'data.dart';
import 'media.dart';
import 'new_group_screen.dart';
import 'search_screen.dart';
import 'stranger_gate_api.dart';
import 'unknown_caller.dart';

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
  StreamSubscription? _contactsSub; // live refresh when a contact is added/removed anywhere
  // 2026-07-12 redesign: AvaTOK is a pure messenger (WhatsApp-like) — the old
  // Dialpad shortcut and the "Ava PRIVATE" promo banner are gone; Ask Ava is
  // reachable via the global shell-wide app-switcher's "Ava" action instead.
  // 0 = Chat, 1 = Community (group chats), 2 = Call log (in-network AvaTOK calls).
  int _tab = 0;
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

  // [SAFE-GATE-2] "Message requests (N)" section: SERVER conv ids (`dm_…`) whose
  // stranger-gate accept_state is 'pending'. Grouped in a collapsed section at
  // the very top of the list (gated on RemoteConfig.strangerGateEnabled). Loaded
  // from the per-account StrangerGateStore.pendingConvs() and refreshed on resume
  // / thread return. _requestsExpanded toggles the collapsed/expanded body.
  Set<String> _pendingConvs = {};
  bool _requestsExpanded = false;
  int _requestsShownCount = -1; // memo so telemetry fires once per count change

  // Cold start paints from a SINGLE indexed SQLite query over the persisted chat
  // -list projection (Db.chatsOnce) — instant on any phone, nothing pre-loaded
  // into memory (that wouldn't scale across many AvaVerse apps). Within a session
  // the tiny ChatListSnapshot makes navigate-away-and-back repaint synchronously.
  // _booted gates the "No chats yet" empty state so it only shows once a load is
  // done; _authoritativeLoaded guards the async projection paint from clobbering
  // the fresher store-backed data if it happens to resolve later.
  bool _booted = false;
  bool _authoritativeLoaded = false;
  // [BLANK-GUARD] The chat list is derived entirely from _contacts, and the
  // per-account caches (DiskCache/Db) silently fall back to a 'default' bucket
  // whenever AccountScope.id is momentarily null — which happens on first mount
  // and again on resume, before Clerk re-resolves the current account. A read in
  // that window returns EMPTY, which used to (a) clobber a populated list and
  // (b) flip on the "No chats yet" empty state → the chats vanished until a cold
  // relaunch, and reappeared/​vanished as the scope flickered. We now refuse to
  // let an empty read under a not-ready scope overwrite good data, and retry the
  // boot load until the scope resolves. _emptyBootRetries bounds that retry loop
  // so a genuinely-empty account (or a guest, who legitimately has a null scope)
  // still reaches the empty state.
  int _emptyBootRetries = 0;
  bool get _scopeReady =>
      AccountScope.id != null && AccountScope.id!.isNotEmpty;
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
    // uid (they have no AvaTOK account). Must match SyncHub's `g:recept_…` key.
    final tel = telPhone(c.seed);
    if (tel != null) return receptTelConvKey(_id?.uid ?? '', tel);
    return '1:${c.seed}';
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

  /// True if [uid] (a contact's uid) currently has a live status.
  bool _hasStatus(String uid) {
    return _statusAuthorHex.contains(uid);
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
      // A thread may have been accepted/blocked from its stranger-gate bar —
      // reconcile the "Message requests" section.
      _loadPendingRequests();
    });
  }

  /// [SAFE-GATE-2] The collapsed "Message requests (N)" section for pending
  /// stranger-gate threads. Returns [] (renders nothing) when the flag is off or
  /// there are no pending requests. Tapping the header expands/collapses; tapping
  /// a request opens the thread (which shows the stranger-gate action bar).
  List<Widget> _messageRequestsSection() {
    if (!RemoteConfig.strangerGateEnabled || _pendingConvs.isEmpty) return const [];
    final myUid = _id?.uid ?? '';
    // Resolve each pending SERVER conv id back to a known contact (dm_<lo>__<hi>
    // == dmConvIdFor(me, contact.uid)). Unknown senders (no contact yet) are
    // still counted, but only resolvable ones become tappable rows.
    final pending = <({String conv, Contact? contact})>[];
    for (final conv in _pendingConvs) {
      Contact? match;
      if (myUid.isNotEmpty) {
        for (final c in _contacts) {
          if (dmConvIdFor(myUid, c.uid) == conv) { match = c; break; }
        }
      }
      pending.add((conv: conv, contact: match));
    }
    final n = pending.length;
    // Fire the shown-telemetry once per count change (email auto-attached).
    if (_requestsShownCount != n) {
      _requestsShownCount = n;
      Analytics.capture('message_requests_section_shown', {'count': n});
    }
    return [
      InkWell(
        onTap: () => setState(() => _requestsExpanded = !_requestsExpanded),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
              border: Border(bottom: BorderSide(
                  color: Zine.ink.withValues(alpha: 0.25), width: 2))),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.userCircle(PhosphorIconsStyle.bold),
                size: 20, color: Zine.blueInk),
            const SizedBox(width: 16),
            Flexible(
                child: Text('Message requests',
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 15))),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
              decoration: BoxDecoration(
                  color: Zine.blue.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: Zine.blueInk, width: 1.5)),
              child: Text('$n', style: ZineText.tag(size: 11, color: Zine.blueInk)),
            ),
            const Spacer(),
            PhosphorIcon(
                _requestsExpanded
                    ? PhosphorIcons.caretUp(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                size: 16, color: Zine.inkSoft),
          ]),
        ),
      ),
      if (_requestsExpanded)
        for (final p in pending)
          if (p.contact != null)
            _ChatRow(
              chat: Chat(
                name: p.contact!.name,
                seed: p.contact!.seed,
                avatarUrl: p.contact!.avatarUrl,
                last: p.contact!.subtitle.isNotEmpty
                    ? p.contact!.subtitle
                    : 'Wants to send you a message',
                time: '',
              ),
              pinned: false,
              muted: false,
              onTap: () {
                Analytics.capture('message_request_opened',
                    {'resolved': true, 'has_peer': true, 'conv': p.conv});
                _openChat(Chat(
                  name: p.contact!.name,
                  seed: p.contact!.seed,
                  avatarUrl: p.contact!.avatarUrl,
                  last: '',
                  time: '',
                ));
              },
              onLongPress: () {},
            )
          else
            // Unresolved sender (not in local contacts): recover the peer uid
            // from the conv id so the row still OPENS its real thread, where the
            // StrangerGateBar (Accept / Block / Report) is shown. Previously this
            // was a dead, un-tappable placeholder — the request looked empty and
            // couldn't be acted on.
            InkWell(
              onTap: () => _openMessageRequest(p.conv),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(
                        color: Zine.ink.withValues(alpha: 0.1), width: 1))),
                child: Row(children: [
                  PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.bold),
                      size: 18, color: Zine.inkSoft),
                  const SizedBox(width: 16),
                  Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text('Unknown sender', style: ZineText.value(size: 14)),
                        const SizedBox(height: 2),
                        Text('Wants to send you a message',
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: ZineText.sub(size: 12.5, color: Zine.inkSoft)),
                      ])),
                  const SizedBox(width: 8),
                  PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                      size: 14, color: Zine.inkSoft),
                ]),
              ),
            ),
    ];
  }

  /// Open a pending message request whose sender is NOT a saved contact. The
  /// peer uid is recovered from the server conv id (`dm_<lo>__<hi>`), so the row
  /// still lands on the correct 1:1 thread — where the stranger-gate bar lets the
  /// user Accept, Block or Report. Returning from the thread reconciles the
  /// "Message requests" section (accept/block may have cleared it).
  void _openMessageRequest(String conv) {
    final myUid = _id?.uid ?? '';
    final peer = peerUidFromConv(conv, myUid);
    Analytics.capture('message_request_opened', {
      'resolved': false,
      'has_peer': peer != null && peer.isNotEmpty,
      'conv': conv,
    });
    if (peer == null || peer.isEmpty) return; // unrecoverable id — nothing to open
    _openChat(Chat(name: 'Unknown sender', seed: peer, last: '', time: ''));
  }

  void _chatRowFlags(Chat c) {
    final k = _keyOf(c);
    bool has(String f) => _flags[f]!.contains(k);
    _showActionSheet(
      children: (ctx) => [
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
        // [FIX-CONTACT-1] Copy / Share vCard / Forward — only for 1:1 contact rows.
        if (c.gid == null) ...[
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold), color: Zine.ink),
              title: Text('Copy contact', style: ZineText.value(size: 15)),
              onTap: () { Navigator.pop(ctx); ContactActions.copy(context, _contactOf(c)); }),
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), color: Zine.ink),
              title: Text('Share contact', style: ZineText.value(size: 15)),
              onTap: () { Navigator.pop(ctx); ContactActions.share(context, _contactOf(c)); }),
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), color: Zine.ink),
              title: Text('Forward contact', style: ZineText.value(size: 15)),
              onTap: () { Navigator.pop(ctx); ContactActions.forward(context, _contactOf(c)); }),
        ],
        if (c.gid == null)
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: Zine.coral),
              title: Text(has('blocked') ? 'Unblock' : 'Block', style: ZineText.value(size: 15, color: Zine.coral)),
              onTap: () { Navigator.pop(ctx); _toggleFlag('blocked', k); }),
        if (c.gid == null)
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.userMinus(PhosphorIconsStyle.bold), color: Zine.coral),
              // [ISSUE-CONTACT-SEMANTICS-1] Hides the thread; contact stays in
              // AvaTOK contacts (find them in search any time).
              title: Text('Remove from chats', style: ZineText.value(size: 15, color: Zine.coral)),
              onTap: () { Navigator.pop(ctx); _removeContact(c); }),
        if (c.gid == null)
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), color: Zine.coral),
              title: Text('Delete contact', style: ZineText.value(size: 15, color: Zine.coral)),
              onTap: () { Navigator.pop(ctx); _deleteContact(c); }),
      ],
    );
  }

  /// Shared bottom-sheet shell for long-press / overflow action menus. Uses
  /// isScrollControlled + a scroll view so a TALL list (pin/mute/archive/copy/
  /// share/forward/block/remove = 8 rows) is never clipped by the default
  /// half-screen sheet cap — the bug where "Remove contact" sat off-screen and
  /// couldn't be tapped. Capped at 85% height (scrolls beyond), a grab handle up
  /// top, and SafeArea + extra bottom padding so the last row always clears the
  /// gesture nav bar.
  void _showActionSheet({required List<Widget> Function(BuildContext ctx) children}) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.85),
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              // Grab handle.
              Container(
                width: 40, height: 4,
                margin: const EdgeInsets.only(top: 10, bottom: 4),
                decoration: BoxDecoration(
                    color: Zine.ink.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(100)),
              ),
              ...children(ctx),
              const SizedBox(height: 12),
            ]),
          ),
        ),
      ),
    );
  }

  // [ISSUE-CONTACT-SEMANTICS-1] (owner decision 2026-07-10) uid → hidden-at ms.
  // Loaded at bootstrap, refreshed after hide/delete. Rendering filters hidden
  // threads out; a newer message than the hide timestamp resurrects the row.
  Map<String, int> _hiddenThreads = {};

  /// "Remove contact" = HIDE the thread only. The contact stays in the AvaTOK
  /// contact book (searchable, messageable); the row disappears from Chats and
  /// stays gone across restores until a NEW message arrives.
  Future<void> _removeContact(Chat c) async {
    await _contactsStore.hideThread(c.seed); // Contact.seed == uid
    final hidden = await _contactsStore.hiddenThreads();
    if (mounted) setState(() => _hiddenThreads = hidden);
  }

  /// "Delete contact" = permanent, tombstoned delete from the AvaTOK contact
  /// book. Survives restores; never resurrected from message history. The
  /// user's PHONE address book is never touched.
  Future<void> _deleteContact(Chat c) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
            borderRadius: BorderRadius.circular(18)),
        title: Text('Delete ${c.name}?', style: ZineText.value(size: 17)),
        content: Text(
            'This deletes them from your AvaTOK contacts for good — the chat '
            'disappears and won\'t come back after a restore. Your phone\'s own '
            'address book is not touched.',
            style: ZineText.value(size: 14)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text('Delete', style: ZineText.value(size: 15, color: Zine.coral))),
        ],
      ),
    );
    if (sure != true) return;
    final list = await _contactsStore.deleteContact(c.seed);
    if (mounted) setState(() => _contacts = list);
  }

  /// [FIX-CONTACT-1] Resolve the saved [Contact] behind a 1:1 chat row for the
  /// Copy / Share / Forward actions. Falls back to a minimal Contact built from
  /// the chat when the row isn't in the saved list (Contact.seed == uid).
  Contact _contactOf(Chat c) {
    for (final x in _contacts) {
      if (x.uid == c.seed) return x;
    }
    return Contact(uid: c.seed, name: c.name, avatarUrl: c.avatarUrl);
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
    // Live-refresh the list the instant ANY code adds/removes a contact (e.g. a
    // marketplace seller materialised on "Contact agent") — no cold restart, no
    // wait for resume. Keeps the thread visible the moment the buyer taps.
    _contactsSub = ContactsStore.changes.listen((list) {
      if (mounted) setState(() => _contacts = list);
    });
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
    _loadPendingRequests();
    // After the first frame, run the throttled Google Play update check: shows
    // the "new version available" popup if a newer build exists, and the
    // "updated to build #X" confirmation if we just restarted into an update.
    // Once per cold launch, Android-only, throttled — see UpdateService.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) UpdateService.maybePromptOnLaunch();
    });
  }

  /// [SAFE-GATE-2] Load the set of pending stranger-gate threads for the "Message
  /// requests (N)" section. No-op (and clears) when the kill switch is off, so a
  /// disabled flag renders nothing. Best-effort; a read failure leaves the last set.
  Future<void> _loadPendingRequests() async {
    if (!RemoteConfig.strangerGateEnabled) {
      if (mounted && _pendingConvs.isNotEmpty) setState(() => _pendingConvs = {});
      return;
    }
    try {
      final convs = await StrangerGateStore().pendingConvs();
      if (mounted) setState(() => _pendingConvs = convs);
    } catch (_) {/* keep last-known set */}
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
              uid: (m['s'] ?? '').toString(),
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
      final tel = telPhone(c.uid);
      final k = tel != null
          ? receptTelConvKey(_id?.uid ?? '', tel)
          : '1:${c.uid}';
      final pv = previews[k];
      final ts = pv?.ts ?? 0;
      rows.add((convKey: k, ts: ts, json: jsonEncode({
        'k': k, 'g': false, 'n': c.name, 'a': c.avatarUrl, 's': c.uid,
        'gid': '', 'mc': 0,
        'pv': pv?.text ?? '', 'ts': ts, 'me': pv?.me ?? false,
        'u': _unread[k] ?? 0, 'f': flagsFor(k),
      })));
    }
    Db.I.replaceChatList(rows).catchError((Object _) {}); // fire-and-forget
  }

  // [ISSUE-THREAD-RESTORE-1] (2026-07-09) The chat LIST renders from the
  // contacts/groups stores, but after a reinstall the message history is
  // restored by the sync hub into SQLite — 219 messages came back for
  // hdavy2002 while the list showed only the 2 vault contacts. Any 1:1
  // conversation present in the message store whose peer is missing from
  // ContactsStore is resurrected here: resolve the peer from the directory,
  // re-add them as a contact (which live-refreshes the list AND re-syncs the
  // contacts vault, so the next device gets them for free). Idempotent —
  // known peers are skipped; runs quietly in the background.
  bool _resurrecting = false;
  Future<void> _resurrectThreadsFromMessages() async {
    if (_resurrecting) return;
    _resurrecting = true;
    try {
      // Refresh the hidden-thread map (cheap; also picks up vault-restored hides).
      _hiddenThreads = await _contactsStore.hiddenThreads();
      if (mounted) setState(() {});
      final convs = await Db.I.distinctDmConvs();
      if (convs.isEmpty) return;
      final myUid = _id?.uid ?? '';
      final known = {for (final c in await _contactsStore.load()) c.uid};
      // [ISSUE-CONTACT-SEMANTICS-1] Deleted contacts are tombstoned — never
      // resurrect them from message history.
      final deleted = await _contactsStore.deletedContacts();
      var restored = 0;
      for (final conv in convs) {
        final uid = conv.convKey.startsWith('1:') ? conv.convKey.substring(2) : '';
        if (uid.isEmpty || uid == myUid || known.contains(uid)) continue;
        if (deleted.containsKey(uid)) continue;
        if (uid.startsWith('tel:')) continue; // receptionist threads have their own lane
        Contact? c;
        try { c = await Directory.resolve(uid); } catch (_) {}
        // [ISSUE-CONTACT-SEMANTICS-1] Peer no longer resolvable (deleted/test
        // account) → SKIP. The old placeholder behaviour flooded the list with
        // "Unknown user" rows (2026-07-10 report) — worthless threads nobody
        // can reply to.
        if (c == null) continue;
        try {
          await _contactsStore.add(c); // streams _changes → list refreshes live
          known.add(uid);
          restored++;
        } catch (_) {/* best-effort per peer */}
      }
      if (restored > 0) {
        Analytics.capture('threads_resurrected', {
          'count': restored,
          'convs_scanned': convs.length,
        });
      }
    } catch (_) {/* best-effort — never disturb the list */} finally {
      _resurrecting = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Coming back to the foreground: a suspended app's relay socket was likely
      // torn down by the OS — reconnect immediately (don't wait out the backoff)
      // so live delivery resumes at once, and clear the unread badge.
      _inbox?.ensureConnected();
      PushService.clearMessageBadge();
      // Ship any telemetry the background FCM isolate parked while we were away
      // (including background crashes, which are otherwise invisible).
      PushService.drainPendingBgTelemetry();
      // Re-read the LOCALLY-SAVED contacts on every resume so anything added while
      // we were backgrounded shows up on return — e.g. a marketplace seller
      // materialised by "Contact agent", or a tel-contact. The list is otherwise
      // kept in memory and only reloads on a full cold start, so a seller saved
      // while the app was away would stay invisible until the app was killed and
      // relaunched. This is a cheap on-disk read of OUR OWN contact cache — it does
      // NOT touch the device address book (that stays on-demand, Invite/Search only).
      _contactsStore.load().then((list) {
        if (!mounted) return;
        // [BLANK-GUARD] On resume the scope can be null again for a beat, so a
        // read may return empty from the 'default' bucket. Never let that wipe a
        // populated list — that's the "pull down / come back and my chats vanish"
        // bug. A genuine removal still flows through ContactsStore.changes.
        if (list.isEmpty && _contacts.isNotEmpty) {
          Analytics.capture('chat_list_blank_guard', {
            'reason': 'resume_empty',
            'had_contacts': _contacts.length,
            'scope': AccountScope.id ?? 'null',
          });
          return;
        }
        if (list.length != _contacts.length) setState(() => _contacts = list);
      });
      // NOTE: the device address book is deliberately NOT read on resume/FCM. It's
      // read on demand ONLY when the Invite/Search screen opens (device_contacts.
      // ensureFresh), so nothing contact-related can freeze the app in the
      // background. Tel-contact reconciliation piggybacks on that on-screen read.
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _inboxSub?.cancel(); // stop listening, but leave the shared SyncHub socket alive
    _contactsSub?.cancel();
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
    final fHidden = _contactsStore.hiddenThreads(); // [ISSUE-CONTACT-SEMANTICS-1]
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
    final hiddenThreads = await fHidden;
    final groups = await fGroups;
    final lastRead = await fLastRead;
    final flags = await fFlags;
    final status = await fStatus;
    final drafts = await fDrafts;
    final previews = await fPreviews;
    final enabled = await fEnabled;
    final kind = await fKind;
    final customFilters = await fFilters;
    // [BLANK-GUARD] If this load came back empty ONLY because the account scope
    // hasn't resolved yet (DiskCache/Db read the 'default' bucket), do NOT paint
    // the empty state or wipe a populated list — retry shortly until the scope is
    // ready. Bounded so a genuinely-empty account / guest still reaches the empty
    // state. A non-empty load always proceeds immediately.
    if (contacts.isEmpty && groups.isEmpty && !_scopeReady && _emptyBootRetries < 8) {
      _emptyBootRetries++;
      Analytics.capture('chat_list_blank_guard', {
        'reason': 'scope_not_ready',
        'retry': _emptyBootRetries,
        'had_contacts': _contacts.length,
        'scope': AccountScope.id ?? 'null',
      });
      if (mounted) Future.delayed(const Duration(milliseconds: 300), _bootstrap);
      return; // network refresh (GroupApi.sync etc.) waits for a real scope too
    }
    if (mounted) {
      setState(() {
        _id = id; _contacts = contacts; _groups = groups;
        _hiddenThreads = hiddenThreads;
        _lastRead = lastRead; _flags = flags; _setStatuses(status); _drafts = drafts;
        _previews = previews;
        _enabledApps = enabled; _accountKind = kind; _customFilters = customFilters;
        _booted = true; // loading done → safe to show the empty state if truly empty
        _authoritativeLoaded = true; // store data wins over the projection paint
      });
    } else {
      _authoritativeLoaded = true;
    }
    // Rich load telemetry (email auto-stamped) so blank-list regressions are
    // visible in PostHog: how many contacts/previews we painted, whether the
    // scope was ready, and how many retries it took to get here.
    Analytics.capture('chat_list_loaded', {
      'contacts': contacts.length,
      'groups': groups.length,
      'previews': previews.length,
      'scope_ready': _scopeReady,
      'retries': _emptyBootRetries,
      'scope': AccountScope.id ?? 'null',
    });
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
    // [ISSUE-THREAD-RESTORE-1] Resurrect chat threads from restored message
    // history: once shortly after boot, and again after the sync catch-up has
    // had time to replay the backlog on a fresh install.
    unawaited(_resurrectThreadsFromMessages());
    Future.delayed(const Duration(seconds: 10), () {
      if (mounted) unawaited(_resurrectThreadsFromMessages());
    });
    // NOTE: the phone address book is NOT read on cold start — it's read on demand
    // only when the user opens a contacts screen (Invite/Search). This keeps app
    // startup instant and can never freeze the app in the background.
    Analytics.identify(id.uid); // attribute diagnostics/events to this uid every app open
    // Open the InboxDO socket FIRST (P0-4): the cursor sync has zero network
    // prerequisites, and gating it behind FCM/Clerk/directory round-trips was
    // delaying new messages by up to 15-20s on flaky devices.
    _startInbox(id);
    // Register this device for incoming-call wake pushes (uid hashed at rest) —
    // fire-and-forget; not a prerequisite for message sync.
    unawaited(PushService.registerToken(id.uid));
    // Email is the human-facing id: publish email → uid so others find me by email.
    // Background task — the chat list never waits on Clerk/directory for this.
    unawaited(() async {
      try {
        final cu = await widget.clerk.currentUser();
        final prof = await ProfileStore().load();
        // Phone + email are the human-facing ids — attach them to telemetry so this
        // user's errors / slow loads / log lines are retrievable by phone or email.
        Analytics.setUserKeys(email: cu?.email, phone: prof.phone);
        if (cu != null && cu.label.isNotEmpty && mounted) setState(() => _clerkName = cu.label);
        if (cu?.email != null && cu!.email!.isNotEmpty) {
          // PERF-7 root cause: cu.label falls back to the EMAIL ADDRESS when the
          // Clerk account has no first_name, and the Worker's name moderation
          // (namePlausible: no digits/'@') 422-rejected it on EVERY launch.
          // Prefer the saved profile name; never send an email/digit "name"
          // (empty name is fine — the server COALESCEs and keeps the stored one).
          final dirName = prof.displayName.trim().isNotEmpty
              ? prof.displayName.trim()
              : (cu.label.contains('@') || cu.label.contains(RegExp(r'\d'))
                  ? ''
                  : cu.label);
          // [ISSUE-PROFILE-PUBLISH-1] (2026-07-09) Don't publish a BLANK profile.
          // On a fresh reinstall — before the server restore hydrates the local
          // profile — dirName AND phone are both empty, and this launch publish
          // got 400 `profile_incomplete` from the Worker's completeness gate on
          // EVERY cold start, for every account. Pure noise that masqueraded as
          // a restore failure in telemetry (the misnamed profile_restore_rejected).
          // The server COALESCEs and keeps its stored fields anyway, so an empty
          // publish can never contribute anything.
          if (dirName.isNotEmpty || prof.phone.trim().isNotEmpty) {
            await Directory.registerProfile(
                uid: id!.uid, email: cu.email!, name: dirName, phone: prof.phone);
          }
        }
      } catch (_) {/* not signed in / offline */}
    }());
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
        } else if (t == 'marketplace_deal') {
          // AvaMarketplace agent-negotiation result. Like 'recept', materialise the
          // counterparty as a contact so the thread APPEARS in the chat list — a
          // newly-negotiated seller isn't a contact yet, so without this the card is
          // delivered but the thread never surfaces. Also record a preview + unread.
          if (u.senderPub != id.uid) {
            final key = '1:${u.senderPub}';
            if (!_flags['blocked']!.contains(key)) {
              if (u.createdAt > (_lastRead[key] ?? 0) && mounted) {
                setState(() => _unread[key] = (_unread[key] ?? 0) + 1);
              }
              if (u.createdAt >= (_previews[key]?.ts ?? 0)) {
                final preview = env['outcome'] == 'deal'
                    ? '🤝 Your agents reached a deal'
                    : '🤝 Your agents finished negotiating';
                _previewStore.record(key, preview, u.createdAt, false).then((_) {
                  if (mounted) _previewStore.load().then((p) { if (mounted) setState(() => _previews = p); });
                });
              }
              _ensureContact(u.senderPub);
            }
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
          if (env['gid'] == null) _ensureContact(u.senderPub);
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

  final Set<String> _autoAdding = {}; // uids currently being auto-added (dedupe)
  Future<void> _ensureContact(String uid) async {
    if (uid.isEmpty || uid == _id?.uid) return;
    if (_contacts.any((c) => c.uid == uid) || !_autoAdding.add(uid)) return;
    final placeholder = Contact(
        uid: uid,
        name: uid.length > 14 ? '${uid.substring(0, 10)}…${uid.substring(uid.length - 4)}' : uid);
    var list = await _contactsStore.add(placeholder);
    if (mounted) setState(() => _contacts = list);
    try {
      final resolved = await Directory.resolve(uid);
      if (resolved != null && resolved.uid == uid) {
        list = await _contactsStore.add(resolved); // de-dupes on uid
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
    final uid = telNpub(e164);
    if (e164.isEmpty || _contacts.any((c) => c.uid == uid) || !_autoAdding.add(uid)) return;
    final name = (callerName != null && callerName.trim().isNotEmpty)
        ? callerName.trim()
        : formatTelDisplay(e164);
    final list = await _contactsStore.add(
        Contact(uid: uid, name: name, phone: e164, handle: kProvisionalContactHandle));
    if (mounted) setState(() => _contacts = list);
  }

  /// Auto-promote provisional `tel:<E.164>` receptionist contacts to real AvaTOK
  /// accounts once the device-contacts match sync discovers that number IS on
  /// AvaTOK (i.e. the caller is in the owner's address book and has since joined,
  /// or was already a user). Folds the synthetic row into the real uid via
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
      final e164 = telPhone(c.uid);
      if (e164 == null) continue;
      final d = matched[e164];
      if (d == null || d.uid == myUid) continue;
      // Preserve a name the owner explicitly saved; otherwise take the matched
      // profile/device name.
      final namedByUser = !isProvisionalContact(c) && c.name.trim().isNotEmpty;
      final name = namedByUser
          ? c.name
          : (d.displayName.isNotEmpty ? d.displayName : formatTelDisplay(e164));
      final real = Contact(uid: d.uid, name: name, handle: d.handle,
          avatarUrl: d.avatarUrl, phone: e164);
      final list = await _contactsStore.mergeTel(e164, real);
      // Move the voicemail cards into the real DM thread.
      final from = receptTelConvKey(myUid, e164);
      final to = '1:${d.uid}';
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
    if (c.uid.isEmpty || c.uid == _id?.uid) {
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

  /// New-chat menu (the green FAB): chat with Ava, message, group, or invite.
  void _openNewChatMenu() {
    _showActionSheet(
      children: (ctx) => [
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
      ],
    );
  }

  void _openSearch() {
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => SearchScreen(identity: _id, contacts: _contacts, groups: _groups)))
        .then((_) => _flagsStore.load().then((f) { if (mounted) setState(() => _flags = f); }));
  }

  /// Open the AvaPhone dialer (PSTN-style calling/SMS over AvaTOK numbers).
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
      final tel = telPhone(c.uid);
      if (tel != null) return receptTelConvKey(_id?.uid ?? '', tel);
      return '1:${c.uid}';
    }
    final contactChats = _contacts.where((c) {
      final k = contactKey(c);
      // [ISSUE-CONTACT-SEMANTICS-1] "Remove contact" hides the THREAD but keeps
      // the contact. A row stays hidden while its last message is older than the
      // hide timestamp — any newer message (sent or received) resurrects it.
      final hiddenAt = _hiddenThreads[c.uid];
      if (hiddenAt != null) {
        final ts = _previews[k]?.ts ?? 0;
        final tsMs = ts > 0 && ts < 100000000000 ? ts * 1000 : ts; // s → ms
        if (tsMs <= hiddenAt) return false;
      }
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
        name: (_clerkName?.isNotEmpty ?? false) ? _clerkName! : (_id?.shortId ?? 'Account'),
        seed: _id?.uid ?? 'avatok',
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
      // No bottom nav bar anymore (2026-07-12 redesign): the persistent shell-wide
      // AppSwitcherBar (AvaTOK · AvaDialer · Marketplace · Ava) owns the bottom of
      // the screen. AvaTOK's own Chat/Community/Call-log sections are a colored
      // top tab strip instead — same pattern as AvaDialer's tab strip. The old
      // "Dialpad" shortcut is gone entirely: AvaTOK is a pure messenger now
      // (WhatsApp-like); dialing PSTN numbers is AvaDialer's job.
      body: Column(children: [
        _AvaTokTabStrip(
          selectedIndex: _tab,
          onSelected: (i) => setState(() => _tab = i),
          chatUnread: _unread.values.fold<int>(0, (a, b) => a + b) > 0,
          communityInvites: _groupInvites,
        ),
        Expanded(
          child: IndexedStack(index: _tab, children: [
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
                  // [SAFE-GATE-2] "Message requests (N)" — pending stranger-gate
                  // threads, collapsed at the very top (only on the All filter).
                  if (_filter == 'all') ..._messageRequestsSection(),
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
                          Flexible(
                              child: Text('Archived',
                                  maxLines: 1, overflow: TextOverflow.ellipsis,
                                  style: ZineText.value(size: 15))),
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
        GroupsTab(
            identity: _id,
            contacts: _contacts,
            onMenu: () => _scaffoldKey.currentState?.openDrawer()),
        const CallsScreen(),
          ]),
        ),
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
                ? Image.memory(s.data!, width: sz, height: sz, fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => const SizedBox.shrink())
                : Avatar(seed: _id?.uid ?? 'me', name: 'You', size: sz),
          ),
        ),
      );
    } else {
      inner = Avatar(seed: _id?.uid ?? 'me', name: 'You', size: sz);
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

/// AvaTOK's own colored tab strip (2026-07-12 redesign) — Chat · Community ·
/// Call log — rendered below the app bar, same pattern as AvaDialer's tab strip.
/// Replaces the old bottom NavigationBar (Chats/Dialpad/Groups/Calls): the
/// bottom of the screen now belongs to the shell-wide [AppSwitcherBar].
class _AvaTokTabStrip extends StatelessWidget {
  final int selectedIndex;
  final ValueChanged<int> onSelected;
  final bool chatUnread;
  final int communityInvites;
  const _AvaTokTabStrip({
    required this.selectedIndex,
    required this.onSelected,
    required this.chatUnread,
    required this.communityInvites,
  });

  static const _items = [
    (Icons.chat_bubble_outline, Icons.chat_bubble, 'Chat', Zine.mint),
    (Icons.groups_outlined, Icons.groups, 'Community', Zine.lilac),
    (Icons.history_outlined, Icons.history, 'Call log', Zine.blue),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (var i = 0; i < _items.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              _tab(i),
            ],
          ],
        ),
      ),
    );
  }

  Widget _tab(int i) {
    final (icon, selectedIcon, label, color) = _items[i];
    final selected = i == selectedIndex;
    final fg = Zine.ink;
    final showDot = i == 0 && chatUnread;
    final showCount = i == 1 && communityInvites > 0;
    return GestureDetector(
      onTap: () => onSelected(i),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? color : Zine.card,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: selected ? Zine.shadowXs : const [],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Stack(clipBehavior: Clip.none, children: [
            Icon(selected ? selectedIcon : icon, size: 17, color: fg),
            if (showDot)
              Positioned(
                right: -2, top: -2,
                child: Container(
                  width: 8, height: 8,
                  decoration: const BoxDecoration(color: Zine.coral, shape: BoxShape.circle),
                ),
              ),
          ]),
          const SizedBox(width: 6),
          Text(label, style: ZineText.tag(size: 12.5, color: fg)),
          if (showCount) ...[
            const SizedBox(width: 5),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(color: Zine.coral, borderRadius: BorderRadius.circular(100)),
              child: Text('$communityInvites',
                  style: ZineText.tag(size: 10, color: Colors.white)),
            ),
          ],
        ]),
      ),
    );
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
