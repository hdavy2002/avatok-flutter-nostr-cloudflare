import 'dart:async';
import 'dart:math' as math;
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:video_compress/video_compress.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';
import 'package:super_clipboard/super_clipboard.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/avatar_cache.dart';
import '../../core/ava_ai_client.dart';
import '../../core/composer_ai.dart';
import '../translation/ondevice_translate.dart';
import '../../core/ava_contracts.dart';
import '../../core/brain_consent.dart';
import '../../core/feature_flags.dart';
import '../ava_companion/companion_thread.dart';
import '../avachat/discuss_seed.dart';
import '../avachat/thread_context.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_ondevice_stt.dart';
import '../../core/ui/mic_input_sheet.dart';
import '../../core/avatar.dart';
import '../../core/cached_image.dart';
import '../../core/ava_identity.dart';
import '../../core/chat_state.dart';
import '../../core/wallpaper.dart';
import '../../core/config.dart';
import '../../core/calls/call_session_manager.dart';
import '../../core/ice_cache.dart';
import '../../core/profile_store.dart';
import '../../core/drive_service.dart';
import '../../core/library_api.dart';
import '../../core/rag_service.dart';
import '../library/library_picker.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/group_store.dart';
import '../../core/message_store.dart';
import '../../identity/identity.dart';
import '../../core/db.dart';
import '../../core/device_contacts.dart';
import '../../sync/dm.dart';
import '../../sync/outbox.dart';
import '../../sync/group_dm.dart';
import '../../sync/party/party_hub.dart';
import '../../sync/legacy_stubs.dart';
import '../../sync/presence.dart';
import '../../sync/sync_hub.dart';
import '../../push/push_service.dart';
import '../../core/remote_config.dart';
import '../ava/ava_invoke.dart';
import 'ava_email.dart';
import 'file_viewer_screen.dart';
import '../genui/a2ui_renderer.dart';
import '../../core/apps_service.dart';
import '../conference/conference_api.dart';
import '../conference/conference_screen.dart';
import '../conference/mesh_api.dart';
import '../conference/mesh_call_screen.dart';
import '../conference/sfu_group_call_api.dart';
import '../conference/sfu_group_call_screen.dart';
import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/live_location_service.dart';
import 'call_screen.dart';
import 'contact_profile_screen.dart';
import 'contacts.dart';
import '../messaging/widgets/stranger_gate_bar.dart'; // STREAM B
import 'stranger_gate_api.dart'; // STREAM B (stranger safety gate)
import 'forward_sheet.dart';
import 'chat_media_cards.dart';
import '../messaging/widgets/link_preview_card.dart';
import 'data.dart';
import '../ava_guardian/guardian_settings.dart'; // shield watchdog (Nemotron) per-chat toggle
import 'live_location.dart';
import 'group_info_screen.dart';
import 'media.dart';
import 'media_library_screen.dart';
import 'unknown_caller.dart';
import 'video_player_screen.dart';
// STREAM G (AI in chats): catch-up card, smart-reply chips, inline translate.
import '../messaging/ai_chat_api.dart';
import '../messaging/widgets/catchup_card.dart';
import '../messaging/widgets/smart_reply_chips.dart';
import '../messaging/widgets/translated_text.dart';
// STREAM J (D17): auto-download policy + tap-to-download placeholder.
import '../../core/media_auto_download.dart';
import '../messaging/widgets/media_download_placeholder.dart';
// STREAM E: WhatsApp-parity input bar + emoji/GIF/sticker panel.
import '../messaging/widgets/rich_input_bar.dart';
import '../messaging/widgets/gif_api.dart';
import '../messaging/widgets/picker_recents_store.dart';
import '../messaging/widgets/sticker_media.dart';

/// AvaTok conversation thread — bubbles, media (photo/video/file/voice),
/// long-press reactions, forward / delete, calls (1:1 or group), ⋮ overflow.
class ChatThreadScreen extends StatefulWidget {
  final Chat chat;
  const ChatThreadScreen({super.key, required this.chat});
  @override
  State<ChatThreadScreen> createState() => _ChatThreadScreenState();
}

class _Msg {
  final int id;
  final bool me;
  String text;
  final String time;
  final int ts; // sort key (epoch seconds; 0 for demo)
  String? evId; // rumor id (real DMs) — set after media upload too
  final String? senderLabel; // group: who sent (null for mine / 1:1)
  String? reaction;
  Map<String, int> reactCounts = {}; // Phase 4: aggregate live reactions (emoji → count)
  Map<String, Set<String>> reactBy = {}; // Phase 5: who reacted (emoji → set of uids) for the "reacted by" sheet
  ChatMedia? media;
  String mediaCaption; // caption shown UNDER the photo in the SAME bubble (WhatsApp-style)
  Uint8List? localBytes; // instant preview of self-sent media
  bool uploading;
  bool fileOpening = false; // [CHAT-PDFVIEW-1] tap→download/decrypt in progress (bubble spinner)
  bool failed;
  bool sent; // relay ACKed this event (["OK", id, true]) — it's on the relay
  Map<String, dynamic>? replyTo; // {id, preview, who}
  bool edited;
  bool starred;
  bool forwarded;
  bool hidden; // soft-deleted on MY device: shown as "deleted" + Undo; data retained
  int? expireAt; // epoch secs after which the message disappears
  String? special; // 'loc' | 'card' | 'poll' | 'sticker'
  Map<String, dynamic>? extra;
  bool aiLocal; // a PRIVATE @ava question — local-only, never sent to the peer (no delivery ticks)
  // Poll tallies (2026-07-04) — server-persisted (survive reinstall). Hydrated
  // from GET /api/poll/state on open and kept live via {t:'vote'} envelopes.
  Map<int, int> pollVotes = {}; // option index → vote count (server-authoritative)
  Map<int, Set<String>> pollBy = {}; // option index → set of voter uids (who-voted)
  Set<int> pollMine = {}; // option indices I currently voted for (drives highlight)
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.senderLabel, this.reaction, this.media, this.mediaCaption = '', this.localBytes,
       this.uploading = false, this.failed = false, this.sent = false, this.replyTo, this.edited = false,
       this.starred = false, this.forwarded = false, this.hidden = false, this.expireAt, this.special, this.extra,
       this.aiLocal = false});
}

/// One semantic ("smart search") hit returned by /api/brain/thread-search and
/// resolved against the local transcript. [localId] is the matched `_Msg.id` when
/// the snippet fuzzy-matches a message loaded in THIS thread (tappable → scrolls
/// to it); null means the hit is "from your other chats" (hidden by default).
class _AiHit {
  final String snippet;   // server snippet (may carry a "Me: "/"Them: " label)
  final bool inThread;    // server's coarse this-conversation guess
  final int? localId;     // matched local _Msg.id, else null
  final String localText; // the matched local message text (for display)
  _AiHit(this.snippet, this.inThread, this.localId, this.localText);
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  // STREAM J (D17): whether incoming media auto-downloads on render in THIS
  // thread. Resolved once on open from MediaAutoDownload.shouldAutoFetch (mode +
  // connectivity + accept_state). Defaults to true so behavior is unchanged until
  // the async check resolves — the check runs in initState and repaints. When
  // false, media bubbles render a tap-to-download placeholder instead of eagerly
  // fetching. A manual tap always downloads regardless.
  bool _mediaAutoFetch = true;
  // Recipient thread accept-state (§B1): 'pending' | 'accepted' | 'blocked' or
  // null when unknown. Stranger-gate (Stream B) will populate this; until then it
  // stays null (treated as accepted). A 'pending' thread NEVER auto-downloads.
  String? _threadAcceptState;
  final _ctrl = TextEditingController();
  final _searchCtrl = TextEditingController(); // in-thread search box (literal + AI)
  final _composerFocus = FocusNode(); // keep the keyboard up after each send
  final _scroll = ScrollController();
  final _picker = ImagePicker();
  final _audio = AudioPlayer();
  final _sfx = AudioPlayer();
  final _recorder = AudioRecorder();
  final _idStore = IdentityStore();
  final _msgStore = MessageStore();
  // F3 (restoreV2): deep-archive scroll pager. When the user scrolls PAST the
  // local hot window, older messages are paged in from /api/archive/page and
  // cached per-conversation so a page is fetched at most once (ever).
  final _archiveStore = ArchivePageStore();
  int? _archiveCursor;            // next `before` (InboxDO id); null ⇒ start at newest
  bool _archiveDone = false;      // the archive is exhausted (no older pages)
  bool _archiveLoading = false;   // a page fetch is in flight
  bool _hasArchived = false;      // ≥1 archived message shown ⇒ render the divider
  // F6: received guardian safety flags, keyed by the flagged message's client id
  // (msg_id / rumorId). Persisted per-account so the red bubble survives reopen;
  // a locally-dismissed ("This is fine") flag is kept out of this set.
  final _safetyStore = SafetyFlagStore();
  final Map<String, String> _safetyFlaggedIds = {}; // rumorId → category (active reds)
  StreamSubscription? _safetySub;
  Timer? _persistTimer;
  String? _myNpub;
  String? _myName;
  String _myAvatarUrl = ''; // my own photo, for the avatar beside my bubbles
  int _seq = 0;
  bool _hasText = false;
  // Premium = topped-up wallet / active subscription. Gates the @ava·#ava
  // composer hint (paid users only) — loaded in initState via MoneyApi.
  bool _premium = false;
  bool _recording = false;
  String? _recPath;
  // Live voice-to-text (on-device Whisper) — types into the composer as you speak.
  SttSession? _sttSession;
  bool _sttActive = false;
  bool _sttPreparing = false; // model loading between tap and "Listening…"

  // STREAM G [GROUP-AI-1] group catch-up ("What did I miss?").
  List<CatchupBullet> _catchupBullets = const [];
  int _catchupCount = 0;
  bool _catchupDismissed = false;
  bool _catchupLoading = false;
  // STREAM G [GROUP-AI-4] smart replies (DMs). Chips above the input bar.
  List<String> _smartReplies = const [];
  Timer? _smartReplyDebounce;
  // STREAM G [GROUP-AI-2/3] per-group "translate this group for me" toggle.
  bool _groupTranslateOn = false;
  bool _groupTranslateBusy = false;

  // Server-routed DM (Cloudflare-native transport) for contacts.
  AvaDm? _dm;
  AvaGroupDm? _gdm;
  Group? _group;
  bool _isGroup = false;
  NostrClient? _nostr;
  bool _realMode = false;
  final Set<String> _seenEv = {};
  int? _playingAudioId;
  // [UI-BUBBLE-3] Voice-note playback speed chip (1x / 1.5x / 2x). Applied to the
  // shared _audio player on play and when the chip is tapped mid-playback.
  double _audioSpeed = 1.0;

  // Presence: typing + read receipts (ephemeral, over the signaling WS).
  PresenceChannel? _presence;
  // Floating-emoji bursts (live reactions + bursts ride PartyKit — see _partyJoin).
  final List<_BurstFx> _burstFx = [];       // active floating-emoji animations (PartyKit bursts)
  int _burstSeq = 0;
  // Live location (WhatsApp-style): one session per share id. The pin moves via
  // ephemeral 'liveloc' presence frames; the durable 't:'live'' bubble anchors
  // it. _liveBroadcaster is non-null only while *I* am actively sharing.
  final Map<String, LiveLocationSession> _live = {};
  LiveLocationBroadcaster? _liveBroadcaster;
  final Map<String, int> _liveViewTelemetryTs = {}; // throttle receiver views
  int _liveTickTelemetryTs = 0; // throttle sender tick telemetry
  bool _peerTyping = false;
  String? _typingWho;
  int _peerReadTs = 0;
  Timer? _typingClear;
  Timer? _myTypingOff;
  // Phase 5: live clock — refreshes relative timestamps + day separators so
  // "Today" rolls to "Yesterday" and "last seen" stays current without a reload.
  Timer? _clockTimer;
  // Phase 5: floating reaction pill (anchored to the bubble on long-press).
  OverlayEntry? _reactionOverlay;

  // Reply / edit / star.
  _Msg? _replyTo;
  _Msg? _editing;
  final _starStore = StarStore();
  Set<String> _starred = {};
  String? _peerNpub; // 1:1 recipient uid for message notifications
  List<String> _memberUids = []; // group recipient uids (excl me)
  String? _convKey; // '1:<hex>' or 'g:<gid>' for read state / unread badges
  // STREAM B (SAFE-GATE): the SERVER conv id (dm_lo__hi) + whether this thread is
  // a pending stranger gate (non-contact). When true the composer is replaced by
  // the StrangerGateBar and media/link-previews are suppressed in bubbles.
  String? _serverConv;
  bool _strangerGatePending = false;
  // Show the Accept/Decline/Block/Report overlay exactly once per thread open
  // when a pending stranger gate is detected (owner request: opening a request
  // from a non-contact must prompt a decision, not just swap the composer bar).
  bool _gatePromptShown = false;
  PartyRoom? _party;               // PartyKit live layer for this thread (ephemeral, gated)
  StreamSubscription? _partySub;
  Identity? _meId;
  // Unknown-number receptionist thread (caller has no AvaTOK account). When set,
  // the thread is a read-only voicemail record keyed by the caller's phone.
  bool _isTelThread = false;
  String _telPhone = ''; // E.164 of the caller for a tel: thread
  bool _callerSaved = true; // false ⇒ show the "Save to contacts" affordances
  bool _saveBannerDismissed = false;
  // Shield watchdog (Ava guardian) state for THIS chat. Green shield = on.
  GuardianPrefs _guardian = GuardianPrefs.off;
  // G1.3: minor accounts have Guardian force-ON (server ignores secure_chat=0 for
  // minors). The shield renders locked-on with no toggle for a minor.
  bool _isMinorAccount = false;
  // created_at (ms) of incoming messages Ava flagged as unsafe → painted RED so
  // they're an obvious red flag to the child. Populated from guardian warnings.
  final Set<int> _flaggedTs = <int>{};
  // Cross-device soft-delete flags (rumorId → hidden), seeded from the InboxDO on
  // /sync so a fresh device shows my deleted messages hidden on a cold open.
  final Map<String, bool> _hiddenIds = {};
  // HARD-delete tombstones (delete-for-everyone RECEIVED from a peer), seeded from
  // the durable [DeletedStore] so a message a peer deleted stays deleted across
  // cold opens — even if my thread was closed when the delete arrived.
  final Set<String> _deletedIds = {};
  int _disappearSecs = 0; // per-chat disappearing timer (0 = off)
  int _peerDeliveredTs = 0;
  bool _peerOnline = false;
  bool _sharePresence = true;
  Timer? _onlineClear;
  Timer? _onlineHeartbeat;           // re-announce "online" every 20s while open
  int _peerLastSeen = 0;             // unix seconds; 0 = unknown
  int _lastSeenPersistTs = 0;        // throttle last-seen disk writes
  String? _presenceMe;               // the label we announce as (ignore our echo)
  Map<String, String>? _pinned; // {id, text}
  bool _searchMode = false;
  String _searchQuery = '';
  // ---- in-thread "smart search" (semantic, over the user's own AI Search) ----
  // Literal search stays instant/offline; smart search is an EXTRA step, run only
  // when the user taps "Search with AI" (or has no literal hit). State is reset
  // whenever the query text changes so stale AI results never show for a new query.
  bool _aiSearching = false;                 // request in flight (spinner)
  String _aiSearchedQuery = '';              // the query the current hits answer
  bool _aiSearchError = false;               // last request failed
  bool _aiBrainOff = false;                  // messaging AvaBrain toggle is off
  bool _aiShowOther = false;                 // reveal "from your other chats" hits
  List<_AiHit> _aiHits = const [];           // matched + unmatched semantic hits
  Map<String, String> _memberNames = {}; // hex → name (group mentions)
  String _wallpaperId = 'default';
  List<String> _mentionMatches = [];

  // Composer quick-tools (Translate · Fix grammar · Rewrite · Reply ideas).
  // Each runs ONE Ava text call (AvaAiClient.ask) and drops the result straight
  // back into the input box so the user just hits send. _aiTool is the chip
  // currently spinning (null = idle); _aiBusy locks the row to one job at a time.
  bool _aiBusy = false;
  String? _aiTool;
  final FlutterSecureStorage _aiPrefs = const FlutterSecureStorage();
  static const _kTransLangKey = 'composer_translate_lang';
  // Per-account "hide deleted messages" preference: when on, both the slim
  // "You deleted this message" pills and peer "This message was deleted"
  // tombstones are collapsed out of the thread so it stays clean. Keyed per
  // conversation so the choice is remembered for THIS chat.
  static const _kHideDeletedKey = 'chat_hide_deleted';
  bool _hideDeleted = false;
  // Remembered translate target (account-scoped). Defaults to Spanish until the
  // saved value loads / the user picks another.
  String _transLangCode = 'Spanish';
  ComposerLang get _transLang => ComposerAi.langByCode(_transLangCode);

  Timer? _markReadTimer;

  void _markRead() {
    final key = _convKey;
    if (key == null) return;
    final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    // Local: drives unread badges on THIS device (instant).
    ReadStateStore().setRead(key, nowSec);
    // Server: persist MY read position in my own InboxDO so a fresh login or a
    // second device (e.g. desktop) restores it and stops recounting already-read
    // messages as new. Best-effort — never blocks the UI.
    //
    // COALESCE the server POST: _markRead fires on init, on every incoming
    // message, and on each Ava stream frame, so an un-debounced POST-per-call
    // turns a brief token gap (e.g. just after a backgrounded app-connect OAuth
    // round-trip) into a 401 STORM that blanks the thread. Debounce to at most
    // one POST every few seconds; only the latest read position matters anyway.
    final myUid = _meId?.uid;
    if (myUid == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    _markReadTimer?.cancel();
    _markReadTimer = Timer(const Duration(seconds: 3), () {
      final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      ApiAuth.postJson(kMsgReadUrl, {'conv': conv, 'read_ts': ts})
          .then((_) {}, onError: (_) {});
      // DURABLE read receipt to the PEER (1:1) so their bubbles turn blue (Read)
      // even if they're offline now — they pick it up on their next /sync. The
      // ephemeral presence read only worked when both were online at once, which
      // is why ticks were stuck on "Sent" (owner report 2026-06-27).
      if (_dm != null) _dm!.sendReceipt('read', ts);
    });
  }

  /// PartyKit live layer for THIS conversation (ephemeral; gated by RemoteConfig
  /// `partyEnabled` — a dormant no-op until the PartyDO is deployed + flipped on,
  /// so this is safe to ship dark). Joins `thread:<serverConv>` and reacts to the
  /// live events the Worker broadcasts. Today it handles the marketplace
  /// `deal_ready` nudge — the instant the negotiation result lands in our InboxDO,
  /// pull it NOW (forceResync) so the card appears without waiting out the poll.
  /// Typing / receipt / reaction rendering hang off this same room next.
  void _partyJoin(String myUid) {
    final key = _convKey;
    if (key == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    try {
      final room = PartyHub.I.join('thread:$conv');
      _party = room;
      _partySub = room.events.listen((e) {
        final t = e['t'];
        if (t == 'new') {
          // P13-B PartyKit delivery hint: a peer just sent to this thread. Do a
          // targeted cursor sync NOW instead of waiting for the hub frame. Hint
          // only — InboxDO is the source of truth, so a missed hint is harmless.
          try { SyncHub.I.syncFromPush(); } catch (_) {}
        } else if (t == 'deal_ready') {
          try { SyncHub.I.forceResync(); } catch (_) {} // marketplace card lands instantly
        } else if (t == 'reaction') {
          _applyPartyReaction(e); // live per-message reaction (#4)
        } else if (t == 'burst') {
          final em = e['emoji']?.toString();
          if (em != null && em.isNotEmpty) _spawnBurst(em); // floating-emoji burst
        }
      });
    } catch (_) {/* party is best-effort */}
  }

  /// Apply a peer's live reaction (PartyKit) to the aggregate count + "reacted by"
  /// set on the target bubble — same logic the retired Ably path used.
  void _applyPartyReaction(Map<String, dynamic> e) {
    final mid = e['mid']?.toString();
    final emoji = e['emoji']?.toString();
    if (mid == null || emoji == null) return;
    final add = e['add'] == true;
    final who = (e['from'] ?? '').toString();
    final whoName = (e['whoName'] ?? '').toString();
    if (whoName.isNotEmpty && who.isNotEmpty && _memberNames[who] != whoName) {
      _memberNames[who] = whoName;
    }
    final i = _msgs.indexWhere((m) => m.evId == mid);
    if (i < 0) return;
    setState(() {
      final msg = _msgs[i];
      final c = msg.reactCounts;
      c[emoji] = ((c[emoji] ?? 0) + (add ? 1 : -1)).clamp(0, 9999);
      if (c[emoji] == 0) c.remove(emoji);
      final by = msg.reactBy.putIfAbsent(emoji, () => <String>{});
      if (add) { by.add(who); } else { by.remove(who); }
      if (by.isEmpty) msg.reactBy.remove(emoji);
    });
  }

  @override
  void initState() {
    super.initState();
    // Opening a thread nudges a catch-up sync: a server-injected message (e.g. a
    // marketplace agent-deal card, or a receptionist card) is appended directly to
    // the InboxDO and only arrives on a fresh sync — if the socket wasn't connected
    // when it landed, the thread would look empty. This probes/reconnects so the
    // missing message pulls in right as you open the chat.
    try { SyncHub.I.onAppResumed(); } catch (_) {}
    // STREAM J (D17): resolve whether incoming media should auto-download in this
    // thread (mode + connectivity + accept_state). Non-blocking; repaints once
    // known so media bubbles render either the real preview or a tap-to-download
    // placeholder. A 'pending' stranger thread never auto-downloads in any mode.
    MediaAutoDownload.shouldAutoFetch(acceptState: _threadAcceptState).then((v) {
      if (mounted && v != _mediaAutoFetch) setState(() => _mediaAutoFetch = v);
      else _mediaAutoFetch = v;
    });
    // STREAM E: load the account-scoped picker recents (emoji/GIF/sticker) +
    // last-known keyboard height so the rich input panel opens instantly.
    // ignore: unawaited_futures
    PickerRecentsStore.I.load().then((_) { if (mounted) setState(() {}); });
    // Phase 5: tick a lightweight clock so relative timestamps, day separators
    // and the "last seen" header stay live without the user reloading the thread.
    _clockTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
    // F6: restore persisted guardian safety flags (red bubbles) + subscribe to
    // live safety_flag frames pushed to me over the shared InboxDO socket.
    _safetyStore.load().then((all) {
      if (!mounted || all.isEmpty) return;
      setState(() {
        for (final e in all.entries) {
          if (e.value['dismissed'] == true) continue; // "This is fine" — stay hidden
          _safetyFlaggedIds[e.key] = (e.value['category'] ?? '').toString();
        }
      });
    });
    _safetySub = SyncHub.I.safetyFlags.listen((f) {
      if (!mounted) return;
      // Only flags for THIS conversation repaint here (the store already persisted
      // it for every conv). Match on the derived convKey the hub emits.
      if (_convKey != null && f['convKey'] != _convKey) return;
      final msgId = (f['msg_id'] ?? '').toString();
      if (msgId.isEmpty) return;
      setState(() => _safetyFlaggedIds[msgId] = (f['category'] ?? '').toString());
    });
    // F3 (restoreV2): pull older history a page at a time as the user scrolls to
    // the top of the hot window. Guarded by the flag inside _maybePageArchive.
    _scroll.addListener(_maybePageArchive);
    // Paid status — drives the paid-only @ava·#ava composer hint.
    MoneyApi.balance().then((b) {
      if (mounted) setState(() => _premium = b['premium'] == 1 || b['premium'] == true);
    }).catchError((_) {});
    _audio.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playingAudioId = null);
    });
    // Load cross-device soft-delete flags, then re-apply to anything already shown.
    HiddenStore().load().then((m) {
      if (!mounted || m.isEmpty) return;
      setState(() {
        _hiddenIds.addAll(m);
        for (final msg in _msgs) {
          if (msg.evId != null && m[msg.evId] == true) msg.hidden = true;
        }
      });
    });
    // Re-apply peer hard-deletes (delete-for-everyone) on a cold open, then tombstone
    // anything already on screen that a peer deleted while this thread was closed.
    DeletedStore().load().then((s) {
      if (!mounted || s.isEmpty) return;
      setState(() {
        _deletedIds.addAll(s);
        for (final msg in _msgs) {
          if (msg.evId != null && s.contains(msg.evId)) _tombstone(msg);
        }
      });
    });
    _idStore.load().then((id) {
      if (!mounted || id == null) return;
      setState(() { _myNpub = id.uid; _myName = id.shortId; _meId = id; });
      _setupDm(id);
    });
    ProfileStore().load().then((p) {
      if (!mounted) return;
      setState(() { if (p.displayName.isNotEmpty) _myName = p.displayName; _sharePresence = p.sharePresence; _myAvatarUrl = p.avatarUrl; _isMinorAccount = p.isMinor; });
    });
    _starStore.load().then((s) { if (mounted) setState(() => _starred = s); });
    // Restore the remembered translate target (account-scoped — a parent and a
    // child sharing the phone keep separate defaults).
    readScoped(_aiPrefs, _kTransLangKey).then((code) {
      if (mounted && code != null && code.isNotEmpty) {
        setState(() => _transLangCode = code);
        // Deferred: warm the on-device model for the remembered language in the
        // background so the first Translate tap is already instant (pic4).
        OnDeviceTranslate.I.prefetch(code);
      }
    }).catchError((_) {});
    // Restore the per-conversation "hide deleted messages" choice.
    readScoped(_aiPrefs, '${_kHideDeletedKey}_${widget.chat.seed}').then((v) {
      if (mounted && v == '1') setState(() => _hideDeleted = true);
    }).catchError((_) {});
    _pruneTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (mounted && _msgs.any((m) => m.expireAt != null && m.expireAt! < nowS)) {
        setState(() => _msgs.removeWhere((m) => m.expireAt != null && m.expireAt! < nowS));
      }
    });
    // Group conferencing (Phase 10): poll for an ongoing LiveKit call so the
    // "tap to join" banner appears/disappears while the thread is open.
    if (widget.chat.gid != null || widget.chat.group) _startConfPolling();
  }

  Timer? _pruneTimer;

  void _setupDm(Identity id) {
    if (widget.chat.gid != null) { _setupGroup(id); return; }
    if (widget.chat.group) return; // legacy local group
    final seed = widget.chat.seed;
    final tel = telPhone(seed);
    if (tel != null) { _setupTelThread(id, tel); return; } // unknown-number voicemail
    final peerHex = seed;
    if (peerHex.isEmpty) return; // no addressable peer id → keep local echo
    _realMode = true;
    setState(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _dm = AvaDm(client: _nostr!, myPriv: id.uid, myPub: id.uid, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.sendStatus.listen(_onSendStatus);
    _dm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomFor1on1(id.uid, peerHex), id.shortId,
        convKey: '1:$peerHex', peerUid: peerHex)..connect();
    _presence!.events.listen(_onPresence);
    _presence!.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    if (_sharePresence) _presence!.sendOnline();
    _startPresenceHeartbeat();
    _loadLastSeen();
    _peerNpub = seed; // contact uid, for message notifications
    _convKey = '1:$peerHex';
    // STREAM B (SAFE-GATE-1/2): compute the SERVER conv id (dm_lo__hi) and, for a
    // non-contact peer, gate the thread. Fire-and-forget; the gate bar renders
    // once _strangerGatePending flips true.
    _serverConv = dmConvIdFor(id.uid, peerHex);
    _initStrangerGate(peerHex);
    _partyJoin(id.uid); // PartyKit live layer (deal-ready nudge etc.); no-op until flag on
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    // Seed instantly from the shared hub's in-memory store (this session).
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    // Durable history from the local SQLite DB — the source of truth. Covers
    // messages received in PAST sessions while this thread was closed (the hub
    // stored them in the DB even though no open thread cached them). _onDm dedups
    // by rumor id, so this never double-renders what's already shown.
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled(); // open ON the latest message, not mid-thread
      // STREAM B: re-evaluate the stranger gate now that history (inbound/outbound)
      // is loaded — the initial call ran before _msgs was populated.
      _initStrangerGate(peerHex);
    });
    // Restore persisted delivery/read marks so ticks are correct immediately on
    // reopen (before any fresh receipt arrives) — survives app restarts.
    ReceiptStore().get(_convKey!).then((r) {
      if (!mounted) return;
      setState(() {
        if (r.delivered > _peerDeliveredTs) _peerDeliveredTs = r.delivered;
        if (r.read > _peerReadTs) _peerReadTs = r.read;
      });
    });
    _markRead();
    _loadChatExtras();
    _loadCachedMessages();
  }

  /// Set up a READ-ONLY unknown-number receptionist thread. The caller has no
  /// AvaTOK account, so there is no live peer to message — this is purely the
  /// owner's voicemail record. We load the stored receptionist cards from the
  /// hub + local DB under the deterministic `g:recept_<me>__tel:<phone>` key and
  /// decide whether to show the "Save to contacts" affordances.
  void _setupTelThread(Identity id, String phone) {
    _realMode = true;
    _isTelThread = true;
    _telPhone = phone;
    _convKey = receptTelConvKey(id.uid, phone);
    setState(() => _msgs.clear());
    // Seed from the in-memory hub store, then durable history from SQLite.
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled();
    });
    // Is this caller already a saved contact? (A provisional `tel:` row counts
    // as "in the list" but NOT as saved until the owner names them.)
    ContactsStore().load().then((cs) {
      if (!mounted) return;
      setState(() => _callerSaved = callerIsSaved(cs, phone));
    });
    _markRead();
    _loadChatExtras();
  }

  Future<void> _loadChatExtras() async {
    final key = _convKey;
    if (key == null) return;
    final draft = (await DraftStore().load())[key];
    final timer = (await ChatTimerStore().load())[key];
    final pin = (await PinnedMsgStore().load())[key];
    final wp = await WallpaperStore().load();
    if (!mounted) return;
    setState(() {
      if (draft != null && draft.isNotEmpty && _ctrl.text.isEmpty) { _ctrl.text = draft; _hasText = true; }
      _disappearSecs = int.tryParse(timer ?? '') ?? 0;
      _wallpaperId = wp[key] ?? wp['global'] ?? 'default';
      try { _pinned = pin != null ? (jsonDecode(pin) as Map).cast<String, String>() : null; } catch (_) {}
    });
    if (_isGroup) {
      final contacts = await ContactsStore().load();
      final names = <String, String>{};
      for (final c in contacts) { names[c.uid] = c.name; }
      if (_meId != null) names[_meId!.uid] = 'You';
      // Merge (don't replace): keep any names already learned from early
      // live reactions / messages (keyed by uid) — Phase 5.
      if (mounted) setState(() => _memberNames.addAll(names));
    }
    // 2026-07-04: hydrate server-persisted poll tallies for this conversation so
    // a reinstalled / new device shows correct counts + my selection + who-voted.
    unawaited(_hydratePolls());
  }

  /// Batch-fetch every poll's tally for THIS conversation from the server and
  /// merge it into the loaded poll bubbles. Runs on open (after cache load) and
  /// again when a new poll bubble arrives. Server is the source of truth — this
  /// replaces the local tally rather than adding to it, so reinstalled devices
  /// converge to the real counts. Best-effort; a failure leaves live-only tallies.
  Future<void> _hydratePolls() async {
    final conv = _serverConvId;
    if (conv == null) return;
    try {
      final res = await ApiAuth.getSigned('$kPollStateUrl?conv=${Uri.encodeComponent(conv)}');
      if (res.statusCode != 200 || !mounted) return;
      final polls = (jsonDecode(res.body)['polls'] as Map?) ?? const {};
      if (polls.isEmpty) return;
      final myUid = _meId?.uid ?? '';
      setState(() {
        for (final m in _msgs) {
          if (m.special != 'poll') continue;
          final id = m.extra?['id']?.toString();
          if (id == null) continue;
          final p = polls[id];
          if (p is! Map) continue;
          final counts = (p['counts'] as Map?) ?? const {};
          final voters = (p['voters'] as Map?) ?? const {};
          m.pollVotes = {};
          m.pollBy = {};
          m.pollMine = {};
          counts.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx != null) m.pollVotes[idx] = (v as num).toInt();
          });
          voters.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx == null || v is! List) return;
            final set = v.map((e) => e.toString()).toSet();
            m.pollBy[idx] = set;
            if (myUid.isNotEmpty && set.contains(myUid)) m.pollMine.add(idx);
          });
        }
      });
    } catch (_) { /* best-effort; live-only tallies remain */ }
  }

  Future<void> _setupGroup(Identity id) async {
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    _realMode = true;
    _isGroup = true;
    _group = g;
    Analytics.capture('group_thread_opened', {'gid': g.id, 'member_count': g.members.length});
    setState(() => _msgs.clear());
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _gdm = AvaGroupDm(group: g);
    _gdm!.messages.listen(_onGroupMsg);
    _gdm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomForGroup(g.id), id.shortId,
        convKey: 'g:${g.id}')..connect();
    _presence!.events.listen(_onPresence);
    _startPresenceHeartbeat();
    _memberUids = g.members.where((m) => m != id.uid).toList();
    _convKey = 'g:${g.id}';
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    _markRead();
    _loadChatExtras();
    _loadCachedMessages();
    // Durable group history from local SQLite — the source of truth that
    // survives restarts WITHOUT re-downloading the backlog (cursor sync). The
    // row stores `mine` but not the peer id, so senderPub is best-effort here
    // ('' → no per-sender label); live frames carry the real sender. _onGroupMsg
    // dedups by rumor id, so this never double-renders what's already shown.
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onGroupMsg(GroupMessage(
            rumorId: m.rumorId, senderPub: '', mine: m.mine,
            payload: m.payload, createdAt: m.createdAt));
      }
    });
    // Let replayed group history settle before indexing LIVE messages into RAG.
    Future.delayed(const Duration(seconds: 3), () { if (mounted) _ragLive = true; });
  }

  void _onPresence(Map<String, dynamic> e) {
    if (!mounted) return;
    // Ignore frames the room echoes back to us — otherwise our OWN online/typing
    // frames would mark the PEER online/typing (a cause of the false "online" in
    // pic2). Compare against the exact label we announce as (_presenceMe), not
    // _myName (which later becomes the display name).
    if (_presenceMe != null && e['who']?.toString() == _presenceMe) return;
    // Peer explicitly left/backgrounded → flip to "last seen" immediately rather
    // than waiting out the 35s online window.
    if (e['type'] == 'offline') {
      final ts = (e['ts'] as num?)?.toInt() ?? (DateTime.now().millisecondsSinceEpoch ~/ 1000);
      _onlineClear?.cancel();
      if (_convKey != null) LastSeenStore().set(_convKey!, '$ts');
      setState(() { _peerOnline = false; _peerTyping = false; _peerLastSeen = ts; });
      return;
    }
    // Only an explicit peer 'online' frame marks them online — NOT read/delivered/
    // typing/liveloc frames. Inferring online from those (or from a mis-attributed
    // echo) is what made every contact look "online" (owner report 2026-06-27).
    if (e['type'] == 'online') _markPeerOnline();
    if (e['type'] == 'typing') {
      setState(() { _peerTyping = e['on'] == true; _typingWho = e['who']?.toString(); });
      _typingClear?.cancel();
      if (_peerTyping) {
        _typingClear = Timer(const Duration(seconds: 5), () {
          if (mounted) setState(() => _peerTyping = false);
        });
      }
    } else if (e['type'] == 'read') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerReadTs) setState(() { _peerReadTs = ts; _peerDeliveredTs = ts > _peerDeliveredTs ? ts : _peerDeliveredTs; });
    } else if (e['type'] == 'delivered') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerDeliveredTs) setState(() => _peerDeliveredTs = ts);
    } else if (e['type'] == 'liveloc') {
      _onLiveLocTick(e);
    } else if (e['type'] == 'livestop') {
      final id = e['id']?.toString();
      if (id != null) _live[id]?.end();
    }
  }

  /// A live-location pin update arrived from the peer. Move the existing session
  /// in place (the bubble + any open map auto-repaint via their listeners) and
  /// throttle the "viewed" telemetry to once / 30 s / share.
  void _onLiveLocTick(Map<String, dynamic> e) {
    final id = e['id']?.toString();
    final lat = (e['lat'] as num?)?.toDouble();
    final lng = (e['lng'] as num?)?.toDouble();
    if (id == null || lat == null || lng == null) return;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final ts = (e['ts'] as num?)?.toInt() ?? now;
    final until = (e['until'] as num?)?.toInt();
    final s = _live.putIfAbsent(
      id,
      () => LiveLocationSession(
        id: id,
        lat: lat,
        lng: lng,
        until: until ?? (now + 3600),
        mine: false,
        name: e['who']?.toString() ?? widget.chat.name,
      ),
    );
    s.apply(lat, lng, ts,
        heading: (e['hdg'] as num?)?.toDouble(),
        speed: (e['spd'] as num?)?.toDouble(),
        until: until);
    final last = _liveViewTelemetryTs[id] ?? 0;
    if (now - last >= 30) {
      _liveViewTelemetryTs[id] = now;
      Analytics.capture('live_location_viewed', {
        'share_id': id,
        'is_sender': false,
        'conv_kind': _isGroup ? 'group' : 'dm',
      });
    }
  }

  void _markPeerOnline() {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    _peerLastSeen = now;
    // Persist last-seen (throttled) so reopening the thread can show it before
    // any live frame arrives.
    if (_convKey != null && now - _lastSeenPersistTs >= 15) {
      _lastSeenPersistTs = now;
      LastSeenStore().set(_convKey!, '$now');
    }
    if (!_peerOnline) setState(() => _peerOnline = true);
    _onlineClear?.cancel();
    _onlineClear = Timer(const Duration(seconds: 35), () { if (mounted) setState(() => _peerOnline = false); });
  }

  /// Keep "online" truthful: re-announce every 20s while the thread is open so a
  /// peer who's actually here never lapses out of the 35s window, and a peer who
  /// left stops showing "online" within ~35s. Rides the existing Cloudflare room
  /// WS — no per-user DO wake, and nothing is sent once the thread is closed.
  void _startPresenceHeartbeat() {
    _onlineHeartbeat?.cancel();
    _onlineHeartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted && _sharePresence) _presence?.sendOnline();
    });
  }

  Future<void> _loadLastSeen() async {
    final key = _convKey;
    if (key == null) return;
    final v = (await LastSeenStore().load())[key];
    final ts = int.tryParse(v ?? '') ?? 0;
    if (ts > 0 && mounted && _peerLastSeen == 0) setState(() => _peerLastSeen = ts);
  }

  /// Human "last seen <time>" label from the tracked unix-seconds timestamp.
  String _relLastSeen() {
    if (_peerLastSeen <= 0) return 'tap for contact info';
    final dt = DateTime.fromMillisecondsSinceEpoch(_peerLastSeen * 1000);
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60) return 'last seen just now';
    if (diff.inMinutes < 60) return 'last seen ${diff.inMinutes}m ago';
    if (diff.inHours < 24) return 'last seen ${diff.inHours}h ago';
    if (diff.inDays == 1) return 'last seen yesterday';
    if (diff.inDays < 7) return 'last seen ${diff.inDays}d ago';
    return 'last seen ${dt.day}/${dt.month}/${dt.year}';
  }

  void _onTyping() {
    if (_presence == null) return;
    _presence!.sendTyping(true);
    _myTypingOff?.cancel();
    _myTypingOff = Timer(const Duration(seconds: 2), () => _presence?.sendTyping(false));
  }


  void _spawnBurst(String emoji) {
    if (!mounted) return;
    final fx = _BurstFx(id: _burstSeq++, emoji: emoji);
    setState(() => _burstFx.add(fx));
    // Self-remove after the rise animation completes.
    Timer(const Duration(milliseconds: 2200), () {
      if (mounted) setState(() => _burstFx.removeWhere((b) => b.id == fx.id));
    });
  }

  // Send an ephemeral floating-emoji burst to everyone in the room + animate locally.
  void _sendBurst(String emoji) {
    HapticFeedback.lightImpact();
    _party?.send({'t': 'burst', 'emoji': emoji}); // PartyKit floating-emoji burst
    _spawnBurst(emoji); // optimistic local animation (peers see it via the burst stream)
  }

  void _pickBurstEmoji() {
    showModalBottomSheet(
      context: context, backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            for (final e in ['🎉', '❤️', '👏', '😂', '🔥', '😮'])
              GestureDetector(
                onTap: () { Navigator.pop(ctx); _sendBurst(e); },
                child: Text(e, style: const TextStyle(fontSize: 32)),
              ),
          ]),
        ),
      ),
    );
  }

  void _onGroupMsg(GroupMessage m) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    String text = '';
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    String? special;
    Map<String, dynamic>? extra;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'gedit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'gmedia') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
      } else if (env is Map && env['t'] == 'gtext') {
        text = (env['body'] ?? '').toString();
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      } else {
        return; // ginfo/gkick etc. — not chat content
      }
      if (env is Map && env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
      // STREAM C: link preview embedded by the sender at compose time — render
      // from the envelope, never fetch on the recipient.
      if (env is Map && env['preview'] is Map) {
        extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
      }
    } catch (_) {
      return;
    }
    final env2 = jsonDecode(m.payload) as Map;
    // Phase 5: learn this member's display name from the message (carried as
    // `fromName`), keyed by their uid — so bubbles AND the "reacted by" sheet can
    // show a real name instead of a short id.
    final fromName = (env2['fromName'] ?? '').toString().trim();
    if (!m.mine && fromName.isNotEmpty && m.senderPub.isNotEmpty &&
        _memberNames[m.senderPub] != fromName) {
      _memberNames[m.senderPub] = fromName;
    }
    final exp = (env2['exp'] as num?)?.toInt();
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return; // already gone
    // Safety net: any control envelope (del/gdel/receipt/…) that reached here
    // unhandled must NEVER render as a raw `{"t":...}` bubble. The explicit
    // handlers above already returned for the ones we act on; this catches the rest.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'group_live'});
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    setState(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: env2['forwarded'] == true, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true,
          senderLabel: _groupLabelFor(m.senderPub, mine: m.mine)));
      _noteGuardianFlag(special, extra);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Full-thread RAG: index a member's LIVE group text into my own store.
    // `_ragLive` gates out the history that replays on open (avoids re-indexing).
    if (!m.mine && _ragLive && special == null && media == null) {
      _ragAddLine(_shortPub(m.senderPub), text);
    }
    _jump();
    _markRead();
    // STREAM G [GROUP-AI-4]: after an INCOMING DM, offer smart replies (debounced,
    // DM-only; the method self-gates on group/foreground and clears on my own msg).
    if (!m.mine && special == null && media == null) _maybeFetchSmartReplies(); // STREAM G
    _schedulePersist();
  }

  String _shortPub(String hex) => hex.length > 8 ? '${hex.substring(0, 6)}…' : hex;

  // Phase 5: my display name, stamped onto outgoing group messages + reactions so
  // peers can show "Reacted by <name>" and a real sender label (not a short id).
  String get _fromNameTag =>
      (_myName != null && _myName!.trim().isNotEmpty) ? _myName!.trim() : 'Member';

  // Resolve a sender/reactor uid to a friendly group label: my uid → "You", a
  // learned name (from a message or reaction that carried fromName) → that name,
  // else a short id. Empty uid → null (no label).
  String? _groupLabelFor(String uid, {bool mine = false}) {
    if (mine) return null;
    if (uid.isEmpty) return null;
    return _memberNames[uid] ?? _shortPub(uid);
  }

  // The relay accepted/rejected one of our sends → flag the bubble accordingly.
  // ok=true means the event is now ON THE RELAY ("sent" / 1 tick); delivery and
  // read are reported separately by the recipient over the presence channel.
  void _onSendStatus(({String rumorId, bool ok, String message}) s) {
    if (!mounted) return;
    final idx = _msgs.indexWhere((m) => m.evId == s.rumorId);
    if (idx < 0) return;
    setState(() { _msgs[idx].failed = !s.ok; _msgs[idx].sent = s.ok; });
  }

  /// Per-message delivery status for MY 1:1 messages (WhatsApp-style). Returns
  /// the tick icon, its colour, and a tiny human label; null when status doesn't
  /// apply (received messages, groups, demo mode). Drives both the ticks and the
  /// little caption under each of my bubbles so the sender always knows where a
  /// message is: still sending → on the relay but not yet on the phone →
  /// delivered to the phone → actually read.
  ({IconData icon, Color color, String label})? _statusFor(_Msg m) {
    if (m.aiLocal) return null; // private @ava question — never sent, so no ticks
    if (!m.me || !_realMode || _isGroup || m.ts <= 0) return null;
    // My bubbles are lime (ink text), so status ticks read in ink tones:
    // read = blue-ink, everything in-flight = ink-soft, failed = coral.
    if (m.failed) {
      return (icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.bold), color: Zine.coral, label: 'Not sent · tap to retry');
    }
    if (m.uploading) {
      return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: Zine.inkSoft, label: 'Sending…');
    }
    if (_peerReadTs > 0 && m.ts <= _peerReadTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: Zine.blueInk, label: 'Read'); // 2 blue ticks
    }
    if (_peerDeliveredTs > 0 && m.ts <= _peerDeliveredTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: Zine.inkSoft, label: 'Delivered'); // 2 grey ticks
    }
    if (m.sent) {
      // 1 tick = left this device / accepted. We deliberately DON'T claim
      // "waiting to reach phone" here — that contradicted the peer showing as
      // online (pic2). Truthful escalation: Sent → Delivered → Read.
      return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.inkSoft, label: 'Sent'); // 1 tick
    }
    return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: Zine.inkSoft, label: 'Sending…');
  }

  // [seed]=true when replaying stored history (hub memory / local DB) on open —
  // it suppresses re-sending read receipts for old messages (only genuinely
  // live, just-arrived messages should mark-read).
  void _onDm(DmMessage m, {bool seed = false}) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    // Parse our envelope: {"t":"text","body":...} or {"t":"media",...}.
    String text = m.payload;
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    bool forwarded = false;
    int? exp;
    String? special;
    Map<String, dynamic>? extra;
    // G3 (inline two-lane scan): an incoming envelope may carry a top-level
    // `safety:{category,severity}` verdict stamped by the server's FAST lane before
    // fan-out. Treat it like a live safety_flag frame — mark the bubble red on
    // arrival via the existing SafetyFlagStore + _safetyFlags path (below), so the
    // recipient sees the red flag instantly instead of waiting for the deep lane's
    // separate safety_flag push. Only for incoming (peer) messages.
    String? inlineSafetyCat;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'receipt') { _applyReceipt(m.mine, env); return; } // status, never a bubble
      if (env is Map && env['t'] == 'read') return; // read high-water (badge clears via the chat list) — never a bubble
      if (env is Map && env['gid'] != null) return; // group message — not this 1:1
      if (env is Map && env['t'] == 'edit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'media') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        final keyShort = media.id.length > 12 ? media.id.substring(media.id.length - 8) : media.id;
        AvaLog.I.log('media', 'recv dm media kind=${media.kind.name} ${media.size}B key=…$keyShort mine=${m.mine}');
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
      } else if (env is Map && env['t'] == 'text') {
        text = env['body'].toString();
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      }
      if (env is Map) {
        if (env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
        forwarded = env['forwarded'] == true;
        exp = (env['exp'] as num?)?.toInt();
        // G3 inline safety verdict on the envelope → red bubble on arrival.
        if (!m.mine && env['safety'] is Map) {
          final cat = ((env['safety'] as Map)['category'] ?? '').toString();
          if (cat.isNotEmpty) inlineSafetyCat = cat;
        }
        // STREAM C: sender-embedded link preview → render from the envelope.
        if (env['preview'] is Map) {
          extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
        }
      }
    } catch (_) {/* legacy/plain text */}
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return;
    // Safety net: a control envelope (del/gdel/receipt/…) must NEVER render as a raw
    // `{"t":...}` bubble. Explicit handlers above already returned for handled ones;
    // this stops any unhandled/older-format control from leaking into the chat.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'dm_live'});
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    setState(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: forwarded, expireAt: exp, special: special, extra: extra,
          sent: m.mine, // my own messages reaching here are already on the relay
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true));
      _noteGuardianFlag(special, extra);
      // G3: an inline fast-lane safety verdict paints THIS bubble red immediately,
      // exactly like a live safety_flag frame (keyed by the message's rumor id).
      if (inlineSafetyCat != null && !_safetyFlaggedIds.containsKey(m.rumorId)) {
        _safetyFlaggedIds[m.rumorId] = inlineSafetyCat!;
      }
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Persist the inline flag so the red bubble survives reopen (mirrors how the
    // deep-lane safety_flag frame is persisted). Best-effort.
    if (inlineSafetyCat != null) {
      unawaited(_safetyStore.put(m.rumorId,
          conv: _serverConvId ?? _convKey ?? '', category: inlineSafetyCat!));
    }
    // Full-thread RAG: index a peer's LIVE text into my own store (not seeded
    // history, not media/special envelopes).
    if (!m.mine && !seed && special == null && media == null) {
      _ragAddLine(widget.chat.name, text);
    }
    _jump();
    if (!m.mine && !seed) {
      // Live (just-arrived) message I'm looking at → tell the sender it's read,
      // both the live (presence) way and the durable (gift-wrapped) way.
      _presence?.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
      _dm?.sendReceipt('read', m.createdAt);
    }
    _markRead();
    _schedulePersist();
  }

  /// Apply a peer's delivery/read receipt for MY messages: advance the in-memory
  /// high-water marks (drives the ticks live) and persist them so the status is
  /// still correct after the thread/app is reopened. A 'read' implies delivered.
  void _applyReceipt(bool mine, Map env) {
    if (mine) return; // my own copy (shouldn't occur — receipts use wrapTo)
    final rts = (env['ts'] as num?)?.toInt() ?? 0;
    if (rts <= 0 || !mounted) return;
    final read = (env['status'] ?? '').toString() == 'read';
    setState(() {
      if (read && rts > _peerReadTs) _peerReadTs = rts;
      if (rts > _peerDeliveredTs) _peerDeliveredTs = rts;
    });
    if (_convKey != null) {
      ReceiptStore().bump(_convKey!, delivered: read ? 0 : rts, read: read ? rts : 0);
    }
  }

  void _applyEdit(String target, String body) {
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) { setState(() { _msgs[i].text = body; _msgs[i].edited = true; }); _schedulePersist(); }
  }

  // ---- local message persistence ----
  // The relay doesn't re-deliver your OWN sent DMs on resubscribe, so cache the
  // thread locally and reload it on open. (Media messages aren't cached.)
  Future<void> _loadCachedMessages() async {
    final key = _convKey;
    if (key == null) return;
    // F3 (restoreV2): restore any previously-paged deep-archive rows for THIS
    // conversation + the pager cursor, so older history reappears instantly on
    // reopen without a second /api/archive/page round-trip. Independent of the
    // hot cache below (which may be empty on a fresh device).
    unawaited(_restoreArchiveCache());
    // [MSG-OUTBOX-1] Load the durable outbox first so isPending() below is accurate
    // when we restore not-yet-ACKed bubbles (sending… vs not-sent affordance).
    await Outbox.I.ensureLoaded();
    final cached = await _msgStore.load(key);
    if (cached.isEmpty || !mounted) return;
    final loaded = <_Msg>[];
    for (final j in cached) {
      final ev = j['evId'] as String?;
      if (ev != null) {
        if (_seenEv.contains(ev)) continue;
        _seenEv.add(ev);
      }
      // Drop any control envelope an older build wrongly cached as a text bubble
      // (e.g. a leaked `{"t":"del",...}`), so it never reappears on reopen.
      if (_isControlEnvelope((j['text'] ?? '').toString())) {
        Analytics.capture('chat_control_filtered', {'where': 'cache'});
        continue;
      }
      final ts = (j['ts'] as num?)?.toInt() ?? 0;
      // Media messages ARE cached now (the envelope/refs — never the bytes; the
      // decrypted bytes live in MediaService's on-disk cache). So on reopen the
      // image/voice bubble reappears instantly and loads local-first, instead of
      // waiting on a full relay re-sync + re-download.
      ChatMedia? media;
      final mj = j['media'];
      if (mj is Map) { try { media = ChatMedia.fromEnvelope(mj.cast<String, dynamic>()); } catch (_) {} }
      final msg = _Msg(
        _seq++, j['me'] == true, (j['text'] ?? '').toString(),
        _fmtTime(ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : ts),
        ts: ts, evId: ev, media: media,
        sent: j['me'] == true, // my persisted history was already accepted by the relay
        special: j['special'] as String?,
        extra: (j['extra'] as Map?)?.cast<String, dynamic>(),
        replyTo: (j['replyTo'] as Map?)?.cast<String, dynamic>(),
        edited: j['edited'] == true,
        forwarded: j['forwarded'] == true,
        expireAt: (j['expireAt'] as num?)?.toInt(),
        senderLabel: j['senderLabel'] as String?,
        reaction: j['reaction'] as String?,
        starred: j['starred'] == true,
        hidden: j['hidden'] == true || _hiddenIds[ev] == true,
      );
      // [MSG-OUTBOX-1] Restore a NOT-yet-ACKed send with the right affordance so it
      // never silently vanishes (the original bug). If its clientId (=evId) is STILL
      // queued in the durable outbox, it's genuinely in flight → show "sending…"
      // and let the outbox status flip it to sent/failed. If it's no longer queued
      // (gave up, or a media upload that can't auto-resume), show the failed
      // "not sent · tap to retry" affordance so the user can re-send manually.
      if (j['pending'] == true && msg.me) {
        final stillQueued = ev != null && Outbox.I.isPending(ev);
        final mediaPending = j['mediaPending'] == true;
        if (stillQueued && !mediaPending) {
          msg.sent = false; msg.failed = false; // "sending…" — outbox is retrying
        } else {
          msg.sent = false; msg.failed = true;   // "not sent · tap to retry"
        }
      }
      // A peer hard-deleted this for everyone (durable tombstone) — collapse the
      // stale cached body/media to the deleted pill before showing it.
      if (ev != null && _deletedIds.contains(ev)) _tombstone(msg);
      loaded.add(msg);
    }
    if (loaded.isEmpty || !mounted) return;
    setState(() {
      _msgs.addAll(loaded);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
    // If any cached poll bubbles were restored, pull their server tallies so a
    // reinstalled device shows real counts + my selection (survives reinstall).
    if (loaded.any((m) => m.special == 'poll')) unawaited(_hydratePolls());
  }

  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(const Duration(milliseconds: 400), _persistNow);
  }

  Future<void> _persistNow() async {
    final key = _convKey;
    if (key == null) return;
    final out = <Map<String, dynamic>>[];
    for (final m in _msgs) {
      if (m.text.contains('"t":"receipt"')) continue; // never cache a stray receipt
      // [MSG-OUTBOX-1] PERSIST failed / still-sending messages instead of dropping
      // them. The old `if (m.uploading || m.failed) continue;` is exactly why a DM
      // that failed to POST silently vanished from the sender's own thread on
      // reopen (the warm cache excluded it). We now cache them WITH their state:
      //   • text that isn't ACKed yet (failed, or my bubble not `sent`) → the
      //     durable outbox is still retrying it, so restore it as pending and let
      //     the outbox status update the bubble; a tap re-enqueues.
      //   • uploading/failed MEDIA → restore as a failed placeholder so it doesn't
      //     disappear. NOTE: the raw bytes live only in memory (never cached), so a
      //     media upload interrupted by a restart cannot auto-resume — the user
      //     re-sends via the failed-bubble tap. Text sends DO auto-resume via the
      //     outbox. (Media-upload resume is out of scope here — see report.)
      final notAcked = m.me && !m.hidden && (m.failed || m.uploading || (!m.sent && m.evId != null));
      out.add({
        'me': m.me, 'text': m.text, 'ts': m.ts,
        if (m.evId != null) 'evId': m.evId,
        if (m.media != null) 'media': m.media!.toEnvelope(), // refs only — bytes are in MediaService's disk cache
        if (m.special != null) 'special': m.special,
        if (m.extra != null) 'extra': m.extra,
        if (m.replyTo != null) 'replyTo': m.replyTo,
        if (m.edited) 'edited': true,
        if (m.forwarded) 'forwarded': true,
        if (m.expireAt != null) 'expireAt': m.expireAt,
        if (m.senderLabel != null) 'senderLabel': m.senderLabel,
        if (m.reaction != null) 'reaction': m.reaction,
        if (m.starred) 'starred': true,
        if (m.hidden) 'hidden': true, // soft-delete survives reopen; data retained for Undo
        // Restore hint: this bubble was NOT yet confirmed on the server. `mediaPending`
        // distinguishes a stuck media upload (no auto-resume) from a text send the
        // outbox will keep retrying.
        if (notAcked) 'pending': true,
        if (notAcked && (m.uploading || m.media != null)) 'mediaPending': true,
      });
    }
    await _msgStore.save(key, out);
    // Keep the chat-list preview + ordering in sync with the latest line here,
    // for both messages I sent and ones I received while this thread was open.
    if (_msgs.isNotEmpty) {
      final last = _msgs.reduce((a, b) => b.ts >= a.ts ? b : a);
      final preview = last.hidden
          ? 'You deleted this message' // never leak hidden content into the list
          : (last.text.isNotEmpty
              ? last.text
              : (last.media != null ? _caption(last.media!.kind, last.media!.name) : ''));
      final ts = last.ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : last.ts;
      if (preview.isNotEmpty) await ChatPreviewStore().record(key, preview, ts, last.me);
    }
  }

  // ── F3: deep-archive scroll pager (restoreV2) ───────────────────────────────
  // When the user scrolls PAST the local hot window, page older messages in from
  // /api/archive/page (batched per-user R2 jsonl), render them above with a subtle
  // "older messages" divider, and CACHE each fetched page per-conversation so a
  // page is fetched at most once — ever, across restarts. All dark unless
  // RemoteConfig.restoreV2 is on (no behaviour change when false).

  /// Feed one archive server row ({id,conv,sender,kind,body,media_ref,client_id,
  /// created_at}) into the thread as seeded history. Dedup + envelope parsing are
  /// handled by the normal _onDm/_onGroupMsg path (via _seenEv), so a row already
  /// in the hot window never double-renders.
  void _ingestArchiveRow(Map<String, dynamic> r) {
    final myUid = _meId?.uid ?? _myNpub ?? '';
    final id = (r['id'] as num?)?.toInt() ?? 0;
    final clientId = (r['client_id'] ?? '').toString();
    final rumorId = clientId.isNotEmpty ? clientId : 'srv_$id';
    final sender = (r['sender'] ?? '').toString();
    final mine = myUid.isNotEmpty && sender == myUid;
    final body = (r['body'] ?? '').toString();
    final createdMs = (r['created_at'] as num?)?.toInt() ??
        DateTime.now().millisecondsSinceEpoch;
    final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs; // ms→s
    if (_isGroup) {
      _onGroupMsg(GroupMessage(
          rumorId: rumorId, senderPub: mine ? '' : sender, mine: mine,
          payload: body, createdAt: createdSec));
    } else {
      _onDm(DmMessage(rumorId: rumorId, mine: mine, payload: body, createdAt: createdSec),
          seed: true);
    }
  }

  /// Restore previously-paged archive rows + the pager cursor from the per-account
  /// cache. Silent + safe when restoreV2 is off (we still restore what was already
  /// cached so history the user already saw doesn't vanish, but never fetch).
  Future<void> _restoreArchiveCache() async {
    final key = _convKey;
    if (key == null) return;
    final cur = await _archiveStore.load(key);
    if (!mounted) return;
    final rows = (cur['rows'] as List).cast<Map<String, dynamic>>();
    if (rows.isNotEmpty) {
      for (final r in rows) _ingestArchiveRow(r);
      setState(() => _hasArchived = true);
    }
    _archiveCursor = cur['cursor'] as int?;
    _archiveDone = cur['done'] == true;
  }

  /// Scroll listener: when the viewport nears the TOP of the loaded thread (older
  /// end), pull the next archive page. Guarded by restoreV2 + one-in-flight.
  void _maybePageArchive() {
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    if (!_scroll.hasClients) return;
    // extentBefore is how much is scrolled off the TOP; near 0 ⇒ at the oldest
    // message currently loaded → fetch older history.
    if (_scroll.position.extentBefore <= 240) {
      unawaited(_fetchArchivePage());
    }
  }

  Future<void> _fetchArchivePage() async {
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    final key = _convKey;
    final myUid = _meId?.uid ?? _myNpub ?? '';
    if (key == null || myUid.isEmpty) return;
    final serverConv = serverConvFromKey(key, myUid);
    if (serverConv == null) return;
    setState(() => _archiveLoading = true);
    // Preserve the scroll position across the prepend so the view doesn't jump:
    // remember distance-from-bottom, restore it after the new rows lay out.
    final beforeMax = _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final beforePix = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    try {
      final before = _archiveCursor; // null ⇒ start from newest segment
      final uri = '$kArchivePageUrl?conv=$serverConv&limit=30'
          '${before != null ? '&before=$before' : ''}';
      final res = await ApiAuth.getSigned(uri);
      if (!mounted) { _archiveLoading = false; return; }
      if (res.statusCode != 200) {
        Analytics.capture('archive_page_failed', {'status': res.statusCode});
        setState(() => _archiveLoading = false);
        return;
      }
      final body = jsonDecode(res.body);
      final rows = (body is Map ? (body['messages'] as List? ?? const []) : const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final nextBefore = (body is Map ? body['next_before'] : null) as num?;
      // Cache the page (dedup at most-once is via the cursor: a fetched `before`
      // is never re-requested — nextBefore always strictly decreases).
      await _archiveStore.appendPage(
        key,
        newRows: rows,
        nextBefore: nextBefore?.toInt(),
        done: nextBefore == null,
      );
      if (!mounted) { _archiveLoading = false; return; }
      for (final r in rows) _ingestArchiveRow(r);
      setState(() {
        _archiveCursor = nextBefore?.toInt();
        _archiveDone = nextBefore == null;
        if (rows.isNotEmpty) _hasArchived = true;
        _archiveLoading = false;
      });
      Analytics.capture('archive_page_loaded', {'rows': rows.length, 'done': _archiveDone});
      // Restore the scroll offset so the freshly-prepended history doesn't yank
      // the user away from where they were reading.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        final grew = _scroll.position.maxScrollExtent - beforeMax;
        if (grew > 0) _scroll.jumpTo((beforePix + grew).clamp(0.0, _scroll.position.maxScrollExtent));
      });
    } catch (e) {
      if (mounted) setState(() => _archiveLoading = false);
      Analytics.capture('archive_page_error', {'error': e.toString()});
    }
  }

  // A subtle divider rendered above the oldest loaded messages once we've paged
  // (or are paging) deep archive, so the user understands they're now looking at
  // history pulled from the cloud backup.
  Widget _olderMessagesDivider() => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 10),
        child: Row(children: [
          Expanded(child: Divider(color: Zine.ink.withValues(alpha: 0.18), thickness: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: _archiveLoading
                ? Row(mainAxisSize: MainAxisSize.min, children: [
                    SizedBox(width: 12, height: 12,
                        child: CircularProgressIndicator(strokeWidth: 1.6, color: Zine.inkSoft)),
                    const SizedBox(width: 7),
                    Text('Loading older messages…', style: ZineText.tag(size: 10, color: Zine.inkSoft)),
                  ])
                : Text(_archiveDone ? 'Start of conversation' : 'Older messages',
                    style: ZineText.tag(size: 10, color: Zine.inkSoft)),
          ),
          Expanded(child: Divider(color: Zine.ink.withValues(alpha: 0.18), thickness: 1)),
        ]),
      );

  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  // Phase 5: realtime timestamps ─────────────────────────────────────────────
  // A short relative age ("now", "2m", "1h") for very recent messages; older
  // ones keep their fixed HH:MM. Recomputed on every clock tick so it stays live.
  String _relTime(int epochSecs) {
    if (epochSecs <= 0) return '';
    final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final diff = nowS - epochSecs;
    if (diff < 45) return 'now';
    if (diff < 3600) return '${(diff / 60).floor()}m';
    if (diff < 21600) return '${(diff / 3600).floor()}h'; // <6h → still feels "live"
    return _fmtTime(epochSecs); // older → fixed clock time
  }

  // A day-separator label: Today / Yesterday / weekday (this week) / d Mon.
  String _dayLabel(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    final now = DateTime.now();
    final day = DateTime(d.year, d.month, d.day);
    final today = DateTime(now.year, now.month, now.day);
    final delta = today.difference(day).inDays;
    if (delta == 0) return 'Today';
    if (delta == 1) return 'Yesterday';
    const wk = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (delta < 7) return wk[d.weekday - 1];
    final y = d.year == now.year ? '' : ' ${d.year}';
    return '${d.day} ${mo[d.month - 1]}$y';
  }

  bool _sameDay(int a, int b) {
    if (a == 0 || b == 0) return true; // demo/unknown ts → no separator
    final da = DateTime.fromMillisecondsSinceEpoch(a * 1000);
    final db = DateTime.fromMillisecondsSinceEpoch(b * 1000);
    return da.year == db.year && da.month == db.month && da.day == db.day;
  }

  // A centered "Today / Yesterday / date" chip rendered between day groups.
  Widget _daySeparator(String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: Zine.ink, width: 1.5),
              boxShadow: Zine.shadowXs,
            ),
            child: Text(label.toUpperCase(),
                style: ZineText.tag(size: 10, color: Zine.inkSoft)),
          ),
        ),
      );

  final List<_Msg> _msgs = [];

  @override
  void dispose() {
    _localAvaSub?.cancel();
    _avaStreamSub?.cancel();
    _safetySub?.cancel();              // F6: live safety_flag frames
    _scroll.removeListener(_maybePageArchive); // F3: archive pager
    _clockTimer?.cancel();              // Phase 5: live clock
    _reactionOverlay?.remove();        // Phase 5: tear down a floating reaction pill if open
    _reactionOverlay = null;
    _partySub?.cancel();               // PartyKit live layer
    _party?.leave();
    _ctrl.dispose();
    _searchCtrl.dispose();
    _composerFocus.dispose();
    _scroll.dispose();
    _audio.dispose();
    _sfx.dispose();
    _recorder.dispose();
    _sttSession?.cancel();
    if (_convKey != null) DraftStore().set(_convKey!, _ctrl.text.trim());
    _dm?.stop();
    _gdm?.stop();
    _liveBroadcaster?.stop('disposed');
    for (final s in _live.values) {
      s.dispose();
    }
    if (_sharePresence) {
      try { _presence?.sendOffline(DateTime.now().millisecondsSinceEpoch ~/ 1000); } catch (_) { /* best-effort */ }
    }
    _onlineHeartbeat?.cancel();
    _presence?.dispose();
    _typingClear?.cancel();
    _myTypingOff?.cancel();
    _onlineClear?.cancel();
    _confTimer?.cancel();
    _pruneTimer?.cancel();
    _persistTimer?.cancel();
    _markReadTimer?.cancel();
    _smartReplyDebounce?.cancel(); // STREAM G smart replies
    _persistNow(); // flush any pending message-cache write on exit
    // NOTE: do NOT dispose _nostr — it's the shared SyncHub client owned by the
    // whole app. _dm.stop()/_gdm.stop() above already cancel this screen's
    // listeners; the socket stays alive so returning to a chat is instant.
    super.dispose();
  }

  // Phase 3 fills this: a hook to summon Ava from the composer. When non-null
  // and the outgoing text mentions @ava (see [_avaWakeWord]), Phase 3 routes the
  // turn to the in-thread agent (POST AvaApi.threadTurn) instead of / in addition
  // to sending the human message. Phase 0 only wires the hook + detection point;
  // it does NOT implement any behavior. Leave null here.
  Future<void> Function(String text)? onSummonAva;

  /// Subscription to on-device Ava answers for THIS conversation (Local Ava AI).
  StreamSubscription<AvaLocalReply>? _localAvaSub;

  /// Subscription to LIVE `@ava` token streaming from the server (cloud agent).
  /// Grows an Ava bubble as deltas arrive; the durable answer replaces it.
  StreamSubscription<Map<String, dynamic>>? _avaStreamSub;

  /// The wake words the composer watches for. `@ava` = a PRIVATE personal call
  /// to Ava (never sent to the peer, private reply). `#ava` = a SHARED call (both
  /// parties see the question + reply).
  static const String _avaWakeWord = '@ava';
  static const String _avaShareWord = '#ava';

  /// Composer "Ava mode": when ON, every message you send is a PRIVATE @ava call
  /// (no need to type @ava) — handy for quietly drafting a reply with Ava, then
  /// flipping back to message the person. Toggled by the ✦ button in the composer.
  bool _avaMode = false;

  /// Buffer of conversation lines (everyone's), flushed into THIS member's own
  /// RAG store (Gemini File Search) in batches so @ava can recall the whole
  /// thread later. Group RAG = each member indexes the full thread into their
  /// own store (owner decision 2026-06-18). `_ragLive` gates incoming messages
  /// so reopening a chat doesn't re-index already-seen history.
  final List<String> _ragBuffer = [];
  bool _ragLive = false;

  /// Append one labelled line to the RAG batch; flush to the store every 10.
  /// Skips empty lines and @ava control lines. Fire-and-forget — never blocks.
  void _ragAddLine(String who, String text) {
    final t = text.trim();
    if (t.isEmpty || t.toLowerCase().contains(_avaWakeWord)) return;
    _ragBuffer.add('$who: $t');
    // On-device memory: ONLY when Local Ava AI is active (model loaded) so we
    // never trigger a model download just from chatting. Makes facts said in
    // this chat findable on-device/offline — including cross-surface in AvaChat.
    if (AvaLocalMode.I.isActive) {
      // Selective embedding: only substantive lines are kept on-device (skips
      // greetings/acks + respects the episodic cap). Facts, not chatter.
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.rememberMessage(who, t, name: 'chat-${widget.chat.name}');
    }
    if (_ragBuffer.length >= 10) {
      final batch = _ragBuffer.join('\n');
      _ragBuffer.clear();
      // ignore: unawaited_futures
      RagService.I.ingestText('Chat with ${widget.chat.name}:\n$batch',
          name: 'chat-${widget.chat.name}');
    }
  }

  /// Render on-device `@ava` answers (Local Ava AI) for THIS conversation as a
  /// normal Ava bubble. Additive — does not touch the server message pipeline.
  void _bindLocalAva() {
    _localAvaSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _localAvaSub = AvaLocalReplies.I.stream.listen((r) {
      if (!mounted || r.convKey != key) return;
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      setState(() {
        // The on-device answer is here — drop the transient "thinking" chip.
        _msgs.removeWhere((m) => m.special == 'ava_status');
        _msgs.add(_Msg(_seq++, false, r.text, _fmtTime(now),
            ts: now, special: 'ava'));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }

  /// A GenUI card fired a `composio` action (Rename, Delete, Schedule a
  /// meeting…). Execute it via the server-validated route; if the server renders
  /// a refreshed surface from the result (e.g. the updated list / created event),
  /// drop it into the thread as a fresh Ava bubble so the chat reflects the new
  /// state. Returns the short answer for the renderer's snackbar.
  Future<String?> _onGenuiComposio(String tool, Map<String, dynamic> args, {String? gid}) async {
    final r = await AppsService.I.genuiAction(tool, args, gid: gid);
    if (!mounted) return r.answer;
    if (r.surface != null) {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final body = r.ok ? '' : r.answer;
      setState(() {
        _msgs.add(_Msg(_seq++, false, body, _fmtTime(now),
            ts: now, special: 'ava', extra: {'a2ui': r.surface, 'text': body}));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    }
    return r.answer;
  }

  /// Render LIVE server `@ava` answers for THIS conversation as they stream in
  /// (cloud agent). Each delta grows a single Ava bubble keyed by `stream_id`;
  /// when the durable answer lands ([_onDm]/[_onGroupMsg]) it removes this
  /// preview so there's no duplicate. Purely additive: if no stream arrives the
  /// answer still appears whole via the normal message path.
  void _bindAvaStream() {
    _avaStreamSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _avaStreamSub = SyncHub.I.avaStream.listen((m) {
      if (!mounted || m['convKey'] != key) return;
      final phase = (m['phase'] ?? '').toString();
      final sid = (m['stream_id'] ?? '').toString();
      if (sid.isEmpty) return;
      final delta = (m['delta'] ?? '').toString();
      final evId = 'stream_$sid';
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      setState(() {
        final i = _msgs.indexWhere((x) => x.evId == evId);
        if (phase == 'end') return; // keep the preview; durable answer replaces it
        if (i >= 0) {
          if (phase == 'delta') _msgs[i].text = _msgs[i].text + delta;
          return;
        }
        // First frame for this turn (start, or a delta if start was missed):
        // drop the "working…" chip and open the growing bubble.
        _msgs.removeWhere((x) => x.special == 'ava_status');
        _msgs.add(_Msg(_seq++, false, delta, _fmtTime(now),
            ts: now, special: 'ava', evId: evId));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }

  /// Remove any live streaming preview bubble(s) once the durable Ava answer
  /// arrives. Prefers exact correlation via the answer's `meta.stream_id`; falls
  /// back to clearing all `stream_` previews (turns are sequential).
  void _clearAvaStreamPreview(Map<String, dynamic>? extra) {
    final sid = (extra?['meta'] is Map) ? (extra!['meta'] as Map)['stream_id']?.toString() : null;
    if (sid != null && sid.isNotEmpty) {
      _msgs.removeWhere((x) => x.evId == 'stream_$sid');
    } else {
      _msgs.removeWhere((x) => (x.evId ?? '').startsWith('stream_'));
    }
  }

  /// Show a transient on-device "Ava is thinking…" chip. Scheduled after the
  /// current frame so it lands below the user's own @ava message; it collapses
  /// automatically once the answer bubble arrives (the 'ava_status' transient
  /// rule keeps only the most-recent chip) or when [_bindLocalAva] clears it.
  void _showLocalAvaThinking() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      setState(() {
        _msgs.add(_Msg(_seq++, false, 'Ava is thinking…', _fmtTime(nowS),
            ts: nowS, special: 'ava_status'));
      });
      _jump();
    });
  }

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    // STREAM B: replying while a thread is pending is an IMPLICIT accept — fire the
    // accept (server restores receipts) and drop the gate before the send.
    if (_strangerGatePending && _serverConv != null) {
      _strangerGatePending = false;
      _threadAcceptState = 'accepted';
      StrangerGateApi.accept(_serverConv!);
      trackStrangerGate('stranger_gate_accept', {'conv': _serverConv!, 'implicit': true});
      // G1.2: an implicit accept (replying to a stranger) also auto-enables Guardian.
      _autoEnableGuardianOnAccept();
    }
    HapticFeedback.selectionClick(); // P9: subtle send confirmation
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final expire = _disappearSecs > 0 ? now + _disappearSecs : null;

    // ----- Ava routing (fresh sends only, never edits) -----
    // `@ava` (or Ava-mode) = a PRIVATE personal call: the question is NOT sent to
    // the peer (so it's instant — no "waiting to reach phone") and the reply comes
    // back privately. `#ava` = SHARED: falls through to a normal send so the peer
    // sees the question, and Ava replies in the thread for both.
    if (_editing == null && onSummonAva != null) {
      final lower = t.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      final privateAva = (atAva && !shared) || avaModePrivate;
      if (privateAva || shared) {
        // Ava-in-chat (@ava / #ava) AND connected-app/composio actions (email,
        // image generation, etc.) are a PAID feature (owner request 2026-06-27).
        // Free users get a one-line upsell instead of an Ava turn.
        if (!_premium) {
          Analytics.capture('ava_chat_gate_blocked', <String, Object>{
            'mode': privateAva ? 'private' : 'shared', 'is_group': _isGroup,
          });
          if (privateAva) {
            // Private @ava is never sent to the peer — show the upsell and stop.
            _composerFocus.requestFocus();
            _capNote('Asking Ava is a paid feature — subscribe to use @ava (private) '
                'and #ava (in chat), plus connected apps like email and image generation.');
            setState(() { _ctrl.clear(); _hasText = false; });
            if (_convKey != null) DraftStore().set(_convKey!, '');
            return;
          }
          // #ava: the literal message still sends to the peer (below); Ava just
          // won't reply for free users.
          _capNote('Ava in chat is a paid feature — subscribe to get an Ava reply to #ava.');
        } else {
          // Ava-mode plain text carries no marker → prefix so AvaInvoke parses it
          // as a private @ava call.
          // ignore: unawaited_futures
          onSummonAva!(avaModePrivate ? '$_avaWakeWord $t' : t);
          if (privateAva) {
            _ragAddLine('You', t);
            _composerFocus.requestFocus();
            setState(() {
              // aiLocal: rendered locally only, never sent → no delivery ticks.
              _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, aiLocal: true));
              _ctrl.clear(); _hasText = false; _replyTo = null;
            });
            _jump();
            if (_convKey != null) DraftStore().set(_convKey!, '');
            _schedulePersist();
            return;
          }
        }
      }
    }

    // RAG memory: index this outgoing line into the user's own File Search store
    // (full-thread indexing — incoming lines are added in the receive handlers).
    _ragAddLine('You', t);
    // Tapping the send button steals focus from the field; grab it back so the
    // keyboard stays up and the user can keep typing without re-tapping the box.
    _composerFocus.requestFocus();

    // Editing an existing message?
    if (_editing != null && _editing!.evId != null) {
      final m = _editing!;
      final target = m.evId!;
      if (_isGroup && _gdm != null) {
        _gdm!.send(jsonEncode({'t': 'gedit', 'gid': _group!.id, 'target': target, 'body': t}));
      } else if (_realMode && _dm != null) {
        _dm!.send(jsonEncode({'t': 'edit', 'target': target, 'body': t}));
      }
      setState(() { m.text = t; m.edited = true; _editing = null; _ctrl.clear(); _hasText = false; });
      _schedulePersist();
      return;
    }

    final replyMeta = _replyTo == null
        ? null
        : {
            'id': _replyTo!.evId ?? '',
            'preview': _replyTo!.text.length > 60 ? _replyTo!.text.substring(0, 60) : _replyTo!.text,
            'who': _replyTo!.me ? 'You' : (_replyTo!.senderLabel ?? widget.chat.name),
          };

    // STREAM C [PREVIEW-2]: compose-time link unfurl. The SENDER unfurls the
    // first URL and embeds the preview in the envelope (`preview:{...}`) so
    // recipients render the card from the envelope — zero recipient fetch. The
    // dispatch is delegated to _dispatchText so we can attach the preview once it
    // resolves (fast timeout; a link with no preview just sends without one).
    if (_isGroup && _gdm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: true);
      return;
    }
    if (_realMode && _dm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: false);
      return;
    }
    setState(() {
      _msgs.add(_Msg(_seq++, true, t, 'now', replyTo: replyMeta));
      _ctrl.clear(); _hasText = false; _replyTo = null;
    });
    _jump();
    _schedulePersist();
  }

  /// STREAM C [PREVIEW-2]: send a text message, optionally embedding a
  /// compose-time link preview in the envelope. The optimistic bubble appears
  /// instantly (mirrors media sends); the actual wire dispatch waits for a fast
  /// unfurl ONLY when the text contains a URL and previews are enabled — so
  /// recipients render the card straight from `preview:{...}` (zero fetch). A URL
  /// that unfurls to nothing (or times out) simply sends without a preview.
  Future<void> _dispatchText({
    required String t,
    required int now,
    required Map<String, dynamic>? replyMeta,
    required int? expire,
    required bool isGroup,
  }) async {
    // Optimistic local bubble first — instant feel, independent of the unfurl.
    final localMsg = _Msg(_seq++, true, t, _fmtTime(now),
        ts: now, sent: true, replyTo: replyMeta, expireAt: expire);
    setState(() {
      _msgs.add(localMsg);
      _ctrl.clear();
      _hasText = false;
      _replyTo = null;
    });
    _jump();
    if (_convKey != null) DraftStore().set(_convKey!, '');

    // Unfurl the first URL (best-effort, fast). Skipped entirely when the flag is
    // off or there's no link — no behavioural change for plain messages.
    Map<String, dynamic>? preview;
    if (RemoteConfig.linkPreviewsEnabled) {
      final url = _firstUrl(t);
      if (url != null) {
        preview = await _unfurl(url);
        if (preview != null && mounted) {
          // Show the card on the sender's own bubble too.
          setState(() => localMsg.extra = {...?localMsg.extra, 'preview': preview});
        }
      }
    }

    final env = <String, dynamic>{
      't': isGroup ? 'gtext' : 'text',
      if (isGroup) 'gid': _group!.id,
      if (isGroup) 'fromName': _fromNameTag,
      'body': t,
      if (replyMeta != null) 'replyTo': replyMeta,
      if (expire != null) 'exp': expire,
      if (preview != null) 'preview': preview,
    };
    final id = isGroup ? _gdm!.send(jsonEncode(env)) : _dm!.send(jsonEncode(env));
    _seenEv.add(id);
    localMsg.evId = id;

    if (isGroup) {
      Analytics.capture('group_message_sent', {
        'gid': _group!.id, 'member_count': _group!.members.length, 'kind': 'text',
        'has_reply': replyMeta != null, 'expiring': expire != null,
        'has_preview': preview != null,
      });
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK', preview: t);
    } else if (_peerNpub != null) {
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK', preview: t);
    }
    _schedulePersist();
  }

  /// First http(s) URL in [text], or null. Mirrors the worker/card regex.
  String? _firstUrl(String text) {
    final m = RegExp(r'https?://[^\s<>()]+', caseSensitive: false).firstMatch(text);
    return m?.group(0);
  }

  /// GET /api/unfurl?url=… (auth Clerk bearer). Returns the preview map or null.
  /// Best-effort with a short timeout so a slow site never delays a send much.
  Future<Map<String, dynamic>?> _unfurl(String url) async {
    try {
      final r = await ApiAuth.getSigned(
        '$kUnfurlUrl?url=${Uri.encodeQueryComponent(url)}',
        timeout: const Duration(seconds: 6),
      );
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body);
      if (j is! Map) return null;
      final type = (j['type'] ?? 'link').toString();
      Analytics.capture('unfurl_requested', {
        'type': type,
        'cached': false, // client can't see the KV hit; the server also logs it
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      // Only embed a preview that will actually render a card (else raw link).
      final hasCard = type == 'youtube' ||
          (type == 'link' &&
              (((j['title'] ?? '').toString().isNotEmpty) ||
                  ((j['image'] ?? '').toString().isNotEmpty)));
      return hasCard ? Map<String, dynamic>.from(j) : null;
    } catch (_) {
      return null;
    }
  }

  void _jump() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });

  /// Robust "land on the latest message" used when a thread first opens. A single
  /// post-frame jump can miss because rows/media are still laying out (the extent
  /// grows after the first frame), leaving the view mid-thread. So we jump after
  /// the frame AND again after a short settle so we reliably end at the bottom.
  void _jumpToEndSettled() {
    void toEnd() { if (mounted && _scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent); }
    WidgetsBinding.instance.addPostFrameCallback((_) => toEnd());
    Future.delayed(const Duration(milliseconds: 250), toEnd);
    Future.delayed(const Duration(milliseconds: 600), toEnd);
  }

  // ---- calls ----
  // 1:1 = P2P (CallRoom DO) via _call(). Groups = LiveKit conference via
  // _groupCall() — RULE CHANGE 2026-06-10 (Phase 10): group conferences are
  // allowed, ≤25 participants. The CallRoom DO 2-peer cap stays untouched.
  bool _dialing = false; // debounce: blocks a second call_started while dialing

  Future<void> _call(String kind) async {
    // This path is 1:1 P2P ONLY — group threads route through _groupCall()
    // (LiveKit) and must NEVER reach the CallRoom DO.
    if (widget.chat.group || widget.chat.gid != null) return;
    // Debounce double-taps / re-entrancy: a single video-button tap was firing
    // TWO POST /api/call + two CallScreens ~1s apart, and the colliding second
    // call busied out the first right after it connected — so the connected
    // call tore down and video never rendered ("audio worked, no video came
    // through"). One dial in flight, and none while already on a call.
    if (_dialing || gLiveCallScreens > 0) {
      Analytics.capture('call_dial_suppressed', {
        'reason': _dialing ? 'already_dialing' : 'already_in_call',
        'kind': kind,
      });
      return;
    }
    // CALLFIX-14: glare detection — if an incoming call from the same peer is
    // currently ringing, accept it instead of dialing (resolves simultaneous dials).
    final to = widget.chat.seed; // the peer's uid
    if (gIncomingRingingFrom == to && gIncomingRingingCallId != null) {
      Analytics.capture('call_glare_autoaccept', {
        'call_id': gIncomingRingingCallId!,
        'kind': kind,
      });
      // Accept the incoming call (dismiss ring UI + open the call like a normal accept)
      await PushService.acceptRingingCall(gIncomingRingingCallId!);
      return;
    }
    _dialing = true;
    IceCache.prefetch(); // warm TURN creds in parallel with the FCM ring
    final video = kind == 'video';
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    // [TRACE-ID-1] Mint ONE correlation id at this dial boundary. It rides the
    // /api/call POST header (→ Worker → push payload → callee → RTC telemetry)
    // and is handed to the CallSession so every call event on BOTH devices
    // stitches under one trace_id in PostHog.
    final traceId = TraceContext.mint();
    // (`to` already declared above in the CALLFIX-14 glare block)
    AvaLog.I.log('call', 'placing ${video ? "video" : "audio"} call callId=$room to=${to.length > 12 ? to.substring(0, 12) : to}…');
    // The callee's default ringtone (AI Ringback) — comes back on the /api/call
    // response so the caller hears it locally while ringing.
    String ringbackUrl = '';
    // [MULTIACCT-4] When the server tells us the callee is UNREACHABLE (no
    // registered device / all tokens stale after a re-login), we must NOT open the
    // CallScreen — opening it plays fake ringback into a call that can never ring
    // (the exact "endless ringback, callee never rings" symptom). This flag short-
    // circuits the dial: show a clear message and stop, no ringback.
    bool unreachable = false;
    // Ring the callee's phone via FCM wake (real uid contacts only).
    if (to.startsWith('user_')) {
      try {
        // 'from' is derived server-side from the NIP-98 signature.
        final res = await ApiAuth.postJsonH(kCallUrl, {
          'to': to,
          'fromName': _myName ?? 'AvaTOK',
          'callId': room,
          'kind': video ? 'video' : 'audio',
        }, {'x-trace-id': traceId}); // [TRACE-ID-1] propagate to Worker + push
        AvaLog.I.log('call', 'POST /api/call -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');
        final callKind = video ? 'video' : 'audio';
        // [MULTIACCT-4] Parse the distinct reachability signal the server now
        // returns (`reachable:false` on both the zero-token 404 and — via a later
        // ring-ack — the all-tokens-pruned case). A 404 is always unreachable.
        bool reachableFalse = false;
        try { reachableFalse = jsonDecode(res.body)['reachable'] == false; } catch (_) {}
        // [CALL-GLARE-2] Server-side mutual-dial resolution. The callee was ALREADY
        // dialing us within the glare window, so the server folded both dials into
        // one winning call (smaller callId) instead of ringing a second room. Join
        // that winning room deterministically instead of mounting a new outgoing
        // CallScreen — no busy dead-end. Both devices compute the same winner.
        String glareJoin = '';
        try {
          final jb = jsonDecode(res.body);
          if (jb is Map && jb['glare'] == true) {
            glareJoin = (jb['join_call_id'] ?? '').toString();
          }
        } catch (_) {}
        if (glareJoin.isNotEmpty) {
          Analytics.capture('call_glare_autoconnect', {
            'winner_call_id': glareJoin,
            'my_call_id': room,
            'kind': video ? 'video' : 'audio',
          });
          _dialing = false;
          if (!mounted) return;
          final outgoingWon = glareJoin == room;
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CallScreen(
                room: glareJoin, title: widget.chat.name, seed: to, video: video,
                avatarUrl: widget.chat.avatarUrl,
                // The winner's placer keeps dialing (outgoing); the loser joins the
                // winning room as the answering side so exactly one room forms.
                outgoing: outgoingWon,
                traceId: traceId,
              ),
            ),
          );
          return;
        }
        if (res.statusCode == 200 && !reachableFalse) {
          try { ringbackUrl = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString(); } catch (_) {}
          Analytics.capture('call_place_ok', {'kind': callKind, 'has_ringback': ringbackUrl.isNotEmpty});
        } else if (res.statusCode == 404 || reachableFalse) {
          // The callee has NO reachable device (0 push tokens, or every token went
          // stale after a re-login). Capture it so call reachability is queryable
          // per-callee, and DON'T open the ringing CallScreen — tell the caller.
          unreachable = true;
          Analytics.capture('call_no_device', {
            'to': to.length > 40 ? to.substring(0, 40) : to,
            'kind': callKind,
            'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text('${widget.chat.name} is unreachable right now — ask them to open AvaTOK')));
          }
        } else {
          // Any other non-200 (auth, 5xx, rate-limit) — capture so a failed call
          // placement isn't silent.
          Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind});
        }
      } catch (e) {
        // [CALL-DIAL-FAIL-1] The place-call POST itself threw (network error,
        // DNS failure, or the ~8s ApiAuth.postJson timeout on a flaky
        // connection) — PostHog calls avatok-536eaa7a/c85ed3b7/2810780b: the
        // callee's phone NEVER rang, yet the old code fell through to
        // Navigator.push(CallScreen(...)) below and let the caller sit through
        // a full fake ringback window before dying with timeout-ringing. Treat
        // this exactly like the server-side "unreachable" signal — abort the
        // dial before the CallScreen ever mounts so no ringback plays into the
        // void, and offer an immediate Retry.
        AvaLog.I.log('call', 'POST /api/call FAILED: $e');
        final err = e.toString();
        Analytics.capture('call_place_failed', {
          'call_id': room,
          'kind': video ? 'video' : 'audio',
          'error': err.length > 160 ? err.substring(0, 160) : err,
        });
        unreachable = true;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: const Text("Can't reach the network — check your connection"),
            action: SnackBarAction(
              label: 'Retry',
              onPressed: () {
                Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': video ? 'video' : 'audio'});
                // ignore: unawaited_futures
                _call(kind);
              },
            ),
          ));
        }
      }
    } else {
      AvaLog.I.log('call', 'NOT ringing — contact seed is not an uid ($to)');
    }
    if (!mounted) { _dialing = false; return; }
    // [MULTIACCT-4] Unreachable callee → abort the dial before mounting CallScreen
    // so no ringback plays. The snackbar above already told the user why.
    if (unreachable) { _dialing = false; return; }
    // From here the CallScreen mounts (gLiveCallScreens > 0 guards re-entry),
    // so the in-flight debounce flag can be released.
    _dialing = false;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CallScreen(
          room: room, title: widget.chat.name, seed: to, video: video,
          avatarUrl: widget.chat.avatarUrl, ringbackUrl: ringbackUrl,
          traceId: traceId, // [TRACE-ID-1]
          // [CALL-DIAL-FAIL-1] Retry affordance on the 'network-error' terminal
          // state: re-runs this exact dial flow (fresh room id, fresh POST)
          // instead of leaving the user stuck on a dead call screen.
          onRetry: () {
            Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': kind});
            // ignore: unawaited_futures
            _call(kind);
          },
        ),
      ),
    );
  }

  // ---- group conferencing (Phase 10 — LiveKit, ≤25 participants) ----
  Timer? _confTimer;
  bool _confLive = false;
  bool _confIsMesh = false; // the live call's transport: true=P2P mesh, false=SFU
  int _confCount = 0;

  int get _groupMemberCount => _group?.members.length ?? widget.chat.members;
  bool get _confAllowed => RemoteConfig.conferenceEnabled && _groupMemberCount <= 25;
  bool get _confOngoingHere => OngoingConference.active?.gid == widget.chat.gid && widget.chat.gid != null;

  void _startConfPolling() {
    if (!_isGroup && widget.chat.gid == null) return;
    _confTimer ??= Timer.periodic(const Duration(seconds: 25), (_) => _refreshConfStatus());
    _refreshConfStatus();
  }

  Future<void> _refreshConfStatus() async {
    final gid = widget.chat.gid;
    if (gid == null || !RemoteConfig.conferenceEnabled) return;
    if (_confOngoingHere) {
      // We're connected to the SFU room — count comes straight from it, no HTTP.
      final n = OngoingConference.active!.participantCount;
      if (mounted) setState(() { _confLive = true; _confCount = n; _confIsMesh = false; });
      return;
    }
    final s = await ConferenceApi.status(gid);
    if (s.live) {
      if (mounted) setState(() { _confLive = true; _confCount = s.count; _confIsMesh = false; });
      return;
    }
    // No SFU call live → check for a free-tier P2P mesh call so its banner shows.
    final m = await MeshApi.status(gid);
    if (mounted) setState(() { _confLive = m.live; _confCount = m.count; _confIsMesh = m.live; });
  }

  Future<void> _groupCall(bool video) async {
    final gid = widget.chat.gid;
    if (gid == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('This group needs to sync once before it can hold calls')));
      return;
    }
    if (!RemoteConfig.conferenceEnabled) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Group calls are temporarily unavailable')));
      return;
    }
    // FREE LAUNCH: when the CF Realtime SFU group-audio path is enabled, AUDIO
    // group calls run on Cloudflare Realtime SFU (≤32, active-speaker). Video
    // group calls and the dormant (flag-off) case fall through to LiveKit/mesh.
    if (RemoteConfig.groupAudioSfuEnabled && !video) {
      await _sfuGroupCall();
      return;
    }
    if (_groupMemberCount > 25) { _confLimitNotice(video); return; }

    // Already in THIS group's call (minimized) → just re-open the room screen.
    if (_confOngoingHere) {
      await Navigator.push(context, MaterialPageRoute(
          builder: (_) => ConferenceScreen.resume(OngoingConference.active!)));
      _refreshConfStatus();
      return;
    }
    // In a DIFFERENT call → one call at a time.
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }

    // ONE live call per group. Joiners follow whatever transport is already
    // running, so a free P2P-mesh call and a paid SFU call can never run in
    // parallel for the same group — only the STARTER picks the transport.
    await _refreshConfStatus();
    if (_confLive && _confIsMesh) {
      await _meshCall(video); // a mesh call is live → everyone joins the mesh
      return;
    }

    try {
      final live = _confLive; // an SFU call is live (mesh case handled above)
      final ticket = live
          ? await ConferenceApi.join(gid)
          : await ConferenceApi.start(gid, video: video);
      // In-thread system row so the group sees the call started (the worker
      // webhook also posts rows for server-registered groups).
      if (!live) {
        _sendSpecial('gcall', {'state': 'start', 'kind': ticket.kind, 'gid': gid},
            ticket.kind == 'audio' ? '🎙️ Audio call started — tap 📞 to join' : '📹 Video call started — tap 📞 to join');
      }
      if (!mounted) return;
      await Navigator.push(context, MaterialPageRoute(
          builder: (_) => ConferenceScreen.connect(
              ticket: ticket, gid: gid, title: widget.chat.name, starter: !live)));
      _refreshConfStatus();
    } on MeshRequiredException catch (_) {
      // Server refused this user an SFU seat (free / no Tokens).
      if (_confLive) {
        // An SFU call is already live → do NOT fork a separate mesh call.
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('This call needs Tokens to join — top up your wallet or wait for your daily free Tokens')));
        }
      } else {
        // Nobody is in a call → start a FREE P2P mesh call (≤5).
        await _meshCall(video);
      }
    } on ConferenceException catch (e) {
      if (!mounted) return;
      if (e.status == 403 && e.message.contains('25')) { _confLimitNotice(video); return; }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      AvaLog.I.log('conference', 'group call failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not start the call')));
      }
    }
  }

  /// FREE LAUNCH group AUDIO via Cloudflare Realtime SFU (≤32, active-speaker).
  /// Reached from _groupCall when RemoteConfig.groupAudioSfuEnabled is ON and the
  /// call is audio. Audio-only by design (no group video on this path).
  Future<void> _sfuGroupCall() async {
    final gid = widget.chat.gid;
    if (gid == null) return;
    if (_groupMemberCount > SfuGroupCallApi.maxParticipants) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(
          'This group has more than ${SfuGroupCallApi.maxParticipants} members, '
          'so group audio is not available')));
      return;
    }
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }
    final s = await SfuGroupCallApi.status(gid);
    final starting = !s.live;
    if (starting) {
      _sendSpecial('gcall', {'state': 'start', 'kind': 'audio', 'gid': gid, 'sfu': true},
          '🎙️ Audio call started — tap 📞 to join');
    }
    if (!mounted) return;
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => SfuGroupCallScreen(gid: gid, title: widget.chat.name, starter: starting)));
    _refreshConfStatus();
  }

  /// FREE-tier group call: P2P mesh (≤5) via MeshCallScreen. Reached when the SFU
  /// endpoint refuses a token with `mode:"mesh"` (the caller is on the Free plan).
  Future<void> _meshCall(bool video) async {
    final gid = widget.chat.gid;
    if (gid == null) return;
    // One call at a time (the SFU minimize-holder also blocks here).
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }
    final s = await MeshApi.status(gid);
    if (s.live && s.count >= MeshApi.maxMesh) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('This free call is full (max 5) — upgrade for larger calls')));
      }
      return;
    }
    final starting = !s.live;
    if (starting) {
      _sendSpecial('gcall', {'state': 'start', 'kind': video ? 'video' : 'audio', 'gid': gid, 'mesh': true},
          video ? '📹 Video call started — tap 📞 to join' : '🎙️ Audio call started — tap 📞 to join');
    }
    if (!mounted) return;
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => MeshCallScreen(gid: gid, title: widget.chat.name, video: video, starter: starting)));
    _refreshConfStatus();
  }

  /// Exact copy required by PHASE-10 acceptance criteria.
  void _confLimitNotice(bool video) {
    final what = video ? 'video' : 'audio';
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${video ? 'Video' : 'Audio'} calls disabled'),
        content: Text('This group has more than 25 members, so $what calls are '
            'disabled. You need fewer than 25 people to have a $what conference.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  /// "Ongoing call · 6 — tap to join" banner (PiP return-to-call included:
  /// if we're connected-but-minimized, tapping re-attaches to the live room).
  Widget _confBanner() => GestureDetector(
        onTap: () => _groupCall(true),
        child: Container(
          decoration: const BoxDecoration(
            color: Zine.mint,
            border: Border(bottom: BorderSide(color: Zine.ink, width: 2)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), color: Zine.ink, size: 17),
            const SizedBox(width: 8),
            Expanded(child: Text(
              _confOngoingHere
                  ? 'Ongoing call · $_confCount — tap to return'
                  : 'Ongoing call · $_confCount — tap to join',
              style: ZineText.value(size: 12.5),
            )),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.ink),
          ]),
        ),
      );

  // ---- media send + retry ----
  String _caption(MediaKind k, String name) => switch (k) {
        MediaKind.image => '📷 Photo',
        MediaKind.video => '🎬 Video',
        MediaKind.audio => '🎙️ Voice message',
        MediaKind.file => '📎 $name',
      };

  // ---- special message types: location / contact card / poll / sticker ----
  String _specialCaption(String type, Map<String, dynamic> e) => switch (type) {
        'loc' => '📍 Location',
        'live' => '📍 Live location',
        'card' => '👤 ${e['name'] ?? 'Contact'}',
        'poll' => '📊 ${e['q'] ?? 'Poll'}',
        'sticker' => (e['emoji'] ?? '🙂').toString(),
        'gcall' => e['kind'] == 'audio' ? '🎙️ Audio call' : '📹 Video call',
        // Ava kinds (Phase 0 contract) — caption used for chat-list previews etc.
        'ava' || 'ava_private' => (e['text'] ?? e['body'] ?? 'Ava').toString(),
        'ava_status' => (e['label'] ?? 'Ava is working…').toString(),
        'recept' => (e['text'] ?? '📞 Ava took a message').toString(),
        'marketplace_deal' => '🤝 ${e['outcome'] == 'deal' ? 'Agents reached a deal' : 'Agents finished negotiating'}',
        _ => '',
      };

  void _notifyRecipients() {
    if (_isGroup) {
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK');
    } else if (_peerNpub != null) {
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK');
    }
  }

  void _sendSpecial(String type, Map<String, dynamic> data, String caption) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final payload = {'t': type, ...data, if (_isGroup) ...{'gid': _group!.id, 'fromName': _fromNameTag}};
    String id;
    if (_isGroup && _gdm != null) {
      id = _gdm!.send(jsonEncode(payload));
    } else if (_realMode && _dm != null) {
      id = _dm!.send(jsonEncode(payload));
    } else {
      id = 'local-${DateTime.now().microsecondsSinceEpoch}';
    }
    _seenEv.add(id);
    setState(() => _msgs.add(_Msg(_seq++, true, caption, _fmtTime(now),
        ts: now, evId: id, special: type, extra: data)));
    _jump();
    _schedulePersist();
    _notifyRecipients();
  }

  // Incoming {t:'vote'} envelope (server fan-out or a peer's device). It carries
  // the voter's FULL current selection (`options`), so we REPLACE that voter's
  // rows in the local tally — idempotent for un-vote (empty options) and vote
  // change alike. Legacy single-`opt` envelopes are treated as a one-option add.
  void _applyVote(Map env) {
    final pollId = (env['poll'] ?? '').toString();
    final i = _msgs.indexWhere((x) => x.special == 'poll' && x.extra?['id'] == pollId);
    if (i < 0 || !mounted) return;
    final voter = (env['voter'] ?? '').toString();
    List<int> opts;
    if (env['options'] is List) {
      opts = (env['options'] as List).map((e) => (e as num).toInt()).toList();
    } else if (env['opt'] != null) {
      opts = [(env['opt'] as num).toInt()];
    } else {
      opts = const [];
    }
    setState(() {
      final m = _msgs[i];
      if (voter.isEmpty) {
        // Legacy anonymous vote (no voter id) — best-effort increment only.
        for (final o in opts) m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
        return;
      }
      // Remove this voter from every option, then re-add their current selection.
      for (final entry in m.pollBy.entries.toList()) {
        if (entry.value.remove(voter)) {
          m.pollVotes[entry.key] = ((m.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
        }
      }
      final myUid = _meId?.uid ?? '';
      if (voter == myUid) m.pollMine = opts.toSet();
      for (final o in opts) {
        m.pollBy.putIfAbsent(o, () => <String>{}).add(voter);
        m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
      }
    });
  }

  // Toggle my vote for an option and persist it server-side (survives reinstall).
  // Single-choice: tapping a new option replaces my vote; tapping my current one
  // un-votes. Multi-select: each tap toggles that option independently. The POST
  // sends my FULL selection; the server replaces my rows + fans out {t:'vote'} to
  // every member's InboxDO for live updates.
  void _vote(_Msg poll, int opt) {
    final pollId = poll.extra?['id']?.toString() ?? '';
    if (pollId.isEmpty) return;
    final multi = poll.extra?['multi'] == true;
    final mine = Set<int>.from(poll.pollMine);
    final myUid = _meId?.uid ?? '';
    if (multi) {
      if (!mine.remove(opt)) mine.add(opt);
    } else {
      if (mine.contains(opt)) { mine.clear(); } else { mine.clear(); mine.add(opt); }
    }
    // Optimistic local update (server fan-out will re-affirm).
    setState(() {
      if (myUid.isNotEmpty) {
        for (final entry in poll.pollBy.entries.toList()) {
          if (entry.value.remove(myUid)) {
            poll.pollVotes[entry.key] = ((poll.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
          }
        }
        for (final o in mine) {
          poll.pollBy.putIfAbsent(o, () => <String>{}).add(myUid);
          poll.pollVotes[o] = (poll.pollVotes[o] ?? 0) + 1;
        }
      }
      poll.pollMine = mine;
    });
    HapticFeedback.selectionClick();
    Analytics.capture('poll_vote', {'options': mine.length, 'cleared': mine.isEmpty, 'multi': multi, 'group': _isGroup});
    final conv = _serverConvId;
    if (conv != null) {
      // Durable, server-persisted vote + fan-out (the source of truth).
      ApiAuth.postJson(kPollVoteUrl, {
        'poll_id': pollId, 'conv': conv, 'options': mine.toList(), 'multi': multi,
      }).then((_) {}, onError: (_) {});
    } else {
      // No server conv (rare) — fall back to the legacy live-only envelope so a
      // 1:1/group device still sees the tick immediately.
      final payload = {'t': 'vote', 'poll': pollId, 'voter': myUid, 'options': mine.toList(), 'multi': multi, if (_isGroup) 'gid': _group!.id};
      if (_isGroup && _gdm != null) { _gdm!.send(jsonEncode(payload)); }
      else if (_realMode && _dm != null) { _dm!.send(jsonEncode(payload)); }
    }
  }

  Future<void> _shareLocation() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      _sendSpecial('loc', {'lat': pos.latitude, 'lng': pos.longitude}, '📍 Location');
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't get location")));
    }
  }

  // ---- live location (WhatsApp-style) ----------------------------------------
  /// Pick a duration, grab the first fix, post the durable `t:'live'` bubble, and
  /// start streaming GPS ticks over the ephemeral presence room.
  Future<void> _shareLiveLocation() async {
    final minutes = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Share live location', style: ZineText.cardTitle(size: 18)),
            const SizedBox(height: 4),
            Text('Your real-time position updates as you move, until the time runs out or you tap Stop.',
                style: ZineText.sub(size: 12.5, color: Zine.inkSoft)),
            const SizedBox(height: 12),
            for (final opt in const [
              ('15 minutes', 15),
              ('1 hour', 60),
              ('8 hours', 480),
            ])
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: PhosphorIcon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold), color: Zine.coral),
                title: Text(opt.$1, style: ZineText.value(size: 15)),
                onTap: () => Navigator.pop(ctx, opt.$2),
              ),
          ]),
        ),
      ),
    );
    if (minutes == null) return;

    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        Analytics.error(domain: 'location', code: 'perm_denied', screen: 'chat_thread', action: 'live_share');
        return;
      }

      final pos = await Geolocator.getCurrentPosition();
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final id = const Uuid().v4();
      final until = now + minutes * 60;

      final me = LiveLocationSession(
        id: id,
        lat: pos.latitude,
        lng: pos.longitude,
        until: until,
        mine: true,
        name: _myName ?? 'You',
        heading: pos.heading,
        speed: pos.speed,
        lastTs: now,
      );
      _live[id] = me;

      // Durable bubble (notifies the peer, survives reconnect/history).
      _sendSpecial('live', {
        'id': id,
        'lat': pos.latitude,
        'lng': pos.longitude,
        'until': until,
        'name': _myName ?? 'Me',
      }, '📍 Live location');

      // Stream the moving pin over the ephemeral presence room.
      _liveBroadcaster?.stop('superseded');
      _liveBroadcaster = LiveLocationBroadcaster(
        id: id,
        untilEpoch: until,
        onTick: (lat, lng, hdg, spd) {
          if (!mounted) return;
          final t = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          me.apply(lat, lng, t, heading: hdg, speed: spd);
          _presence?.sendLiveLoc(id, lat, lng, heading: hdg, speed: spd, until: until, ts: t);
          if (t - _liveTickTelemetryTs >= 30) {
            _liveTickTelemetryTs = t;
            Analytics.capture('live_location_tick', {
              'share_id': id,
              'is_sender': true,
              'conv_kind': _isGroup ? 'group' : 'dm',
            });
          }
        },
        onEnd: (reason) {
          me.end();
          _presence?.sendLiveStop(id);
          Analytics.capture('live_location_stopped', {
            'share_id': id,
            'reason': reason,
            'is_sender': true,
          });
          if (mounted) setState(() {});
        },
      )..start();

      Analytics.capture('live_location_started', {
        'share_id': id,
        'duration_min': minutes,
        'conv_kind': _isGroup ? 'group' : 'dm',
        'members': _groupMemberCount,
      });
      AvaLog.I.log('location', 'live share started id=${id.substring(0, 8)} dur=${minutes}m');
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't start live location")));
      Analytics.error(domain: 'location', code: 'live_start_failed', message: '$e', screen: 'chat_thread', action: 'live_share');
    }
  }

  void _stopLiveShare(String id) {
    if (_liveBroadcaster?.id == id) {
      _liveBroadcaster?.stop('manual');
    } else {
      _live[id]?.end();
      _presence?.sendLiveStop(id);
      Analytics.capture('live_location_stopped', {'share_id': id, 'reason': 'manual', 'is_sender': true});
    }
    if (mounted) setState(() {});
  }

  /// Inline live-location bubble: a small OSM preview that re-pins as ticks
  /// arrive, a live status line, and (for my own share) a STOP affordance.
  Widget _liveBubble(LiveLocationSession s) {
    return AnimatedBuilder(
      animation: s,
      builder: (context, _) {
        final active = s.isActive;
        return GestureDetector(
          onTap: () => _openLiveMap(s),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Stack(children: [
                LiveMapView(lat: s.lat, lng: s.lng, width: 220, height: 120, zoom: 15),
                if (active)
                  Positioned(
                    right: 6,
                    top: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                          color: Zine.coral,
                          borderRadius: BorderRadius.circular(100),
                          border: Border.all(color: Zine.ink, width: 2)),
                      child: Text('LIVE', style: ZineText.tag(size: 9.5, color: Colors.white)),
                    ),
                  ),
              ]),
              const SizedBox(height: 6),
              Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(
                    active
                        ? PhosphorIcons.broadcast(PhosphorIconsStyle.fill)
                        : PhosphorIcons.mapPin(PhosphorIconsStyle.fill),
                    color: active ? Zine.coral : Zine.inkSoft,
                    size: 16),
                const SizedBox(width: 6),
                Flexible(child: Text(s.statusLabel(), style: ZineText.value(size: 12.5, color: Zine.blueInk))),
              ]),
              if (s.mine && active)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: GestureDetector(
                    onTap: () => _stopLiveShare(s.id),
                    child: Text('STOP SHARING', style: ZineText.tag(size: 10, color: Zine.coral)),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  void _openLiveMap(LiveLocationSession s) {
    Analytics.capture('live_location_opened', {'share_id': s.id, 'is_sender': s.mine});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => LiveMapScreen(
        session: s,
        title: s.mine ? 'Your live location' : '${s.name} · live',
        onStop: s.mine ? () => _stopLiveShare(s.id) : null,
        onTelemetry: (ev) => Analytics.capture(ev, {'share_id': s.id, 'is_sender': s.mine}),
      ),
    ));
  }

  Future<void> _shareContactCard() async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    showModalBottomSheet(context: context, backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Share a contact', style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 8),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
            for (final c in contacts)
              ListTile(contentPadding: EdgeInsets.zero, leading: Avatar(seed: c.seed, name: c.name, size: 40),
                title: Text(c.name, style: ZineText.value(size: 15)),
                onTap: () { Navigator.pop(ctx); _sendSpecial('card', {'name': c.name, 'uid': c.uid, 'handle': c.handle}, '👤 ${c.name}'); }),
          ])),
        ]))));
  }

  // Create Poll sheet (zine style): question + 2–10 options + a multi-select
  // toggle. The poll DEFINITION rides the message envelope (t:'poll'); votes are
  // persisted server-side (see _vote → /api/poll/vote).
  Future<void> _createPoll() async {
    final q = TextEditingController();
    final opts = <TextEditingController>[TextEditingController(), TextEditingController()];
    var multi = false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: SafeArea(child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(PhosphorIcons.chartBar(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
              const SizedBox(width: 8),
              Text('Create poll', style: ZineText.value(size: 16)),
            ]),
            const SizedBox(height: 14),
            TextField(controller: q, autofocus: true, textCapitalization: TextCapitalization.sentences,
              style: ZineText.value(size: 15),
              decoration: InputDecoration(hintText: 'Ask a question…',
                hintStyle: ZineText.sub(size: 15, color: Zine.inkSoft),
                filled: true, fillColor: Zine.card,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Zine.ink, width: 2)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Zine.ink, width: 2)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Zine.ink, width: 2)))),
            const SizedBox(height: 12),
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
              for (var i = 0; i < opts.length; i++)
                Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(children: [
                  Expanded(child: TextField(controller: opts[i], textCapitalization: TextCapitalization.sentences,
                    style: ZineText.value(size: 14),
                    decoration: InputDecoration(hintText: 'Option ${i + 1}',
                      hintStyle: ZineText.sub(size: 14, color: Zine.inkSoft),
                      isDense: true, filled: true, fillColor: Zine.card,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Zine.ink, width: 2)),
                      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Zine.ink, width: 2)),
                      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Zine.ink, width: 2))))),
                  if (opts.length > 2)
                    IconButton(
                      icon: Icon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), size: 20, color: Zine.inkSoft),
                      onPressed: () => setSheet(() { opts.removeAt(i).dispose(); }),
                    ),
                ])),
            ])),
            if (opts.length < 10)
              TextButton.icon(
                onPressed: () => setSheet(() => opts.add(TextEditingController())),
                icon: Icon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
                label: Text('Add option', style: ZineText.tag(size: 12, color: Zine.ink)),
              ),
            const SizedBox(height: 4),
            InkWell(
              onTap: () => setSheet(() => multi = !multi),
              borderRadius: BorderRadius.circular(10),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Icon(multi ? PhosphorIcons.checkSquare(PhosphorIconsStyle.fill) : PhosphorIcons.square(PhosphorIconsStyle.bold),
                      size: 22, color: multi ? Zine.accents[1] : Zine.inkSoft),
                  const SizedBox(width: 10),
                  Expanded(child: Text('Allow multiple answers', style: ZineText.value(size: 14))),
                ])),
            ),
            const SizedBox(height: 12),
            SizedBox(width: double.infinity, child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Zine.ink, foregroundColor: Zine.paper,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
              onPressed: () => Navigator.pop(ctx, true),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('Create poll', style: ZineText.tag(size: 13, color: Zine.paper))),
            )),
          ]),
        )),
      )),
    );
    if (ok != true) return;
    final options = opts.map((c) => c.text.trim()).where((t) => t.isNotEmpty).toList();
    if (q.text.trim().isEmpty || options.length < 2) {
      if (mounted) _toast('A poll needs a question and at least 2 options.');
      return;
    }
    Analytics.capture('poll_create', {'options': options.length, 'multi': multi, 'group': _isGroup});
    _sendSpecial('poll',
      {'id': const Uuid().v4(), 'q': q.text.trim(), 'options': options, 'multi': multi},
      '📊 ${q.text.trim()}');
  }

  void _stickerPicker() {
    const stickers = ['😀','😂','🥳','😍','😎','🤩','😭','🙏','👍','👏','🔥','❤️','🎉','💯','🚀','🌈','🍕','☕','⚡','✨'];
    showModalBottomSheet(context: context, backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Wrap(spacing: 10, runSpacing: 10, children: [
          for (final s in stickers)
            GestureDetector(onTap: () { Navigator.pop(ctx); _sendSpecial('sticker', {'emoji': s}, s); },
                child: Text(s, style: const TextStyle(fontSize: 38))),
        ]))));
  }

  Widget _specialContent(_Msg m) {
    final e = m.extra ?? {};
    // Both bubble fills (lime/card) are light — text is always ink (§2: white
    // text only on coral).
    const fg = Zine.ink;
    switch (m.special) {
      case 'sticker':
        return Text((e['emoji'] ?? '🙂').toString(), style: const TextStyle(fontSize: 46));
      case 'loc':
        return GestureDetector(
          onTap: () => launchUrl(Uri.parse('https://maps.google.com/?q=${e['lat']},${e['lng']}'),
              mode: LaunchMode.externalApplication),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), color: Zine.coral, size: 20),
            const SizedBox(width: 6),
            Text('Location · open in Maps', style: ZineText.value(size: 13.5, color: Zine.blueInk)),
          ]),
        );
      case 'live':
        {
          final id = (e['id'] ?? '').toString();
          final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          final s = _live.putIfAbsent(
            id,
            () => LiveLocationSession(
              id: id,
              lat: (e['lat'] as num?)?.toDouble() ?? 0,
              lng: (e['lng'] as num?)?.toDouble() ?? 0,
              until: (e['until'] as num?)?.toInt() ?? now,
              mine: m.me,
              name: (e['name'] ?? widget.chat.name).toString(),
            ),
          );
          return _liveBubble(s);
        }
      case 'card':
        return Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: Avatar(seed: (e['uid'] ?? 'c').toString(), name: (e['name'] ?? '').toString(), size: 36),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['name'] ?? 'Contact').toString(), style: ZineText.value(size: 14)),
            GestureDetector(onTap: () => _addSharedContact(e),
                child: Text('ADD CONTACT', style: ZineText.tag(size: 10, color: Zine.blueInk))),
          ]),
        ]);
      case 'gcall':
        // Call start/end system row — Join affordance while the call is live.
        final audio = e['kind'] == 'audio';
        return GestureDetector(
          onTap: _confLive ? () => _groupCall(!audio) : null,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                audio
                    ? PhosphorIcons.phone(PhosphorIconsStyle.fill)
                    : PhosphorIcons.videoCamera(PhosphorIconsStyle.fill),
                size: 17, color: Zine.mintInk),
            const SizedBox(width: 6),
            Text(audio ? 'Audio call' : 'Video call', style: ZineText.value(size: 14)),
            if (_confLive) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                    color: Zine.mint,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2)),
                child: Text('JOIN', style: ZineText.tag(size: 10.5)),
              ),
            ],
          ]),
        );
      case 'poll':
        final options = (e['options'] as List?)?.map((x) => x.toString()).toList() ?? [];
        final multi = e['multi'] == true;
        // Total votes = distinct voters across options (a multi voter counts once
        // toward the "N votes" label). Percentage bars use per-option share of the
        // largest single-option count so bars stay comparable in multi polls.
        final voters = <String>{};
        for (final s in m.pollBy.values) voters.addAll(s);
        final totalVoters = voters.isNotEmpty ? voters.length : m.pollVotes.values.fold<int>(0, (a, b) => a + b);
        return ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 200),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['q'] ?? 'Poll').toString(), style: ZineText.value(size: 14)),
            if (multi) Padding(padding: const EdgeInsets.only(top: 2),
              child: Text('Select one or more', style: ZineText.tag(size: 10, color: Zine.inkSoft))),
            const SizedBox(height: 8),
            for (var i = 0; i < options.length; i++)
              Builder(builder: (_) {
                final count = m.pollVotes[i] ?? 0;
                final maxCount = m.pollVotes.values.fold<int>(0, (a, b) => a > b ? a : b);
                final frac = maxCount > 0 ? count / maxCount : 0.0;
                final mine = m.pollMine.contains(i);
                final pct = totalVoters > 0 ? (count * 100 / totalVoters).round() : 0;
                return GestureDetector(
                  onTap: () => _vote(m, i),
                  onLongPress: (_isGroup && (m.pollBy[i]?.isNotEmpty ?? false)) ? () => _showPollVoters(options[i], m.pollBy[i]!) : null,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    decoration: BoxDecoration(
                        border: Border.all(color: mine ? Zine.accents[1] : Zine.ink, width: 2),
                        borderRadius: BorderRadius.circular(10)),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Stack(children: [
                        // Percentage bar fill.
                        Positioned.fill(child: FractionallySizedBox(
                          alignment: Alignment.centerLeft, widthFactor: frac.clamp(0.0, 1.0),
                          child: Container(color: (mine ? Zine.accents[1] : Zine.ink).withValues(alpha: 0.14)))),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: Row(children: [
                            if (mine) Padding(padding: const EdgeInsets.only(right: 6),
                              child: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 15, color: Zine.accents[1])),
                            Expanded(child: Text(options[i],
                              style: ZineText.sub(size: 13, color: fg).copyWith(fontWeight: mine ? FontWeight.w700 : FontWeight.w500))),
                            Text('$pct%', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                );
              }),
            Padding(padding: const EdgeInsets.only(top: 2),
              child: Text(
                totalVoters == 0 ? 'Tap to vote' : '$totalVoters ${totalVoters == 1 ? 'vote' : 'votes'}'
                    '${m.pollMine.isNotEmpty ? ' · tap again to change' : ''}',
                style: ZineText.tag(size: 10, color: Zine.inkSoft))),
          ]),
        );
      case 'marketplace_deal':
        return _MarketplaceDealCard(extra: e);
      case 'recept':
        return _ReceptionistCard(
          extra: e,
          sessionId: (e['session_id'] ?? e['sid'] ?? '').toString(),
        );
      case 'ava':
      case 'ava_private':
        // Ava's turn. The feminine bubble + "AVA" label are applied in _bubble;
        // here we render her answer as light markdown (bold, numbered lists,
        // bullets, headings) so structured results (e.g. an email digest) look
        // clean instead of showing raw ** and 1. markers.
        final body = (e['text'] ?? e['body'] ?? m.text).toString();
        // In-chat email: when the turn carried structured inbox cards, render the
        // AvaTOK email UI (View / Spam / Delete + read→reply overlay) under the
        // lead line instead of plain text.
        final inbox = AvaInboxEmail.listFrom(e['emails']);
        if (inbox.isNotEmpty) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            EmailInboxCards(emails: inbox),
          ]);
        }
        // Generated image (e.g. "create an image of …"). The public image URL
        // rides in the envelope (media_ref) so it renders even though the
        // separate media_ref column is dropped during sync — that drop was why
        // Ava's image turns showed the caption but never the picture.
        final mediaRef = (e['media_ref'] ?? '').toString();
        if (mediaRef.isNotEmpty) {
          return _avaImageBubble(mediaRef, body, fg);
        }
        // GenUI/A2UI surface (generic): the agent composed a layout from our Zine
        // catalog (calendar today, any tool tomorrow). Rendered natively.
        final a2ui = e['a2ui'];
        if (a2ui is Map) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            AvaA2uiSurface(
              surface: a2ui.cast<String, dynamic>(),
              onPrompt: (t) { if (onSummonAva != null) onSummonAva!('$_avaWakeWord $t'); },
              onComposio: _onGenuiComposio,
            ),
          ]);
        }
        return _avaRich(body, fg);
      default:
        return Text(m.text, style: ZineText.sub(size: 13.5, color: fg));
    }
  }

  /// Lightweight markdown renderer for Ava's bubbles (no extra dependency).
  /// Handles: # headings, **bold**, `code`, numbered lists (1.) and bullets
  /// (- / *), and blank-line spacing — enough to make digests/results look neat.
  Widget _avaRich(String text, Color fg) {
    final base = ZineText.sub(size: 13.5, color: fg).copyWith(height: 1.32);
    final lines = text.replaceAll('\r\n', '\n').split('\n');
    final out = <Widget>[];
    final numRe = RegExp(r'^\s*(\d+)\.\s+(.*)$');
    final bulRe = RegExp(r'^\s*[-*]\s+(.*)$');
    final headRe = RegExp(r'^#{1,6}\s+(.*)$');
    for (final raw in lines) {
      final line = raw.trimRight();
      if (line.trim().isEmpty) { out.add(const SizedBox(height: 7)); continue; }
      final head = headRe.firstMatch(line);
      final num = numRe.firstMatch(line);
      final bul = bulRe.firstMatch(line);
      if (head != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(top: 2, bottom: 3),
          child: _avaInline(head.group(1)!, base.copyWith(fontWeight: FontWeight.w800, fontSize: 14.5)),
        ));
      } else if (num != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 22, child: Text('${num.group(1)}.',
                style: base.copyWith(fontWeight: FontWeight.w800, color: Zine.blueInk))),
            Expanded(child: _avaInline(num.group(2)!, base)),
          ]),
        ));
      } else if (bul != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Padding(padding: const EdgeInsets.only(left: 2, right: 8, top: 1),
                child: Text('•', style: base.copyWith(fontWeight: FontWeight.w800, color: Zine.blueInk))),
            Expanded(child: _avaInline(bul.group(1)!, base)),
          ]),
        ));
      } else {
        out.add(_avaInline(line, base));
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: out);
  }

  /// Render inline **bold** and `code` spans within one line.
  Widget _avaInline(String text, TextStyle base) {
    final spans = <TextSpan>[];
    final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+?)`');
    var i = 0;
    for (final mt in re.allMatches(text)) {
      if (mt.start > i) spans.add(TextSpan(text: text.substring(i, mt.start)));
      if (mt.group(1) != null) {
        spans.add(TextSpan(text: mt.group(1), style: base.copyWith(fontWeight: FontWeight.w800)));
      } else {
        spans.add(TextSpan(text: ' ${mt.group(2)} ',
            style: base.copyWith(fontFeatures: const [], backgroundColor: Zine.paper2)));
      }
      i = mt.end;
    }
    if (i < text.length) spans.add(TextSpan(text: text.substring(i)));
    return RichText(text: TextSpan(style: base, children: spans.isEmpty ? [TextSpan(text: text)] : spans));
  }

  /// True when this message is one of Ava's persisted bubble kinds. Uses the
  /// Phase 0 contract (app/lib/core/ava_contracts.dart) so the kind strings stay
  /// in one place.
  bool _isAvaBubble(_Msg m) => AvaKind.isBubble(m.special);

  // Per-sender bubble tint for GROUP chats — a stable colour picked from a small
  // pastel palette by hashing the sender label, so each person keeps the same
  // colour throughout the thread and you can tell who's who at a glance. Lime
  // (me) and lilac (Ava) are intentionally excluded from this palette.
  static const List<Color> _groupTints = [
    Zine.mint,
    Zine.blue,
    Zine.coral,
    Color(0xFFF7D070), // amber
    Color(0xFFB7E4A0), // sage
    Color(0xFFF3A6C9), // pink
  ];
  Color _groupSenderTint(String sender) {
    var h = 0;
    for (final c in sender.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return _groupTints[h % _groupTints.length];
  }

  /// The inline "Ava is working…" chip row (kind 'ava_status'). Not a normal
  /// bubble — a subtle lilac pill with a tiny spinner. Generic: any phase that
  /// posts an 'ava_status' frame gets this with no extra UI work.
  Widget _avaStatusChip(_Msg m) {
    final label = (m.extra?['label'] ?? m.text).toString();
    // Image generation gets a ChatGPT-style inline placeholder (a blank, image-
    // shaped card with a spinner) instead of the small text pill. It auto-
    // collapses when the finished image (a normal ava media_ref message) arrives
    // and this transient 'ava_status' chip is dropped.
    final isImage = (m.extra?['source'] ?? '').toString() == 'image' ||
        label.toLowerCase().contains('generating an image');
    if (isImage) return _imageGeneratingCard(label);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: Zine.lilac,
          borderRadius: BorderRadius.circular(100),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(width: 12, height: 12,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: Zine.ink)),
          const SizedBox(width: 8),
          Text(label.isEmpty ? 'Ava is working…' : label,
              style: ZineText.sub(size: 12.5, color: Zine.ink)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// ChatGPT-style placeholder shown WHILE Ava generates an image: a blank,
  /// image-shaped card with a spinner and a status line. Replaced by the real
  /// picture (a normal ava media_ref bubble) when generation finishes.
  Widget _imageGeneratingCard(String label) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        width: 240,
        height: 200,
        decoration: BoxDecoration(
          color: Zine.lilac,
          borderRadius: BorderRadius.circular(14),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(PhosphorIcons.image(PhosphorIconsStyle.duotone),
              size: 34, color: Zine.ink),
          const SizedBox(height: 14),
          const SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink)),
          const SizedBox(height: 12),
          Text(label.isEmpty ? 'Generating image…' : label,
              style: ZineText.sub(size: 12.5, color: Zine.ink)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// A finished Ava image bubble: the picture, tappable to open full-screen, with
  /// a ⋮ overflow menu (Open / Download full-res / Share) in the top-right corner.
  Widget _avaImageBubble(String mediaRef, String body, Color fg) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (body.isNotEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
      ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(children: [
          GestureDetector(
            onTap: () => _openImageFull(mediaRef),
            // Disk-cached so it loads instantly on reopen (no re-download).
            child: CachedImage(mediaRef, width: 240),
          ),
          Positioned(
            top: 6,
            right: 6,
            child: DecoratedBox(
              decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
              child: PopupMenuButton<String>(
                tooltip: 'Image options',
                icon: const Icon(Icons.more_vert, size: 18, color: Colors.white),
                padding: EdgeInsets.zero,
                onSelected: (v) {
                  if (v == 'open') _openImageFull(mediaRef);
                  if (v == 'download') _downloadImage(mediaRef);
                  if (v == 'share') _downloadImage(mediaRef, share: true);
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'open', child: Text('Open')),
                  PopupMenuItem(value: 'download', child: Text('Download full-res')),
                  PopupMenuItem(value: 'share', child: Text('Share')),
                ],
              ),
            ),
          ),
        ]),
      ),
    ]);
  }

  /// Full-screen, pinch-to-zoom view of a generated image.
  void _openImageFull(String url) {
    showDialog<void>(
      context: context,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(children: [
          InteractiveViewer(
            minScale: 0.8,
            maxScale: 4,
            child: Center(
              child: Image.network(AvatarCache.sizedUrl(url, 1600),
                  errorBuilder: (_, __, ___) => const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Image unavailable',
                          style: TextStyle(color: Colors.white)))),
            ),
          ),
          Positioned(
            top: 8, right: 8,
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white),
              onPressed: () => Navigator.of(dctx).maybePop(),
            ),
          ),
        ]),
      ),
    );
  }

  /// Full-screen, pinch-to-zoom view of a DECRYPTED chat photo (received or
  /// sent). Tap any photo bubble to open it in-session; an X closes it and a
  /// copy button puts the image on the clipboard so it can be pasted elsewhere.
  void _openImageBytes(Uint8List bytes, {String? mime}) {
    Analytics.capture('chat_image_open', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'size': bytes.length,
    });
    showDialog<void>(
      context: context,
      barrierColor: Colors.black,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: EdgeInsets.zero,
        child: Stack(children: [
          Positioned.fill(
            child: InteractiveViewer(
              minScale: 0.8,
              maxScale: 5,
              child: Center(child: Image.memory(bytes, errorBuilder: (_, __, ___) => const SizedBox.shrink())),
            ),
          ),
          // X — close the viewer.
          Positioned(
            top: 40, right: 8,
            child: _viewerButton(Icons.close, 'Close',
                () => Navigator.of(dctx).maybePop()),
          ),
          // Copy the image to the system clipboard (paste into any app).
          Positioned(
            top: 40, left: 8,
            child: _viewerButton(Icons.copy, 'Copy',
                () => _copyImageBytes(bytes, mime: mime)),
          ),
        ]),
      ),
    );
  }

  Widget _viewerButton(IconData icon, String tooltip, VoidCallback onTap) =>
      DecoratedBox(
        decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
        child: IconButton(
          tooltip: tooltip,
          icon: Icon(icon, color: Colors.white),
          onPressed: onTap,
        ),
      );

  /// Put a chat image on the system clipboard so it can be pasted into another
  /// app. Flutter's built-in Clipboard is text-only, so this uses super_clipboard
  /// (Formats.png / Formats.jpeg). Degrades gracefully where unsupported.
  Future<void> _copyImageBytes(Uint8List bytes, {String? mime}) async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) {
      _capNote('Copying images isn’t supported on this device.');
      return;
    }
    // Label by real format: PNG magic (‰PNG) or the declared mime, else JPEG.
    final isPng = (mime?.toLowerCase().contains('png') ?? false) ||
        (bytes.length > 4 && bytes[0] == 0x89 && bytes[1] == 0x50 &&
            bytes[2] == 0x4E && bytes[3] == 0x47);
    try {
      final item = DataWriterItem();
      item.add(isPng ? Formats.png(bytes) : Formats.jpeg(bytes));
      await clipboard.write([item]);
      HapticFeedback.selectionClick();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Image copied'), duration: Duration(seconds: 1)));
      }
      Analytics.capture('chat_image_copied', {
        'mime': isPng ? 'image/png' : 'image/jpeg',
        'size': bytes.length,
      });
    } catch (e) {
      _capNote('Couldn’t copy the image.');
      Analytics.capture('chat_image_copy_failed', {'err': e.toString()});
    }
  }

  /// Load a message's image bytes and copy it to the clipboard. Handles both a
  /// real chat photo (cached or decrypt) and an Ava-generated image (fetched
  /// from its public `media_ref` URL).
  Future<void> _copyImageFromMsg(_Msg m) async {
    Uint8List? bytes = m.localBytes;
    String? mime = m.media?.contentType;
    if (bytes == null && m.media != null) {
      bytes = await MediaService.downloadAndDecrypt(m.media!);
    }
    if (bytes == null) {
      final url = _imageRefOf(m);
      if (url.isNotEmpty) {
        try {
          final res = await http.get(Uri.parse(url));
          if (res.statusCode == 200) {
            bytes = res.bodyBytes;
            mime = res.headers['content-type'] ?? mime;
          }
        } catch (_) {}
      }
    }
    if (bytes == null) { _capNote('Could not load this image.'); return; }
    if (m.media != null) m.localBytes = bytes; // cache real chat media only
    await _copyImageBytes(bytes, mime: mime);
  }

  /// Download the FULL-RESOLUTION image (the stored public URL is already the
  /// full-res PNG; the in-chat preview is just display-sized) and hand it to the
  /// OS share sheet so the user can save it to Photos or send it on.
  Future<void> _downloadImage(String url, {bool share = false}) async {
    try {
      final res = await http.get(Uri.parse(url));
      if (res.statusCode != 200) throw 'http ${res.statusCode}';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/ava_image_${DateTime.now().millisecondsSinceEpoch}.png');
      await f.writeAsBytes(res.bodyBytes, flush: true);
      await Share.shareXFiles([XFile(f.path)], subject: 'Ava image');
      Analytics.capture('ava_image_download', {'ok': true, 'share': share});
    } catch (e) {
      Analytics.capture('ava_image_download', {'ok': false, 'error': e.toString()});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't download the image")));
      }
    }
  }

  /// Export a chat media message (image / video / file / voice note) to the OS
  /// share sheet so it can be sent to WhatsApp, Files, etc. Decrypts/loads the
  /// bytes on-device, writes a temp file with a sensible name + extension, and
  /// hands it to share_plus. This is what was missing for voice recordings —
  /// Forward only sent in-app; there was no way OUT to another app.
  Future<void> _shareMedia(_Msg m) async {
    try {
      Uint8List? bytes = m.localBytes;
      if (bytes == null && m.media != null) {
        bytes = await MediaService.downloadAndDecrypt(m.media!);
      }
      if (bytes == null) { _capNote('Could not load this attachment to share.'); return; }
      final ct = m.media?.contentType ?? '';
      final kind = m.media?.kind ??
          (m.localBytes != null ? MediaKind.image : MediaKind.file);
      final ext = _extFor(ct, kind);
      final base = (m.media?.name ?? '').trim();
      final safe = base.isNotEmpty && base.contains('.')
          ? base
          : 'avatok_${DateTime.now().millisecondsSinceEpoch}$ext';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/$safe');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: ct.isEmpty ? null : ct)]);
      Analytics.capture('chat_media_shared_out', {'kind': kind.name, 'ok': true});
    } catch (e) {
      Analytics.capture('chat_media_shared_out', {'ok': false, 'error': e.toString()});
      if (mounted) _capNote('Couldn’t share this attachment.');
    }
  }

  /// Pick a file extension from a content type, falling back to the media kind.
  static String _extFor(String contentType, MediaKind kind) {
    final ct = contentType.toLowerCase();
    if (ct.contains('png')) return '.png';
    if (ct.contains('jpeg') || ct.contains('jpg')) return '.jpg';
    if (ct.contains('gif')) return '.gif';
    if (ct.contains('webp')) return '.webp';
    if (ct.contains('mp4') && kind == MediaKind.audio) return '.m4a';
    if (ct.contains('mp4')) return '.mp4';
    if (ct.contains('quicktime') || ct.contains('mov')) return '.mov';
    if (ct.contains('wav')) return '.wav';
    if (ct.contains('mpeg') && kind == MediaKind.audio) return '.mp3';
    if (ct.contains('mp3')) return '.mp3';
    if (ct.contains('ogg') || ct.contains('opus')) return '.ogg';
    if (ct.contains('pdf')) return '.pdf';
    switch (kind) {
      case MediaKind.image: return '.jpg';
      case MediaKind.video: return '.mp4';
      case MediaKind.audio: return '.m4a';
      case MediaKind.file: return '';
    }
  }

  Future<void> _addSharedContact(Map e) async {
    final uid = (e['uid'] ?? '').toString();
    if (!uid.startsWith('user_')) return;
    await ContactsStore().add(Contact(uid: uid, name: (e['name'] ?? 'Contact').toString(), handle: (e['handle'] ?? '').toString()));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${e['name']} added')));
  }

  Future<void> _sendMedia(MediaKind kind, Uint8List bytes, String ct, String name, {String caption = ''}) async {
    // Stamp the message with a real send time. Without this it defaulted to ts=0,
    // so any list re-sort floated the bubble to the very TOP of the thread and it
    // appeared to "disappear" from the bottom where it was just added.
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final msg = _Msg(_seq++, true, _caption(kind, name), _fmtTime(now),
        ts: now, localBytes: bytes, uploading: true, mediaCaption: caption);
    setState(() => _msgs.add(msg));
    _jump();
    // Index shared docs/images into the user's own RAG store (content extraction
    // supports text/PDF/Office/PNG/JPEG, not audio/video). Fire-and-forget.
    if (kind == MediaKind.image || kind == MediaKind.file) {
      // ignore: unawaited_futures
      RagService.I.ingestFileBytes(bytes, ct, name);
    }
    // Also index a short DESCRIPTOR line (name + caption + kind) for EVERY
    // attachment — so "@ava find the logo I sent" / "the video about X" resolves
    // by name even when the bytes aren't text-extractable (video/audio) or the
    // content lacks the words the user searches by. This is what makes Ava able
    // to find files via Cloudflare AI Search.
    final descr = StringBuffer('Shared a ${kind.name} named "$name"');
    if (caption.trim().isNotEmpty) descr.write(' — note: ${caption.trim()}');
    // ignore: unawaited_futures
    RagService.I.ingestText(descr.toString(), name: 'chat-${widget.chat.name}-file');
    Analytics.capture('chat_media_sent', {
      'kind': kind.name,
      'has_caption': caption.trim().isNotEmpty,
      'size': bytes.length,
      'conv_kind': _isGroup ? 'group' : 'dm',
    });
    await _upload(msg, bytes, kind, ct, name, caption: caption);
  }

  Future<void> _upload(_Msg msg, Uint8List bytes, MediaKind kind, String ct, String name, {String caption = ''}) async {
    setState(() { msg.uploading = true; msg.failed = false; });
    try {
      // [CHAT-UPLOAD-1] A live 1:1 call shares this device's uplink. Encrypt off
      // the main thread + pace the ciphertext PUT so the upload never starves
      // WebRTC (which previously forced both-sides reconnects). Full speed off-call.
      final live = CallSessionManager.instance.current;
      final inCall = live != null && !live.isEnded;
      final m = await MediaService.encryptAndUpload(bytes, kind: kind, contentType: ct, name: name, caption: caption, inCall: inCall);
      if (!mounted) return;
      setState(() { msg.media = m; msg.uploading = false; });
      final keyShort = m.id.length > 12 ? m.id.substring(m.id.length - 8) : m.id;
      // Deliver the media reference + key inside an encrypted DM / group fan-out.
      if (_isGroup && _gdm != null) {
        final id = _gdm!.send(jsonEncode({...m.toEnvelope(), 't': 'gmedia', 'gid': _group!.id, 'fromName': _fromNameTag}));
        msg.evId = id;
        _seenEv.add(id);
        Analytics.capture('group_message_sent', {
          'gid': _group!.id, 'member_count': _group!.members.length, 'kind': kind.name,
        });
        AvaLog.I.log('media', 'sent gmedia kind=${kind.name} ${bytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      } else if (_realMode && _dm != null) {
        final id = _dm!.send(jsonEncode(m.toEnvelope()));
        msg.evId = id;
        _seenEv.add(id);
        AvaLog.I.log('media', 'sent dm media kind=${kind.name} ${bytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      }
      _schedulePersist(); // cache the media message so it survives reopen
    } catch (e) {
      if (!mounted) return;
      AvaLog.I.log('media', 'send media FAILED kind=${kind.name}: $e');
      setState(() { msg.uploading = false; msg.failed = true; });
    }
  }

  // STREAM E — GIPHY send (Tenor→GIPHY migration). Download the full media bytes
  // from GIPHY's CDN, then push them through the SAME encrypted media pipeline as
  // any photo so the recipient fetches from R2 (never GIPHY). No fork of the
  // upload path. Routing by GIPHY content type:
  //   • clip  → video message (mp4 WITH sound)
  //   • sticker / text / emoji → bubble-less sticker (kind:"sticker" via name tag)
  //   • gif   → animated media (image/gif or webp)
  Future<void> _sendGif(GifResult g) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushGif(g.toRecent());
    Analytics.capture('giphy_selected', {
      'content_type': g.contentType.wire,
      'conv_kind': _isGroup ? 'group' : 'dm',
    });
    Analytics.capture('gif_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'query_len': g.desc.length,
      'content_type': g.contentType.wire,
    });
    final bytes = await GifApi.download(g.url);
    if (!mounted) return;
    if (bytes == null || bytes.isEmpty) { _capNote("Couldn't send GIF"); return; }
    if (bytes.length > _kMediaMaxBytes) { _capNote('That GIF is too large'); return; }

    final lowerUrl = g.url.toLowerCase();
    switch (g.contentType) {
      case GifContentType.clip:
        // Clips = GIF WITH SOUND → send as a video message.
        await _sendMedia(
          MediaKind.video, bytes, 'video/mp4', 'giphy-${g.id}.mp4');
        return;
      case GifContentType.sticker:
      case GifContentType.text:
      case GifContentType.emoji:
        // Transparent WebP/GIF → render bubble-less at 160dp (Stream E sticker
        // path). Reuse the sticker name tag so the bubble builder detects it.
        final isGif = lowerUrl.contains('.gif');
        await _sendMedia(
          MediaKind.image,
          bytes,
          isGif ? 'image/gif' : 'image/webp',
          stickerMediaName('giphy/${g.id}.${isGif ? 'gif' : 'webp'}'),
        );
        return;
      case GifContentType.gif:
        final isMp4 = lowerUrl.contains('.mp4');
        final isWebp = lowerUrl.contains('.webp');
        await _sendMedia(
          isMp4 ? MediaKind.video : MediaKind.image,
          bytes,
          isMp4 ? 'video/mp4' : (isWebp ? 'image/webp' : 'image/gif'),
          'giphy-${g.id}.${isMp4 ? 'mp4' : (isWebp ? 'webp' : 'gif')}',
        );
        return;
    }
  }

  // STREAM E — sticker send. Load the bundled .webp bytes and send through the
  // encrypted media pipeline, tagging the media name so the message can render
  // as a bubble-less 160dp sticker (see sticker_media.dart). Reuses _sendMedia.
  Future<void> _sendStickerAsset(String assetPath) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushSticker(assetPath);
    Analytics.capture('sticker_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'pack': assetPath.split('/').length > 2 ? assetPath.split('/')[2] : 'unknown',
    });
    try {
      final data = await rootBundle.load(assetPath);
      final bytes = data.buffer.asUint8List();
      if (!mounted) return;
      await _sendMedia(
          MediaKind.image, bytes, 'image/webp', stickerMediaName(assetPath));
    } catch (_) {
      if (mounted) _capNote("Couldn't send sticker");
    }
  }

  // Upload caps (owner rule): photos/videos ≤ 25 MB each; ≤ 8 photos per pick.
  static const int _kMediaMaxBytes = 25 * 1024 * 1024;
  static const int _kMaxPhotosPerPick = 8;

  void _capNote(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // Camera → one photo. (Gallery multi-select uses _pickPhotos.)
  Future<void> _pickImage(ImageSource source) async {
    final x = await _picker.pickImage(source: source, imageQuality: 85);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
    await _sendImageWithCaption(bytes, 'image/jpeg', x.name);
  }

  // Photo caption step: preview the picked image and let the user "say something
  // about the pic" before it goes out. WhatsApp-style: the caption rides INSIDE
  // the photo's own message envelope, so the picture + its text are ONE bubble.
  // This is what lets Ava link an "@ava send this as email" instruction to the
  // photo it refers to — previously the caption went out as a SEPARATE text
  // message, so by the time Ava processed the request the attachment wasn't tied
  // to it and she'd ask "where's the photo / what's its S3 key?".
  /// The composer text was carried into an attachment's caption — clear it so it
  /// is NOT also sent as a separate text message (the "splits into two" bug).
  void _consumeComposer(String seed) {
    if (seed.isEmpty) return;
    setState(() { _ctrl.clear(); _hasText = false; });
    if (_convKey != null) DraftStore().set(_convKey!, '');
  }

  Future<void> _sendImageWithCaption(Uint8List bytes, String ct, String name) async {
    // WhatsApp-style: if the user already typed something in the composer, carry
    // it INTO the caption field (seed) instead of sending it as a separate text
    // message. This is the fix for "my message splits into two parts" — the photo
    // and the words now travel as ONE message, so Ava can link the instruction to
    // the attachment.
    final seed = _ctrl.text.trim();
    final caption = await _captionSheet(bytes, initial: seed);
    if (caption == null) return; // user backed out
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: photo + caption together (awaits upload + delivery so the
    // attachment is on the InboxDO before we summon Ava below).
    await _sendMedia(MediaKind.image, bytes, ct, name, caption: c);
    if (c.isEmpty) return;
    // Index the caption into the user's own RAG store (same as a normal line),
    // but skip @ava control lines.
    _ragAddLine('You', c);
    // If the caption summons Ava (@ava / #ava / Ava-mode), fire the in-thread
    // turn now — the photo (with this caption) is already on the InboxDO, so the
    // server's recentWindow sees the attachment AND the instruction together.
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  // ---- clipboard image paste into the composer ----
  /// Read an image off the system clipboard (PNG/JPEG via super_clipboard) and,
  /// if one is present, send it as a photo attachment (with the WhatsApp-style
  /// caption sheet). Returns true when an image was found and handled, so the
  /// caller can skip the normal text-paste fallback. Flutter's built-in
  /// `Clipboard` is text-only — this is what makes "copy an image elsewhere,
  /// paste it into the chat box" actually work.
  Future<bool> _tryPasteImage() async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) return false;
    try {
      final reader = await clipboard.read();
      final fmt = reader.canProvide(Formats.png)
          ? Formats.png
          : (reader.canProvide(Formats.jpeg) ? Formats.jpeg : null);
      if (fmt == null) return false;
      final done = Completer<Uint8List?>();
      reader.getFile(fmt, (file) async {
        try {
          done.complete(await file.readAll());
        } catch (_) {
          if (!done.isCompleted) done.complete(null);
        }
      }, onError: (_) {
        if (!done.isCompleted) done.complete(null);
      });
      final bytes = await done.future;
      if (bytes == null || bytes.isEmpty) return false;
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'clipboard'});
        _capNote('That image is over 25 MB — please copy a smaller one.');
        return true; // we DID find an image; just too big to fall back to text
      }
      final isPng = fmt == Formats.png;
      final mime = isPng ? 'image/png' : 'image/jpeg';
      final ext = isPng ? 'png' : 'jpg';
      Analytics.capture('chat_image_pasted', {'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
      return true;
    } catch (e) {
      AvaLog.I.log('media', 'paste image failed: $e');
      Analytics.capture('chat_image_paste_failed', {'err': e.toString()});
      return false;
    }
  }

  /// Keyboard / system-clipboard rich-content insertion (Android commitContent).
  /// This is the path Samsung's "super paste" panel and Gboard's image/GIF paste
  /// use — distinct from the toolbar Paste button. The inserted image arrives as
  /// bytes (or a content URI the engine resolves for us), so route it straight to
  /// the photo-with-caption flow, mirroring _tryPasteImage. Falls back to a
  /// clipboard read if the payload is empty.
  Future<void> _onContentInserted(KeyboardInsertedContent content) async {
    try {
      final data = content.data;
      if (data == null || data.isEmpty) {
        // The Samsung "super paste" / blank-editor failure mode: the keyboard
        // announced an image but handed us nothing. Record it, then fall back to
        // reading the clipboard so the paste can still succeed.
        Analytics.capture('chat_image_insert_empty', {'mime': content.mimeType});
        await _tryPasteImage();
        return;
      }
      final bytes = Uint8List.fromList(data);
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'insert'});
        _capNote('That image is over 25 MB — please use a smaller one.');
        return;
      }
      final mime = content.mimeType.isNotEmpty ? content.mimeType : 'image/png';
      final ext = mime.contains('gif')
          ? 'gif'
          : (mime.contains('png') ? 'png' : (mime.contains('webp') ? 'webp' : 'jpg'));
      Analytics.capture('chat_image_inserted', {'mime': mime, 'size': bytes.length});
      // [CHAT-PASTE-1] keyboard/system commitContent path.
      Analytics.capture('chat_image_pasted', {'via': 'keyboard', 'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
    } catch (e) {
      AvaLog.I.log('media', 'content insert failed: $e');
      Analytics.capture('chat_image_insert_failed', {'err': e.toString()});
      if (mounted) _capNote("Couldn't paste that image — long-press the box to paste.");
    }
  }

  /// Composer paste entry point used by both the toolbar "Paste" button and the
  /// hardware Cmd/Ctrl+V shortcut. Tries an image first; on miss, falls back to
  /// the normal text paste (insert at the cursor / replace the selection).
  Future<void> _onComposerPaste({String via = 'context_menu'}) async {
    final handledImage = await _tryPasteImage();
    if (handledImage) {
      // [CHAT-PASTE-1] toolbar/context-menu Paste or hardware Cmd/Ctrl+V.
      Analytics.capture('chat_image_pasted', {'via': via});
      return;
    }
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    final base = _ctrl.text;
    final sel = _ctrl.selection;
    final start = sel.start < 0 ? base.length : sel.start;
    final end = sel.end < 0 ? base.length : sel.end;
    final newText = base.replaceRange(start, end, text);
    _ctrl.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    _onInputChanged(newText);
  }

  // Bottom sheet: image preview + a caption field. Returns the caption (possibly
  // empty → send with no caption) or null if dismissed without sending.
  Future<String?> _captionSheet(Uint8List bytes, {String initial = ''}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 14,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Image.memory(bytes,
                width: double.infinity,
                height: 280,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink()),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rField),
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ZineText.input(size: 15),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: 'Add a caption…',
                    hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  // Gallery → up to 8 photos in one go; each capped at 25 MB.
  Future<void> _pickPhotos() async {
    final xs = await _picker.pickMultiImage(imageQuality: 85);
    if (xs.isEmpty) return;
    final take = xs.length > _kMaxPhotosPerPick ? xs.sublist(0, _kMaxPhotosPerPick) : xs;
    if (xs.length > _kMaxPhotosPerPick) _capNote('Up to 8 photos at a time — sending the first 8.');
    // Single photo → offer the caption step ("say something about the pic").
    if (take.length == 1) {
      final bytes = await take.first.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
      await _sendImageWithCaption(bytes, 'image/jpeg', take.first.name);
      return;
    }
    // Composer text rides as the caption on the FIRST photo (one bubble), so a
    // multi-pick never splits the user's words into a separate message.
    final seed = _ctrl.text.trim();
    var firstSent = true;
    var skipped = 0;
    for (final x in take) {
      final bytes = await x.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { skipped++; continue; }
      await _sendMedia(MediaKind.image, bytes, 'image/jpeg', x.name,
          caption: firstSent ? seed : '');
      firstSent = false;
    }
    _consumeComposer(seed);
    if (skipped > 0) _capNote('$skipped photo(s) skipped — over the 25 MB limit.');
  }

  // VIDPOL-1: chat videos are transcoded to 720p H.264 on-device, then held to a
  // hard 64 MB cap. Source clips off a modern phone are often 200+ MB; the
  // transcode brings a typical 3–5 min clip well under the cap, and anything
  // still over is rejected with the owner-mandated notice below.
  static const int _kVideoMaxBytes = 64 * 1024 * 1024; // 64 MB (VIDPOL-1/2)
  static const String _kVideoTooBigMsg =
      'Videos are limited to 64 MB (about 3–5 minutes). Trim it and try again.';

  Future<void> _pickVideo(ImageSource source) async {
    // Recording auto-stops at the clip cap; gallery picks an existing clip.
    final x = await _picker.pickVideo(source: source, maxDuration: kVideoClipMax);
    if (x == null) return;
    final inBytes = await x.readAsBytes();
    final inLen = inBytes.length;

    // Compress to 720p H.264 via the platform encoder. Best-effort: if the
    // transcode fails/returns nothing, fall back to the original bytes and let
    // the 64 MB cap below decide.
    Uint8List bytes = inBytes;
    String name = x.name;
    double? durationS;
    if (mounted) _capNote('Optimising video…');
    try {
      final info = await VideoCompress.compressVideo(
        x.path,
        quality: VideoQuality.Res1280x720Quality, // 720p H.264
        deleteOrigin: false,
        includeAudio: true,
      );
      durationS = info?.duration == null ? null : (info!.duration! / 1000.0);
      final outPath = info?.file?.path;
      if (outPath != null) {
        final out = await File(outPath).readAsBytes();
        if (out.isNotEmpty) {
          bytes = out;
          if (!name.toLowerCase().endsWith('.mp4')) name = '$name.mp4';
        }
      }
    } catch (e) {
      AvaLog.I.log('media', 'video compress failed, using original: $e');
    }

    if (bytes.length > _kVideoMaxBytes) {
      _capNote(_kVideoTooBigMsg);
      // Email rides in the envelope (Analytics._base); support can pull why a
      // video never sent, keyed by user + byte size. (VIDPOL telemetry)
      Analytics.capture('video_upload_rejected', {'bytes': bytes.length});
      return;
    }
    Analytics.capture('video_upload_compressed', {
      'in_bytes': inLen,
      'out_bytes': bytes.length,
      if (durationS != null) 'duration_s': durationS,
    });
    await _sendVideoWithCaption(bytes, name);
  }

  // Videos get the same caption/instruction step as photos + files, so any text
  // typed in the composer rides INSIDE the video's message (one bubble) and an
  // `@ava` instruction stays attached to the clip it refers to.
  Future<void> _sendVideoWithCaption(Uint8List bytes, String name) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed, label: 'Video');
    if (caption == null) return;
    _consumeComposer(seed);
    final c = caption.trim();
    await _sendMedia(MediaKind.video, bytes, 'video/mp4', name, caption: c);
    if (c.isEmpty) return;
    _ragAddLine('You', c);
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  Future<void> _pickFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    await _sendFileWithCaption(f.bytes!, f.name);
  }

  // Files (PDFs, docs…) get the SAME "say something about it" caption step that
  // photos do, so you can explain the file — and, in Ask-Ava mode, the caption
  // is the instruction Ava acts on with the attachment in context. Previously a
  // file went out silently with no way to add text.
  Future<void> _sendFileWithCaption(Uint8List bytes, String name) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed);
    if (caption == null) return; // dismissed
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: file + caption together, awaited so the attachment is on the
    // InboxDO before we summon Ava below.
    await _sendMedia(MediaKind.file, bytes, 'application/octet-stream', name, caption: c);
    if (c.isEmpty) return;
    _ragAddLine('You', c);
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  // Compact sheet: a file chip (icon + name) + a caption/instruction field.
  // Returns the caption (possibly empty → send with no text) or null if dismissed.
  Future<String?> _fileCaptionSheet(String name, {String initial = '', String label = 'File'}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: Row(children: [
              PhosphorIcon(
                  label == 'Video'
                      ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                      : PhosphorIcons.file(PhosphorIconsStyle.bold),
                  size: 22, color: Zine.ink),
              const SizedBox(width: 10),
              Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 14))),
            ]),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: _avaMode ? Zine.lilac : Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rField),
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ZineText.input(size: 15),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: _avaMode ? 'Tell Ava about this file…' : 'Add a note…',
                    hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  MediaKind _kindFromCategory(String c) => c == 'image'
      ? MediaKind.image
      : c == 'video'
          ? MediaKind.video
          : c == 'audio'
              ? MediaKind.audio
              : MediaKind.file;

  // Browse AvaLibrary and attach an existing file into this chat. The picked
  // file is downloaded and re-sent through the normal media path (so it's
  // encrypted + shared like any attachment).
  Future<void> _addFromLibrary() async {
    final item = await Navigator.push<LibraryItem?>(
        context, MaterialPageRoute(builder: (_) => const LibraryPickerScreen()));
    if (item == null || !mounted) return;
    if (item.displayUrl.isEmpty) { _capNote('This file can\'t be attached from here.'); return; }
    _capNote('Attaching ${item.name}…');
    try {
      final resp = await http.get(Uri.parse(item.displayUrl)).timeout(const Duration(seconds: 60));
      if (resp.statusCode != 200) { _capNote('Could not load that file.'); return; }
      final bytes = resp.bodyBytes;
      final kind = _kindFromCategory(item.category);
      // VIDPOL-1: video is held to the 64 MB policy cap; photos keep the 25 MB cap.
      if (kind == MediaKind.video && bytes.length > _kVideoMaxBytes) {
        _capNote(_kVideoTooBigMsg);
        Analytics.capture('video_upload_rejected', {'bytes': bytes.length});
        return;
      }
      if (kind == MediaKind.image && bytes.length > _kMediaMaxBytes) {
        _capNote('That file is over 25 MB.'); return;
      }
      await _sendMedia(kind, bytes, item.mime, item.name);
    } catch (_) {
      _capNote('Could not attach from library.');
    }
  }

  // ---- mic menu: record audio OR convert voice to text ----
  void _openMicMenu() {
    FocusScope.of(context).unfocus();
    showMicInputSheet(context, options: [
      MicSheetOption(
        icon: PhosphorIcons.microphone(PhosphorIconsStyle.fill),
        color: Zine.coral,
        title: 'Record audio',
        subtitle: 'Record a voice note and send it',
        onTap: _toggleRecord,
      ),
      MicSheetOption(
        icon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
        color: Zine.mint,
        title: 'Convert voice to text',
        subtitle: 'Speak and watch it type into the box',
        onTap: _startVoiceToText,
      ),
    ]);
  }

  // Start on-device Whisper dictation — text fills the composer live as you talk.
  // The Whisper model downloads on first use (the "Preparing…" note shows then).
  Future<void> _startVoiceToText() async {
    if (_sttActive || _sttPreparing) return;
    setState(() => _sttPreparing = true);
    _capNote('Preparing voice-to-text…'); // visible feedback while the model loads
    final session = await AvaOnDeviceStt.I.startDictation(
      lang: 'en',
      onText: (t) {
        if (!mounted) return;
        setState(() {
          _ctrl.text = t;
          _ctrl.selection = TextSelection.collapsed(offset: t.length);
          _hasText = t.trim().isNotEmpty;
        });
      },
    );
    if (!mounted) return;
    setState(() => _sttPreparing = false);
    if (session == null) {
      _capNote('Couldn’t start voice-to-text. Try again, or re-enable Ava Voice in Settings.');
      return;
    }
    setState(() { _sttSession = session; _sttActive = true; });
  }

  Future<void> _stopVoiceToText() async {
    final s = _sttSession;
    if (s == null) return;
    setState(() => _sttActive = false);
    final text = await s.stop();
    if (!mounted) return;
    setState(() {
      if (text.isNotEmpty) {
        _ctrl.text = text;
        _ctrl.selection = TextSelection.collapsed(offset: text.length);
        _hasText = text.trim().isNotEmpty;
      }
      _sttSession = null;
    });
    _composerFocus.requestFocus();
  }

  // ---- voice note record ----
  Future<void> _toggleRecord() async {
    if (_recording) {
      final path = await _recorder.stop();
      setState(() => _recording = false);
      if (path == null) return;
      final bytes = await File(path).readAsBytes();
      await _sendMedia(MediaKind.audio, bytes, 'audio/mp4', 'voice.m4a');
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission needed for voice messages')));
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    _recPath = '${dir.path}/vn_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(const RecordConfig(), path: _recPath!);
    setState(() => _recording = true);
  }

  Future<void> _playAudio(_Msg m) async {
    if (_playingAudioId == m.id) {
      await _audio.stop();
      if (mounted) setState(() => _playingAudioId = null);
      return;
    }
    try {
      final bytes = m.localBytes ?? (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null) return;
      await _audio.stop();
      // audioplayers can't reliably decode an .m4a/AAC clip from an in-memory
      // BytesSource on Android (no container/mime hint) — it silently no-ops,
      // which is exactly why the play button "did nothing". Write the decrypted
      // bytes to a real temp file and play that, so the OS media stack reads the
      // m4a header.
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/play_${m.id}.m4a');
      await f.writeAsBytes(bytes, flush: true);
      await _audio.play(DeviceFileSource(f.path));
      // [UI-BUBBLE-3] honour the chosen playback speed for this note.
      try { await _audio.setPlaybackRate(_audioSpeed); } catch (_) {/* not supported on all platforms */}
      if (mounted) setState(() => _playingAudioId = m.id);
      Analytics.capture('voice_note_played', {'speed': _audioSpeed});
    } catch (e) {
      AvaLog.I.log('media', 'voice play failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't play this voice message")));
      }
    }
  }

  /// [UI-BUBBLE-3] Cycle the voice-note playback speed 1x → 1.5x → 2x → 1x. When a
  /// note is currently playing, apply the new rate live.
  void _cycleAudioSpeed() {
    const steps = [1.0, 1.5, 2.0];
    final next = steps[(steps.indexOf(_audioSpeed) + 1) % steps.length];
    setState(() => _audioSpeed = next);
    if (_playingAudioId != null) {
      _audio.setPlaybackRate(next).catchError((_) {});
    }
    Analytics.capture('voice_note_speed', {'speed': next});
  }

  Future<void> _openGroupInfo() async {
    if (widget.chat.gid == null) return;
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    final left = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => GroupInfoScreen(group: g)));
    if (left == true && mounted) Navigator.pop(context); // left/deleted → close thread
  }

  Future<void> _openVideo(_Msg m) async {
    if (m.media == null && m.localBytes == null) return;
    if (m.media != null) {
      Navigator.push(context, MaterialPageRoute(
          builder: (_) => VideoPlayerScreen(media: m.media!, bytes: m.localBytes)));
    }
  }

  /// The image URL carried by an Ava-generated image bubble (envelope
  /// `media_ref`), or '' if this message isn't one. Lets "Copy image" / viewer
  /// work on Ava images too, which have no `m.media`.
  String _imageRefOf(_Msg m) => (m.extra?['media_ref'] ?? '').toString();

  /// True when the message shows an image — a real chat photo OR an Ava image.
  bool _msgHasImage(_Msg m) =>
      m.media?.kind == MediaKind.image || _imageRefOf(m).isNotEmpty;

  // ---- Phase 5: floating reaction pill (anchored to the bubble) ----
  void _closeReactionOverlay() {
    _reactionOverlay?.remove();
    _reactionOverlay = null;
  }

  // Long-press / right-click a bubble → a floating emoji pill + compact action
  // menu anchored to the touch point (iMessage / WhatsApp style), instead of a
  // bottom sheet. "+" opens the full emoji picker; "More…" opens the full menu.
  void _onBubbleLongPressAt(_Msg m, Offset pos) {
    HapticFeedback.mediumImpact();
    Analytics.capture('chat_reaction_pill_open', {'group': widget.chat.group});
    _closeReactionOverlay();
    final size = MediaQuery.of(context).size;
    const pillW = 312.0;
    final left = pos.dx.clamp(12.0, math.max(12.0, size.width - pillW - 12.0)).toDouble();
    final top = (pos.dy - 64).clamp(90.0, math.max(90.0, size.height - 360.0)).toDouble();
    const quick = ['❤️', '👍', '😂', '😮', '😢', '👏'];
    final hasImage = _msgHasImage(m);

    Widget pillBtn(Widget child, VoidCallback onTap) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: child,
          ),
        );

    Widget menuRow(IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
        InkWell(
          onTap: () { _closeReactionOverlay(); onTap(); },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(children: [
              Icon(icon, size: 18, color: danger ? Zine.coral : Zine.ink),
              const SizedBox(width: 12),
              Text(label, style: ZineText.value(size: 14.5, color: danger ? Zine.coral : Zine.ink)),
            ]),
          ),
        );

    _reactionOverlay = OverlayEntry(builder: (octx) => Stack(children: [
          // Tap anywhere to dismiss.
          Positioned.fill(child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _closeReactionOverlay,
            child: Container(color: Colors.black.withOpacity(0.05)),
          )),
          Positioned(
            left: left, top: top, width: pillW,
            child: Material(
              color: Colors.transparent,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                // Floating emoji pill.
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(
                    color: Zine.paper,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    for (final e in quick)
                      pillBtn(
                        Text(e, style: TextStyle(fontSize: m.reaction == e ? 30 : 26)),
                        () { _closeReactionOverlay(); _react(m, e); },
                      ),
                    // "+" → full emoji picker.
                    pillBtn(
                      Container(
                        width: 30, height: 30, alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: Zine.card, shape: BoxShape.circle,
                          border: Border.all(color: Zine.ink, width: 1.5)),
                        child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 15, color: Zine.ink),
                      ),
                      () async {
                        _closeReactionOverlay();
                        final picked = await _openEmojiPicker();
                        if (picked != null) {
                          Analytics.capture('chat_react_custom_emoji', {'emoji': picked});
                          _react(m, picked);
                        }
                      },
                    ),
                  ]),
                ),
                const SizedBox(height: 8),
                // Compact action menu.
                Container(
                  decoration: BoxDecoration(
                    color: Zine.paper,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    menuRow(PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply',
                        () => setState(() => _replyTo = m)),
                    if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                      menuRow(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                          m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                    if (hasImage)
                      menuRow(PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                          () => _copyImageFromMsg(m)),
                    menuRow(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                    menuRow(PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                        m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                    if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                      menuRow(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                    menuRow(PhosphorIcons.dotsThree(PhosphorIconsStyle.bold), 'More…',
                        () => _onBubbleLongPress(m)),
                  ]),
                ),
              ]),
            ),
          ),
        ]));
    Overlay.of(context).insert(_reactionOverlay!);
  }

  // ---- bubble long-press actions ----
  void _onBubbleLongPress(_Msg m) {
    HapticFeedback.mediumImpact();
    final hasImage = _msgHasImage(m);
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      // Tall menus must be able to grow + scroll; the default sheet clips its
      // child. isScrollControlled lets it size up, the ListView scrolls, and
      // SafeArea keeps the last items clear of the phone's nav bar.
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.8),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Fixed header: quick reactions.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                for (final e in ['❤️', '👍', '😂', '😮', '😢', '👏'])
                  GestureDetector(
                    onTap: () { Navigator.pop(ctx); _react(m, e); },
                    child: Text(e, style: const TextStyle(fontSize: 28)),
                  ),
              ]),
            ),
            const Divider(height: 24),
            // Scrollable action list — grows with the number of items and
            // scrolls when it can't fit, so nothing hides off-screen.
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  _action(ctx, PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply', () => setState(() => _replyTo = m)),
                  if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.copy(PhosphorIconsStyle.bold),
                        m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                  // Copy a detected link. When the bubble holds exactly one URL
                  // we copy it straight; with several we pop a small chooser.
                  if (urlSpans(m.text).isNotEmpty)
                    _action(ctx, PhosphorIcons.link(PhosphorIconsStyle.bold),
                        urlSpans(m.text).length > 1 ? 'Copy link…' : 'Copy link',
                        () => _copyLink(m)),
                  // Copy the actual IMAGE to the clipboard (paste into any app).
                  if (hasImage)
                    _action(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                        () => _copyImageFromMsg(m)),
                  _action(ctx, PhosphorIcons.pushPin(PhosphorIconsStyle.bold), 'Pin message', () => _pinMessage(m)),
                  _action(ctx, PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                      m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                  if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                    _action(ctx, PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                  // STREAM G [GROUP-AI-5]: inline translate any text bubble into the
                  // user's remembered language (added via the existing _action menu
                  // extension point — no Stream K geometry change).
                  if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _inlineTranslate(m)),
                  // Voice notes: transcribe the audio (cloud Whisper) and/or
                  // translate that transcript. Viewer-only, cached per message.
                  if (_isVoiceNote(m)) ...[
                    _action(ctx, PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'Transcribe',
                        () => _transcribeVoice(m)),
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _translateVoice(m)),
                  ],
                  _action(ctx, PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                  // Share OUT to another app (WhatsApp, Files, etc.) via the OS
                  // share sheet — works for any media, including voice notes.
                  if (m.media != null || m.localBytes != null)
                    _action(ctx, PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), 'Share to other apps', () => _shareMedia(m)),
                  if (m.media != null)
                    _action(ctx, PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), 'Save to my AvaTOK Drive', () => _saveMediaToDrive(m)),
                  _action(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete for me', () => _deleteForMe(m)),
                  _action(ctx, PhosphorIcons.trashSimple(PhosphorIconsStyle.bold), 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
      ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        leading: Icon(icon, color: danger ? Zine.coral : Zine.ink),
        title: Text(label,
            style: ZineText.value(size: 15, color: danger ? Zine.coral : Zine.ink)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

  /// Copy a bubble's text (or a media caption) to the system clipboard — e.g.
  /// copy Ava's private reply, flip out of Ava-mode, and paste it to the person.
  void _copyText(_Msg m) {
    final text = m.text.trim();
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
    }
  }

  /// Copy a URL detected inside a bubble to the clipboard. One link → copied
  /// straight; multiple links → a small chooser so the user picks which one.
  Future<void> _copyLink(_Msg m) async {
    final urls = urlSpans(m.text).map((s) => s.url).toList();
    if (urls.isEmpty) return;
    String url = urls.first;
    if (urls.length > 1) {
      final picked = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Copy which link?', style: ZineText.value(size: 15)),
              ),
            ),
            for (final u in urls)
              ListTile(
                leading: Icon(PhosphorIcons.link(PhosphorIconsStyle.bold), color: Zine.ink),
                title: Text(u, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 13.5, color: Zine.ink)),
                onTap: () => Navigator.pop(ctx, u),
              ),
          ]),
        ),
      );
      if (picked == null) return;
      url = picked;
    }
    await Clipboard.setData(ClipboardData(text: url));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Link copied'), duration: Duration(seconds: 1)));
    }
    Analytics.capture('chat_link_copied', {'count': urls.length});
  }

  Future<void> _toggleStar(_Msg m) async {
    if (m.evId == null) { setState(() => m.starred = !m.starred); return; }
    final set = await _starStore.toggle(m.evId!);
    if (mounted) setState(() { _starred = set; m.starred = set.contains(m.evId); });
  }

  void _startEdit(_Msg m) {
    setState(() {
      _editing = m; _replyTo = null;
      _ctrl.text = m.text; _hasText = m.text.trim().isNotEmpty;
    });
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
  }

  Future<void> _pinMessage(_Msg m) async {
    if (_convKey == null) return;
    final pin = {'id': m.evId ?? '${m.id}', 'text': m.text};
    await PinnedMsgStore().set(_convKey!, jsonEncode(pin));
    if (mounted) setState(() => _pinned = pin);
  }

  Future<void> _unpin() async {
    if (_convKey == null) return;
    await PinnedMsgStore().set(_convKey!, '');
    if (mounted) setState(() => _pinned = null);
  }

  void _openInfo() {
    if (widget.chat.group) { _openGroupInfo(); return; }
    if (!widget.chat.seed.startsWith('user_')) return;
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => ContactProfileScreen(name: widget.chat.name, uid: widget.chat.seed, me: _meId)));
  }

  static const _reactionSounds = {
    '❤️': 'heart', '👍': 'like', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '👏': 'clap',
  };

  void _react(_Msg m, String emoji) {
    final adding = m.reaction != emoji;
    final prev = m.reaction;
    final myUidTag = _meId?.uid ?? 'me';
    setState(() {
      // Maintain MY single reaction + the aggregate count shown on the bubble.
      if (prev != null) { // remove my previous emoji from the tally
        m.reactCounts[prev] = ((m.reactCounts[prev] ?? 1) - 1).clamp(0, 9999);
        if (m.reactCounts[prev] == 0) m.reactCounts.remove(prev);
        m.reactBy[prev]?.remove(myUidTag);
        if (m.reactBy[prev]?.isEmpty ?? false) m.reactBy.remove(prev);
      }
      m.reaction = adding ? emoji : null;
      if (adding) {
        m.reactCounts[emoji] = (m.reactCounts[emoji] ?? 0) + 1;
        m.reactBy.putIfAbsent(emoji, () => <String>{}).add(myUidTag);
      }
    });
    Analytics.capture('chat_reaction', {'emoji': emoji, 'op': adding ? 'add' : 'remove'});
    HapticFeedback.lightImpact();
    if (adding) {
      final file = _reactionSounds[emoji];
      if (file != null) {
        _sfx.stop();
        _sfx.play(AssetSource('sounds/$file.wav'));
      }
    }
    // PartyKit live reaction (the reaction's home now that Ably is retired).
    final p = _party;
    final mid = m.evId;
    if (p != null && mid != null) {
      if (prev != null && prev != emoji) {
        p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': prev, 'add': false, 'whoName': _fromNameTag});
      }
      p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': emoji, 'add': adding, 'whoName': _fromNameTag});
    }
  }

  // Phase 5: a curated, categorized emoji picker. Returns the chosen emoji (or
  // null). Kept package-free (a scrollable grid of common emoji) so it builds in
  // CI without a new dependency.
  static const Map<String, List<String>> _emojiCatalog = {
    'Smileys': ['😀','😁','😂','🤣','😊','😍','😘','😎','🤩','😢','😭','😡','🥺','🤔','😴','🤯','😱','🥳','😅','😉','🙃','😇','🤗','🤭','😬','🙄','😏','😌','🤤','🤪'],
    'Gestures': ['👍','👎','👏','🙏','🤝','💪','👊','✊','🤞','✌️','🤟','🤙','👌','🖐️','✋','👋','🫶','🫰','👇','👆'],
    'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','❤️‍🔥'],
    'Fun': ['🔥','🎉','🎊','✨','⭐','🌟','💯','🚀','🏆','🎈','🎁','💎','👑','💥','💫','🌈','☀️','⚡','🍾','🥂'],
    'Animals': ['🐶','🐱','🦄','🐼','🦁','🐯','🐸','🐵','🐧','🐢','🦋','🐝','🐬','🐳','🦊','🐰','🐨','🐮','🐷','🐙'],
    'Food': ['🍕','🍔','🍟','🌮','🍣','🍦','🍩','🍪','🎂','🍰','🍫','🍿','☕','🍺','🍷','🥤','🍓','🍉','🍌','🥑'],
  };

  Future<String?> _openEmojiPicker() {
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Align(alignment: Alignment.centerLeft,
                  child: Text('React with…', style: ZineText.value(size: 15))),
            ),
            Flexible(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  for (final cat in _emojiCatalog.entries) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
                      child: Align(alignment: Alignment.centerLeft,
                          child: Text(cat.key.toUpperCase(), style: ZineText.tag(size: 10, color: Zine.inkSoft))),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Wrap(children: [
                        for (final e in cat.value)
                          GestureDetector(
                            onTap: () => Navigator.pop(ctx, e),
                            child: Padding(
                              padding: const EdgeInsets.all(6),
                              child: Text(e, style: const TextStyle(fontSize: 28)),
                            ),
                          ),
                      ]),
                    ),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // Resolve a reactor uid to a friendly name. Mine → "You"; a learned group
  // member name (from a message or reaction that carried fromName) → that name;
  // a 1:1 peer → the chat name; otherwise a short id.
  String _reactorName(String uid) {
    if (uid == (_meId?.uid ?? 'me') || uid == 'me') return 'You';
    final known = _memberNames[uid];
    if (known != null && known.isNotEmpty && known != 'You') return known;
    if (!widget.chat.group) return widget.chat.name;
    return _shortPub(uid);
  }

  // Phase 5: "reacted by" — long-press a reaction chip to see who reacted.
  void _showReactedBy(_Msg m) {
    if (m.reactBy.isEmpty) return;
    Analytics.capture('chat_reacted_by_view', {'kinds': m.reactBy.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Reactions', style: ZineText.value(size: 15))),
          ),
          for (final e in m.reactBy.entries)
            for (final uid in e.value)
              ListTile(
                dense: true,
                leading: Text(e.key, style: const TextStyle(fontSize: 22)),
                title: Text(_reactorName(uid), style: ZineText.value(size: 14, color: Zine.ink)),
              ),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  // "Who voted" for a poll option (group threads) — long-press an option.
  void _showPollVoters(String option, Set<String> uids) {
    if (uids.isEmpty) return;
    Analytics.capture('poll_voters_view', {'count': uids.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Voted "$option"', style: ZineText.value(size: 15))),
          ),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360), child: ListView(shrinkWrap: true, children: [
            for (final uid in uids)
              ListTile(
                dense: true,
                leading: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 20, color: Zine.accents[1]),
                title: Text(_reactorName(uid), style: ZineText.value(size: 14, color: Zine.ink)),
              ),
          ])),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  // Save a chat media file into the user's OWN AvaTOK Google Drive folder
  // (Hybrid: their own copy in Drive; the shared original stays on encrypted R2).
  Future<void> _saveMediaToDrive(_Msg m) async {
    if (m.media == null) return;
    _capNote('Saving to your AvaTOK Drive…');
    final bytes = m.localBytes ?? await MediaService.downloadAndDecrypt(m.media!);
    if (bytes == null) { _capNote('Could not load this file.'); return; }
    final kind = m.media!.kind;
    final bucket = kind == MediaKind.image ? 'Photos' : kind == MediaKind.video ? 'Videos' : 'Files';
    final mime = kind == MediaKind.image ? 'image/jpeg' : kind == MediaKind.video ? 'video/mp4' : 'application/octet-stream';
    final ok = await DriveService.I.upload(bucket, m.media!.name, mime, bytes);
    if (mounted) _capNote(ok ? 'Saved to your AvaTOK Drive ✓' : "Couldn't save — connect Drive in AvaStorage.");
  }

  // DELETE FOR ME — soft-hide on MY device only. The content is RETAINED (not
  // erased) so I can Undo to recover it later (copy something I lost, then re-hide).
  void _deleteForMe(_Msg m) {
    setState(() => m.hidden = true);
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'me', 'group': _group != null,
      if (m.evId != null) 'delete_id': m.evId!,
    });
  }

  // Persist a soft-delete/Undo to the durable, per-account [HiddenStore] AND the
  // in-memory map, so it's re-applied on the next cold open even if the capped
  // per-conversation message cache was cleared by an app update / OEM wipe. This
  // is the local-first source of truth; the server mirror (_syncHidden) is purely
  // for cross-device. Without this, a delete only lived in the cache + a best-
  // effort server POST, so a re-sync after an update brought the message back.
  void _persistHidden(String? evId, bool hidden) {
    if (evId == null || evId.isEmpty) return;
    _hiddenIds[evId] = hidden;
    HiddenStore().set(evId, hidden);
  }

  // Sync MY soft-delete/Undo to my OTHER devices via the InboxDO (owner-only state).
  void _syncHidden(_Msg m, bool hidden) {
    final conv = _guardianConv; // server conv id for this thread
    final target = m.evId;
    if (conv == null || target == null || target.isEmpty) {
      // The hide can't be mirrored to my other devices (no server conv / evId) —
      // this is the silent gap behind "my Mac still shows it". Make it visible.
      Analytics.capture('chat_hide_send_skipped', {
        'hidden': hidden, 'has_conv': conv != null, 'has_evid': target != null && target.isNotEmpty,
      });
      return;
    }
    // Sender-side anchor for the multi-device funnel: this hide/undo went to the
    // server (which broadcasts live + FCM-wakes my other devices). Join `target`
    // to chat_hide_fanout (worker) and chat_hide_applied (each device).
    ApiAuth.postJson(kMsgHideUrl, {'conv': conv, 'target': target, 'hidden': hidden}).then(
      (res) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': res.statusCode == 200, 'status': res.statusCode,
      }),
      onError: (e) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': false, 'err': e.toString(),
      }),
    );
  }

  // Apply a hide/Undo that arrived from one of my OTHER devices.
  void _applyHide(String target, bool hidden) {
    _persistHidden(target, hidden); // keep this device's durable state current
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) {
      setState(() => _msgs[i].hidden = hidden);
      _schedulePersist();
    }
  }

  // DELETE FOR EVERYONE — soft-hide MY copy (retained, so I can Undo and recover my
  // own data), AND tell the peer(s) to delete on THEIR side. KEY DIFFERENCE from
  // WhatsApp: my own copy isn't destroyed. The recipient's copy IS hard-removed
  // (server tombstone + _applyDelete) — only I, the owner, can Undo to see it again.
  void _deleteForEveryone(_Msg m) {
    final target = m.evId;
    var channel = 'none';
    if (_realMode && target != null && target.isNotEmpty) {
      try {
        if (_group != null && _gdm != null) {
          _gdm!.send(jsonEncode({'t': 'gdel', 'gid': _group!.id, 'target': target}));
          channel = 'gdm';
        } else if (_dm != null) {
          _dm!.send(jsonEncode({'t': 'del', 'target': target}));
          channel = 'dm';
        }
      } catch (e) {/* best-effort; local hide still applies */
        Analytics.capture('chat_delete_send_failed', {
          if (target != null) 'delete_id': target, 'group': _group != null, 'err': e.toString(),
        });
      }
    }
    setState(() => m.hidden = true); // retained — Undo brings it back for ME only
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'everyone', 'group': _group != null, 'had_evid': target != null,
      if (target != null) 'delete_id': target,
    });
    // Sender-side lifecycle anchor: join this delete_id to the worker's
    // chat_delete_delivery/fanout and the recipient's chat_delete_applied to see,
    // per delete, whether it went out live vs push and whether it ever landed.
    Analytics.capture('chat_delete_sent', {
      if (target != null) 'delete_id': target,
      'group': _group != null, 'channel': channel, 'realmode': _realMode,
    });
  }

  // Undo MY own soft-delete — restore the message in my view only (never re-sent to
  // anyone). Owner-only recovery: a peer's hard-deleted copy has no Undo.
  void _undoDelete(_Msg m) {
    setState(() => m.hidden = false);
    _persistHidden(m.evId, false); // clear the durable hide on THIS device too
    _schedulePersist();
    _syncHidden(m, false); // mirror the Undo to my other devices
    Analytics.capture('message_delete_undo', {'group': _group != null});
  }

  // Apply a delete-for-everyone the PEER sent: HARD-remove the targeted message
  // from my view (no Undo — I'm not its owner). The server also tombstones my
  // stored copy so it never re-syncs.
  // Convert a message in place into the delete-for-everyone tombstone.
  void _tombstone(_Msg m) {
    m.text = 'This message was deleted';
    m.media = null; m.localBytes = null;
    m.reaction = null; m.special = null; m.extra = null;
    m.mediaCaption = ''; m.hidden = false;
  }

  void _applyDelete(String target) {
    if (target.isEmpty) return;
    _deletedIds.add(target);
    DeletedStore().add(target); // durable — re-applies even after the cache is rebuilt
    final i = _msgs.indexWhere((x) => x.evId == target);
    Analytics.capture('message_delete_applied', {
      'group': _group != null, 'on_screen': i >= 0,
    });
    if (i >= 0 && mounted) {
      setState(() => _tombstone(_msgs[i]));
      _schedulePersist();
    }
  }

  // STREAM I (FWD-1): open the multi-select Forward sheet (Groups + Contacts,
  // search, checkmarks, single Send). If forwarding is flag-disabled, fall back
  // to a quiet no-op. One selected contact with editable text still gets the
  // caption editor; everything else fans out straight to the chosen targets.
  Future<void> _forward(_Msg m) async {
    if (!RemoteConfig.unlimitedForwardEnabled) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Forwarding is temporarily unavailable')));
      return;
    }
    final msgKind = m.media?.kind.name ?? 'text';
    final targets = await showForwardSheet(context, msgKind: msgKind);
    if (targets == null || targets.isEmpty || !mounted) return;
    // Preserve the single-contact caption-edit UX when it's exactly one DM.
    if (targets.length == 1 && !targets.first.isGroup) {
      final peerUid = targets.first.peerUid;
      final saved = await ContactsStore().load();
      final hit = saved.where((c) => c.uid == peerUid).toList();
      final match = hit.isNotEmpty
          ? hit.first
          : Contact(uid: peerUid, name: targets.first.label);
      if (!mounted) return;
      await _forwardWithText(m, match);
      return;
    }
    await _forwardToTargets(m, targets);
  }

  /// Fan a single message out to a MIX of DMs + groups in ONE server call
  /// (/api/msg/forward). The envelope carries `fwd:true` (Stream K renders the
  /// "↪ Forwarded" label from this) and — for privacy (FWD-1) — NOTHING about
  /// the original sender. Media re-references the SAME content-addressed R2 key
  /// via the same envelope (its per-blob AES key rides in the envelope, so no
  /// re-upload is ever needed — FWD-2, all cases including cross-context).
  Future<void> _forwardToTargets(_Msg m, List<ForwardTarget> targets,
      {String? caption}) async {
    final id = _meId;
    if (id == null) return;
    final Map<String, dynamic> payload;
    if (m.media != null) {
      // Same envelope → same media_ref → one R2 copy, never re-uploaded.
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    // media_ref: the R2 content hash so the server indexes the forward against
    // the SAME object (zero duplication). For text this stays null.
    final mediaRef = m.media?.id;
    final body = jsonEncode(payload);
    final serverTargets = [
      for (final t in targets)
        t.isGroup ? {'conv': t.groupId} : {'to': t.peerUid},
    ];
    final nGroups = targets.where((t) => t.isGroup).length;
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'n_targets': targets.length,
      'n_groups': nGroups,
      'edited_caption': caption != null,
    });
    int status = 0;
    try {
      final res = await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text',
        'body': body,
        if (mediaRef != null) 'media_ref': mediaRef,
        'targets': serverTargets,
      });
      status = res.statusCode;
      // Wake the DM peers (groups fan out server-side).
      final dmUids = [for (final t in targets) if (!t.isGroup) t.peerUid];
      if (dmUids.isNotEmpty) PushService.notifyMessage(dmUids, _myName ?? 'AvaTOK');
      // FWD-4 telemetry (email auto-attached by Analytics.identify person props).
      if (status == 429) {
        Analytics.capture('forward_rate_capped', {
          'n_targets': targets.length, 'n_groups': nGroups,
        });
      } else if (status == 200) {
        Analytics.capture('forward_sent', {
          'n_targets': targets.length, 'n_groups': nGroups,
          'media_kind': m.media?.kind.name ?? 'text',
          'cross_context': true,
        });
      }
    } catch (_) {}
    if (!mounted) return;
    final n = targets.length;
    final msg = status == 429
        ? 'Slow down — too many forwards. Try again shortly.'
        : (status == 200 || status == 0)
            ? 'Forwarded to $n chat${n == 1 ? '' : 's'}'
            : "Couldn't forward — try again";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Step between picking a recipient and sending: when the message has text
  /// associated with it (a media caption, or a plain text body), show that text
  /// in an EDITABLE box so the user can tweak or clear it before forwarding.
  /// Media with no caption forwards straight through (unchanged behaviour).
  Future<void> _forwardWithText(_Msg m, Contact c) async {
    final isMedia = m.media != null;
    final initial = (isMedia ? _mediaCaptionOf(m) : m.text).trim();
    // No associated text on a media item → nothing to edit, forward as-is.
    if (isMedia && initial.isEmpty) { await _doForward(m, c); return; }

    final edit = TextEditingController(text: initial);
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 16, right: 16, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Forward to ${c.name}', style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 4),
          Text(isMedia ? 'Edit or remove the caption before sending'
                       : 'Edit the message before sending',
              style: ZineText.sub(size: 13, color: Zine.inkMute)),
          const SizedBox(height: 12),
          // For media, show a small preview chip so it's clear what rides along.
          if (isMedia) ...[
            Row(children: [
              if (m.localBytes != null && m.media!.kind == MediaKind.image)
                ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: Image.memory(m.localBytes!, width: 44, height: 44, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                )
              else
                PhosphorIcon(
                    m.media!.kind == MediaKind.video
                        ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                        : m.media!.kind == MediaKind.image
                            ? PhosphorIcons.image(PhosphorIconsStyle.bold)
                            : PhosphorIcons.file(PhosphorIconsStyle.bold),
                    size: 26, color: Zine.ink),
              const SizedBox(width: 10),
              Expanded(child: Text(m.media!.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 14))),
            ]),
            const SizedBox(height: 12),
          ],
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rField),
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: edit,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ZineText.input(size: 15),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: isMedia ? 'Add a caption…' : 'Message',
                    hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, edit.text)),
          ]),
        ]),
      ),
    ).whenComplete(edit.dispose);

    if (result == null) return; // dismissed without sending
    final text = result.trim();
    // A plain text message edited down to nothing → don't forward an empty line.
    if (!isMedia && text.isEmpty) return;
    await _doForward(m, c, caption: text);
  }

  /// Really forward [m] to contact [c] over a one-off send, flagged forwarded.
  /// [caption] (when provided) overrides the carried text/caption — empty means
  /// forward the media with no caption.
  Future<void> _doForward(_Msg m, Contact c, {String? caption}) async {
    final id = _meId;
    final peerHex = c.uid;
    if (id == null || peerHex.isEmpty) return;
    final Map<String, dynamic> payload;
    // STREAM I: carry `fwd:true` (Stream K renders "↪ Forwarded") + keep the
    // legacy `forwarded` key for the existing bubble renderer. NOTHING about the
    // original sender travels (privacy, FWD-1).
    if (m.media != null) {
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'edited_caption': caption != null,
      'conv_kind': _isGroup ? 'group' : 'dm',
      'n_targets': 1,
      'n_groups': 0,
    });
    try {
      // STREAM I: route single-contact forwards through /api/msg/forward too, so
      // the rate cap + liveness guard apply uniformly. Media re-references the
      // SAME R2 key via media_ref (no re-upload — FWD-2, all cases).
      await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text', 'body': jsonEncode(payload),
        if (m.media?.id != null) 'media_ref': m.media!.id,
        'targets': [{'to': peerHex}],
      });
      PushService.notifyMessage([c.uid], _myName ?? 'AvaTOK');
    } catch (_) {}
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
  }

  // ---- STREAM G [GROUP-AI-2/3] per-member group translation ----
  /// Toggle "Translate this group for me". When turned ON, translate the loaded
  /// TEXT messages into the user's Stream-A language on FETCH (server caches per
  /// msg_id+lang). Voice notes are not translated (only text rows are sent).
  Future<void> _toggleGroupTranslate() async {
    if (!(widget.chat.group || widget.chat.gid != null)) return;
    final turningOn = !_groupTranslateOn;
    setState(() => _groupTranslateOn = turningOn);
    if (!turningOn) {
      // Revert: drop the translations so bubbles show the original again.
      setState(() { for (final m in _msgs) { m.extra?.remove('translated'); m.extra?.remove('translated_lang'); } });
      Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': false});
      return;
    }
    Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': true});
    await _applyGroupTranslation();
  }

  /// Fetch translations for the currently-loaded, not-mine text messages of the
  /// group into the remembered language and stash them on each bubble's extra so
  /// the TranslatedText wrapper renders "translated · show original".
  Future<void> _applyGroupTranslation() async {
    if (!_groupTranslateOn || _groupTranslateBusy) return;
    final conv = _serverConvId;
    if (conv == null) return;
    final lang = _transLang.code;
    // Only text rows the member actually fetched, no media/voice, not mine.
    final targets = _msgs.where((m) => !m.me && m.special == null && m.media == null
        && m.text.trim().isNotEmpty && (m.extra?['translated'] == null)).toList();
    if (targets.isEmpty) return;
    setState(() => _groupTranslateBusy = true);
    final batch = <Map<String, String>>[
      for (final m in targets) {'id': m.evId ?? '${m.id}', 'text': m.text.trim()},
    ];
    final out = await AiChatApi.groupTranslate(conv, lang, batch);
    if (!mounted) { return; }
    setState(() {
      _groupTranslateBusy = false;
      for (final m in targets) {
        final t = out[m.evId ?? '${m.id}'];
        if (t != null && t.isNotEmpty) {
          (m.extra ??= <String, dynamic>{})['translated'] = t;
          m.extra!['translated_lang'] = lang;
        }
      }
    });
  }

  // ---- STREAM G [GROUP-AI-1] group catch-up ("What did I miss?") ----
  /// Server conv id for THIS thread computed from the conv key (works for DM +
  /// group). Renamed from _serverConv to avoid clashing with the stranger-gate
  /// field `_serverConv` (both were added by concurrent streams).
  String? get _serverConvId {
    final key = _convKey;
    final myUid = _meId?.uid;
    if (key == null || myUid == null || myUid.isEmpty) return null;
    return serverConvFromKey(key, myUid);
  }

  /// Count of unread INCOMING messages currently loaded (drives the >25 gate).
  int get _unreadIncoming => _msgs.where((m) => !m.me && m.special == null).length;

  /// Whether the "What did I miss?" button should be offered: a group thread with
  /// >25 unread and the messaging AvaBrain guardrail ON.
  Future<bool> _catchupAvailable() async {
    if (!(widget.chat.group || widget.chat.gid != null)) return false;
    if (_unreadIncoming <= 25) return false;
    return BrainConsent.isOn('messaging');
  }

  Future<void> _whatDidIMiss() async {
    final conv = _serverConvId;
    if (conv == null) return;
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to use catch-up.');
      return;
    }
    setState(() { _catchupLoading = true; _catchupDismissed = false; });
    // since_seq 0 = summarise the whole loaded unread window; the server pulls
    // text-only from my own InboxDO and never stores the summary.
    final bullets = await AiChatApi.catchup(conv, sinceSeq: 0);
    if (!mounted) return;
    setState(() {
      _catchupLoading = false;
      _catchupBullets = bullets;
      _catchupCount = _unreadIncoming;
    });
    if (bullets.isEmpty) _toast('Nothing to catch up on.');
  }

  void _dismissCatchup() => setState(() { _catchupDismissed = true; _catchupBullets = const []; });

  // ---- STREAM G [GROUP-AI-4] smart replies (DMs) ----
  /// Debounced fetch after an incoming DM. Only fires for 1:1 threads when the
  /// screen is mounted (open + foreground). Guardrail + flag are enforced server-side.
  void _maybeFetchSmartReplies() {
    if (widget.chat.group || widget.chat.gid != null) return; // DMs only
    _smartReplyDebounce?.cancel();
    _smartReplyDebounce = Timer(const Duration(milliseconds: 900), () async {
      if (!mounted) return;
      // Don't suggest replies to my own last message.
      final tail = _msgs.where((m) => m.special == null && m.text.trim().isNotEmpty).toList();
      if (tail.isEmpty || tail.last.me) { if (_smartReplies.isNotEmpty) setState(() => _smartReplies = const []); return; }
      final last4 = tail.length <= 4 ? tail : tail.sublist(tail.length - 4);
      final payload = <Map<String, Object>>[
        for (final m in last4) {'me': m.me, 'text': m.text.trim()},
      ];
      final s = await AiChatApi.smartReplies(payload);
      if (!mounted) return;
      setState(() => _smartReplies = s);
    });
  }

  void _insertSmartReply(String text) {
    Analytics.capture('smart_reply_used', {'len': text.length});
    _ctrl.text = _ctrl.text.isEmpty ? text : '${_ctrl.text} $text';
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    setState(() { _hasText = _ctrl.text.trim().isNotEmpty; _smartReplies = const []; });
    _composerFocus.requestFocus();
  }

  // ---- STREAM G [GROUP-AI-5] inline translate one bubble ----
  Future<void> _inlineTranslate(_Msg m) async {
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    final text = m.text.trim();
    if (text.isEmpty) return;
    final to = _transLang.code; // user's Stream-A / remembered language
    // Local drift cache first (scoped per account) so a re-translate is free.
    final cached = await _msgStore.readTranslation(m.evId ?? '${m.id}', to);
    if (cached != null && cached.isNotEmpty) {
      if (mounted) _showInlineTranslation(m, cached, to);
      return;
    }
    _toast('Translating…');
    final out = await AiChatApi.translate(text, to);
    if (!mounted) return;
    if (out == null) { _toast('Could not translate.'); return; }
    Analytics.capture('inline_translate_used', {'lang': to});
    try { await _msgStore.writeTranslation(m.evId ?? '${m.id}', to, out); } catch (_) {}
    _showInlineTranslation(m, out, to);
  }

  /// Stash the translation on the message's `extra` so the bubble can render it
  /// under the original (via TranslatedText) without touching Stream K geometry.
  void _showInlineTranslation(_Msg m, String translated, String lang) {
    setState(() {
      (m.extra ??= <String, dynamic>{})['translated'] = translated;
      m.extra!['translated_lang'] = lang;
    });
  }

  // ---- voice-note Transcribe + Translate ------------------------------------
  // A voice note is an audio-kind media bubble (recorded via the mic composer).
  bool _isVoiceNote(_Msg m) =>
      m.media?.kind == MediaKind.audio && m.special == null;

  /// Stable per-message cache key: the durable rumor id when present, else the
  /// local monotonic id. Matches the scheme used by inline text translation.
  String _msgCacheKey(_Msg m) => m.evId ?? '${m.id}';

  /// Fetch the DECRYPTED voice bytes (local-first, per-account MediaService
  /// cache), POST them to the existing cloud-Whisper transcribe route, and cache
  /// the transcript per message (account-scoped). Returns '' on failure. The
  /// transcript is stashed on m.extra['transcript'] so the bubble renders it.
  Future<String> _ensureTranscript(_Msg m) async {
    final key = _msgCacheKey(m);
    // 1) Already on the message this session.
    final live = (m.extra?['transcript'] as String?)?.trim();
    if (live != null && live.isNotEmpty) return live;
    // 2) Per-account disk cache (never re-transcribe on reopen).
    final cached = await _msgStore.readTranscript(key);
    if (cached != null && cached.trim().isNotEmpty) {
      if (mounted) setState(() => (m.extra ??= <String, dynamic>{})['transcript'] = cached);
      return cached;
    }
    // 3) Transcribe: decrypted bytes → /api/stt/transcribe (same route the
    //    composer's cloud dictation uses). Voice notes are m4a/AAC.
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null || bytes.isEmpty) {
        Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'no_bytes'});
        return '';
      }
      final r = await ApiAuth.postJson(
        '$kApiBase/stt/transcribe',
        {'audio': base64Encode(bytes), 'format': 'm4a'},
        timeout: const Duration(seconds: 45),
      );
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      if (r.statusCode != 200) {
        AvaLog.I.log('voice_stt', 'transcribe HTTP ${r.statusCode}: ${r.body}');
        Analytics.capture('voice_transcribe', {'ok': false, 'status': r.statusCode, 'ms': ms});
        return '';
      }
      final decoded = jsonDecode(r.body);
      final text = (decoded is Map && decoded['text'] is String)
          ? (decoded['text'] as String).trim()
          : '';
      Analytics.capture('voice_transcribe', {'ok': text.isNotEmpty, 'ms': ms, 'chars': text.length});
      if (text.isEmpty) return '';
      try { await _msgStore.writeTranscript(key, text); } catch (_) {}
      if (mounted) setState(() => (m.extra ??= <String, dynamic>{})['transcript'] = text);
      return text;
    } catch (e) {
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      AvaLog.I.log('voice_stt', 'transcribe FAILED: $e');
      Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'exception', 'ms': ms});
      return '';
    }
  }

  /// Long-press → Transcribe: show the Whisper transcript below the voice bubble
  /// (viewer-only, cached). Inline snackbar on failure — never crashes.
  Future<void> _transcribeVoice(_Msg m) async {
    if ((m.extra?['transcript'] as String?)?.trim().isNotEmpty == true) return;
    _toast('Transcribing…');
    final text = await _ensureTranscript(m);
    if (!mounted) return;
    if (text.isEmpty) {
      _toast("Couldn't transcribe this voice message.");
    }
  }

  /// Long-press → Translate a voice note: pick a language, transcribe (if not
  /// cached), translate the transcript with the existing engine, then show
  /// "translated (Language)" below the bubble. Viewer-only, cached per message
  /// in the SAME translation cache keyed by '<msgId>|<lang>'.
  Future<void> _translateVoice(_Msg m) async {
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    // Reuse the shared language picker sheet.
    final picked = await _pickVoiceLang();
    if (picked == null || !mounted) return;
    final to = picked.code;
    final key = _msgCacheKey(m);
    // Translation already cached for this note+language?
    final cachedTr = await _msgStore.readTranslation(key, to);
    if (cachedTr != null && cachedTr.trim().isNotEmpty) {
      if (mounted) _showVoiceTranslation(m, cachedTr, picked.label);
      return;
    }
    _toast('Transcribing…');
    final transcript = await _ensureTranscript(m);
    if (!mounted) return;
    if (transcript.isEmpty) { _toast("Couldn't transcribe this voice message."); return; }
    _toast('Translating…');
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final out = await AiChatApi.translate(transcript, to);
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    if (!mounted) return;
    if (out == null) {
      Analytics.capture('voice_translate', {'ok': false, 'lang': to, 'ms': ms});
      _toast('Could not translate.');
      return;
    }
    Analytics.capture('voice_translate', {'ok': true, 'lang': to, 'ms': ms, 'chars': out.length});
    try { await _msgStore.writeTranslation(key, to, out); } catch (_) {}
    _showVoiceTranslation(m, out, picked.label);
  }

  /// Language picker for voice-note translation — same list/sheet style as the
  /// composer Translate picker, but returns the chosen language instead of
  /// remembering it as the composer target.
  Future<ComposerLang?> _pickVoiceLang() => showModalBottomSheet<ComposerLang>(
        context: context,
        backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                    size: 20, color: Zine.ink),
                const SizedBox(width: 10),
                Text('Translate into…', style: ZineText.cardTitle(size: 18)),
              ]),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final l in ComposerAi.languages)
                    ListTile(
                      title: Text(l.label, style: ZineText.value(size: 16)),
                      subtitle: l.code != l.label
                          ? Text(l.code, style: ZineText.sub(size: 13))
                          : null,
                      onTap: () => Navigator.pop(ctx, l),
                    ),
                ],
              ),
            ),
          ]),
        ),
      );

  /// Stash the transcript translation on the message so the bubble renders it
  /// as "translated (Language)" below the voice waveform. Viewer-only.
  void _showVoiceTranslation(_Msg m, String translated, String langLabel) {
    setState(() {
      (m.extra ??= <String, dynamic>{})['transcript_translated'] = translated;
      m.extra!['transcript_translated_lang'] = langLabel;
    });
  }

  // ---- header overflow ----
  void _overflow() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          if (_isTelThread && !_callerSaved)
            _action(ctx, PhosphorIcons.userPlus(PhosphorIconsStyle.bold), 'Save to contacts',
                () { Navigator.pop(ctx); _saveUnknownContact(source: 'thread_menu'); }),
          if (kDiscussWithAvaEnabled && _convKey != null)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'Discuss with Ava',
                _discussWithAva),
          // STREAM G [GROUP-AI-1]: catch-up on a busy group thread. Shown only for
          // a group with >25 unread; the guardrail is re-checked in _whatDidIMiss.
          if ((widget.chat.group || widget.chat.gid != null) && _unreadIncoming > 25)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'What did I miss?',
                () { Navigator.pop(ctx); _whatDidIMiss(); }),
          // STREAM G [GROUP-AI-2/3]: per-member "translate this group for me".
          // Hidden while the groupTranslationEnabled flag (cost watch) is OFF.
          if ((widget.chat.group || widget.chat.gid != null) && RemoteConfig.groupTranslationEnabled)
            _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold),
                _groupTranslateOn ? 'Stop translating this group' : 'Translate this group for me',
                () { Navigator.pop(ctx); _toggleGroupTranslate(); }),
          _action(ctx, PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), 'Search',
              () { Navigator.pop(ctx); setState(() { _searchMode = true; _searchQuery = ''; }); }),
          _action(ctx, PhosphorIcons.images(PhosphorIconsStyle.bold), 'Media, links & docs',
              () { Navigator.pop(ctx); _openMediaLibrary(); }),
          _action(
              ctx,
              _hideDeleted
                  ? PhosphorIcons.eye(PhosphorIconsStyle.bold)
                  : PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold),
              _hideDeleted ? 'Show deleted messages' : 'Hide deleted messages',
              () { Navigator.pop(ctx); _toggleHideDeleted(); }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.timer(PhosphorIconsStyle.bold),
                _disappearSecs == 0 ? 'Disappearing messages' : 'Disappearing: ${_disappearLabel(_disappearSecs)}',
                _pickDisappear),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.paintRoller(PhosphorIconsStyle.bold), 'Chat theme', _pickWallpaper),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.archive(PhosphorIconsStyle.bold), 'Archive chat', () async {
              await ChatFlagsStore().toggle('archived', _convKey!);
              if (mounted) Navigator.pop(context);
            }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), 'Mute chat',
                () => ChatFlagsStore().toggle('muted', _convKey!)),
          if (_convKey != null && !widget.chat.group)
            _action(ctx, PhosphorIcons.prohibit(PhosphorIconsStyle.bold), 'Block user', () async {
              await ChatFlagsStore().toggle('blocked', _convKey!);
              if (mounted) Navigator.pop(context);
            }, danger: true),
          _action(ctx, PhosphorIcons.broom(PhosphorIconsStyle.bold), 'Delete chat', () => Navigator.pop(context)),
        ]),
      ),
    );
  }

  /// Toggle (and remember, per-conversation) whether deleted-message pills and
  /// tombstones are hidden from the thread.
  Future<void> _toggleHideDeleted() async {
    final next = !_hideDeleted;
    setState(() => _hideDeleted = next);
    try {
      await _aiPrefs.write(
          key: scopedKey('${_kHideDeletedKey}_${widget.chat.seed}'),
          value: next ? '1' : '0');
    } catch (_) {/* preference best-effort */}
    Analytics.capture('chat_hide_deleted_toggled', {'on': next});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(next ? 'Deleted messages hidden' : 'Deleted messages shown'),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  /// "Discuss with Ava" — open ChatAVA (the Companion thread) pointed at THIS
  /// conversation. The transcript is assembled on-device from the already-decoded
  /// bubbles and passed transiently as grounding context; it is never indexed
  /// server-side (DM/group content stays on the phone). Gated at use by the
  /// matching AvaBrain consent toggle.
  Future<void> _discussWithAva() async {
    final isGroup = widget.chat.group || widget.chat.gid != null;
    // Consent gate: DMs use 'avatok_dms' (on-device only), groups 'group_chats'.
    final allowed = await BrainConsent.isOn(isGroup ? 'group_chats' : 'avatok_dms');
    if (!mounted) return;
    if (!allowed) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Turn on AvaBrain for your messages in Settings to discuss '
            'a chat with Ava. Your messages stay on this device.'),
      ));
      return;
    }
    // Build the transcript from the visible bubbles (skip Ava/system/special).
    final turns = <DiscussTurn>[];
    for (final m in _msgs) {
      if (m.special != null) continue; // ava bubbles, receipts, calls, etc.
      final text = m.text.trim();
      if (text.isEmpty) continue;
      // Groups: attribute each non-mine bubble to its sender so Ava can tell
      // participants apart. 1:1 falls back to the peer label.
      turns.add(DiscussTurn(me: m.me, text: text, speaker: m.me ? null : m.senderLabel));
    }
    // Long threads need a summarisation pass — let the user know we're reading.
    if (turns.length > ThreadContext.kRawTailTurns * 4) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        duration: Duration(seconds: 2),
        content: Text('Reading your chat for Ava…'),
      ));
    }
    // Assemble the grounding block on-device. Short threads come back verbatim;
    // long ones are map-reduce summarised (recent tail kept raw) to stay lean.
    final transcript = await ThreadContext.buildSmart(
      peerLabel: widget.chat.name,
      turns: turns,
      isGroup: isGroup,
      summarize: (chunk) async {
        final ans = await AvaAiClient.I.ask(
          message: 'Summarise these chat messages in 2-3 sentences. Preserve who '
              'said what and any decisions, plans, questions, or feelings:\n\n$chunk',
        );
        return ans.answer;
      },
    );
    if (!mounted) return;
    if (transcript.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Not enough messages here yet for Ava to weigh in.'),
      ));
      return;
    }
    Analytics.capture('discuss_with_ava_opened', {
      'surface': 'thread',
      'is_group': isGroup,
      'turns': turns.length,
      'chars': transcript.length,
      'summarized': transcript.contains('(summarised)'),
    });
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CompanionThreadScreen(
        persona: discussPersona(widget.chat.name, isGroup: isGroup),
        discussContext: transcript,
        initialTitle: 'Chat with ${widget.chat.name}',
        onUseDraft: _prefillComposer,
      ),
    ));
  }

  /// Pre-fill the composer with a draft Ava handed back from "Discuss with Ava".
  /// We never auto-send — the user reviews/edits before it goes to the peer.
  void _prefillComposer(String text) {
    _ctrl.text = text;
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    _composerFocus.requestFocus();
  }

  /// Open the chat library — every photo, video, link and doc shared here.
  void _openMediaLibrary() {
    final media = <ChatMedia>[];
    final docs = <ChatMedia>[];
    final links = <LinkItem>[];
    final linkRe = RegExp(r'(https?://[^\s]+)', caseSensitive: false);
    for (final m in _msgs) {
      if (m.media != null) {
        final k = m.media!.kind;
        if (k == MediaKind.image || k == MediaKind.video) {
          media.add(m.media!);
        } else {
          docs.add(m.media!); // file + audio/voice
        }
      }
      for (final match in linkRe.allMatches(m.text)) {
        final url = match.group(1);
        if (url != null) links.add(LinkItem(url: url, ts: m.ts, me: m.me));
      }
    }
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => MediaLibraryScreen(
            title: widget.chat.name, media: media, docs: docs, links: links)));
  }

  String _disappearLabel(int s) => s == 0 ? 'Off' : (s >= 604800 ? '1 week' : (s >= 86400 ? '1 day' : '1 hour'));

  void _pickDisappear() {
    showModalBottomSheet(
      context: context, backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.all(14),
            child: Text('Disappearing messages', style: ZineText.cardTitle(size: 17))),
        for (final opt in [['Off', 0], ['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]])
          ListTile(
            title: Text(opt[0] as String),
            trailing: _disappearSecs == opt[1]
                ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.blueInk)
                : null,
            onTap: () async {
              final secs = opt[1] as int;
              await ChatTimerStore().set(_convKey!, secs == 0 ? '' : '$secs');
              if (mounted) { setState(() => _disappearSecs = secs); Navigator.pop(ctx); }
            },
          ),
      ])),
    );
  }

  // [CHAT-PASTE-1] One-time tip (per account) shown the first time the attach
  // menu is opened, now that the redundant 'Paste image' tile is gone: it tells
  // users the message box itself pastes images via long-press.
  static const String _kPasteHintKey = 'chat_paste_hint_shown';
  Future<void> _maybeShowPasteHint() async {
    try {
      final seen = await readScoped(_aiPrefs, _kPasteHintKey);
      if (seen == '1') return;
      await _aiPrefs.write(key: scopedKey(_kPasteHintKey), value: '1');
      if (mounted) _capNote('Tip: long-press the message box to paste images');
    } catch (_) {/* best-effort */}
  }

  // ---- attach menu (+) ----
  void _attach() {
    // ignore: unawaited_futures
    _maybeShowPasteHint();
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photos', Zine.accents[0], _pickPhotos),
            // [CHAT-PASTE-1] 'Paste image' removed — the message box already pastes
            // images natively (keyboard commitContent + context-menu Paste). A
            // one-time hint (below) points users at the long-press paste instead.
            _attachItem(ctx, PhosphorIcons.camera(PhosphorIconsStyle.bold), 'Camera', Zine.accents[1], () => _pickImage(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), 'Library', Zine.accents[4], _addFromLibrary),
            _attachItem(ctx, PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), 'Video', Zine.accents[2], () => _pickVideo(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.file(PhosphorIconsStyle.bold), 'File', Zine.accents[3], _pickFile),
            _attachItem(ctx, PhosphorIcons.mapPin(PhosphorIconsStyle.bold), 'Location', Zine.accents[4], _shareLocation),
            _attachItem(ctx, PhosphorIcons.broadcast(PhosphorIconsStyle.bold), 'Live location', Zine.accents[2], _shareLiveLocation),
            _attachItem(ctx, PhosphorIcons.user(PhosphorIconsStyle.bold), 'Contact', Zine.accents[0], _shareContactCard),
            _attachItem(ctx, PhosphorIcons.chartBar(PhosphorIconsStyle.bold), 'Poll', Zine.accents[1], _createPoll),
            _attachItem(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), 'Sticker', Zine.accents[3], _stickerPicker),
          ]),
        ),
      ),
    );
  }

  // Attachment tile — zine icon badge (flat accent fill, ink border, hard
  // shadow) + mono label. Accents rotate per tile (§6).
  Widget _attachItem(BuildContext ctx, IconData icon, String label, Color color, VoidCallback onTap) =>
      GestureDetector(
        onTap: () { Navigator.pop(ctx); onTap(); },
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Container(width: 56, height: 56,
                decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(Zine.rSm),
                    border: Zine.border,
                    boxShadow: Zine.shadowXs),
                child: Icon(icon, color: color == Zine.coral ? Colors.white : Zine.ink, size: 24)),
            const SizedBox(height: 8),
            Text(label.toUpperCase(), style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final c = widget.chat;
    return Scaffold(
      backgroundColor: Zine.paper,
      body: Stack(children: [
      SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Thread header — paper-2 band with ink bottom border (§8).
            Container(
              height: 58,
              decoration: const BoxDecoration(
                color: Zine.paper2,
                border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
              ),
              padding: const EdgeInsets.only(left: 4, right: 6),
              child: _searchMode ? _searchBar() : Row(children: [
                IconButton(
                  icon: PhosphorIcon(PhosphorIcons.caretLeft(PhosphorIconsStyle.bold), size: 22, color: Zine.ink),
                  onPressed: () => Navigator.pop(context),
                ),
                Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: Zine.ink, width: 2),
                  ),
                  child: Avatar(seed: c.seed, name: c.name, size: 38, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: GestureDetector(
                    onTap: _openInfo,
                    behavior: HitTestBehavior.opaque,
                    child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.value(size: 15)),
                      Text(
                          (_peerTyping
                              ? (c.group ? '${_typingWho ?? "Someone"} is typing…' : 'typing…')
                              : (c.group ? '${c.members} members · tap to manage'
                                  : (_peerOnline ? 'online' : _relLastSeen()))).toUpperCase(),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 9,
                              color: (_peerTyping || _peerOnline)
                                  ? (_peerOnline && !_peerTyping ? Zine.mintInk : Zine.blueInk)
                                  : Zine.inkMute)),
                    ],
                  ),
                  ),
                ),
                // Header actions — uniform 40px compact targets so they sit with
                // EVEN spacing and don't leave a big gap after the last icon.
                // Shield watchdog — green when Ava is watching this chat.
                // Hidden when Guardian is switched off (pro/live launch, KV
                // `guardianEnabled:false`).
                if (RemoteConfig.guardianEnabled) _shieldAction(),
                _headerAction(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                    () => setState(() { _searchMode = true; _searchQuery = ''; }),
                    color: Zine.blueInk),
                if (_isTelThread) ...[
                  // Unknown-number voicemail record — no live peer to call. Offer
                  // a quick "save contact" shortcut in the header instead.
                  if (!_callerSaved)
                    _headerAction(PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
                        () => _saveUnknownContact(source: 'thread_header'), color: Zine.lilac),
                ] else if (!c.group) ...[
                  _headerAction(PhosphorIcons.phone(PhosphorIconsStyle.bold), () => _call('voice'), color: Zine.mintInk),
                  _headerAction(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), () => _call('video'), color: Zine.coral),
                ] else if (RemoteConfig.conferenceEnabled) ...[
                  // Phase 10 RULE CHANGE: group conferences (LiveKit, ≤25).
                  // >25 members → greyed icons; tapping pops the limit notice.
                  _headerAction(PhosphorIcons.phone(PhosphorIconsStyle.bold),
                      () => _confAllowed ? _groupCall(false) : _confLimitNotice(false),
                      color: _confAllowed ? Zine.ink : Zine.inkMute),
                  _headerAction(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                      () => _confAllowed ? _groupCall(true) : _confLimitNotice(true),
                      color: _confAllowed ? Zine.ink : Zine.inkMute),
                  if (!_confAllowed)
                    _headerAction(PhosphorIcons.info(PhosphorIconsStyle.bold),
                        () => _confLimitNotice(true), size: 22, color: Zine.inkMute),
                ],
                _headerAction(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), _overflow, color: Zine.lilac),
              ]),
            ),
            if (_pinned != null) _pinBanner(),
            // Unknown-number receptionist thread — invite the owner to save the
            // caller (dismissible). Hidden once saved or dismissed.
            if (_isTelThread && !_callerSaved && !_saveBannerDismissed) _saveContactBanner(),
            // Ongoing group conference (Phase 10) — joinable, not ringing.
            if (widget.chat.gid != null && _confLive && RemoteConfig.conferenceEnabled) _confBanner(),
            // STREAM G [GROUP-AI-1]: the catch-up summary card, pinned above the
            // thread (dismissible). Rendered only when we have bullets to show.
            if (!_catchupDismissed && _catchupBullets.isNotEmpty)
              CatchupCard(bullets: _catchupBullets, msgCount: _catchupCount, onDismiss: _dismissCatchup),
            Expanded(
              child: DecoratedBox(
                decoration: BoxDecoration(gradient: wallpaperGradient(_wallpaperId)),
                child: Builder(builder: (_) {
                final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
                var visible = _msgs
                    .where((m) => m.expireAt == null || m.expireAt! >= nowS)
                    // Never render control envelopes (read/delivered/typing
                    // receipts) as chat bubbles — they leaked through as raw
                    // JSON "{t:read,…}" green messages that multiplied on reopen.
                    .where((m) => !_isControlEnvelope(m.text))
                    .toList();
                // "Ava is working…" chips are transient: only the MOST RECENT
                // message may be one. A real reply (or anything later) makes
                // earlier chips stale, so they collapse instead of sticking.
                if (visible.isNotEmpty) {
                  final lastIdx = visible.length - 1;
                  visible = [
                    for (var i = 0; i < visible.length; i++)
                      if (visible[i].special != 'ava_status' || i == lastIdx) visible[i],
                  ];
                }
                // "Hide deleted messages" — drop my soft-deleted pills and peer
                // "This message was deleted" tombstones so they don't clutter.
                if (_hideDeleted) {
                  visible = visible
                      .where((m) => !m.hidden && m.text != 'This message was deleted')
                      .toList();
                }
                final searching = _searchMode && _searchQuery.trim().isNotEmpty;
                if (searching) {
                  final q = _foldSearch(_searchQuery);
                  visible = visible.where((m) => _foldSearch(m.text).contains(q)).toList();
                  // No literal hit → keep the user IN the thread and offer BOTH the
                  // on-device "Discuss with Ava" find AND the server-side smart
                  // (semantic) search over their own consented index.
                  if (visible.isEmpty) return _searchEmptyState(_searchQuery.trim());
                }
                // Smart-search footer: below the literal hits, offer "Search with
                // AI" (or render the AI results/spinner once run). Only in search
                // mode with a query, and only when there ARE literal hits (the
                // empty-state path renders its own AI section).
                final showAiFooter = searching;
                // F3 (restoreV2): a leading "Older messages" divider sits above
                // the oldest loaded row once we've paged (or are paging) the deep
                // archive, so the extra rows read as history from the backup.
                final showArchiveHeader = RemoteConfig.restoreV2 &&
                    !searching &&
                    (_hasArchived || _archiveLoading);
                final headerCount = showArchiveHeader ? 1 : 0;
                final footerCount = showAiFooter ? 1 : 0;
                return ListView.builder(
                  controller: _scroll,
                  // [UI-BUBBLE-1] Symmetric 12dp horizontal thread padding for both
                  // incoming & outgoing (bubbles cap at 78% of the thread width).
                  padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
                  itemCount: visible.length + headerCount + footerCount,
                  itemBuilder: (c, i) {
                    if (showArchiveHeader && i == 0) return _olderMessagesDivider();
                    final vi = i - headerCount;
                    if (showAiFooter && vi == visible.length) return _aiSearchFooter();
                    final m = visible[vi];
                    // Phase 5: insert a "Today / Yesterday / date" separator above
                    // the first message of each new calendar day.
                    final needsSep = m.ts != 0 &&
                        (vi == 0 || !_sameDay(visible[vi - 1].ts, m.ts));
                    if (!needsSep) return _bubble(m);
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [_daySeparator(_dayLabel(m.ts)), _bubble(m)],
                    );
                  },
                );
              }),
              ),
            ),
            if (_mentionMatches.isNotEmpty) _mentionBar(),
            // Unknown-number threads are a one-way voicemail record (no live peer
            // to reply to), so the composer is replaced with a read-only note.
            // STREAM G [GROUP-AI-4]: smart-reply chips above the input (DMs only).
            if (!_isTelThread && _smartReplies.isNotEmpty)
              SmartReplyChips(suggestions: _smartReplies, onTap: _insertSmartReply),
            // STREAM B (SAFE-GATE-2): a pending stranger thread replaces the
            // composer with the safety gate bar (Safety/Block/Report/Accept).
            // Message list stays scrollable above; no typing indicator/composer.
            if (_isTelThread) SafeArea(top: false, child: _telFooter())
            else if (_strangerGatePending && StrangerGateBar.enabled && _serverConv != null)
              SafeArea(top: false, child: StrangerGateBar(
                conv: _serverConv!,
                peerUid: _peerNpub ?? widget.chat.seed,
                peerName: widget.chat.name,
                onAccepted: () {
                  setState(() { _strangerGatePending = false; _threadAcceptState = 'accepted'; });
                  // G1.2: accepting a stranger auto-enables Guardian for this chat.
                  _autoEnableGuardianOnAccept();
                },
                onBlockedOrReported: () { if (mounted) Navigator.of(context).maybePop(); },
              ))
            else SafeArea(top: false, child: _inputBar()),
          ],
        ),
      ),
      // Phase 4: floating-emoji burst overlay (ignores touches; pure delight).
      if (_burstFx.isNotEmpty) Positioned.fill(child: IgnorePointer(child: _burstOverlay())),
      ]),
    );
  }

  // Floating-emoji bursts rise + fade from the bottom. Each _BurstFx self-removes
  // after the animation (see _spawnBurst). Horizontal offset is deterministic per
  // id so concurrent bursts spread out instead of stacking.
  Widget _burstOverlay() {
    final w = MediaQuery.of(context).size.width;
    return Stack(children: [
      for (final b in _burstFx)
        TweenAnimationBuilder<double>(
          key: ValueKey(b.id),
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 2100),
          curve: Curves.easeOut,
          builder: (_, t, __) => Positioned(
            left: 24 + ((b.id * 53) % (w.toInt().clamp(120, 4000) - 80)).toDouble(),
            bottom: 90 + t * (MediaQuery.of(context).size.height * 0.5),
            child: Opacity(
              opacity: (1 - t).clamp(0.0, 1.0),
              child: Transform.scale(scale: 1 + t * 0.6, child: Text(b.emoji, style: const TextStyle(fontSize: 34))),
            ),
          ),
        ),
    ]);
  }

  // Uniform header action button — fixed 40x40 hit area, zero internal padding,
  // so the row of actions sits with even spacing and no trailing dead space.
  // ---- shield watchdog (Ava guardian) -----------------------------------------
  String? get _guardianConv {
    final key = _convKey;
    final uid = _meId?.uid;
    if (key == null || uid == null || uid.isEmpty) return null;
    return serverConvFromKey(key, uid);
  }

  // STREAM B (SAFE-GATE-1/2): gate a NEW thread from a NON-CONTACT. The contact
  // check is client-side (ContactsStore is local); the server enforces the
  // receipt suppression once the state is 'pending'. We reconcile with the
  // server (multi-device) but render the local decision instantly.
  Future<void> _initStrangerGate(String peerHex) async {
    if (!StrangerGateBar.enabled) return;
    final conv = _serverConv;
    if (conv == null || peerHex.isEmpty) return;
    try {
      // Respect an explicit stored/server decision. NOTE: 'accepted' is also the
      // DEFAULT for a fresh thread, so we do NOT early-return on accepted here —
      // the contact check + inbound/outbound guards below decide a new thread. Only
      // a blocked thread short-circuits (handled elsewhere).
      final serverState = await StrangerGateApi.state(conv);
      if (serverState == AcceptState.blocked) return;
      // If I already explicitly accepted (I have outbound below) this stays open.
      // Confirm the peer is really a non-contact before gating.
      final contacts = await ContactsStore().load();
      final isContact = contacts.any((c) => c.uid == peerHex);
      if (isContact) { if (mounted) setState(() => _threadAcceptState = 'accepted'); return; } // a saved contact is never gated
      // Only INBOUND-first threads are gated: if I already sent in this thread I
      // initiated contact (e.g. marketplace "Contact seller"), so no gate. History
      // loads async, so we re-check once (the send path also clears the gate via
      // implicit-accept). Empty thread with no inbound → nothing to gate yet.
      final hasOutbound = _msgs.any((m) => m.me);
      final hasInbound = _msgs.any((m) => !m.me);
      if (hasOutbound || !hasInbound) return;
      // Non-contact. If the server hasn't recorded a pending state yet (a brand-new
      // inbound thread reads as the 'accepted' default), DECLARE it pending so the
      // server starts suppressing our read-receipts to the stranger.
      if (serverState != AcceptState.pending) {
        await StrangerGateApi.declarePending(conv);
      }
      if (!mounted) return;
      setState(() { _strangerGatePending = true; _threadAcceptState = 'pending'; });
      StrangerGateBar.trackShown(conv, peerHex);
      // Prompt a decision up front with a modal overlay (once per open). The
      // inline StrangerGateBar remains for when the user dismisses the overlay.
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowStrangerGateSheet(peerHex));
    } catch (_) { /* fail open — no gate rather than a broken thread */ }
  }

  /// Modal overlay shown when a non-contact thread is opened: Accept, Decline
  /// (leave it in Message requests), Block or Report. Mirrors StrangerGateBar's
  /// actions/telemetry so the two entry points stay consistent. Shown once per
  /// thread open; the inline bar handles subsequent decisions.
  Future<void> _maybeShowStrangerGateSheet(String peerHex) async {
    if (!mounted || _gatePromptShown || !_strangerGatePending) return;
    if (_serverConv == null || !StrangerGateBar.enabled) return;
    _gatePromptShown = true;
    final conv = _serverConv!;
    final name = widget.chat.name.trim().isEmpty ? 'This person' : widget.chat.name.trim();
    bool busy = false;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Future<void> run(Future<void> Function() action, String verb) async {
          if (busy) return;
          setSheet(() => busy = true);
          try { await action(); } catch (_) {}
        }
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PhosphorIcon(PhosphorIcons.userCircle(PhosphorIconsStyle.bold), size: 26, color: Zine.blueInk),
                const SizedBox(width: 10),
                Expanded(child: Text('Message request', style: ZineText.value(size: 18))),
              ]),
              const SizedBox(height: 10),
              Text('$name is not in your contacts. Accept to reply, or block/report if it looks like spam. Decline keeps it under Message requests.',
                  style: ZineText.sub(size: 13.5)),
              const SizedBox(height: 18),
              // Accept — restore the composer and resume normal receipts.
              _gateSheetBtn(
                icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
                label: 'Accept', bg: Zine.lime, fg: Zine.ink, busy: busy,
                onTap: () => run(() async {
                  await StrangerGateApi.accept(conv);
                  trackStrangerGate('stranger_gate_accept', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  if (mounted) setState(() { _strangerGatePending = false; _threadAcceptState = 'accepted'; });
                  if (ctx.mounted) Navigator.of(ctx).pop();
                }, 'accept'),
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                  label: 'Block', bg: Zine.lilac, fg: Zine.ink, busy: busy,
                  onTap: () => run(() async {
                    await StrangerGateApi.block(conv: conv, uid: peerHex.isEmpty ? null : peerHex);
                    trackStrangerGate('stranger_gate_block', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop(); // leave the thread
                  }, 'block'),
                )),
                const SizedBox(width: 10),
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
                  label: 'Report', bg: Zine.coral, fg: Colors.white, busy: busy,
                  onTap: () => run(() async {
                    final id = await StrangerGateApi.report(conv: conv, lastN: 10);
                    trackStrangerGate('stranger_gate_report', {'conv': conv, 'peer': peerHex, 'ok': id != null, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop();
                  }, 'report'),
                )),
              ]),
              const SizedBox(height: 10),
              // Decline = not now: dismiss, keep pending so it stays in Message requests.
              Center(child: TextButton(
                onPressed: busy ? null : () {
                  trackStrangerGate('stranger_gate_decline', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  Navigator.of(ctx).pop();
                },
                child: Text('Decline', style: ZineText.value(size: 15, color: Zine.inkSoft)),
              )),
            ]),
          ),
        );
      }),
    );
  }

  Widget _gateSheetBtn({
    required IconData icon, required String label, required Color bg,
    required Color fg, required bool busy, required VoidCallback onTap,
  }) => ZinePressable(
        onTap: busy ? null : onTap,
        color: bg,
        radius: BorderRadius.circular(14),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(icon, size: 18, color: fg),
          const SizedBox(width: 8),
          Text(label, style: ZineText.value(size: 15, color: fg)),
        ]),
      );

  Future<void> _loadGuardian() async {
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final p = await GuardianPrefsClient.I.get(conv);
      if (mounted) setState(() => _guardian = p);
    } catch (_) {/* keep default off */}
  }

  // Tap the shield → toggle Ava watching THIS chat for scams/grooming/unsafe
  // behaviour. Green = on. Single tap toggles off with no confirmation. Long-press
  // opens the full guardian sheet. G1.3: for MINOR accounts Guardian is force-ON —
  // the shield is locked and this is a no-op (guarded in _shieldAction too).
  Future<void> _toggleGuardian() async {
    if (_isMinorAccount) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian always protects this account')));
      return;
    }
    final conv = _guardianConv;
    if (conv == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian isn’t available for this chat yet')));
      return;
    }
    final next = await GuardianPrefsClient.I.set(conv, secureChat: !_guardian.secureChat, source: 'tap');
    if (!mounted) return;
    setState(() => _guardian = next);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(next.secureChat
            ? 'Ava is now watching this chat — you’ll get a private heads-up if something looks unsafe'
            : 'Ava watch turned off for this chat')));
  }

  // G1.2: when the user ACCEPTS a message request from a non-contact stranger,
  // auto-enable Guardian for the chat (source: 'stranger_accept') and show a brief
  // notice. Best-effort — a failed prefs write never blocks the accept. Skipped for
  // minors (already force-ON) and when the shield is already on.
  Future<void> _autoEnableGuardianOnAccept() async {
    if (_isMinorAccount || _guardian.secureChat) return;
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final next = await GuardianPrefsClient.I.set(conv, secureChat: true, source: 'stranger_accept');
      if (!mounted) return;
      setState(() => _guardian = next);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Ava Guardian is on for this chat — tap the shield to turn it off.')));
    } catch (_) {/* best-effort — never block the accept */}
  }

  void _openGuardianSheet() {
    final conv = _guardianConv;
    if (conv == null) return;
    // U1-lite: pass the peer uid for 1:1 chats so the (dark) "Require verification"
    // row can address the peer. Null for groups → the row is hidden there.
    GuardianSettingsSheet.show(context,
            conv: conv,
            chatLabel: widget.chat.name,
            peerUid: _isGroup ? null : _peerNpub)
        .then((_) => _loadGuardian());
  }

  // Header action icons (shield / search / call / video / ⋮). Bumped to 26px
  // with 46px tap targets (owner request 2026-06-24: the top-bar icons were too
  // small to read/tap comfortably).
  Widget _headerAction(IconData icon, VoidCallback onTap,
          {double size = 26, Color color = Zine.ink}) =>
      IconButton(
        icon: PhosphorIcon(icon, size: size, color: color),
        onPressed: onTap,
        visualDensity: VisualDensity.compact,
        padding: EdgeInsets.zero,
        splashRadius: 26,
        constraints: const BoxConstraints(minWidth: 46, minHeight: 46),
      );

  // Shield watchdog toggle: GREEN when Ava is watching this chat. Single tap
  // toggles (no confirmation); long-press opens the full guardian settings.
  // G1.3: for MINOR accounts the shield is LOCKED-ON — green, no toggle, a tooltip
  // explaining Guardian always protects the account.
  Widget _shieldAction() {
    if (_isMinorAccount) {
      return Tooltip(
        message: 'Guardian always protects this account',
        child: _headerAction(
          PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
          () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Guardian always protects this account'))),
          color: Zine.mintInk,
        ),
      );
    }
    final on = _guardian.secureChat;
    return GestureDetector(
      onLongPress: _openGuardianSheet,
      child: _headerAction(
        on ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill)
           : PhosphorIcons.shield(PhosphorIconsStyle.bold),
        _toggleGuardian,
        color: on ? Zine.mintInk : Zine.inkSoft,
      ),
    );
  }

  // Lime circular send button — ink border, hard shadow (the screen's one
  // lime primary action).
  Widget _sendCircle(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(width: 44, height: 44,
            decoration: BoxDecoration(
                color: Zine.lime, shape: BoxShape.circle,
                border: Zine.border, boxShadow: Zine.shadowXs),
            child: Icon(icon, color: Zine.ink, size: 20)),
      );

  Widget _inputBar() {
    // Input band: paper-2 with ink top border; field = ink-bordered pill.
    const bandDeco = BoxDecoration(
      color: Zine.paper2,
      border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
    );
    if (_recording) {
      return Container(
        decoration: bandDeco,
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 10),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.record(PhosphorIconsStyle.fill), color: Zine.coral, size: 16),
          const SizedBox(width: 8),
          Expanded(child: Text('Recording… tap to send', style: ZineText.value(size: 14))),
          _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill), _toggleRecord),
        ]),
      );
    }
    // STREAM E: WhatsApp-parity rich input bar + emoji/GIF/sticker panel (flag ON
    // by default). Reuses the SAME handlers as the legacy row below (_send,
    // _attach, camera, _toggleRecord, _onInputChanged) so send/attach/camera/mic
    // behaviour is unchanged; adds the emoji/GIF/sticker panel + GIF/sticker send.
    // The reply/listening banners + quick-tools ride in `topSlot`. When the flag
    // is OFF we fall through to the legacy composer below.
    if (RemoteConfig.richInputEnabled) {
      return RichInputBar(
        controller: _ctrl,
        focusNode: _composerFocus,
        hasText: _hasText,
        hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
        fieldColor: _avaMode ? Zine.lilac : Zine.card,
        onSend: _send,
        onAttach: _attach,
        onCamera: () => _pickImage(ImageSource.camera),
        onMic: _toggleRecord,
        onChanged: _onInputChanged,
        onGif: _sendGif,
        onSticker: _sendStickerAsset,
        topSlot: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_replyTo != null || _editing != null) _replyBanner(),
          if (_sttActive) _listeningBanner(),
          _composerTools(),
        ]),
      );
    }
    return Container(
      decoration: bandDeco,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_replyTo != null || _editing != null) _replyBanner(),
        if (_sttActive) _listeningBanner(),
        _composerTools(),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 12, 10),
          // Bottom-align so the + and send controls stay pinned to the bottom
          // as the multi-line field grows upward. (The Ava-mode toggle now
          // lives in the quick-tools row above — see _avaModeChip.)
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        IconButton(
            icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), color: Zine.ink, size: 26),
            onPressed: _attach),
        // Phase 4: tap = send a 🎉 burst to the room; long-press picks the emoji.
        if (_party != null)
          GestureDetector(
            onLongPress: _pickBurstEmoji,
            child: IconButton(
              icon: PhosphorIcon(PhosphorIcons.confetti(PhosphorIconsStyle.bold), color: Zine.coral, size: 24),
              onPressed: () => _sendBurst('🎉'),
            ),
          ),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
                color: _avaMode ? Zine.lilac : Zine.card,
                borderRadius: BorderRadius.circular(5),
                border: Zine.border),
            // Wrap the field so BOTH a hardware Cmd/Ctrl+V and the long-press
            // toolbar "Paste" route through _onComposerPaste — which pastes an
            // image from the clipboard (super_clipboard) when one is present and
            // otherwise pastes text as usual. Without this the box silently
            // ignores copied images (Flutter's clipboard is text-only).
            child: Actions(
              actions: {
                PasteTextIntent: CallbackAction<PasteTextIntent>(
                  onInvoke: (intent) {
                    _onComposerPaste(via: 'keyboard');
                    return null;
                  },
                ),
              },
              child: TextField(
              controller: _ctrl,
              focusNode: _composerFocus,
              onChanged: _onInputChanged,
              onSubmitted: (_) => _send(),
              // Accept images inserted by the keyboard / system clipboard (Samsung
              // "super paste", Gboard image paste, GIF insert). These arrive via
              // Android's InputConnection.commitContent — NOT PasteTextIntent — so
              // without this config the image is silently dropped (the input box
              // stays empty and the system falls back to a blank editor view).
              contentInsertionConfiguration: ContentInsertionConfiguration(
                allowedMimeTypes: const [
                  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
                ],
                onContentInserted: _onContentInserted,
              ),
              // Auto-grow upward as the user types (1 line → max 5, then it
              // scrolls internally so the text always stays in view). Enter
              // still sends — the keyboard action button is wired to send.
              minLines: 1,
              maxLines: 5,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.send,
              style: ZineText.input(size: 15.5),
              cursorColor: Zine.blueInk,
              contextMenuBuilder: (ctx, editableState) {
                // Rebuild the default selection toolbar but re-point its "Paste"
                // button at our image-aware handler, so pasting a copied image
                // works from the toolbar too.
                final items = editableState.contextMenuButtonItems
                    .map((b) => b.type == ContextMenuButtonType.paste
                        ? ContextMenuButtonItem(
                            type: ContextMenuButtonType.paste,
                            onPressed: () {
                              editableState.hideToolbar();
                              _onComposerPaste();
                            },
                          )
                        : b)
                    .toList();
                return AdaptiveTextSelectionToolbar.buttonItems(
                  anchors: editableState.contextMenuAnchors,
                  buttonItems: items,
                );
              },
              decoration: InputDecoration(
                  hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
                  hintStyle: ZineText.input(size: 15.5).copyWith(
                      color: Zine.placeholder, fontWeight: FontWeight.w600),
                  border: InputBorder.none, isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12)),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        if (_sttActive)
          GestureDetector(
            onTap: _stopVoiceToText,
            child: Container(width: 44, height: 44,
                decoration: BoxDecoration(
                    color: Zine.coral, shape: BoxShape.circle,
                    border: Zine.border, boxShadow: Zine.shadowXs),
                child: Icon(Icons.stop_rounded, color: Colors.white, size: 22)),
          )
        else
          // Mic is now a pure voice-note record button (owner request
          // 2026-06-27): tapping it starts/stops recording a voice message.
          // The old "Record audio / Convert voice to text" chooser (_openMicMenu)
          // and the speech-to-text path are no longer surfaced.
          _sendCircle(
              _hasText
                  ? PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill)
                  : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
              _hasText ? _send : _toggleRecord),
          ]),
        ),
      ]),
    );
  }

  // Thin "Listening…" banner shown above the composer during voice-to-text.
  Widget _listeningBanner() => Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.waveform(PhosphorIconsStyle.fill),
              color: Zine.mintInk, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: ValueListenableBuilder<String>(
              valueListenable: AvaOnDeviceStt.I.statusLine,
              builder: (_, s, __) => Text(
                s.isEmpty ? 'Listening…' : s,
                style: ZineText.kicker(size: 11, color: Zine.mintInk),
              ),
            ),
          ),
          Text('TAP ■ TO INSERT', style: ZineText.kicker(size: 9.5)),
        ]),
      );

  // ===========================================================================
  // Composer quick-tools row (Translate · Fix grammar · Rewrite · Reply ideas)
  // ===========================================================================

  /// The little horizontally-scrolling chip bar that sits right on top of the
  /// text field. Each chip runs one Ava call and writes the result back into
  /// the input box. The whole row dims while a job is in flight.
  Widget _composerTools() {
    // Centered, evenly-spaced quick tools. Each tool gets a distinct pastel
    // fill so it's recognizable at a glance. Wrap keeps them centered and never
    // overflows on narrow screens (falls to a second centered row if needed).
    // Spread the quick-tools evenly across the FULL width of the composer with
    // bigger, better-separated touch targets — they used to be tiny and bunched
    // in the centre with empty space either side. spaceEvenly gives equal gutters
    // left, right and between, so the row breathes and each chip is easy to hit.
    // Owner request (2026-06-27): the three quick-tool chips — Talk-to-Ava (✦),
    // Translate, and Help-me-write-better — are retired from the composer. In
    // their place a tiny PAID-ONLY hint reminds people how to summon Ava inline:
    // `@ava` for a private reply, `#ava` to ask Ava in front of everyone. Free
    // users see nothing here (Ava AI in chat is a paid feature). The old chip
    // builders below are intentionally left in place (unused) to keep this a
    // surgical, low-risk change.
    if (!_premium) return const SizedBox.shrink();
    return _avaHintNote();
  }

  /// Tiny paid-only reminder above the field: how to call Ava without a button.
  Widget _avaHintNote() => Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              size: 14, color: Zine.blueInk),
          const SizedBox(width: 6),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'Type '),
                TextSpan(text: '@ava', style: ZineText.tag(size: 11.5, color: Zine.blueInk)),
                const TextSpan(text: ' for a private reply, or '),
                TextSpan(text: '#ava', style: ZineText.tag(size: 11.5, color: Zine.mintInk)),
                const TextSpan(text: ' to ask Ava in the chat.'),
              ]),
              style: ZineText.sub(size: 11.5),
            ),
          ),
        ]),
      );

  /// Ava-mode toggle chip — sits at the front of the quick-tools row. Flip ON
  /// to talk privately to Ava without typing @ava; flip back to message the
  /// person. Fills lilac + sparkle-fill when ON.
  Widget _avaModeChip() {
    return Tooltip(
        message: _avaMode
            ? 'Talking to Ava (tap to message ${widget.chat.name})'
            : 'Talk privately to Ava',
        child: GestureDetector(
          onTap: () {
            setState(() => _avaMode = !_avaMode);
            _composerFocus.requestFocus();
          },
          child: Container(
            width: 48, height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _avaMode ? Zine.lilac : Zine.card,
              shape: BoxShape.circle,
              border: Zine.border,
              boxShadow: Zine.shadowXs,
            ),
            child: PhosphorIcon(
                PhosphorIcons.sparkle(
                    _avaMode ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                size: 23,
                color: _avaMode ? Zine.blueInk : Zine.ink),
          ),
        ),
      );
  }

  /// Consolidated "Help me write better" control — replaces the separate Fix
  /// grammar / Rewrite / Reply ideas chips. Tapping opens a menu of writing
  /// actions, so the composer row stays clean (Ava · Translate · Write help).
  Widget _writeHelpChip() {
    const writeTools = {'grammar', 'rewrite', 'reply_ideas'};
    final busy = _aiTool != null && writeTools.contains(_aiTool);
    final dimmed = _aiBusy && !busy;
    return Opacity(
      opacity: dimmed ? 0.4 : 1,
      child: GestureDetector(
        onTap: _aiBusy ? null : _openWriteHelp,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: busy ? Zine.lime : Zine.card,
            borderRadius: BorderRadius.circular(100),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            busy
                ? const SizedBox(width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                : PhosphorIcon(PhosphorIcons.magicWand(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
            const SizedBox(width: 8),
            Text('Help me write better', style: ZineText.tag(size: 12.5, color: Zine.ink)),
          ]),
        ),
      ),
    );
  }

  /// Menu for [_writeHelpChip]: Fix grammar, the rewrite tones (flattened so a
  /// tone is one tap), and Reply ideas.
  Future<void> _openWriteHelp() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('HELP ME WRITE BETTER', style: ZineText.kicker()),
          const SizedBox(height: 12),
          _writeHelpRow(ctx, PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), Zine.blue,
              'Fix grammar', 'Spelling & grammar, same meaning', 'grammar'),
          _writeHelpRow(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), Zine.lime,
              'Friendlier', 'Warmer, friendlier tone', 'friendly'),
          _writeHelpRow(ctx, PhosphorIcons.briefcase(PhosphorIconsStyle.bold), Zine.mint,
              'More formal', 'Formal and professional', 'formal'),
          _writeHelpRow(ctx, PhosphorIcons.scissors(PhosphorIconsStyle.bold), Zine.lilac,
              'Shorter & clearer', 'Trim it down, keep the point', 'short'),
          _writeHelpRow(ctx, PhosphorIcons.lightbulb(PhosphorIconsStyle.bold), Zine.coral,
              'Reply ideas', 'Suggest replies to the last message', 'reply_ideas'),
        ])),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case 'grammar': _runFixGrammar(); break;
      case 'reply_ideas': _runReplyIdeas(); break;
      case 'friendly': _runRewriteStyle('Friendlier', 'warmer and friendlier'); break;
      case 'formal': _runRewriteStyle('More formal', 'more formal and professional'); break;
      case 'short': _runRewriteStyle('Shorter & clearer', 'shorter, clearer and more concise'); break;
    }
  }

  Widget _writeHelpRow(BuildContext ctx, IconData icon, Color accent, String title, String subtitle, String action) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZinePressable(
        onTap: () => Navigator.pop(ctx, action),
        radius: BorderRadius.circular(Zine.rSm),
        boxShadow: Zine.shadowXs,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 32),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 15)),
            const SizedBox(height: 2),
            Text(subtitle, style: ZineText.sub(size: 12)),
          ])),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
        ]),
      ),
    );
  }

  /// Translate chip — split into two tap zones: the left runs a translation
  /// into the remembered language; the trailing language + caret opens the
  /// picker to change it.
  Widget _translateChip() {
    final busy = _aiTool == 'translate';
    final dimmed = _aiBusy && !busy;
    return Opacity(
        opacity: dimmed ? 0.4 : 1,
        child: Container(
          decoration: BoxDecoration(
            color: busy ? Zine.lime : Zine.mint,
            borderRadius: BorderRadius.circular(100),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Tooltip(
              message: 'Translate',
              child: GestureDetector(
                onTap: _aiBusy ? null : _runTranslate,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(15, 13, 12, 13),
                  child: busy
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink),
                        )
                      : PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                          size: 23, color: Zine.ink),
                ),
              ),
            ),
            GestureDetector(
              onTap: _aiBusy ? null : _pickTransLang,
              child: Container(
                padding: const EdgeInsets.fromLTRB(9, 9, 12, 9),
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: Zine.ink, width: Zine.bw)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(_transLang.label,
                      style: ZineText.tag(size: 12.5, color: Zine.blueInk)),
                  const SizedBox(width: 3),
                  PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                      size: 12, color: Zine.blueInk),
                ]),
              ),
            ),
          ]),
        ),
      );
  }

  /// Shared runner: flips the busy flags, fires the [call], reports failures,
  /// and returns the trimmed answer (or null on block/empty/error).
  Future<String?> _runAiTool(String tool, Future<AvaAnswer> Function() call,
      {Map<String, Object> props = const <String, Object>{}}) async {
    if (_aiBusy) return null;
    setState(() { _aiBusy = true; _aiTool = tool; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var retried = false;
    Analytics.capture('composer_ai_used', <String, Object>{
      'tool': tool, 'is_group': _isGroup, ...props,
    });
    // Rich latency breakdown so we can answer "why was translate/suggest slow?":
    // client_ms (round-trip the user felt), server_ms/gen_ms/setup_ms (where the
    // server spent it), tool_calls (agentic round-trips — should be 0 for these),
    // whether we retried, and the network type. Attached to ok AND failure events.
    Map<String, Object> timing(AvaAnswer a) => <String, Object>{
          'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
          'retried': retried,
          if (a.clientMs != null) 'client_ms': a.clientMs!,
          if (a.serverMs != null) 'server_ms': a.serverMs!,
          if (a.genMs != null) 'gen_ms': a.genMs!,
          if (a.setupMs != null) 'setup_ms': a.setupMs!,
          if (a.toolCalls != null) 'tool_calls': a.toolCalls!,
        };
    try {
      // One silent auto-retry on a TRANSIENT failure (a dropped request or a 5xx)
      // so a single network blip doesn't make the user re-tap the chip. A real
      // block (moderation / daily cap) or a populated answer is returned as-is.
      var a = await call();
      final transient1 = a.blocked &&
          (a.reason == 'network' || (a.reason?.startsWith('http_5') ?? false));
      if (transient1) {
        retried = true;
        await Future.delayed(const Duration(milliseconds: 350));
        if (!mounted) return null;
        a = await call();
      }
      if (!mounted) return null;
      if (a.blocked) {
        // Distinct copy per cause so the user knows whether to wait, top up, or
        // check their connection — not one catch-all "couldn't help".
        final String msg;
        if (a.hitDailyCap) {
          msg = 'Daily free AI limit reached — connect your own key in Settings for unlimited.';
        } else if (a.reason == 'network') {
          msg = 'Couldn’t reach Ava — check your connection and try again.';
        } else if (a.reason?.startsWith('http_5') ?? false) {
          msg = 'Ava is busy right now — give it a moment and try again.';
        } else {
          msg = 'Ava couldn’t help with that right now.';
        }
        _toolHint(msg);
        Analytics.capture('composer_ai_blocked', <String, Object>{
          'tool': tool, 'reason': a.reason ?? 'unknown', ...timing(a),
        });
        return null;
      }
      final out = a.answer.trim();
      if (out.isEmpty) {
        _toolHint('Ava returned nothing — try again.');
        Analytics.capture('composer_ai_empty', <String, Object>{'tool': tool, ...timing(a)});
        return null;
      }
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': tool, 'tier': a.tier ?? 'unknown', ...timing(a),
      });
      return out;
    } catch (e) {
      if (mounted) _toolHint('Something went wrong. Check your connection.');
      Analytics.capture('composer_ai_error', {
        'tool': tool, 'total_ms': DateTime.now().millisecondsSinceEpoch - t0, 'retried': retried,
      });
      return null;
    } finally {
      if (mounted) setState(() { _aiBusy = false; _aiTool = null; });
    }
  }

  /// Drop [out] into the input box (replacing the draft), cursor at the end,
  /// keyboard kept up — the user just hits send.
  void _replaceComposer(String out) {
    _ctrl.value = TextEditingValue(
      text: out,
      selection: TextSelection.collapsed(offset: out.length),
    );
    setState(() => _hasText = out.trim().isNotEmpty);
    _composerFocus.requestFocus();
  }

  void _toolHint(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      behavior: SnackBarBehavior.floating,
      duration: const Duration(seconds: 3),
    ));
  }

  Future<void> _runTranslate() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Translate'); return; }
    if (_aiBusy) return;
    // INSTANT PATH (pic4): on-device ML Kit translation (~tens of ms, offline,
    // free). Falls through to the server (Gemini) path when the language pair
    // isn't supported on-device or the model isn't downloaded yet (the download
    // runs deferred in the background, so the next tap is instant).
    final t0 = DateTime.now().millisecondsSinceEpoch;
    setState(() { _aiBusy = true; _aiTool = 'translate'; });
    final local = await OnDeviceTranslate.I.translate(text, _transLang.code);
    if (!mounted) return;
    setState(() { _aiBusy = false; _aiTool = null; });
    if (local != null) {
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': 'translate', 'engine': 'ondevice', 'lang': _transLang.code,
        'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      _replaceComposer(local);
      return;
    }
    final out = await _runAiTool('translate',
        () => ComposerAi.translate(text, _transLang.code),
        props: {'lang': _transLang.code, 'engine': 'server'});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runFixGrammar() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Fix grammar'); return; }
    final out = await _runAiTool('grammar', () => ComposerAi.fixGrammar(text));
    if (out != null) _replaceComposer(out);
  }

  /// Rewrite the draft in a fixed [style] (called from the write-help menu).
  Future<void> _runRewriteStyle(String label, String style) async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a draft first, then pick a style'); return; }
    final out = await _runAiTool('rewrite',
        () => ComposerAi.rewrite(text, style), props: {'tone': label});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runReplyIdeas() async {
    final incoming = _lastIncomingText();
    if (incoming == null) { _toolHint('No message to reply to yet'); return; }
    final out = await _runAiTool('reply_ideas',
        () => ComposerAi.replyIdeas(incoming));
    if (out == null) return;
    final ideas = ComposerAi.parseIdeas(out);
    if (ideas.isEmpty) { _toolHint('No suggestions — try again.'); return; }
    _showReplyIdeas(ideas);
  }

  /// The most recent non-empty message FROM the other side (skips my own
  /// messages, control envelopes and special bubbles like polls/location).
  String? _lastIncomingText() {
    for (var i = _msgs.length - 1; i >= 0; i--) {
      final m = _msgs[i];
      if (m.me || m.special != null) continue;
      final t = m.text.trim();
      if (t.isEmpty || _isControlEnvelope(t)) continue;
      return t;
    }
    return null;
  }

  // ---- pickers --------------------------------------------------------------

  Future<void> _pickTransLang() async {
    final picked = await showModalBottomSheet<ComposerLang>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                  size: 20, color: Zine.ink),
              const SizedBox(width: 10),
              Text('Translate into…', style: ZineText.cardTitle(size: 18)),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final l in ComposerAi.languages)
                  ListTile(
                    title: Text(l.label, style: ZineText.value(size: 16)),
                    subtitle: l.code != l.label
                        ? Text(l.code, style: ZineText.sub(size: 13))
                        : null,
                    trailing: l.code == _transLangCode
                        ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                            color: Zine.blueInk)
                        : null,
                    onTap: () => Navigator.pop(ctx, l),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
    if (picked == null) return;
    setState(() => _transLangCode = picked.code);
    try {
      await _aiPrefs.write(key: scopedKey(_kTransLangKey), value: picked.code);
    } catch (_) {/* preference best-effort */}
    // Translate straight away with the new choice — one tap less.
    await _runTranslate();
  }

  void _showReplyIdeas(List<String> ideas) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.lightbulb(PhosphorIconsStyle.bold),
                  size: 20, color: Zine.ink),
              const SizedBox(width: 10),
              Text('Reply ideas', style: ZineText.cardTitle(size: 18)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Tap one to drop it into your message.',
                  style: ZineText.sub(size: 13)),
            ),
          ),
          for (final idea in ideas)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: GestureDetector(
                onTap: () { Navigator.pop(ctx); _replaceComposer(idea); },
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: Zine.card,
                    borderRadius: BorderRadius.circular(14),
                    border: Zine.border,
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Text(idea, style: ZineText.value(size: 15, weight: FontWeight.w600)),
                ),
              ),
            ),
          const SizedBox(height: 12),
        ]),
      ),
    );
  }

  Widget _replyBanner() {
    final isEdit = _editing != null;
    final preview = isEdit ? _editing!.text : (_replyTo?.text ?? '');
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
      child: Row(children: [
        Container(width: 3, height: 32, color: Zine.blueInk),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((isEdit ? 'Editing' : 'Replying to ${_replyTo!.me ? "yourself" : (_replyTo!.senderLabel ?? widget.chat.name)}').toUpperCase(),
                style: ZineText.kicker(size: 10, color: Zine.blueInk)),
            Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 12.5)),
          ]),
        ),
        IconButton(
          icon: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
          onPressed: () => setState(() {
            _replyTo = null;
            if (_editing != null) { _editing = null; _ctrl.clear(); _hasText = false; }
          }),
        ),
      ]),
    );
  }

  /// True if [text] is a control/receipt envelope (read/delivered/typing/ack)
  /// that should never appear as a chat bubble.
  bool _isControlEnvelope(String text) {
    final t = text.trim();
    if (t.isEmpty || t.codeUnitAt(0) != 0x7B /* { */) return false;
    if (t.contains('"read_ts"') || t.contains('"delivered_ts"')) return true;
    try {
      final j = jsonDecode(t);
      if (j is Map) {
        const ctrl = {'read', 'delivered', 'typing', 'ack', 'receipt', 'seen', 'del', 'gdel'};
        return ctrl.contains(j['t']) || ctrl.contains(j['type']);
      }
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  /// Normalise text for in-thread search: lower-case and strip the most common
  /// accents so "cafe" matches "café" and case never matters. Keeps it simple —
  /// no full Unicode NFD dependency.
  static String _foldSearch(String s) {
    var t = s.toLowerCase();
    const from = 'áàâäãåéèêëíìîïóòôöõúùûüñçý';
    const to = 'aaaaaaeeeeiiiiooooouuuuncy';
    final b = StringBuffer();
    for (final ch in t.split('')) {
      final i = from.indexOf(ch);
      b.write(i >= 0 ? to[i] : ch);
    }
    return b.toString().trim();
  }

  /// Reset any smart-search state — called when the query text changes so stale
  /// AI results/spinner/error never linger for a different query.
  void _resetAiSearch() {
    if (_aiSearching || _aiHits.isNotEmpty || _aiSearchError ||
        _aiSearchedQuery.isNotEmpty || _aiShowOther || _aiBrainOff) {
      _aiSearching = false;
      _aiHits = const [];
      _aiSearchError = false;
      _aiSearchedQuery = '';
      _aiShowOther = false;
      _aiBrainOff = false;
    }
  }

  /// Run "smart search": query the user's own semantic index (Cloudflare AI
  /// Search) scoped best-effort to THIS conversation, then map hits back to local
  /// messages by fuzzy text match. Literal search is untouched — this is additive.
  ///
  /// Gated by the messaging AvaBrain consent (the same ingestion the smart index
  /// is built from): if it's off we show only the literal results plus a one-line
  /// "enable AvaBrain" hint. Never throws — errors surface as a graceful state.
  Future<void> _smartSearch() async {
    final q = _searchQuery.trim();
    if (q.isEmpty || _aiSearching) return;
    // Same query already answered → don't refetch.
    if (_aiSearchedQuery == q && (_aiHits.isNotEmpty || _aiSearchError)) return;

    // Respect the existing BrainConsent gate (E2E/private content is only ever
    // indexed under the user's own consented ingestion; if that's off there is
    // nothing to search and we must not pretend otherwise).
    if (!await BrainConsent.isOn('messaging')) {
      if (!mounted) return;
      setState(() { _aiBrainOff = true; _aiHits = const []; _aiSearchError = false; });
      return;
    }

    setState(() { _aiSearching = true; _aiSearchError = false; _aiBrainOff = false; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var ok = false;
    var matchedLocal = 0;
    List<_AiHit> hits = const [];
    try {
      final res = await ApiAuth.postJson(
        _brainSearchUrl(),
        {'q': q, 'conv': _serverConvId ?? '', 'name': widget.chat.name},
        timeout: const Duration(seconds: 12),
      );
      if (res.statusCode == 200) {
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final raw = (body['hits'] as List?) ?? const [];
        final parsed = <_AiHit>[];
        for (final h in raw) {
          if (h is! Map) continue;
          final snip = (h['text'] ?? '').toString().trim();
          if (snip.isEmpty) continue;
          final inThread = h['inThread'] == true;
          final local = _matchLocalMessage(snip);
          if (local != null) matchedLocal++;
          parsed.add(_AiHit(snip, inThread, local?.id, local?.text ?? ''));
        }
        // Order: in-thread matches first, then in-thread unmatched, then others.
        parsed.sort((a, b) {
          int rank(_AiHit x) => x.localId != null ? 0 : (x.inThread ? 1 : 2);
          return rank(a).compareTo(rank(b));
        });
        hits = parsed;
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    Analytics.capture('chat_ai_search',
        {'ok': ok, 'ms': ms, 'hits': hits.length, 'matched_local': matchedLocal});
    if (!mounted) return;
    setState(() {
      _aiSearching = false;
      _aiSearchedQuery = q;
      _aiSearchError = !ok;
      _aiHits = hits;
    });
  }

  static String _brainSearchUrl() {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin${AvaApi.brainThreadSearch}';
  }

  /// Fuzzy-match a server snippet to a message loaded in THIS thread. Strips any
  /// "Me: "/"Them: "/"Ava: " speaker label the index added, folds accents/case,
  /// then looks for a two-way containment against each local bubble's text.
  _Msg? _matchLocalMessage(String snippet) {
    var s = snippet.replaceFirst(RegExp(r'^(me|them|you|ava)\s*:\s*', caseSensitive: false), '').trim();
    final needle = _foldSearch(s);
    if (needle.length < 3) return null;
    _Msg? best;
    var bestLen = 0;
    for (final m in _msgs) {
      if (m.special != null || m.text.trim().isEmpty) continue;
      final hay = _foldSearch(m.text);
      if (hay.isEmpty) continue;
      // Two-way containment: the message contains the snippet, or the snippet
      // (a longer indexed line) contains the whole message.
      final overlap = hay.contains(needle) || (needle.length > hay.length && needle.contains(hay));
      if (overlap && hay.length > bestLen) { best = m; bestLen = hay.length; }
    }
    return best;
  }

  /// Tap a matched AI hit → reuse the existing literal-search filter to reveal the
  /// message: set the query to a distinctive slice of the matched local text so
  /// the list filters down to (and shows) that bubble.
  void _openAiHit(_AiHit hit) {
    if (hit.localId == null || hit.localText.trim().isEmpty) return;
    Analytics.capture('chat_ai_search_open', {'in_thread': hit.inThread});
    // Pick a distinctive slice (first ~5 words) so the literal filter narrows to
    // this message but the search box stays readable/editable.
    final words = hit.localText.trim().split(RegExp(r'\s+'));
    final slice = (words.length > 6 ? words.sublist(0, 6) : words).join(' ');
    _searchCtrl.text = slice;
    setState(() {
      _searchQuery = slice;
      _resetAiSearch();
    });
  }

  /// Compact "AI results" section rendered under the literal hits (or in the empty
  /// state). Handles spinner / error / empty / consent-off, all in Zine styling.
  Widget _aiResultsSection() {
    final children = <Widget>[
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
        child: Row(children: [
          Expanded(child: Container(height: Zine.bw, color: Zine.inkMute.withValues(alpha: 0.4))),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 13, color: Zine.blueInk),
          const SizedBox(width: 5),
          Text('AI RESULTS', style: ZineText.tag(size: 9, color: Zine.blueInk)),
          const SizedBox(width: 8),
          Expanded(child: Container(height: Zine.bw, color: Zine.inkMute.withValues(alpha: 0.4))),
        ]),
      ),
    ];

    if (_aiBrainOff) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('Enable AvaBrain for your messages in Settings to search by meaning.',
            textAlign: TextAlign.center, style: ZineText.sub(size: 12)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearching) {
      children.add(const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Center(child: SizedBox(
            width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearchError) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text("Couldn't reach smart search. Tap to retry.",
            textAlign: TextAlign.center, style: ZineText.sub(size: 12, color: Zine.coral)),
      ));
      children.add(_aiSearchButton(label: 'Retry smart search'));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }

    final inThread = _aiHits.where((h) => h.localId != null).toList();
    final other = _aiHits.where((h) => h.localId == null).toList();
    if (inThread.isEmpty && other.isEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('No meaning-based matches in this chat.',
            textAlign: TextAlign.center, style: ZineText.sub(size: 12)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    for (final h in inThread) children.add(_aiHitTile(h, tappable: true));
    if (other.isNotEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: GestureDetector(
          onTap: () => setState(() => _aiShowOther = !_aiShowOther),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                _aiShowOther ? PhosphorIcons.caretDown(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                size: 12, color: Zine.inkMute),
            const SizedBox(width: 4),
            Text('${other.length} from your other chats',
                style: ZineText.tag(size: 10, color: Zine.inkMute)),
          ]),
        ),
      ));
      if (_aiShowOther) for (final h in other) children.add(_aiHitTile(h, tappable: false));
    }
    return Column(mainAxisSize: MainAxisSize.min, children: children);
  }

  /// Footer under the literal hits: either the "Search with AI" opt-in pill (not
  /// yet run for this query) or the AI results section (spinner/hits/error).
  Widget _aiSearchFooter() {
    final q = _searchQuery.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: (_aiSearching || ranForThisQuery)
          ? _aiResultsSection()
          : _aiSearchButton(),
    );
  }

  Widget _aiHitTile(_AiHit h, {required bool tappable}) {
    final label = h.localId != null ? h.localText : h.snippet;
    final tile = Container(
      margin: const EdgeInsets.fromLTRB(16, 3, 16, 3),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Zine.paper,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tappable ? Zine.ink : Zine.inkMute, width: tappable ? 2 : 1),
      ),
      child: Row(children: [
        Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis,
            style: ZineText.value(size: 13.5))),
        if (tappable) ...[
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), size: 15, color: Zine.blueInk),
        ],
      ]),
    );
    if (!tappable) return tile;
    return GestureDetector(onTap: () => _openAiHit(h), behavior: HitTestBehavior.opaque, child: tile);
  }

  /// The explicit "Search with AI" pill — shown under literal results (and in the
  /// empty state) so the user can opt into the semantic step.
  Widget _aiSearchButton({String label = 'Search with AI'}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: GestureDetector(
            onTap: _smartSearch,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              decoration: BoxDecoration(
                color: Zine.lilac,
                borderRadius: BorderRadius.circular(100),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: Zine.blueInk),
                const SizedBox(width: 6),
                Text(label, style: ZineText.value(size: 13, color: Zine.blueInk)),
              ]),
            ),
          ),
        ),
      );

  /// Empty state shown when an in-thread search finds no literal match. Keeps the
  /// user IN the thread (the complaint was being kicked out) and offers Ava as a
  /// meaning-based fallback over the on-device transcript.
  Widget _searchEmptyState(String query) {
    final q = query.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 30, color: Zine.inkMute),
        const SizedBox(height: 10),
        Text('No messages match “$query”.',
            textAlign: TextAlign.center, style: ZineText.value(size: 14)),
        const SizedBox(height: 4),
        Text('Search this chat by meaning, not just exact words.',
            textAlign: TextAlign.center, style: ZineText.sub(size: 12)),
        const SizedBox(height: 14),
        // Server-side smart (semantic) search over the user's own consented
        // index — the primary "AI search" path. Shows spinner/hits/error once run.
        if (_aiSearching || ranForThisQuery)
          _aiResultsSection()
        else
          _aiSearchButton(),
        const SizedBox(height: 10),
        // On-device "Discuss with Ava" — reads the visible bubbles locally and
        // answers by meaning (kept as a secondary, fully-local option).
        GestureDetector(
          onTap: () {
            setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); });
            _discussWithAva();
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            decoration: BoxDecoration(
              color: Zine.paper,
              borderRadius: BorderRadius.circular(100),
              border: Zine.border,
              boxShadow: Zine.shadowXs,
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
                  size: 15, color: Zine.ink),
              const SizedBox(width: 6),
              Text('Discuss with Ava',
                  style: ZineText.value(size: 13, color: Zine.ink)),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _searchBar() => Row(children: [
        IconButton(icon: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold), color: Zine.ink),
            onPressed: () => setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); })),
        Expanded(child: TextField(
          autofocus: true,
          controller: _searchCtrl,
          onChanged: (v) => setState(() { _searchQuery = v; _resetAiSearch(); }),
          style: ZineText.input(size: 15.5),
          cursorColor: Zine.blueInk,
          decoration: InputDecoration(
              hintText: 'Search messages',
              hintStyle: ZineText.input(size: 15.5).copyWith(
                  color: Zine.placeholder, fontWeight: FontWeight.w700),
              border: InputBorder.none),
        )),
      ]);

  void _pickWallpaper() {
    showModalBottomSheet(context: context, backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Chat wallpaper', style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 12),
          Wrap(spacing: 12, runSpacing: 12, children: [
            for (final id in kWallpaperOrder)
              GestureDetector(
                onTap: () async {
                  await WallpaperStore().set(_convKey!, id == 'default' ? '' : id);
                  if (mounted) { setState(() => _wallpaperId = id); Navigator.pop(ctx); }
                },
                child: Container(
                  width: 64, height: 64,
                  decoration: BoxDecoration(
                      gradient: wallpaperGradient(id), borderRadius: BorderRadius.circular(14),
                      border: Border.all(
                          color: _wallpaperId == id ? Zine.ink : Zine.inkMute,
                          width: _wallpaperId == id ? 3 : 2)),
                ),
              ),
          ]),
        ]))));
  }

  // ---- @mentions (groups) ----
  void _onInputChanged(String v) {
    setState(() => _hasText = v.trim().isNotEmpty);
    _onTyping();
    if (_isGroup) _updateMentions(v);
  }

  void _updateMentions(String v) {
    final m = RegExp(r'@(\w*)$').firstMatch(v);
    if (m == null) { if (_mentionMatches.isNotEmpty) setState(() => _mentionMatches = []); return; }
    final q = m.group(1)!.toLowerCase();
    final names = _memberNames.values.where((n) => n != 'You' && n.toLowerCase().contains(q)).toSet().toList();
    setState(() => _mentionMatches = names.take(6).toList());
  }

  void _insertMention(String name) {
    final v = _ctrl.text.replaceFirst(RegExp(r'@\w*$'), '@$name ');
    _ctrl.text = v;
    _ctrl.selection = TextSelection.collapsed(offset: v.length);
    setState(() { _mentionMatches = []; _hasText = v.trim().isNotEmpty; });
  }

  Widget _mentionBar() => Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(top: BorderSide(color: Zine.ink, width: 2)),
        ),
        constraints: const BoxConstraints(maxHeight: 160),
        child: ListView(shrinkWrap: true, children: [
          for (final n in _mentionMatches)
            ListTile(
              dense: true,
              leading: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                child: Avatar(seed: n, name: n, size: 32),
              ),
              title: Text(n, style: ZineText.value(size: 14)),
              onTap: () => _insertMention(n),
            ),
        ]),
      );

  /// Open the "Save to contacts" sheet for an unknown caller, prefilled with
  /// their number. On success the affordances disappear and the header repaints
  /// with the chosen name.
  Future<void> _saveUnknownContact({String source = 'thread_menu'}) async {
    if (_telPhone.isEmpty) return;
    final saved = await showSavePhoneContactSheet(context, phone: _telPhone, source: source);
    if (saved != null && mounted) {
      setState(() => _callerSaved = true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Saved ${saved.name}'),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  /// Dismissible banner shown atop an unknown-number thread inviting the owner
  /// to save the caller as a contact.
  Widget _saveContactBanner() => Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(bottom: BorderSide(color: Zine.ink, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 16, color: Zine.lilac),
          const SizedBox(width: 8),
          Expanded(child: Text('Unknown number · ${formatTelDisplay(_telPhone)}',
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.sub(size: 12.5, color: Zine.ink))),
          GestureDetector(
            onTap: () => _saveUnknownContact(source: 'thread_banner'),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: Text('Save', style: ZineText.tag(size: 11)),
            ),
          ),
          const SizedBox(width: 6),
          GestureDetector(onTap: () => setState(() => _saveBannerDismissed = true),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: Zine.inkSoft)),
          const SizedBox(width: 8),
        ]),
      );

  /// Read-only footer for an unknown-number voicemail thread.
  Widget _telFooter() => Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(top: BorderSide(color: Zine.ink, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(Icons.voicemail, size: 15, color: Zine.inkMute),
          const SizedBox(width: 8),
          Flexible(child: Text(
              _callerSaved
                  ? 'Voicemail record · this caller isn’t on AvaTOK'
                  : 'Voicemail record from an unknown number',
              style: ZineText.sub(size: 12.5, color: Zine.inkSoft))),
          if (!_callerSaved) ...[
            const SizedBox(width: 10),
            GestureDetector(
              onTap: () => _saveUnknownContact(source: 'thread_footer'),
              child: Text('Save contact', style: ZineText.tag(size: 12, color: Zine.blueInk)),
            ),
          ],
        ]),
      );

  Widget _pinBanner() => Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(bottom: BorderSide(color: Zine.ink, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.fill), size: 15, color: Zine.blueInk),
          const SizedBox(width: 8),
          Expanded(child: Text('Pinned: ${_pinned!['text'] ?? ''}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5, color: Zine.ink))),
          GestureDetector(onTap: _unpin,
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: Zine.inkSoft)),
          const SizedBox(width: 8),
        ]),
      );

  // When a guardian warning arrives, remember WHICH message it flagged (by the
  // shared created_at ms) so that incoming message gets painted red.
  void _noteGuardianFlag(String? special, Map<String, dynamic>? extra) {
    if (special != 'ava_private' || extra == null) return;
    final meta = extra['meta'];
    if (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) {
      final ts = meta['flagged_created_at'];
      if (ts is num && ts > 0) _flaggedTs.add(ts.toInt());
    }
  }

  // A guardian SAFETY ALERT (private warning Ava posts to the at-risk user).
  bool _isGuardianWarn(_Msg m) {
    if (m.special != 'ava_private') return false;
    final meta = m.extra?['meta'];
    return (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) ||
        m.extra?['source'] == 'guardian';
  }

  // RED bubble: white text, shield icon — used for the safety alert AND for an
  // incoming message Ava flagged. Deliberately self-contained so it never touches
  // the normal media/special bubble path.
  // Soft-deleted (by me) pill: "You deleted this message" + an Undo that restores
  // it in MY view only. The content lives on in `m` until I tap Undo (recover) or
  // leave it hidden. onRight for my own messages, left for received ones I hid.
  Widget _hiddenBubble(_Msg m) {
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: Zine.paper2,
          border: Border.all(color: Zine.ink.withValues(alpha: 0.35), width: 1.5),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), size: 14, color: Zine.inkSoft),
          const SizedBox(width: 6),
          Text('You deleted this message',
              style: ZineText.sub(size: 12.5, color: Zine.inkSoft)),
          const SizedBox(width: 12),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => _undoDelete(m),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), size: 13, color: Zine.blueInk),
              const SizedBox(width: 3),
              Text('UNDO', style: ZineText.tag(size: 11, color: Zine.blueInk)),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _redFlagBubble(_Msg m, String label) {
    return GestureDetector(
      onLongPress: () => _onBubbleLongPress(m),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: Zine.ink, width: 2),
            boxShadow: Zine.shadowXs,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 9.5,
                  fontWeight: FontWeight.w800, letterSpacing: 0.6)),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 3),
            Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
          ]),
        ),
      ),
    );
  }

  // ── F6: safety-flag bubble + tap-sheet ──────────────────────────────────────
  // The server posts {type:'safety_flag', conv, msg_id, category} to MY InboxDO;
  // SyncHub persists it (per-account, keyed by msg_id) and fans it out. Here the
  // flagged bubble renders red and, on tap/long-press, opens a sheet with the
  // category explanation + Block / Report / This is fine. The sender is NEVER
  // notified (block/report are one-sided; "This is fine" is a local dismiss).

  /// The active safety category for [m] (null ⇒ not flagged, or locally
  /// dismissed). Matches on the message's rumor id (evId), the flag's msg_id.
  String? _safetyCategoryFor(_Msg m) {
    final id = m.evId;
    if (id == null || id.isEmpty) return null;
    return _safetyFlaggedIds[id];
  }

  /// Plain-language explanation for a guardian category (kept generic so an
  /// unknown/new category still reads sensibly).
  String _safetyCategoryExplain(String category) {
    switch (category.toLowerCase()) {
      case 'grooming':
        return 'Ava spotted signs of grooming — an adult trying to build secret trust, '
            'move you off the app, or ask for private things. Please tell an adult you trust.';
      case 'scam':
      case 'fraud':
        return 'Ava thinks this may be a scam — an unexpected offer, a prize, or a request '
            'for money or codes. Never send money or personal details.';
      case 'sextortion':
      case 'csam':
      case 'sexual':
        return 'Ava flagged sexual or exploitative content. You do not have to reply. '
            'Block this person and tell an adult you trust — you are not in trouble.';
      case 'harassment':
      case 'bullying':
        return 'Ava flagged bullying or harassment. You can block or report this person, '
            'and it is okay to ask an adult for help.';
      case 'violence':
      case 'self_harm':
      case 'selfharm':
        return 'Ava flagged content about harm. If you or someone is in danger, please '
            'reach out to an adult you trust right away.';
      case 'spam':
        return 'Ava thinks this looks like spam or an unsolicited promo. You can ignore, '
            'block, or report it.';
      default:
        return 'Ava flagged this message as possibly unsafe. Trust your gut — you can block '
            'or report this person, or dismiss this if you know it is fine.';
    }
  }

  String _safetyCategoryLabel(String category) {
    final c = category.trim();
    if (c.isEmpty) return 'FLAGGED BY AVA';
    return '⚠ ${c.replaceAll('_', ' ').toUpperCase()} — FLAGGED BY AVA';
  }

  Widget _safetyFlagBubble(_Msg m, String category) {
    return GestureDetector(
      onTap: () => _openSafetySheet(m, category),
      onLongPress: () => _openSafetySheet(m, category),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: Zine.ink, width: 2),
            boxShadow: Zine.shadowXs,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Flexible(child: Text(_safetyCategoryLabel(category),
                  style: const TextStyle(color: Colors.white, fontSize: 9.5,
                      fontWeight: FontWeight.w800, letterSpacing: 0.5))),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 4),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
              const SizedBox(width: 8),
              Text('Tap for options', style: const TextStyle(color: Colors.white70, fontSize: 10,
                  fontWeight: FontWeight.w600)),
            ]),
          ]),
        ),
      ),
    );
  }

  /// Bottom sheet for a flagged message: category explanation + Block sender /
  /// Report / This is fine. The sender is never told about any of these.
  void _openSafetySheet(_Msg m, String category) {
    HapticFeedback.mediumImpact();
    Analytics.capture('safety_flag_sheet_opened', {'category': category, 'is_group': _isGroup});
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: Zine.coral, size: 40),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava flagged this message', style: ZineText.cardTitle(size: 18)),
                Text('From Ava — only you can see this', style: ZineText.sub(size: 11.5)),
              ])),
            ]),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: Zine.paper2,
                borderRadius: BorderRadius.circular(12),
                border: Zine.border,
              ),
              child: Text(_safetyCategoryExplain(category), style: ZineText.sub(size: 13.5)),
            ),
            const SizedBox(height: 16),
            ZineButton(
              label: 'Block sender',
              variant: ZineButtonVariant.coral,
              fullWidth: true,
              icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _blockSender(category); },
            ),
            const SizedBox(height: 8),
            ZineButton(
              label: 'Report',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _reportFlagged(m, category); },
            ),
            const SizedBox(height: 8),
            ZineButton(
              label: 'This is fine',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _dismissFlag(m, category); },
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _blockSender(String category) async {
    final uid = _peerNpub;
    if (uid == null || uid.isEmpty) {
      _toast('Couldn\'t identify the sender to block.');
      return;
    }
    Analytics.capture('safety_flag_block', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (block).
    Analytics.capture('guardian_warning_actioned', {'action': 'block', 'category': category, 'is_group': _isGroup});
    try {
      // Same `blocks` table the messaging gate reads — a block silently stops all
      // future sends from this uid. The sender is not notified.
      final res = await ApiAuth.postJson('$kApiBase/creators/$uid/block', const {});
      _toast(res.statusCode == 200 ? 'Blocked. They can no longer message you.'
                                   : 'Couldn\'t block right now — try again.');
    } catch (_) {
      _toast('Couldn\'t block right now — try again.');
    }
  }

  Future<void> _reportFlagged(_Msg m, String category) async {
    Analytics.capture('safety_flag_report', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (report).
    Analytics.capture('guardian_warning_actioned', {'action': 'report', 'category': category, 'is_group': _isGroup});
    final targetId = _peerNpub ?? _convKey ?? '';
    try {
      // Generic moderation report (POST /api/report {targetType,targetId,reason}).
      // Carry the flagged message id (msg_id) so moderation can locate the row.
      final res = await ApiAuth.postJson('$kApiBase/report', {
        'targetType': 'message',
        'targetId': targetId,
        'reason': 'safety_flag:$category',
        if (m.evId != null) 'msgId': m.evId,
      });
      _toast(res.statusCode == 200 ? 'Thanks — reported to our safety team.'
                                   : 'Couldn\'t send the report — try again.');
    } catch (_) {
      _toast('Couldn\'t send the report — try again.');
    }
  }

  /// "This is fine" — local dismiss. Persists the dismissal (so it stays hidden
  /// on reopen) and removes the red state now. NO network call — the sender is
  /// never notified.
  Future<void> _dismissFlag(_Msg m, String category) async {
    final id = m.evId;
    if (id == null || id.isEmpty) return;
    Analytics.capture('safety_flag_dismissed', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (dismiss = "This is fine").
    Analytics.capture('guardian_warning_actioned', {'action': 'dismiss', 'category': category, 'is_group': _isGroup});
    setState(() => _safetyFlaggedIds.remove(id));
    await _safetyStore.dismiss(id);
    // [G2] Also push the dismissal to the server so "This is fine" reaches my OTHER
    // devices and survives a reinstall (store-and-forward). Best-effort — the local
    // dismiss above already applied; a failed round-trip reconciles on the next sync.
    unawaited(GuardianPrefsClient.I.dismissFlag(id, conv: _serverConvId ?? ''));
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Widget _bubble(_Msg m) {
    // Ava "working…" chip (kind 'ava_status') — inline, not a bubble. A 'phase:end'
    // frame is the CLOSE signal (e.g. image done/failed) — it must collapse the
    // chip, not render as a stuck "generating…" placeholder.
    if (m.special == 'ava_status') {
      if ((m.extra?['phase'] ?? '').toString() == 'end') return const SizedBox.shrink();
      return _avaStatusChip(m);
    }
    // SOFT-DELETED (by me) — a slim "deleted" pill with an Undo so I can recover my
    // own data. The real content stays in `m` (hidden, not erased) until I confirm.
    if (m.hidden) return _hiddenBubble(m);
    // RED FLAGS — Ava's safety alert, and any incoming message Ava flagged as
    // unsafe. Both render red/white so the danger is obvious to the child.
    if (_isGuardianWarn(m)) return _redFlagBubble(m, 'AVA · SAFETY ALERT');
    // F6: a persisted `safety_flag` frame for THIS message (keyed by rumorId).
    // Tap / long-press opens the safety sheet (Block · Report · This is fine).
    // Kept ahead of the legacy _flaggedTs fallback so the newer, richer path wins;
    // the _flaggedTs path below still fires for older guardian-warning flags.
    final flagCat = _safetyCategoryFor(m);
    if (flagCat != null && !m.me && m.special == null && m.media == null && m.localBytes == null) {
      return _safetyFlagBubble(m, flagCat);
    }
    if (!m.me && m.special == null && m.media == null && m.localBytes == null && _flaggedTs.contains(m.ts)) {
      return _redFlagBubble(m, '⚠ FLAGGED BY AVA — DO NOT TRUST');
    }
    // [UI-BUBBLE-STICKER] Fully bubble-LESS sticker (Stream E follow-up). A
    // sticker rides the media pipeline tagged via `isStickerName`. WhatsApp-parity:
    // render StickerMediaView (160dp) with NO bubble chrome — no background, no
    // padding, no tail, no border — aligned to the sender side, with the timestamp
    // + read receipt in a small row BELOW the sticker (also side-aligned). Long-
    // press still opens the reaction/action sheet; tap opens the fullscreen viewer.
    if (isStickerName(m.media?.name ?? '')) {
      return _stickerBubbleLess(m);
    }
    final hasMedia = m.media != null || m.localBytes != null;
    // Ava bubbles always render on the LEFT (she is a participant, not "me"),
    // in a distinct feminine lilac fill — visually separate from my lime and
    // peers' card bubbles.
    final isAva = _isAvaBubble(m);
    // My OWN message that I sent TO Ava (private @ava question). Colour it the
    // same lilac as Ava's replies so a glance tells me "this is an Ava
    // conversation", never confused with a green message to a person.
    final toAva = m.me && m.aiLocal;
    final onRight = m.me && !isAva;
    // [UI-BUBBLE-2] "media IS the bubble": for a bare image/video (no caption,
    // no reply, no special kind) the media fills the bubble edge-to-edge and the
    // forwarded label + timestamp/status overlay ON the media (bottom-right scrim
    // + top-left label) instead of the normal below-bubble rows.
    final _mediaKind = m.media?.kind ??
        (m.localBytes != null ? MediaKind.image : null);
    final isPureMedia = m.special == null &&
        hasMedia &&
        m.replyTo == null &&
        _mediaCaptionOf(m).isEmpty &&
        !isStickerName(m.media?.name ?? '') && // stickers keep their own bubble-less path
        (_mediaKind == MediaKind.image || _mediaKind == MediaKind.video);
    final core = GestureDetector(
        // Phase 5: long-press / right-click → floating reaction pill anchored at
        // the touch point. Double-tap → quick ❤️ (toggle), like iMessage.
        onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
        // Double-tap → quick ❤️ (toggle). Disabled on media bubbles so the
        // single-tap "open image/video" stays instant (no double-tap wait).
        onDoubleTap: hasMedia
            ? null
            : () {
                Analytics.capture('chat_react_doubletap', const <String, Object>{});
                _react(m, '❤️');
              },
        child: Column(
          crossAxisAlignment: onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              // Visual media (image/video/file/pdf cards) hug the bubble edge with
              // a slim border. Resolve the kind via localBytes too, so a still-
              // uploading attachment (m.media == null) doesn't fall back to the
              // wide text padding — that was the broad white border on sent media.
              // Voice notes stay on the normal padding (they're an inline row).
              // [UI-BUBBLE-2] pure image/video = ZERO padding so the media reaches
              // the bubble edge (the media IS the bubble); other media keep the 3px
              // hug; text/voice keep the wide padding.
              padding: isPureMedia
                  ? EdgeInsets.zero
                  : (m.special == null &&
                          hasMedia &&
                          (m.media?.kind ??
                                  (m.localBytes != null ? MediaKind.image : MediaKind.file)) !=
                              MediaKind.audio)
                      ? const EdgeInsets.all(3)
                      : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              // Ava email-card and GenUI/A2UI bubbles need more room (the design
              // uses ~92%); everything else stays at the standard [UI-BUBBLE-1] 78%
              // (symmetric for incoming & outgoing — text sizes to content up to this).
              constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width *
                      (((m.extra?['emails'] is List && (m.extra!['emails'] as List).isNotEmpty) ||
                              m.extra?['a2ui'] is Map)
                          ? 0.92
                          : 0.78)),
              // Chat bubble (§7.14): 2.5px ink border, radius 16 with one
              // squared corner toward the sender; me = lime, them = card.
              decoration: BoxDecoration(
                // me = lime, Ava (or my message TO Ava) = lilac, a 1:1 peer = card,
                // and in GROUPS each sender gets their own stable tint so you can
                // tell at a glance who said what.
                color: (isAva || toAva)
                    ? Zine.lilac
                    : onRight
                        ? Zine.lime
                        : (widget.chat.group && m.senderLabel != null
                            ? _groupSenderTint(m.senderLabel!)
                            : Zine.card),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(onRight ? 16 : 4),
                  bottomRight: Radius.circular(onRight ? 4 : 16),
                ),
              ),
              // [UI-BUBBLE-2] clip edge-to-edge media to the bubble's rounded shape.
              clipBehavior: isPureMedia ? Clip.antiAlias : Clip.none,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Ava label — a small "AVA" tag on her bubbles. ava_private
                  // adds a "· private" hint so the recipient knows it is just
                  // for them (consent/disclosure, proposal §9).
                  if (isAva)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                            size: 11, color: Zine.ink),
                        const SizedBox(width: 4),
                        Text(
                            m.special == 'ava_private' ? 'AVA · PRIVATE' : 'AVA',
                            style: ZineText.tag(size: 9.5, color: Zine.ink)),
                      ]),
                    ),
                  // [UI-BUBBLE-2] For pure media the FORWARDED label overlays the
                  // media (top-left) instead of this inline row.
                  if (m.forwarded && !isPureMedia)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 1),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
                            size: 11, color: Zine.inkMute),
                        const SizedBox(width: 3),
                        Text('FORWARDED', style: ZineText.tag(size: 9, color: Zine.inkMute)),
                      ]),
                    ),
                  if (m.senderLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(m.senderLabel!.toUpperCase(),
                          style: ZineText.tag(size: 9.5, color: Zine.blueInk)),
                    ),
                  if (m.replyTo != null)
                    Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
                      decoration: BoxDecoration(
                          color: Zine.paper2,
                          border: const Border(left: BorderSide(color: Zine.blueInk, width: 3)),
                          borderRadius: BorderRadius.circular(6)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text((m.replyTo!['who'] ?? '').toString().toUpperCase(),
                            style: ZineText.tag(size: 9, color: Zine.blueInk)),
                        Text((m.replyTo!['preview'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: ZineText.sub(size: 11.5)),
                      ]),
                    ),
                  if (m.special != null) _specialContent(m)
                  else if (hasMedia) ...[
                    // [UI-BUBBLE-2] pure image/video → media fills edge-to-edge with
                    // the forwarded label + timestamp/status overlaid on it.
                    _mediaContent(m, overlayMeta: isPureMedia),
                    // WhatsApp-style caption: the attachment's own text, in the
                    // SAME bubble. A hairline divider above it separates the media
                    // area from the text area so the two read as distinct zones.
                    if (_mediaCaptionOf(m).isNotEmpty) ...[
                      // Full-bleed divider: negative horizontal margin (= the 3px
                      // media padding) pushes it flush to the bubble's inner edge,
                      // and a 2px ink rule clearly splits the media + text zones.
                      Container(
                        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
                        height: 2,
                        color: Zine.ink.withValues(alpha: 0.28),
                      ),
                      Padding(
                        padding: const EdgeInsets.only(top: 7, left: 5, right: 5),
                        child: Text(_mediaCaptionOf(m),
                            style: ZineText.sub(size: 13.5, color: Zine.ink)),
                      ),
                    ],
                    // Voice-note transcript / translation (viewer-only). Rendered
                    // below the waveform when the user long-pressed → Transcribe
                    // or Translate. Both are cached per message, per-account.
                    ..._voiceTranscriptBlock(m),
                  ]
                  else _textContent(m),
                  // [UI-BUBBLE-2] pure media carries its timestamp/status as an
                  // overlay scrim on the media itself, so skip this inline row.
                  if (!isPureMedia)
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2, right: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (m.starred) ...[
                        PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), size: 11, color: Zine.blueInk),
                        const SizedBox(width: 3),
                      ],
                      if (m.edited) ...[
                        Text('EDITED ', style: ZineText.tag(size: 9, color: Zine.inkMute)),
                      ],
                      // Mono timestamp (10px) — Phase 5: live relative age for
                      // recent messages ("now"/"2m"/"1h"), fixed HH:MM for older.
                      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
                          style: ZineText.tag(size: 10, color: Zine.inkSoft)),
                      if (m.expireAt != null) ...[
                        const SizedBox(width: 4),
                        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: Zine.inkSoft),
                      ],
                      // Delivery status (my 1:1 messages): tick + tiny caption —
                      // sending → "waiting to reach phone" (1 tick) → "delivered"
                      // (2 grey) → "read" (2 blue). Tap to retry when failed.
                      Builder(builder: (_) {
                        final st = _statusFor(m);
                        if (st == null) return const SizedBox.shrink();
                        final row = Row(mainAxisSize: MainAxisSize.min, children: [
                          const SizedBox(width: 4),
                          Icon(st.icon, size: 13, color: st.color),
                          const SizedBox(width: 3),
                          Text(st.label.toUpperCase(),
                              style: ZineText.tag(size: 8.5, color: st.color)),
                        ]);
                        if (!m.failed) return row;
                        return GestureDetector(
                          onTap: () {
                            if (m.localBytes != null) {
                              final kind = m.media?.kind ?? MediaKind.file;
                              _upload(m, m.localBytes!, kind, 'application/octet-stream', m.text);
                            } else if (_realMode && _dm != null && m.media == null && m.special == null) {
                              // Resend a failed text message; track the new wrap.
                              final newId = _dm!.send(jsonEncode({'t': 'text', 'body': m.text,
                                  if (m.replyTo != null) 'replyTo': m.replyTo, if (m.expireAt != null) 'exp': m.expireAt}));
                              setState(() { m.evId = newId; m.failed = false; m.sent = true; _seenEv.add(newId); });
                            }
                          },
                          child: row,
                        );
                      }),
                      if (m.uploading && _statusFor(m) == null) ...[
                        const SizedBox(width: 6),
                        const SizedBox(width: 10, height: 10,
                            child: CircularProgressIndicator(strokeWidth: 1.5, color: Zine.inkSoft)),
                      ],
                    ]),
                  ),
                ],
              ),
            ),
            // Phase 4: aggregate reaction chips (emoji + live count). Falls back to
            // a single sticker when there are no counts yet (legacy local-only tap).
            if (m.reactCounts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10, top: 1),
                child: Wrap(spacing: 4, children: [
                  for (final e in m.reactCounts.entries)
                    GestureDetector(
                      onTap: () => _react(m, e.key),
                      onLongPress: () => _showReactedBy(m), // Phase 5: who reacted
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                            color: m.reaction == e.key ? Zine.lime : Zine.card,
                            borderRadius: BorderRadius.circular(100),
                            border: Border.all(color: Zine.ink, width: 2),
                            boxShadow: Zine.shadowXs),
                        child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                            style: const TextStyle(fontSize: 13)),
                      ),
                    ),
                ]),
              )
            else if (m.reaction != null)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                // Reaction sticker — ink border + hard offset shadow, no blur.
                decoration: BoxDecoration(
                    color: Zine.card,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: Zine.shadowXs),
                child: Text(m.reaction!, style: const TextStyle(fontSize: 14)),
              ),
          ],
        ),
      );
    // My own bubbles: avatar circle on the RIGHT (my photo / initials).
    if (onRight) {
      return Padding(
        padding: const EdgeInsets.only(left: 28),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Flexible(child: core),
            const SizedBox(width: 6),
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 1.5),
              ),
              child: Avatar(
                seed: _myNpub ?? 'me',
                name: _myName ?? 'You',
                size: 30,
                avatarUrl: _myAvatarUrl.isEmpty ? null : _myAvatarUrl,
              ),
            ),
          ],
        ),
      );
    }
    // Incoming bubbles (a 1:1 peer, a group member, or Ava) get a tiny avatar
    // circle on the left so you can tell at a glance who said it.
    return Padding(
      padding: const EdgeInsets.only(right: 28),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          _bubbleAvatar(m, isAva),
          const SizedBox(width: 6),
          Flexible(child: core),
        ],
      ),
    );
  }

  // [UI-BUBBLE-STICKER] A sticker rendered with ZERO bubble chrome: just the
  // 160dp sticker aligned to the sender's side, with a slim timestamp + read-
  // receipt row underneath (WhatsApp-parity). Long-press → reaction/action sheet;
  // tap → fullscreen viewer once bytes are available.
  Widget _stickerBubbleLess(_Msg m) {
    final onRight = m.me && !_isAvaBubble(m);
    final st = _statusFor(m);
    // The sticker itself (decrypt on demand for received stickers).
    Widget sticker() {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          future: MediaService.downloadAndDecrypt(m.media!),
          builder: (c, snap) {
            if (snap.hasData) m.localBytes = snap.data; // cache decrypted bytes
            return snap.hasData
                ? StickerMediaView(bytes: snap.data!, mine: m.me)
                : const SizedBox(
                    width: kStickerRenderSize, height: kStickerRenderSize);
          },
        );
      }
      return const SizedBox(
          width: kStickerRenderSize, height: kStickerRenderSize);
    }

    // Timestamp + delivery-status row, mirroring the in-bubble meta row but with
    // no bubble surround. Aligned to the sender's side.
    final meta = Padding(
      padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (m.starred) ...[
          PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill),
              size: 11, color: Zine.blueInk),
          const SizedBox(width: 3),
        ],
        Text(m.ts != 0 ? _relTime(m.ts) : m.time,
            style: ZineText.tag(size: 10, color: Zine.inkSoft)),
        if (st != null) ...[
          const SizedBox(width: 4),
          Icon(st.icon, size: 13, color: st.color),
        ],
      ]),
    );

    final column = Column(
      crossAxisAlignment:
          onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
          onTap: () {
            final b = m.localBytes;
            if (b != null) _openImageBytes(b, mime: m.media?.contentType);
          },
          child: sticker(),
        ),
        meta,
        if (m.reactCounts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 8),
            child: Wrap(spacing: 4, children: [
              for (final e in m.reactCounts.entries)
                GestureDetector(
                  onTap: () => _react(m, e.key),
                  onLongPress: () => _showReactedBy(m),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                        color: m.reaction == e.key ? Zine.lime : Zine.card,
                        borderRadius: BorderRadius.circular(100),
                        border: Border.all(color: Zine.ink, width: 2),
                        boxShadow: Zine.shadowXs),
                    child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                        style: const TextStyle(fontSize: 13)),
                  ),
                ),
            ]),
          )
        else
          const SizedBox(height: 8),
      ],
    );

    // Align to the sender's side, matching the padding gutters used by the
    // normal bubble rows (so the sticker sits under the same margin).
    return Padding(
      padding: EdgeInsets.only(left: onRight ? 34 : 0, right: onRight ? 0 : 34),
      child: Align(
        alignment: onRight ? Alignment.centerRight : Alignment.centerLeft,
        child: column,
      ),
    );
  }

  // The tiny avatar shown beside an incoming bubble. Ava uses her sitewide
  // asset (with a lilac-sparkle fallback if the asset is missing); a 1:1 peer
  // uses the chat's avatar; a group member uses a per-sender seed.
  Widget _bubbleAvatar(_Msg m, bool isAva) {
    const s = 30.0;
    Widget inner;
    if (isAva) {
      inner = ClipOval(
        child: Image.asset(
          AvaId.avatarAsset,
          width: s, height: s, fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Container(
            width: s, height: s, color: Zine.lilac, alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                size: 15, color: Zine.ink),
          ),
        ),
      );
    } else if (widget.chat.group) {
      inner = Avatar(seed: m.senderLabel ?? 'peer', name: m.senderLabel ?? '?', size: s);
    } else {
      inner = Avatar(seed: widget.chat.seed, name: widget.chat.name, size: s,
          avatarUrl: widget.chat.avatarUrl.isEmpty ? null : widget.chat.avatarUrl);
    }
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: Zine.ink, width: 1.5),
      ),
      child: inner,
    );
  }

  // The caption to show under a media bubble — the instant local value (set on
  // send) or, for received/restored messages, whatever rode in the envelope.
  String _mediaCaptionOf(_Msg m) =>
      m.mediaCaption.isNotEmpty ? m.mediaCaption : (m.media?.caption ?? '');

  /// Below-the-waveform transcript + translation for a voice note (viewer-only).
  /// Styled like the inline text-translate rendering: a hairline rule then the
  /// text, with a small translate/transcript glyph + label. Empty for anything
  /// that hasn't been transcribed/translated yet, so it costs nothing until used.
  List<Widget> _voiceTranscriptBlock(_Msg m) {
    final transcript = (m.extra?['transcript'] as String?)?.trim();
    final translated = (m.extra?['transcript_translated'] as String?)?.trim();
    final tLang = (m.extra?['transcript_translated_lang'] as String?) ?? '';
    if ((transcript == null || transcript.isEmpty) &&
        (translated == null || translated.isEmpty)) {
      return const [];
    }
    Widget line(IconData icon, String label, String body) => Padding(
          padding: const EdgeInsets.only(top: 6, left: 5, right: 5),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 11, color: Zine.blueInk),
              const SizedBox(width: 4),
              Text(label, style: ZineText.tag(size: 9.5, color: Zine.blueInk)),
            ]),
            const SizedBox(height: 2),
            Text(body, style: ZineText.sub(size: 13.5, color: Zine.ink)),
          ]),
        );
    return [
      Container(
        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
        height: 2,
        color: Zine.ink.withValues(alpha: 0.28),
      ),
      if (transcript != null && transcript.isNotEmpty)
        line(PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'transcript', transcript),
      if (translated != null && translated.isNotEmpty)
        line(PhosphorIcons.translate(PhosphorIconsStyle.bold),
            tLang.isEmpty ? 'translated' : 'translated · $tLang', translated),
    ];
  }

  // Plain-text bubble content: links are tappable, and a YouTube link renders a
  // rich card with inline playback right inside the chat (no leaving the thread).
  Widget _textContent(_Msg m) {
    final style = ZineText.sub(size: 13.5, color: Zine.ink);
    final link = ChatLinkText(text: m.text, style: style);

    // STREAM G [GROUP-AI-3/5]: translated bubble → "show original" toggle. Wraps
    // the ORIGINAL child; does NOT alter Stream K geometry.
    final translated = m.extra?['translated'] as String?;
    if (translated != null && translated.trim().isNotEmpty) {
      // Translations suppress the preview card (the text is the point).
      return TranslatedText(original: link, translated: translated, translatedStyle: style);
    }

    // STREAM C [PREVIEW-3]: STRANGER GATE — while the thread's accept_state is
    // pending, render raw URL text only (never a card). Also honours the master
    // linkPreviewsEnabled flag ([PREVIEW-4]).
    final pending = _threadAcceptState == 'pending';
    if (pending || !RemoteConfig.linkPreviewsEnabled) return link;

    // Preferred path: render the card from the SENDER's compose-time envelope
    // preview (m.extra['preview']) — zero recipient fetch.
    final envPreview = LinkPreview.fromEnvelope(m.extra?['preview']);
    if (envPreview != null) {
      final card = buildLinkPreviewCard(envPreview, pending: pending);
      if (card != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && envPreview.isYouTube) {
            Analytics.capture('chat_youtube_card_shown', {'video_id': envPreview.videoId ?? ''});
          }
        });
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [link, const SizedBox(height: 6), card],
        );
      }
    }

    // Fallback (older messages / sender had no preview): keep the legacy inline
    // YouTube card so a bare youtube link still plays inline.
    final ytId = firstYouTubeId(m.text);
    if (ytId == null) return link;
    final ytUrl = urlSpans(m.text)
        .map((s) => s.url)
        .firstWhere((u) => firstYouTubeId(u) == ytId, orElse: () => 'https://youtu.be/$ytId');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Analytics.capture('chat_youtube_card_shown', {'video_id': ytId});
    });
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      link,
      const SizedBox(height: 6),
      YouTubeCard(videoId: ytId, url: ytUrl),
    ]);
  }

  /// [UI-BUBBLE-2] The overlay stack children for an edge-to-edge image/video:
  /// the "↪ Forwarded" label (top-left, when fwd:true) and the timestamp/status
  /// scrim (bottom-right). White-on-scrim so it reads over any image.
  List<Widget> _mediaMetaOverlays(_Msg m) {
    final st = _statusFor(m);
    final trailing = Row(mainAxisSize: MainAxisSize.min, children: [
      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
          style: ZineText.tag(size: 10, color: Colors.white)),
      if (m.expireAt != null) ...[
        const SizedBox(width: 4),
        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: Colors.white),
      ],
      if (st != null) ...[
        const SizedBox(width: 5),
        Icon(st.icon, size: 13, color: st.color == Zine.blueInk ? const Color(0xFF7EC8FF) : Colors.white),
      ],
    ]);
    return [
      if (m.forwarded) const MediaForwardedLabel(),
      MediaTimestampScrim(trailing: trailing),
    ];
  }

  Widget _mediaContent(_Msg m, {bool overlayMeta = false}) {
    // STREAM E: sticker media (tagged via stickerMediaName). Renders at a fixed
    // 160dp via StickerMediaView. NOTE: pure sticker messages are now intercepted
    // in _bubble() and rendered fully bubble-LESS via _stickerBubbleLess (no
    // background/padding/tail) — see [UI-BUBBLE-STICKER]. This branch is retained
    // as a defensive fallback for any sticker that reaches _mediaContent (e.g. a
    // sticker with a caption/reply that keeps the normal bubble).
    final stName = m.media?.name ?? '';
    if (isStickerName(stName)) {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          future: MediaService.downloadAndDecrypt(m.media!),
          builder: (c, snap) => snap.hasData
              ? StickerMediaView(bytes: snap.data!, mine: m.me)
              : const SizedBox(width: kStickerRenderSize, height: kStickerRenderSize),
        );
      }
    }
    final kind = m.media?.kind ??
        (m.localBytes != null ? MediaKind.image : MediaKind.file); // best guess pre-upload
    switch (kind) {
      case MediaKind.image:
        if (m.localBytes != null) {
          // [UI-BUBBLE-2] edge-to-edge, 78%-wide, ≤320dp, overlaid meta.
          if (overlayMeta) {
            return ChatImageCard(
              bytes: m.localBytes!,
              onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
              overlays: _mediaMetaOverlays(m),
            );
          }
          // Tap → full-screen, pinch-to-zoom viewer with an X to close (and a
          // Copy button). Long-press still opens the message action sheet.
          return GestureDetector(
            onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Image.memory(m.localBytes!, width: 220, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
            ),
          );
        }
        if (m.media != null) {
          // STREAM J (D17): auto-download off + no local bytes -> tap-to-download
          // placeholder instead of eagerly fetching. Tapping is a MANUAL fetch
          // (always allowed); it caches into m.localBytes and repaints the preview.
          if (!_mediaAutoFetch) {
            return MediaDownloadPlaceholder(
              key: ValueKey('imgph_${m.media!.id}'),
              media: m.media!,
              width: 220,
              height: 160,
              onFetched: (bytes) {
                if (!mounted) return;
                setState(() => m.localBytes = bytes);
              },
            );
          }
          return FutureBuilder<Uint8List>(
            future: MediaService.downloadAndDecrypt(m.media!),
            builder: (ctx, snap) {
              if (snap.hasData) {
                m.localBytes = snap.data; // cache decrypted bytes
                // [UI-BUBBLE-2] edge-to-edge, 78%-wide, ≤320dp, overlaid meta.
                if (overlayMeta) {
                  return ChatImageCard(
                    bytes: snap.data!,
                    onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                    overlays: _mediaMetaOverlays(m),
                  );
                }
                return GestureDetector(
                  onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: Image.memory(snap.data!, width: 220, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                  ),
                );
              }
              if (snap.hasError) return _fileChip(m, PhosphorIcons.imageBroken(PhosphorIconsStyle.bold), 'Photo');
              return Container(
                width: 220, height: 140, alignment: Alignment.center,
                child: const CircularProgressIndicator(strokeWidth: 2),
              );
            },
          );
        }
        return _fileChip(m, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photo');
      case MediaKind.audio:
        // STREAM J (D17): auto-download off + nothing cached -> small download
        // button. Tapping fetches (manual = allowed) and repaints into play control.
        if (!_mediaAutoFetch && m.localBytes == null && m.media != null) {
          return MediaDownloadPlaceholder(
            key: ValueKey('audioph_${m.media!.id}'),
            media: m.media!,
            compact: true,
            onFetched: (bytes) {
              if (!mounted) return;
              setState(() => m.localBytes = bytes);
            },
          );
        }
        // [UI-BUBBLE-3] rich voice-note bubble: large circular play, waveform,
        // live duration, and a 1x/1.5x/2x speed chip after play starts.
        return VoiceNoteBubble(
          key: ValueKey('voice_${m.media?.id ?? m.id}'),
          playing: _playingAudioId == m.id,
          speed: _audioSpeed,
          onRight: m.me && !_isAvaBubble(m),
          onPlayPause: () => _playAudio(m),
          onCycleSpeed: _cycleAudioSpeed,
        );
      case MediaKind.video:
        // Rich card: first-frame thumbnail + tap-to-play inline; the expand
        // glyph opens the fullscreen player. [UI-BUBBLE-2] when it's the whole
        // bubble, fill the width (≤78%, capped ~320dp by the card's 16:9) and
        // overlay the forwarded label + timestamp scrim.
        if (overlayMeta) {
          return LayoutBuilder(builder: (ctx, cons) {
            final w = cons.maxWidth.isFinite
                ? cons.maxWidth
                : MediaQuery.of(context).size.width * 0.78;
            return Stack(children: [
              ChatVideoCard(
                key: ValueKey('vid_${m.media?.id ?? m.id}'),
                media: m.media,
                localBytes: m.localBytes,
                width: w,
                autoFetch: _mediaAutoFetch,
                onFullscreen: () => _openVideo(m),
              ),
              ..._mediaMetaOverlays(m),
            ]);
          });
        }
        return ChatVideoCard(
          key: ValueKey('vid_${m.media?.id ?? m.id}'),
          media: m.media,
          localBytes: m.localBytes,
          width: 220,
          autoFetch: _mediaAutoFetch,
          onFullscreen: () => _openVideo(m),
        );
      case MediaKind.file:
        // Rich card: PDF first-page thumbnail, or a typed card (badge + name +
        // size) for any other file. Tap downloads/opens it.
        final fname = (m.media?.name.isNotEmpty == true)
            ? m.media!.name
            : m.text.replaceFirst('📎 ', '');
        // [UI-BUBBLE-2] full-width file row (no dead right space): fill the bubble
        // width so the filename can use the whole line, ellipsised.
        return LayoutBuilder(builder: (ctx, cons) {
          final w = cons.maxWidth.isFinite && cons.maxWidth > 0
              ? cons.maxWidth
              : MediaQuery.of(context).size.width * 0.78;
          final card = ChatFileCard(
            key: ValueKey('file_${m.media?.id ?? m.id}'),
            media: m.media,
            localBytes: m.localBytes,
            name: fname,
            mime: m.media?.contentType ?? '',
            size: m.media?.size ?? (m.localBytes?.length ?? 0),
            width: w,
            autoFetch: _mediaAutoFetch,
            onOpen: () => _openFile(m, fname),
          );
          // [CHAT-PDFVIEW-1] Overlay a spinner while the tap downloads/decrypts
          // so the bubble shows progress instead of appearing dead.
          if (!m.fileOpening) return card;
          return Stack(alignment: Alignment.center, children: [
            card,
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.18),
                    borderRadius: BorderRadius.circular(Zine.rSm)),
                child: const Center(
                    child: SizedBox(
                        width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2))),
              ),
            ),
          ]);
        });
    }
  }

  /// [CHAT-PDFVIEW-1] Open an attachment. Downloads + decrypts (or reuses cached
  /// bytes) with a bubble spinner, then routes PDFs/images to the in-app viewer
  /// (pinch-zoom, page indicator, share). Any other type goes to the OS open sheet
  /// with a CLEAR snackbar when no handler exists — replacing the old silent
  /// `launchUrl(external)` that "did nothing" when no app claimed the file.
  Future<void> _openFile(_Msg m, String name) async {
    if (m.fileOpening) return;
    Analytics.capture('chat_file_open', {
      'kind': 'file',
      'mime': m.media?.contentType ?? '',
    });
    setState(() => m.fileOpening = true);
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (!mounted) return;
      if (bytes == null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't load $name")));
        return;
      }
      m.localBytes = bytes;
      final mime = m.media?.contentType ?? '';
      if (FileViewerScreen.canView(mime, name)) {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => FileViewerScreen(bytes: bytes, name: name, mime: mime),
        ));
      } else {
        final ok = await openFileWithOs(bytes, name, mime);
        if (!ok && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("No app on this device can open $name — tap share to send it elsewhere.")));
        }
      }
    } catch (e) {
      AvaLog.I.log('media', 'open file failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't open $name")));
      }
    } finally {
      if (mounted) setState(() => m.fileOpening = false);
    }
  }

  Widget _fileChip(_Msg m, IconData icon, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: Zine.ink),
        const SizedBox(width: 8),
        Flexible(child: Text(label,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ZineText.value(size: 14))),
      ]);
}

/// AvaMarketplace deal card (special kind 'marketplace_deal'). Shows the agent
/// negotiation result + a play button for the 2-voice audio note. Colour-coded:
/// DEAL = green (go), IMPASSE = pale yellow (no-go). Audio streams from the
/// authed /api/marketplace/audio endpoint (the render is server-side, not E2E).
class _MarketplaceDealCard extends StatefulWidget {
  const _MarketplaceDealCard({required this.extra});
  final Map<String, dynamic> extra;
  @override
  State<_MarketplaceDealCard> createState() => _MarketplaceDealCardState();
}

class _MarketplaceDealCardState extends State<_MarketplaceDealCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _loading = false;
  bool _playing = false;
  bool _sharing = false;
  bool _expanded = false;
  Uint8List? _bytes; // cached downloaded audio (play + share reuse it)

  Map<String, dynamic> get _e => widget.extra;
  bool get _isDeal => _e['outcome'] == 'deal';
  String get _audioKey => (_e['audio_key'] ?? '').toString();
  bool get _isMp3 => _audioKey.toLowerCase().endsWith('.mp3');
  String get _mime => _isMp3 ? 'audio/mpeg' : 'audio/wav';

  @override
  void dispose() { _player.dispose(); super.dispose(); }

  /// Download the audio once and cache it (play + share both use it).
  Future<Uint8List?> _fetchBytes() async {
    if (_bytes != null) return _bytes;
    if (_audioKey.isEmpty) return null;
    final url = 'https://$kSignalingHost/api/marketplace/audio?key=${Uri.encodeQueryComponent(_audioKey)}';
    final r = await ApiAuth.getBytes(url);
    if (r.statusCode != 200 || r.bodyBytes.isEmpty) return null;
    _bytes = r.bodyBytes;
    return _bytes;
  }

  Future<void> _toggle() async {
    if (_playing) { await _player.stop(); if (mounted) setState(() => _playing = false); return; }
    if (_audioKey.isEmpty) return;
    setState(() => _loading = true);
    try {
      final b = await _fetchBytes();
      if (b == null) { if (mounted) setState(() => _loading = false); return; }
      _player.onPlayerComplete.listen((_) { if (mounted) setState(() => _playing = false); });
      await _player.play(BytesSource(b, mimeType: _mime));
      if (mounted) setState(() { _loading = false; _playing = true; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Save the voice note to a temp file and open the native share sheet, so the
  /// user can send it to WhatsApp / Telegram / anywhere.
  Future<void> _share() async {
    if (_audioKey.isEmpty || _sharing) return;
    setState(() => _sharing = true);
    try {
      final b = await _fetchBytes();
      if (b == null) { if (mounted) setState(() => _sharing = false); return; }
      final dir = await getTemporaryDirectory();
      final ext = _isMp3 ? 'mp3' : 'wav';
      final f = File('${dir.path}/negotiation_${DateTime.now().millisecondsSinceEpoch}.$ext');
      await f.writeAsBytes(b, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: _mime)],
          text: 'Voice conversation from my AvaTOK agents');
    } catch (_) {/* best-effort */} finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bg = _isDeal ? const Color(0xFFD7F5DD) : const Color(0xFFFFF6CC); // green / pale yellow
    final transcript = (_e['transcript'] as List?) ?? const [];
    final text = (_e['text'] ?? (_isDeal ? 'Your agents reached a deal.' : 'Your agents finished negotiating.')).toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: Zine.ink, width: 2),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text(_isDeal ? '🤝 Deal' : '💬 No deal',
              style: ZineText.tag(size: 12, color: Zine.ink)),
        ]),
        const SizedBox(height: 4),
        Text(text, style: ZineText.sub(size: 13, color: Zine.ink)),
        const SizedBox(height: 8),
        Row(children: [
          GestureDetector(
            onTap: _audioKey.isEmpty ? null : _toggle,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: _audioKey.isEmpty ? Zine.inkSoft : Zine.ink,
                borderRadius: BorderRadius.circular(100),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(_loading ? Icons.hourglass_top : _playing ? Icons.stop : Icons.play_arrow,
                    color: Colors.white, size: 18),
                const SizedBox(width: 6),
                Text(_audioKey.isEmpty ? 'No audio' : _playing ? 'Stop' : 'Play conversation',
                    style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
          if (_audioKey.isNotEmpty) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: _sharing ? null : _share,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: Zine.paper,
                  border: Border.all(color: Zine.ink, width: 1.5),
                  borderRadius: BorderRadius.circular(100),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_sharing ? Icons.hourglass_top : Icons.ios_share, color: Zine.ink, size: 16),
                  const SizedBox(width: 5),
                  const Text('Share', style: TextStyle(color: Colors.black, fontSize: 12, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ],
          const Spacer(),
          if (transcript.isNotEmpty)
            GestureDetector(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Text(_expanded ? 'Hide' : 'Transcript',
                  style: ZineText.tag(size: 12, color: Zine.inkSoft)),
            ),
        ]),
        if (_expanded && transcript.isNotEmpty) ...[
          const SizedBox(height: 8),
          ...transcript.whereType<Map>().map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text('${t['speaker'] ?? 'Agent'}: ${t['text'] ?? ''}',
                    style: ZineText.sub(size: 12, color: Zine.ink)),
              )),
        ],
      ]),
    );
  }
}

/// Ava Receptionist message card (special kind 'recept', v2). Renders inside a
/// chat bubble when Ava answered a call the owner missed: who called, the
/// AI summary, an expandable transcript and a play button for the voicemail
/// recording (streamed from /api/receptionist/recording, owner-authed).
/// Spec: Specs/PROPOSAL-RECEPTIONIST-V2.md §5.
class _ReceptionistCard extends StatefulWidget {
  const _ReceptionistCard({required this.extra, required this.sessionId});
  final Map<String, dynamic> extra;
  final String sessionId;
  @override
  State<_ReceptionistCard> createState() => _ReceptionistCardState();
}

class _ReceptionistCardState extends State<_ReceptionistCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _expanded = false;
  bool _loadingAudio = false;
  bool _playing = false;
  bool _saved = true; // assume saved until the contacts check says otherwise

  @override
  void initState() {
    super.initState();
    // Prefetch the voicemail into the per-account cache as soon as the card
    // renders, so tapping Play replays LOCAL bytes instantly instead of waiting
    // on a fresh owner-authed download — the "playing the message took too long"
    // complaint. Best-effort; _togglePlay still fetches on demand if this misses.
    // ignore: unawaited_futures
    _prefetch();
    _checkSaved();
  }

  /// The caller's E.164 number (if the card carries one).
  String get _phone => (_e['caller_phone'] ?? '').toString();

  /// Decide whether to offer "Save contact": only when we have a phone number
  /// and no real (named) contact yet exists for it.
  Future<void> _checkSaved() async {
    final p = _phone;
    if (p.isEmpty) return;
    final e164 = DeviceContactsService.normPhone(p);
    try {
      final cs = await ContactsStore().load();
      if (mounted) setState(() => _saved = callerIsSaved(cs, e164));
    } catch (_) {/* leave the button hidden on failure */}
  }

  Future<void> _save() async {
    final p = _phone;
    if (p.isEmpty) return;
    final saved = await showSavePhoneContactSheet(context, phone: p, source: 'recept_card');
    if (saved != null && mounted) setState(() => _saved = true);
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Map<String, dynamic> get _e => widget.extra;

  bool _sharing = false;

  /// Export the voicemail recording to the OS share sheet (WhatsApp, Files, …).
  /// Cache-first, mirroring playback, so a previously-played recording shares
  /// instantly. This is the "no option to share a voice recording" fix.
  Future<void> _shareRecording() async {
    if (_sharing) return;
    setState(() => _sharing = true);
    try {
      final cacheKey = 'recept_${widget.sessionId}';
      Uint8List? bytes = await MediaService.cachedBlob(cacheKey);
      if (bytes == null || bytes.isEmpty) {
        final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${widget.sessionId}';
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
          bytes = r.bodyBytes;
          await MediaService.writeBlob(cacheKey, bytes);
        }
      }
      if (bytes == null || bytes.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Couldn’t load the recording to share.')));
        }
        return;
      }
      final dir = await getTemporaryDirectory();
      final caller = (_e['caller'] ?? _e['caller_name'] ?? 'voicemail').toString()
          .replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
      final f = File('${dir.path}/ava_${caller}_${widget.sessionId}.wav');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'audio/wav')],
          subject: 'Voicemail from ${_e['caller'] ?? 'a caller'}');
      Analytics.capture('ava_recept_share', {'session_id': widget.sessionId, 'ok': true});
    } catch (e) {
      Analytics.capture('ava_recept_share', {'session_id': widget.sessionId, 'ok': false});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Couldn’t share the recording.')));
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  bool get _hasRecording =>
      _e['has_recording'] == true ||
      (_e['recording_url'] ?? '').toString().isNotEmpty;

  Future<void> _prefetch() async {
    final sid = widget.sessionId;
    if (sid.isEmpty || !_hasRecording) return;
    final cacheKey = 'recept_$sid';
    try {
      final cached = await MediaService.cachedBlob(cacheKey);
      if (cached != null && cached.isNotEmpty) return; // already on-device
      final t0 = DateTime.now().millisecondsSinceEpoch;
      final url = 'https://$kSignalingHost/api/receptionist/recording?sid=$sid';
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) return;
      await MediaService.writeBlob(cacheKey, r.bodyBytes); // best-effort
      Analytics.capture('ava_recept_recording_prefetched', {
        'session_id': sid,
        'bytes': r.bodyBytes.length,
        'fetch_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
    } catch (_) {/* on-demand fetch in _togglePlay is the fallback */}
  }

  String get _caller {
    final summary = _e['summary'];
    final name = (summary is Map ? summary['caller_name'] : null) ??
        _e['caller_name'] ?? _e['caller_phone'] ?? 'Unknown caller';
    return name.toString();
  }

  String get _reason {
    final summary = _e['summary'];
    if (summary is Map && (summary['reason'] ?? '').toString().trim().isNotEmpty) {
      return summary['reason'].toString();
    }
    return 'Left a message.';
  }

  String get _durationLabel {
    final s = (_e['duration_s'] as num?)?.toInt() ?? 0;
    if (s <= 0) return '';
    final m = s ~/ 60, sec = s % 60;
    return '${m}:${sec.toString().padLeft(2, '0')}';
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    if (widget.sessionId.isEmpty) return;
    setState(() => _loadingAudio = true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      // Cache-first: a voicemail recording never changes, so once fetched we
      // keep the bytes in the per-account media cache and replay locally instead
      // of re-downloading on every tap / chat reopen.
      final cacheKey = 'recept_${widget.sessionId}';
      Uint8List? bytes = await MediaService.cachedBlob(cacheKey);
      final fromCache = bytes != null && bytes.isNotEmpty;
      if (!fromCache) {
        final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${widget.sessionId}';
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
          Analytics.capture('ava_recept_playback', {
            'session_id': widget.sessionId, 'ok': false, 'cached': false,
            'status': r.statusCode,
            'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
          });
          if (mounted) setState(() => _loadingAudio = false);
          return;
        }
        bytes = r.bodyBytes;
        await MediaService.writeBlob(cacheKey, bytes); // best-effort
      }
      _player.onPlayerComplete.listen((_) {
        if (mounted) setState(() => _playing = false);
      });
      await _player.play(BytesSource(bytes, mimeType: 'audio/wav'));
      // Playback latency, split by cache vs network — the signal behind "the
      // message took too long to play". cached=true should be near-instant.
      Analytics.capture('ava_recept_playback', {
        'session_id': widget.sessionId, 'ok': true, 'cached': fromCache,
        'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      if (mounted) setState(() { _loadingAudio = false; _playing = true; });
    } catch (_) {
      Analytics.capture('ava_recept_playback', {
        'session_id': widget.sessionId, 'ok': false, 'cached': false,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      if (mounted) setState(() => _loadingAudio = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final transcript = (_e['transcript'] ?? '').toString().trim();
    final hasRec = _e['has_recording'] == true || (_e['recording_url'] ?? '').toString().isNotEmpty;
    final dur = _durationLabel;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.phone_callback, size: 18, color: Zine.lilac),
        const SizedBox(width: 6),
        Flexible(child: Text('$_caller called', style: ZineText.value(size: 14))),
      ]),
      const SizedBox(height: 2),
      Text('Ava took a message', style: ZineText.kicker(size: 10.5)),
      // Caller's phone number — always shown when present, even if Ava also
      // captured a name, so the owner can identify/return the call.
      if (_phone.isNotEmpty) ...[
        const SizedBox(height: 4),
        Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.phone, size: 13, color: Zine.inkSoft),
          const SizedBox(width: 5),
          Flexible(child: Text(formatTelDisplay(_phone),
              style: ZineText.tag(size: 12, color: Zine.inkSoft))),
        ]),
      ],
      const SizedBox(height: 6),
      Text(_reason, style: ZineText.sub(size: 13, color: Zine.ink)),
      const SizedBox(height: 8),
      // Unknown caller → offer to save them as a contact right from the card.
      if (_phone.isNotEmpty && !_saved) ...[
        GestureDetector(
          onTap: _save,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.person_add_alt, size: 15, color: Zine.ink),
              const SizedBox(width: 5),
              Text('Save contact', style: ZineText.tag(size: 11)),
            ]),
          ),
        ),
        const SizedBox(height: 8),
      ],
      Row(mainAxisSize: MainAxisSize.min, children: [
        if (hasRec)
          GestureDetector(
            onTap: _loadingAudio ? null : _togglePlay,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _loadingAudio
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(_playing ? Icons.stop : Icons.play_arrow, size: 16, color: Zine.ink),
                const SizedBox(width: 5),
                Text(_playing ? 'Stop' : 'Play recording', style: ZineText.tag(size: 11)),
              ]),
            ),
          ),
        if (hasRec && dur.isNotEmpty) ...[
          const SizedBox(width: 8),
          Text('⏱ $dur', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
        ],
        if (hasRec) ...[
          const SizedBox(width: 8),
          GestureDetector(
            onTap: _sharing ? null : _shareRecording,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _sharing
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(Icons.ios_share, size: 15, color: Zine.ink),
                const SizedBox(width: 4),
                Text('Share', style: ZineText.tag(size: 11)),
              ]),
            ),
          ),
        ],
      ]),
      if (transcript.isNotEmpty) ...[
        const SizedBox(height: 8),
        GestureDetector(
          onTap: () => setState(() => _expanded = !_expanded),
          child: Text(_expanded ? 'Hide transcript' : 'Show transcript',
              style: ZineText.tag(size: 11, color: Zine.blueInk)),
        ),
        if (_expanded) ...[
          const SizedBox(height: 4),
          Text(transcript, style: ZineText.sub(size: 12.5, color: Zine.inkSoft)),
        ],
      ],
    ]);
  }
}

/// Phase 4 (ABLY-R2): one active floating-emoji burst animation.
class _BurstFx {
  final int id;
  final String emoji;
  const _BurstFx({required this.id, required this.emoji});
}
