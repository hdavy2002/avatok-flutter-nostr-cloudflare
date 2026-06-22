import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:record/record.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/ava_ai_client.dart';
import '../../core/composer_ai.dart';
import '../../core/ava_contracts.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_ondevice_stt.dart';
import '../../core/ui/mic_input_sheet.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/wallpaper.dart';
import '../../core/config.dart';
import '../../core/ice_cache.dart';
import '../../core/profile_store.dart';
import '../../core/drive_service.dart';
import '../../core/library_api.dart';
import '../../core/rag_service.dart';
import '../library/library_picker.dart';
import '../../core/ui/zine.dart';
import '../../core/group_store.dart';
import '../../core/message_store.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../core/db.dart';
import '../../sync/dm.dart';
import '../../sync/group_dm.dart';
import '../../sync/legacy_stubs.dart';
import '../../sync/presence.dart';
import '../../sync/sync_hub.dart';
import '../../push/push_service.dart';
import '../../core/remote_config.dart';
import '../ava/ava_invoke.dart';
import 'ava_email.dart';
import '../genui/a2ui_renderer.dart';
import '../../core/apps_service.dart';
import '../conference/conference_api.dart';
import '../conference/conference_screen.dart';
import '../../core/analytics.dart';
import '../../core/live_location_service.dart';
import 'call_screen.dart';
import 'contact_profile_screen.dart';
import 'contacts.dart';
import 'data.dart';
import 'live_location.dart';
import 'group_info_screen.dart';
import 'media.dart';
import 'media_library_screen.dart';
import 'video_player_screen.dart';

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
  ChatMedia? media;
  String mediaCaption; // caption shown UNDER the photo in the SAME bubble (WhatsApp-style)
  Uint8List? localBytes; // instant preview of self-sent media
  bool uploading;
  bool failed;
  bool sent; // relay ACKed this event (["OK", id, true]) — it's on the relay
  Map<String, dynamic>? replyTo; // {id, preview, who}
  bool edited;
  bool starred;
  bool forwarded;
  int? expireAt; // epoch secs after which the message disappears
  String? special; // 'loc' | 'card' | 'poll' | 'sticker'
  Map<String, dynamic>? extra;
  bool aiLocal; // a PRIVATE @ava question — local-only, never sent to the peer (no delivery ticks)
  Map<int, int> pollVotes = {}; // option index → count (local tally)
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.senderLabel, this.reaction, this.media, this.mediaCaption = '', this.localBytes,
       this.uploading = false, this.failed = false, this.sent = false, this.replyTo, this.edited = false,
       this.starred = false, this.forwarded = false, this.expireAt, this.special, this.extra,
       this.aiLocal = false});
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _ctrl = TextEditingController();
  final _composerFocus = FocusNode(); // keep the keyboard up after each send
  final _scroll = ScrollController();
  final _picker = ImagePicker();
  final _audio = AudioPlayer();
  final _sfx = AudioPlayer();
  final _recorder = AudioRecorder();
  final _idStore = IdentityStore();
  final _msgStore = MessageStore();
  Timer? _persistTimer;
  String? _myNpub;
  String? _myName;
  int _seq = 0;
  bool _hasText = false;
  bool _recording = false;
  String? _recPath;
  // Live voice-to-text (on-device Whisper) — types into the composer as you speak.
  SttSession? _sttSession;
  bool _sttActive = false;
  bool _sttPreparing = false; // model loading between tap and "Listening…"

  // Server-routed DM (Cloudflare-native transport) for contacts.
  AvaDm? _dm;
  AvaGroupDm? _gdm;
  Group? _group;
  bool _isGroup = false;
  NostrClient? _nostr;
  bool _realMode = false;
  final Set<String> _seenEv = {};
  int? _playingAudioId;

  // Presence: typing + read receipts (ephemeral, over the signaling WS).
  PresenceChannel? _presence;
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

  // Reply / edit / star.
  _Msg? _replyTo;
  _Msg? _editing;
  final _starStore = StarStore();
  Set<String> _starred = {};
  String? _peerNpub; // 1:1 recipient npub for message notifications
  List<String> _memberNpubs = []; // group recipient npubs (excl me)
  String? _convKey; // '1:<hex>' or 'g:<gid>' for read state / unread badges
  Identity? _meId;
  int _disappearSecs = 0; // per-chat disappearing timer (0 = off)
  int _peerDeliveredTs = 0;
  bool _peerOnline = false;
  bool _sharePresence = true;
  Timer? _onlineClear;
  Map<String, String>? _pinned; // {id, text}
  bool _searchMode = false;
  String _searchQuery = '';
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
    });
  }

  @override
  void initState() {
    super.initState();
    _audio.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playingAudioId = null);
    });
    _idStore.load().then((id) {
      if (!mounted || id == null) return;
      setState(() { _myNpub = id.npub; _myName = id.shortNpub; _meId = id; });
      _setupDm(id);
    });
    ProfileStore().load().then((p) {
      if (!mounted) return;
      setState(() { if (p.displayName.isNotEmpty) _myName = p.displayName; _sharePresence = p.sharePresence; });
    });
    _starStore.load().then((s) { if (mounted) setState(() => _starred = s); });
    // Restore the remembered translate target (account-scoped — a parent and a
    // child sharing the phone keep separate defaults).
    readScoped(_aiPrefs, _kTransLangKey).then((code) {
      if (mounted && code != null && code.isNotEmpty) {
        setState(() => _transLangCode = code);
      }
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
    final peerHex = NostrKeys.npubToHex(seed);
    if (peerHex == null) return; // demo contact → keep local echo
    _realMode = true;
    setState(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _dm = AvaDm(client: _nostr!, myPriv: id.uid, myPub: id.uid, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.sendStatus.listen(_onSendStatus);
    _dm!.start();
    _presence = PresenceChannel(PresenceChannel.roomFor1on1(id.uid, peerHex), id.shortNpub)..connect();
    _presence!.events.listen(_onPresence);
    _presence!.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    if (_sharePresence) _presence!.sendOnline();
    _peerNpub = seed; // contact npub, for message notifications
    _convKey = '1:$peerHex';
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
      for (final c in contacts) { final h = NostrKeys.npubToHex(c.npub); if (h != null) names[h] = c.name; }
      if (_meId != null) names[_meId!.uid] = 'You';
      if (mounted) setState(() => _memberNames = names);
    }
  }

  Future<void> _setupGroup(Identity id) async {
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    _realMode = true;
    _isGroup = true;
    _group = g;
    setState(() => _msgs.clear());
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _gdm = AvaGroupDm(client: _nostr!, myPriv: id.uid, myPub: id.uid, group: g);
    _gdm!.messages.listen(_onGroupMsg);
    _gdm!.start();
    _presence = PresenceChannel(PresenceChannel.roomForGroup(g.id), id.shortNpub)..connect();
    _presence!.events.listen(_onPresence);
    _memberNpubs = g.members.where((m) => m != id.uid).map((h) => NostrKeys.npub(h)).toList();
    _convKey = 'g:${g.id}';
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
    _markPeerOnline();
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
    if (!_peerOnline) setState(() => _peerOnline = true);
    _onlineClear?.cancel();
    _onlineClear = Timer(const Duration(seconds: 35), () { if (mounted) setState(() => _peerOnline = false); });
  }

  void _onTyping() {
    if (_presence == null) return;
    _presence!.sendTyping(true);
    _myTypingOff?.cancel();
    _myTypingOff = Timer(const Duration(seconds: 2), () => _presence?.sendTyping(false));
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
      if (env is Map && env['t'] == 'vote') { _applyVote(env['poll'].toString(), (env['opt'] as num).toInt()); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
      } else if (env is Map && env['t'] == 'gmedia') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
      } else if (env is Map && env['t'] == 'gtext') {
        text = (env['body'] ?? '').toString();
      } else {
        return; // ginfo/gkick etc. — not chat content
      }
      if (env is Map && env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final env2 = jsonDecode(m.payload) as Map;
    final exp = (env2['exp'] as num?)?.toInt();
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return; // already gone
    setState(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: env2['forwarded'] == true, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId),
          senderLabel: m.mine ? null : _shortPub(m.senderPub)));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Full-thread RAG: index a member's LIVE group text into my own store.
    // `_ragLive` gates out the history that replays on open (avoids re-indexing).
    if (!m.mine && _ragLive && special == null && media == null) {
      _ragAddLine(_shortPub(m.senderPub), text);
    }
    _jump();
    _markRead();
    _schedulePersist();
  }

  String _shortPub(String hex) => hex.length > 8 ? '${hex.substring(0, 6)}…' : hex;

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
      return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.inkSoft, label: 'Waiting to reach phone'); // 1 tick
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
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'receipt') { _applyReceipt(m.mine, env); return; } // status, never a bubble
      if (env is Map && env['t'] == 'read') return; // read high-water (badge clears via the chat list) — never a bubble
      if (env is Map && env['gid'] != null) return; // group message — not this 1:1
      if (env is Map && env['t'] == 'edit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env['poll'].toString(), (env['opt'] as num).toInt()); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
      } else if (env is Map && env['t'] == 'media') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        final keyShort = media.id.length > 12 ? media.id.substring(media.id.length - 8) : media.id;
        AvaLog.I.log('media', 'recv dm media kind=${media.kind.name} ${media.size}B key=…$keyShort mine=${m.mine}');
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
      } else if (env is Map && env['t'] == 'text') {
        text = env['body'].toString();
      }
      if (env is Map) {
        if (env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
        forwarded = env['forwarded'] == true;
        exp = (env['exp'] as num?)?.toInt();
      }
    } catch (_) {/* legacy/plain text */}
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return;
    setState(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: forwarded, expireAt: exp, special: special, extra: extra,
          sent: m.mine, // my own messages reaching here are already on the relay
          starred: _starred.contains(m.rumorId)));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
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
    final cached = await _msgStore.load(key);
    if (cached.isEmpty || !mounted) return;
    final loaded = <_Msg>[];
    for (final j in cached) {
      final ev = j['evId'] as String?;
      if (ev != null) {
        if (_seenEv.contains(ev)) continue;
        _seenEv.add(ev);
      }
      final ts = (j['ts'] as num?)?.toInt() ?? 0;
      // Media messages ARE cached now (the envelope/refs — never the bytes; the
      // decrypted bytes live in MediaService's on-disk cache). So on reopen the
      // image/voice bubble reappears instantly and loads local-first, instead of
      // waiting on a full relay re-sync + re-download.
      ChatMedia? media;
      final mj = j['media'];
      if (mj is Map) { try { media = ChatMedia.fromEnvelope(mj.cast<String, dynamic>()); } catch (_) {} }
      loaded.add(_Msg(
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
      ));
    }
    if (loaded.isEmpty || !mounted) return;
    setState(() {
      _msgs.addAll(loaded);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
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
      if (m.uploading || m.failed) continue; // in-flight/failed: not durable yet
      if (m.text.contains('"t":"receipt"')) continue; // never cache a stray receipt
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
      });
    }
    await _msgStore.save(key, out);
    // Keep the chat-list preview + ordering in sync with the latest line here,
    // for both messages I sent and ones I received while this thread was open.
    if (_msgs.isNotEmpty) {
      final last = _msgs.reduce((a, b) => b.ts >= a.ts ? b : a);
      final preview = last.text.isNotEmpty
          ? last.text
          : (last.media != null ? _caption(last.media!.kind, last.media!.name) : '');
      final ts = last.ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : last.ts;
      if (preview.isNotEmpty) await ChatPreviewStore().record(key, preview, ts, last.me);
    }
  }

  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  final List<_Msg> _msgs = [];

  @override
  void dispose() {
    _localAvaSub?.cancel();
    _avaStreamSub?.cancel();
    _ctrl.dispose();
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
    _presence?.dispose();
    _typingClear?.cancel();
    _myTypingOff?.cancel();
    _onlineClear?.cancel();
    _confTimer?.cancel();
    _pruneTimer?.cancel();
    _persistTimer?.cancel();
    _markReadTimer?.cancel();
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
        // Ava-mode plain text carries no marker → prefix so AvaInvoke parses it
        // as a private @ava call.
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $t' : t);
      }
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

    if (_isGroup && _gdm != null) {
      final id = _gdm!.send(jsonEncode({
        't': 'gtext', 'gid': _group!.id, 'body': t,
        if (replyMeta != null) 'replyTo': replyMeta, if (expire != null) 'exp': expire,
      }));
      _seenEv.add(id);
      setState(() {
        _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, evId: id, replyTo: replyMeta, expireAt: expire));
        _ctrl.clear(); _hasText = false; _replyTo = null;
      });
      _jump();
      if (_convKey != null) DraftStore().set(_convKey!, '');
      _schedulePersist();
      PushService.notifyMessage(_memberNpubs, _myName ?? 'AvaTOK');
      return;
    }
    if (_realMode && _dm != null) {
      final id = _dm!.send(jsonEncode({
        't': 'text', 'body': t,
        if (replyMeta != null) 'replyTo': replyMeta, if (expire != null) 'exp': expire,
      }));
      _seenEv.add(id);
      setState(() {
        _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, evId: id, replyTo: replyMeta, expireAt: expire));
        _ctrl.clear(); _hasText = false; _replyTo = null;
      });
      _jump();
      if (_convKey != null) DraftStore().set(_convKey!, '');
      _schedulePersist();
      if (_peerNpub != null) PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK');
      return;
    }
    setState(() {
      _msgs.add(_Msg(_seq++, true, t, 'now', replyTo: replyMeta));
      _ctrl.clear(); _hasText = false; _replyTo = null;
    });
    _jump();
    _schedulePersist();
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
  Future<void> _call(String kind) async {
    // This path is 1:1 P2P ONLY — group threads route through _groupCall()
    // (LiveKit) and must NEVER reach the CallRoom DO.
    if (widget.chat.group || widget.chat.gid != null) return;
    IceCache.prefetch(); // warm TURN creds in parallel with the FCM ring
    final video = kind == 'video';
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    final to = widget.chat.seed; // for real contacts this is their npub
    AvaLog.I.log('call', 'placing ${video ? "video" : "audio"} call callId=$room to=${to.length > 12 ? to.substring(0, 12) : to}…');
    // The callee's default ringtone (AI Ringback) — comes back on the /api/call
    // response so the caller hears it locally while ringing.
    String ringbackUrl = '';
    // Ring the callee's phone via FCM wake (real npub contacts only).
    if (to.startsWith('user_')) {
      try {
        // 'from' is derived server-side from the NIP-98 signature.
        final res = await ApiAuth.postJson(kCallUrl, {
          'to': to,
          'fromName': _myName ?? 'AvaTOK',
          'callId': room,
          'kind': video ? 'video' : 'audio',
        });
        AvaLog.I.log('call', 'POST /api/call -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');
        if (res.statusCode == 200) {
          try { ringbackUrl = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString(); } catch (_) {}
        }
        if (res.statusCode == 404 && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('They have no device registered yet — they need to open AvaTOK once')));
        }
      } catch (e) { AvaLog.I.log('call', 'POST /api/call FAILED: $e'); }
    } else {
      AvaLog.I.log('call', 'NOT ringing — contact seed is not an npub ($to)');
    }
    if (!mounted) return;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CallScreen(room: room, title: widget.chat.name, seed: to, video: video, avatarUrl: widget.chat.avatarUrl, ringbackUrl: ringbackUrl),
      ),
    );
  }

  // ---- group conferencing (Phase 10 — LiveKit, ≤25 participants) ----
  Timer? _confTimer;
  bool _confLive = false;
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
      // We're connected — count comes straight from the live room, no HTTP.
      final n = OngoingConference.active!.participantCount;
      if (mounted) setState(() { _confLive = true; _confCount = n; });
      return;
    }
    final s = await ConferenceApi.status(gid);
    if (mounted) setState(() { _confLive = s.live; _confCount = s.count; });
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

    try {
      final live = _confLive;
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
        _ => '',
      };

  void _notifyRecipients() {
    if (_isGroup) {
      PushService.notifyMessage(_memberNpubs, _myName ?? 'AvaTOK');
    } else if (_peerNpub != null) {
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK');
    }
  }

  void _sendSpecial(String type, Map<String, dynamic> data, String caption) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final payload = {'t': type, ...data, if (_isGroup) 'gid': _group!.id};
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

  void _applyVote(String pollId, int opt) {
    final i = _msgs.indexWhere((x) => x.special == 'poll' && x.extra?['id'] == pollId);
    if (i >= 0 && mounted) setState(() => _msgs[i].pollVotes[opt] = (_msgs[i].pollVotes[opt] ?? 0) + 1);
  }

  void _vote(_Msg poll, int opt) {
    final pollId = poll.extra?['id']?.toString() ?? '';
    setState(() => poll.pollVotes[opt] = (poll.pollVotes[opt] ?? 0) + 1);
    final payload = {'t': 'vote', 'poll': pollId, 'opt': opt, if (_isGroup) 'gid': _group!.id};
    if (_isGroup && _gdm != null) {
      _gdm!.send(jsonEncode(payload));
    } else if (_realMode && _dm != null) {
      _dm!.send(jsonEncode(payload));
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
                onTap: () { Navigator.pop(ctx); _sendSpecial('card', {'name': c.name, 'npub': c.npub, 'handle': c.handle}, '👤 ${c.name}'); }),
          ])),
        ]))));
  }

  Future<void> _createPoll() async {
    final q = TextEditingController();
    final opts = [TextEditingController(), TextEditingController(), TextEditingController()];
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Create poll'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: q, decoration: const InputDecoration(hintText: 'Question')),
        const SizedBox(height: 8),
        for (var i = 0; i < opts.length; i++)
          TextField(controller: opts[i], decoration: InputDecoration(hintText: 'Option ${i + 1}')),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
      ],
    ));
    if (ok != true) return;
    final options = opts.map((c) => c.text.trim()).where((t) => t.isNotEmpty).toList();
    if (q.text.trim().isEmpty || options.length < 2) return;
    _sendSpecial('poll', {'id': const Uuid().v4(), 'q': q.text.trim(), 'options': options}, '📊 ${q.text.trim()}');
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
            child: Avatar(seed: (e['npub'] ?? 'c').toString(), name: (e['name'] ?? '').toString(), size: 36),
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
        return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text((e['q'] ?? 'Poll').toString(), style: ZineText.value(size: 14)),
          const SizedBox(height: 6),
          for (var i = 0; i < options.length; i++)
            GestureDetector(onTap: () => _vote(m, i), child: Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                  color: Zine.card,
                  border: Border.all(color: Zine.ink, width: 2),
                  borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                Expanded(child: Text(options[i], style: ZineText.sub(size: 13, color: fg))),
                Text('${m.pollVotes[i] ?? 0}', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
              ]),
            )),
        ]);
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

  /// The inline "Ava is working…" chip row (kind 'ava_status'). Not a normal
  /// bubble — a subtle lilac pill with a tiny spinner. Generic: any phase that
  /// posts an 'ava_status' frame gets this with no extra UI work.
  Widget _avaStatusChip(_Msg m) {
    final label = (m.extra?['label'] ?? m.text).toString();
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

  Future<void> _addSharedContact(Map e) async {
    final npub = (e['npub'] ?? '').toString();
    if (!npub.startsWith('user_')) return;
    await ContactsStore().add(Contact(npub: npub, name: (e['name'] ?? 'Contact').toString(), handle: (e['handle'] ?? '').toString()));
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
    // Index shared docs/images into the user's own RAG store (File Search
    // supports text/PDF/Office/PNG/JPEG, not audio/video). Fire-and-forget.
    if (kind == MediaKind.image || kind == MediaKind.file) {
      // ignore: unawaited_futures
      RagService.I.ingestFileBytes(bytes, ct, name);
    }
    await _upload(msg, bytes, kind, ct, name, caption: caption);
  }

  Future<void> _upload(_Msg msg, Uint8List bytes, MediaKind kind, String ct, String name, {String caption = ''}) async {
    setState(() { msg.uploading = true; msg.failed = false; });
    try {
      final m = await MediaService.encryptAndUpload(bytes, kind: kind, contentType: ct, name: name, caption: caption);
      if (!mounted) return;
      setState(() { msg.media = m; msg.uploading = false; });
      final keyShort = m.id.length > 12 ? m.id.substring(m.id.length - 8) : m.id;
      // Deliver the media reference + key inside an encrypted DM / group fan-out.
      if (_isGroup && _gdm != null) {
        final id = _gdm!.send(jsonEncode({...m.toEnvelope(), 't': 'gmedia', 'gid': _group!.id}));
        msg.evId = id;
        _seenEv.add(id);
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
  Future<void> _sendImageWithCaption(Uint8List bytes, String ct, String name) async {
    final caption = await _captionSheet(bytes);
    if (caption == null) return; // user backed out
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

  // Bottom sheet: image preview + a caption field. Returns the caption (possibly
  // empty → send with no caption) or null if dismissed without sending.
  Future<String?> _captionSheet(Uint8List bytes) {
    final cap = TextEditingController();
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
                fit: BoxFit.cover),
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
    var skipped = 0;
    for (final x in take) {
      final bytes = await x.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { skipped++; continue; }
      await _sendMedia(MediaKind.image, bytes, 'image/jpeg', x.name);
    }
    if (skipped > 0) _capNote('$skipped photo(s) skipped — over the 25 MB limit.');
  }

  Future<void> _pickVideo(ImageSource source) async {
    // Recording auto-stops at the clip cap; gallery picks an existing clip.
    final x = await _picker.pickVideo(source: source, maxDuration: kVideoClipMax);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    if (bytes.length > _kMediaMaxBytes) { _capNote('Videos must be under 25 MB. Trim the clip and try again.'); return; }
    await _sendMedia(MediaKind.video, bytes, 'video/mp4', x.name);
  }

  Future<void> _pickFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    await _sendMedia(MediaKind.file, f.bytes!, 'application/octet-stream', f.name);
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
      if ((kind == MediaKind.image || kind == MediaKind.video) && bytes.length > _kMediaMaxBytes) {
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
      if (mounted) setState(() => _playingAudioId = m.id);
    } catch (e) {
      AvaLog.I.log('media', 'voice play failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't play this voice message")));
      }
    }
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

  // ---- bubble long-press actions ----
  void _onBubbleLongPress(_Msg m) {
    HapticFeedback.mediumImpact();
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            for (final e in ['❤️', '👍', '😂', '😮', '😢', '👏'])
              GestureDetector(
                onTap: () { Navigator.pop(ctx); _react(m, e); },
                child: Text(e, style: const TextStyle(fontSize: 28)),
              ),
          ]),
          const Divider(height: 24),
          _action(ctx, PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply', () => setState(() => _replyTo = m)),
          if (m.text.trim().isNotEmpty && m.special != 'ava_status')
            _action(ctx, PhosphorIcons.copy(PhosphorIconsStyle.bold),
                m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
          _action(ctx, PhosphorIcons.pushPin(PhosphorIconsStyle.bold), 'Pin message', () => _pinMessage(m)),
          _action(ctx, PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
              m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
          if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
            _action(ctx, PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
          _action(ctx, PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
          if (m.media != null)
            _action(ctx, PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), 'Save to my AvaTOK Drive', () => _saveMediaToDrive(m)),
          _action(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete for me', () => _deleteForMe(m)),
          _action(ctx, PhosphorIcons.trashSimple(PhosphorIconsStyle.bold), 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
        ]),
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
        builder: (_) => ContactProfileScreen(name: widget.chat.name, npub: widget.chat.seed, me: _meId)));
  }

  static const _reactionSounds = {
    '❤️': 'heart', '👍': 'like', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '👏': 'clap',
  };

  void _react(_Msg m, String emoji) {
    final adding = m.reaction != emoji;
    setState(() => m.reaction = adding ? emoji : null);
    HapticFeedback.lightImpact();
    if (adding) {
      final file = _reactionSounds[emoji];
      if (file != null) {
        _sfx.stop();
        _sfx.play(AssetSource('sounds/$file.wav'));
      }
    }
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

  void _deleteForMe(_Msg m) => setState(() => _msgs.removeWhere((x) => x.id == m.id));
  void _deleteForEveryone(_Msg m) => setState(() {
        m.text = 'You deleted this message';
        m.media = null; m.localBytes = null; m.reaction = null;
      });

  Future<void> _forward(_Msg m) async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Forward to', style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 8),
          if (contacts.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 20),
                child: Text('No contacts yet — add someone first', style: ZineText.sub()))
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 320),
              child: ListView(shrinkWrap: true, children: [
                for (final c in contacts)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Avatar(seed: c.seed, name: c.name, size: 40),
                    title: Text(c.name, style: ZineText.value(size: 15)),
                    onTap: () { Navigator.pop(ctx); _doForward(m, c); },
                  ),
              ]),
            ),
        ]),
      ),
    );
  }

  /// Really forward [m] to contact [c] over a one-off gift-wrap, flagged forwarded.
  Future<void> _doForward(_Msg m, Contact c) async {
    final id = _meId;
    final peerHex = NostrKeys.npubToHex(c.npub);
    if (id == null || peerHex == null) return;
    final payload = m.media != null
        ? {...m.media!.toEnvelope(), 'forwarded': true}
        : {'t': 'text', 'body': m.text, 'forwarded': true};
    try {
      // Cloudflare-native: forward = one-off send to the peer's InboxDO over HTTP.
      await ApiAuth.postJson(kMsgSendUrl, {
        'to': peerHex, 'kind': 'text', 'body': jsonEncode(payload),
        'client_id': 'fwd_${DateTime.now().millisecondsSinceEpoch}',
      });
      PushService.notifyMessage([c.npub], _myName ?? 'AvaTOK');
    } catch (_) {}
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
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
          _action(ctx, PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), 'Search',
              () { Navigator.pop(ctx); setState(() { _searchMode = true; _searchQuery = ''; }); }),
          _action(ctx, PhosphorIcons.images(PhosphorIconsStyle.bold), 'Media, links & docs',
              () { Navigator.pop(ctx); _openMediaLibrary(); }),
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

  // ---- attach menu (+) ----
  void _attach() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photos', Zine.accents[0], _pickPhotos),
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
      body: SafeArea(
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
              padding: const EdgeInsets.only(left: 4, right: 10),
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
                                  : (_peerOnline ? 'online' : 'tap for contact info'))).toUpperCase(),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 9,
                              color: (_peerTyping || _peerOnline)
                                  ? (_peerOnline && !_peerTyping ? Zine.mintInk : Zine.blueInk)
                                  : Zine.inkMute)),
                    ],
                  ),
                  ),
                ),
                IconButton(icon: PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
                    onPressed: () => setState(() { _searchMode = true; _searchQuery = ''; })),
                if (!c.group) ...[
                  IconButton(icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
                      onPressed: () => _call('voice')),
                  IconButton(icon: PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
                      onPressed: () => _call('video')),
                ] else if (RemoteConfig.conferenceEnabled) ...[
                  // Phase 10 RULE CHANGE: group conferences (LiveKit, ≤25).
                  // >25 members → greyed icons; tapping pops the limit notice.
                  IconButton(
                      icon: PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 20,
                          color: _confAllowed ? Zine.ink : Zine.inkMute),
                      onPressed: () => _confAllowed ? _groupCall(false) : _confLimitNotice(false)),
                  IconButton(
                      icon: PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), size: 20,
                          color: _confAllowed ? Zine.ink : Zine.inkMute),
                      onPressed: () => _confAllowed ? _groupCall(true) : _confLimitNotice(true)),
                  if (!_confAllowed)
                    IconButton(
                        icon: PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.bold), size: 18, color: Zine.inkMute),
                        onPressed: () => _confLimitNotice(true)),
                ],
                IconButton(icon: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
                    onPressed: _overflow),
              ]),
            ),
            if (_pinned != null) _pinBanner(),
            // Ongoing group conference (Phase 10) — joinable, not ringing.
            if (widget.chat.gid != null && _confLive && RemoteConfig.conferenceEnabled) _confBanner(),
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
                if (_searchMode && _searchQuery.isNotEmpty) {
                  final q = _searchQuery.toLowerCase();
                  visible = visible.where((m) => m.text.toLowerCase().contains(q)).toList();
                }
                return ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                  itemCount: visible.length,
                  itemBuilder: (c, i) => _bubble(visible[i]),
                );
              }),
              ),
            ),
            if (_mentionMatches.isNotEmpty) _mentionBar(),
            SafeArea(top: false, child: _inputBar()),
          ],
        ),
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
    return Container(
      decoration: bandDeco,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_replyTo != null || _editing != null) _replyBanner(),
        if (_sttActive) _listeningBanner(),
        _composerTools(),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 12, 10),
          // Bottom-align so the +, sparkle and send controls stay pinned to the
          // bottom as the multi-line field grows upward.
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        // Ava-mode toggle: flip to talk privately to Ava without typing @ava;
        // flip back to message the person. Highlights when ON.
        IconButton(
            tooltip: _avaMode ? 'Talking to Ava (tap to message ${widget.chat.name})' : 'Talk privately to Ava',
            icon: PhosphorIcon(PhosphorIcons.sparkle(_avaMode ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                color: _avaMode ? Zine.blueInk : Zine.ink, size: 24),
            onPressed: () {
              setState(() => _avaMode = !_avaMode);
              _composerFocus.requestFocus();
            }),
        IconButton(
            icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), color: Zine.ink, size: 26),
            onPressed: _attach),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
                color: _avaMode ? Zine.lilac : Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Zine.border),
            child: TextField(
              controller: _ctrl,
              focusNode: _composerFocus,
              onChanged: _onInputChanged,
              onSubmitted: (_) => _send(),
              // Auto-grow upward as the user types (1 line → max 5, then it
              // scrolls internally so the text always stays in view). Enter
              // still sends — the keyboard action button is wired to send.
              minLines: 1,
              maxLines: 5,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.send,
              style: ZineText.input(size: 15.5),
              cursorColor: Zine.blueInk,
              decoration: InputDecoration(
                  hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
                  hintStyle: ZineText.input(size: 15.5).copyWith(
                      color: Zine.placeholder, fontWeight: FontWeight.w600),
                  border: InputBorder.none, isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12)),
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
          _sendCircle(
              _hasText
                  ? PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill)
                  : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
              _hasText ? _send : _openMicMenu),
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
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: SizedBox(
        height: 34,
        child: ListView(
          scrollDirection: Axis.horizontal,
          physics: const BouncingScrollPhysics(),
          children: [
            _translateChip(),
            _toolChip(
              tool: 'grammar',
              icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
              label: 'Fix grammar',
              onTap: _runFixGrammar,
            ),
            _toolChip(
              tool: 'rewrite',
              icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
              label: 'Rewrite',
              onTap: _runRewrite,
            ),
            _toolChip(
              tool: 'reply_ideas',
              icon: PhosphorIcons.lightbulb(PhosphorIconsStyle.bold),
              label: 'Reply ideas',
              onTap: _runReplyIdeas,
            ),
          ],
        ),
      ),
    );
  }

  /// A single icon-only chip. The label is exposed via a tooltip (long-press)
  /// so the row stays compact and scannable. Shows a spinner in place of its
  /// icon while it's the active job; the rest of the row is greyed meanwhile.
  Widget _toolChip({
    required String tool,
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    final busy = _aiTool == tool;
    final dimmed = _aiBusy && !busy;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Opacity(
        opacity: dimmed ? 0.4 : 1,
        child: Tooltip(
          message: label,
          child: GestureDetector(
            onTap: _aiBusy ? null : onTap,
            child: Container(
              width: 34, height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: busy ? Zine.lime : Zine.card,
                shape: BoxShape.circle,
                border: Zine.border,
                boxShadow: Zine.shadowXs,
              ),
              child: busy
                  ? const SizedBox(
                      width: 14, height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink),
                    )
                  : PhosphorIcon(icon, size: 16, color: Zine.ink),
            ),
          ),
        ),
      ),
    );
  }

  /// Translate chip — split into two tap zones: the left runs a translation
  /// into the remembered language; the trailing language + caret opens the
  /// picker to change it.
  Widget _translateChip() {
    final busy = _aiTool == 'translate';
    final dimmed = _aiBusy && !busy;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Opacity(
        opacity: dimmed ? 0.4 : 1,
        child: Container(
          decoration: BoxDecoration(
            color: busy ? Zine.lime : Zine.card,
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
                  padding: const EdgeInsets.fromLTRB(11, 8, 9, 8),
                  child: busy
                      ? const SizedBox(
                          width: 14, height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink),
                        )
                      : PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                          size: 16, color: Zine.ink),
                ),
              ),
            ),
            GestureDetector(
              onTap: _aiBusy ? null : _pickTransLang,
              child: Container(
                padding: const EdgeInsets.fromLTRB(8, 6, 11, 6),
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
      ),
    );
  }

  /// Shared runner: flips the busy flags, fires the [call], reports failures,
  /// and returns the trimmed answer (or null on block/empty/error).
  Future<String?> _runAiTool(String tool, Future<AvaAnswer> Function() call,
      {Map<String, Object> props = const <String, Object>{}}) async {
    if (_aiBusy) return null;
    setState(() { _aiBusy = true; _aiTool = tool; });
    Analytics.capture('composer_ai_used', <String, Object>{
      'tool': tool, 'is_group': _isGroup, ...props,
    });
    try {
      final a = await call();
      if (!mounted) return null;
      if (a.blocked) {
        _toolHint(a.hitDailyCap
            ? 'Daily free AI limit reached — connect your own key in Settings for unlimited.'
            : 'Ava couldn’t help with that right now.');
        Analytics.capture('composer_ai_blocked',
            <String, Object>{'tool': tool, 'reason': a.reason ?? 'unknown'});
        return null;
      }
      final out = a.answer.trim();
      if (out.isEmpty) { _toolHint('Ava returned nothing — try again.'); return null; }
      Analytics.capture('composer_ai_ok',
          <String, Object>{'tool': tool, 'tier': a.tier ?? 'unknown'});
      return out;
    } catch (e) {
      if (mounted) _toolHint('Something went wrong. Check your connection.');
      Analytics.capture('composer_ai_error', {'tool': tool});
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
    final out = await _runAiTool('translate',
        () => ComposerAi.translate(text, _transLang.code),
        props: {'lang': _transLang.code});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runFixGrammar() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Fix grammar'); return; }
    final out = await _runAiTool('grammar', () => ComposerAi.fixGrammar(text));
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runRewrite() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a draft first, then tap Rewrite'); return; }
    final tone = await _pickRewriteTone();
    if (tone == null) return;
    final out = await _runAiTool('rewrite',
        () => ComposerAi.rewrite(text, tone.style), props: {'tone': tone.label});
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

  Future<ComposerTone?> _pickRewriteTone() {
    return showModalBottomSheet<ComposerTone>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
                  size: 20, color: Zine.ink),
              const SizedBox(width: 10),
              Text('Rewrite as…', style: ZineText.cardTitle(size: 18)),
            ]),
          ),
          for (final t in ComposerAi.tones)
            ListTile(
              title: Text(t.label, style: ZineText.value(size: 16)),
              onTap: () => Navigator.pop(ctx, t),
            ),
          const SizedBox(height: 8),
        ]),
      ),
    );
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
        const ctrl = {'read', 'delivered', 'typing', 'ack', 'receipt', 'seen'};
        return ctrl.contains(j['t']) || ctrl.contains(j['type']);
      }
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  Widget _searchBar() => Row(children: [
        IconButton(icon: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold), color: Zine.ink),
            onPressed: () => setState(() { _searchMode = false; _searchQuery = ''; })),
        Expanded(child: TextField(
          autofocus: true,
          onChanged: (v) => setState(() => _searchQuery = v),
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

  Widget _bubble(_Msg m) {
    // Ava "working…" chip (kind 'ava_status') — inline, not a bubble.
    if (m.special == 'ava_status') return _avaStatusChip(m);
    final hasMedia = m.media != null || m.localBytes != null;
    // Ava bubbles always render on the LEFT (she is a participant, not "me"),
    // in a distinct feminine lilac fill — visually separate from my lime and
    // peers' card bubbles.
    final isAva = _isAvaBubble(m);
    final onRight = m.me && !isAva;
    return Align(
      alignment: onRight ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => _onBubbleLongPress(m),
        child: Column(
          crossAxisAlignment: onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              padding: hasMedia && (m.media?.kind == MediaKind.image)
                  ? const EdgeInsets.all(4)
                  : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              // Ava email-card and GenUI/A2UI bubbles need more room (the design
              // uses ~92%); everything else stays at the standard 76%.
              constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width *
                      (((m.extra?['emails'] is List && (m.extra!['emails'] as List).isNotEmpty) ||
                              m.extra?['a2ui'] is Map)
                          ? 0.92
                          : 0.76)),
              // Chat bubble (§7.14): 2.5px ink border, radius 16 with one
              // squared corner toward the sender; me = lime, them = card.
              decoration: BoxDecoration(
                // me = lime, Ava = lilac (feminine accent), them = card.
                color: isAva ? Zine.lilac : (onRight ? Zine.lime : Zine.card),
                border: Zine.border,
                boxShadow: Zine.shadowXs,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(onRight ? 16 : 4),
                  bottomRight: Radius.circular(onRight ? 4 : 16),
                ),
              ),
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
                  if (m.forwarded)
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
                    _mediaContent(m),
                    // WhatsApp-style caption: the photo's own text, in the SAME
                    // bubble (no longer a separate message).
                    if (_mediaCaptionOf(m).isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6, left: 2, right: 2),
                        child: Text(_mediaCaptionOf(m),
                            style: ZineText.sub(size: 13.5, color: Zine.ink)),
                      ),
                  ]
                  else Text(m.text, style: ZineText.sub(size: 13.5, color: Zine.ink)),
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
                      // Mono timestamp (10px).
                      Text(m.time, style: ZineText.tag(size: 10, color: Zine.inkSoft)),
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
                              setState(() { m.evId = newId; m.failed = false; m.sent = false; _seenEv.add(newId); });
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
            if (m.reaction != null)
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
      ),
    );
  }

  // The caption to show under a media bubble — the instant local value (set on
  // send) or, for received/restored messages, whatever rode in the envelope.
  String _mediaCaptionOf(_Msg m) =>
      m.mediaCaption.isNotEmpty ? m.mediaCaption : (m.media?.caption ?? '');

  Widget _mediaContent(_Msg m) {
    final kind = m.media?.kind ??
        (m.localBytes != null ? MediaKind.image : MediaKind.file); // best guess pre-upload
    switch (kind) {
      case MediaKind.image:
        if (m.localBytes != null) {
          return ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Image.memory(m.localBytes!, width: 220, fit: BoxFit.cover),
          );
        }
        if (m.media != null) {
          return FutureBuilder<Uint8List>(
            future: MediaService.downloadAndDecrypt(m.media!),
            builder: (ctx, snap) {
              if (snap.hasData) {
                m.localBytes = snap.data; // cache decrypted bytes
                return ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: Image.memory(snap.data!, width: 220, fit: BoxFit.cover),
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
        final playing = _playingAudioId == m.id;
        return GestureDetector(
          onTap: () => _playAudio(m),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                playing
                    ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                    : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                color: Zine.ink, size: 30),
            const SizedBox(width: 8),
            Text('Voice message', style: ZineText.value(size: 14)),
          ]),
        );
      case MediaKind.video:
        return GestureDetector(onTap: () => _openVideo(m),
            child: _fileChip(m, PhosphorIcons.playCircle(PhosphorIconsStyle.fill), 'Video'));
      case MediaKind.file:
        return _fileChip(m, PhosphorIcons.file(PhosphorIconsStyle.bold), m.text.replaceFirst('📎 ', ''));
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

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Map<String, dynamic> get _e => widget.extra;

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
    try {
      final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${widget.sessionId}';
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
        if (mounted) setState(() => _loadingAudio = false);
        return;
      }
      _player.onPlayerComplete.listen((_) {
        if (mounted) setState(() => _playing = false);
      });
      await _player.play(BytesSource(r.bodyBytes, mimeType: 'audio/wav'));
      if (mounted) setState(() { _loadingAudio = false; _playing = true; });
    } catch (_) {
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
      const SizedBox(height: 6),
      Text(_reason, style: ZineText.sub(size: 13, color: Zine.ink)),
      const SizedBox(height: 8),
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
