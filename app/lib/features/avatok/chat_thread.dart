import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

import '../../core/api_auth.dart';
import '../../core/avatar.dart';
import '../../core/chat_state.dart';
import '../../core/wallpaper.dart';
import '../../core/config.dart';
import '../../core/profile_store.dart';
import '../../core/theme.dart';
import '../../core/group_store.dart';
import '../../core/message_store.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/ava_dm.dart';
import '../../nostr/ava_group_dm.dart';
import '../../nostr/nip17.dart';
import '../../nostr/nostr_client.dart';
import '../../nostr/presence.dart';
import '../../push/push_service.dart';
import 'call_screen.dart';
import 'contact_profile_screen.dart';
import 'contacts.dart';
import 'data.dart';
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
  Uint8List? localBytes; // instant preview of self-sent media
  bool uploading;
  bool failed;
  Map<String, dynamic>? replyTo; // {id, preview, who}
  bool edited;
  bool starred;
  bool forwarded;
  int? expireAt; // epoch secs after which the message disappears
  String? special; // 'loc' | 'card' | 'poll' | 'sticker'
  Map<String, dynamic>? extra;
  Map<int, int> pollVotes = {}; // option index → count (local tally)
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.senderLabel, this.reaction, this.media, this.localBytes,
       this.uploading = false, this.failed = false, this.replyTo, this.edited = false,
       this.starred = false, this.forwarded = false, this.expireAt, this.special, this.extra});
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _ctrl = TextEditingController();
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

  // Real end-to-end DM (NIP-44 over the relay) for npub contacts.
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

  void _markRead() {
    if (_convKey != null) {
      ReadStateStore().setRead(_convKey!, DateTime.now().millisecondsSinceEpoch ~/ 1000);
    }
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
    _pruneTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (mounted && _msgs.any((m) => m.expireAt != null && m.expireAt! < nowS)) {
        setState(() => _msgs.removeWhere((m) => m.expireAt != null && m.expireAt! < nowS));
      }
    });
  }

  Timer? _pruneTimer;

  void _setupDm(Identity id) {
    if (widget.chat.gid != null) { _setupGroup(id); return; }
    if (widget.chat.group) return; // legacy local group
    final seed = widget.chat.seed;
    final peerHex = seed.startsWith('npub1') ? NostrKeys.npubToHex(seed) : null;
    if (peerHex == null) return; // demo contact → keep local echo
    _realMode = true;
    setState(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = NostrClient(kNostrRelayUrl);
    _dm = AvaDm(client: _nostr!, myPriv: id.privHex, myPub: id.pubHex, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.start();
    _presence = PresenceChannel(PresenceChannel.roomFor1on1(id.pubHex, peerHex), id.shortNpub)..connect();
    _presence!.events.listen(_onPresence);
    _presence!.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    if (_sharePresence) _presence!.sendOnline();
    _peerNpub = seed; // contact npub, for message notifications
    _convKey = '1:$peerHex';
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
      if (_meId != null) names[_meId!.pubHex] = 'You';
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
    _nostr = NostrClient(kNostrRelayUrl);
    _gdm = AvaGroupDm(client: _nostr!, myPriv: id.privHex, myPub: id.pubHex, group: g);
    _gdm!.messages.listen(_onGroupMsg);
    _gdm!.start();
    _presence = PresenceChannel(PresenceChannel.roomForGroup(g.id), id.shortNpub)..connect();
    _presence!.events.listen(_onPresence);
    _memberNpubs = g.members.where((m) => m != id.pubHex).map((h) => NostrKeys.npub(h)).toList();
    _convKey = 'g:${g.id}';
    _markRead();
    _loadChatExtras();
    _loadCachedMessages();
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
      if (env is Map && const ['loc', 'card', 'poll', 'sticker'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
      } else if (env is Map && env['t'] == 'gmedia') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
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
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: env2['forwarded'] == true, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId),
          senderLabel: m.mine ? null : _shortPub(m.senderPub)));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
    _markRead();
    _schedulePersist();
  }

  String _shortPub(String hex) => hex.length > 8 ? '${hex.substring(0, 6)}…' : hex;

  void _onDm(DmMessage m) {
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
      if (env is Map && env['gid'] != null) return; // group message — not this 1:1
      if (env is Map && env['t'] == 'edit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env['poll'].toString(), (env['opt'] as num).toInt()); return; }
      if (env is Map && const ['loc', 'card', 'poll', 'sticker'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
      } else if (env is Map && env['t'] == 'media') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
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
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: forwarded, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId)));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
    if (!m.mine) _presence?.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    _markRead();
    _schedulePersist();
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
      loaded.add(_Msg(
        _seq++, j['me'] == true, (j['text'] ?? '').toString(),
        _fmtTime(ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : ts),
        ts: ts, evId: ev,
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
      if (m.media != null) continue; // media bytes/refs not cached
      out.add({
        'me': m.me, 'text': m.text, 'ts': m.ts,
        if (m.evId != null) 'evId': m.evId,
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
  }

  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  final List<_Msg> _msgs = [];

  @override
  void dispose() {
    _ctrl.dispose();
    _scroll.dispose();
    _audio.dispose();
    _sfx.dispose();
    _recorder.dispose();
    if (_convKey != null) DraftStore().set(_convKey!, _ctrl.text.trim());
    _dm?.stop();
    _gdm?.stop();
    _presence?.dispose();
    _typingClear?.cancel();
    _myTypingOff?.cancel();
    _onlineClear?.cancel();
    _pruneTimer?.cancel();
    _persistTimer?.cancel();
    _persistNow(); // flush any pending message-cache write on exit
    _nostr?.dispose();
    super.dispose();
  }

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final expire = _disappearSecs > 0 ? now + _disappearSecs : null;

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

  // ---- calls (1:1 only; groups are messaging-only) ----
  Future<void> _call(String kind) async {
    final video = kind == 'video';
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    final to = widget.chat.seed; // for real contacts this is their npub
    // Ring the callee's phone via FCM wake (real npub contacts only).
    if (to.startsWith('npub1')) {
      try {
        // 'from' is derived server-side from the NIP-98 signature.
        final res = await ApiAuth.postJson(kCallUrl, {
          'to': to,
          'fromName': _myName ?? 'AvaTOK',
          'callId': room,
          'kind': video ? 'video' : 'audio',
        });
        if (res.statusCode == 404 && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('They have no device registered yet — they need to open AvaTOK once')));
        }
      } catch (_) {/* still open the call screen so caller can wait */}
    }
    if (!mounted) return;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CallScreen(room: room, title: widget.chat.name, seed: to, video: video),
      ),
    );
  }

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
        'card' => '👤 ${e['name'] ?? 'Contact'}',
        'poll' => '📊 ${e['q'] ?? 'Poll'}',
        'sticker' => (e['emoji'] ?? '🙂').toString(),
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

  Future<void> _shareContactCard() async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    showModalBottomSheet(context: context, backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Share a contact', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 8),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
            for (final c in contacts)
              ListTile(contentPadding: EdgeInsets.zero, leading: Avatar(seed: c.seed, name: c.name, size: 40),
                title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w700)),
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
    showModalBottomSheet(context: context, backgroundColor: Colors.white,
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
    final fg = m.me ? Colors.white : AvaColors.ink;
    switch (m.special) {
      case 'sticker':
        return Text((e['emoji'] ?? '🙂').toString(), style: const TextStyle(fontSize: 46));
      case 'loc':
        return GestureDetector(
          onTap: () => launchUrl(Uri.parse('https://maps.google.com/?q=${e['lat']},${e['lng']}'),
              mode: LaunchMode.externalApplication),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.location_on, color: m.me ? Colors.white : AvaColors.danger),
            const SizedBox(width: 6),
            Text('Location · open in Maps',
                style: TextStyle(color: m.me ? Colors.white : AvaColors.brand, fontWeight: FontWeight.w600)),
          ]),
        );
      case 'card':
        return Row(mainAxisSize: MainAxisSize.min, children: [
          Avatar(seed: (e['npub'] ?? 'c').toString(), name: (e['name'] ?? '').toString(), size: 36),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['name'] ?? 'Contact').toString(), style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
            GestureDetector(onTap: () => _addSharedContact(e),
                child: Text('Add contact', style: TextStyle(color: m.me ? Colors.white70 : AvaColors.brand, fontSize: 12))),
          ]),
        ]);
      case 'poll':
        final options = (e['options'] as List?)?.map((x) => x.toString()).toList() ?? [];
        return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text((e['q'] ?? 'Poll').toString(), style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          for (var i = 0; i < options.length; i++)
            GestureDetector(onTap: () => _vote(m, i), child: Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                  color: (m.me ? Colors.white : AvaColors.brand).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8)),
              child: Row(children: [
                Expanded(child: Text(options[i], style: TextStyle(color: fg))),
                Text('${m.pollVotes[i] ?? 0}', style: TextStyle(color: m.me ? Colors.white70 : AvaColors.sub, fontWeight: FontWeight.w700)),
              ]),
            )),
        ]);
      default:
        return Text(m.text, style: TextStyle(color: fg, fontSize: 14.5));
    }
  }

  Future<void> _addSharedContact(Map e) async {
    final npub = (e['npub'] ?? '').toString();
    if (!npub.startsWith('npub1')) return;
    await ContactsStore().add(Contact(npub: npub, name: (e['name'] ?? 'Contact').toString(), handle: (e['handle'] ?? '').toString()));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${e['name']} added')));
  }

  Future<void> _sendMedia(MediaKind kind, Uint8List bytes, String ct, String name) async {
    final msg = _Msg(_seq++, true, _caption(kind, name), 'now',
        localBytes: bytes, uploading: true);
    setState(() => _msgs.add(msg));
    _jump();
    await _upload(msg, bytes, kind, ct, name);
  }

  Future<void> _upload(_Msg msg, Uint8List bytes, MediaKind kind, String ct, String name) async {
    setState(() { msg.uploading = true; msg.failed = false; });
    try {
      final m = await MediaService.encryptAndUpload(bytes, kind: kind, contentType: ct, name: name);
      if (!mounted) return;
      setState(() { msg.media = m; msg.uploading = false; });
      // Deliver the media reference + key inside an encrypted DM / group fan-out.
      if (_isGroup && _gdm != null) {
        final id = _gdm!.send(jsonEncode({...m.toEnvelope(), 't': 'gmedia', 'gid': _group!.id}));
        msg.evId = id;
        _seenEv.add(id);
      } else if (_realMode && _dm != null) {
        final id = _dm!.send(jsonEncode(m.toEnvelope()));
        msg.evId = id;
        _seenEv.add(id);
      }
    } catch (_) {
      if (!mounted) return;
      setState(() { msg.uploading = false; msg.failed = true; });
    }
  }

  Future<void> _pickImage(ImageSource source) async {
    final x = await _picker.pickImage(source: source, imageQuality: 85);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    await _sendMedia(MediaKind.image, bytes, 'image/jpeg', x.name);
  }

  Future<void> _pickVideo(ImageSource source) async {
    // Recording auto-stops at the clip cap; gallery picks an existing clip.
    final x = await _picker.pickVideo(source: source, maxDuration: kVideoClipMax);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    await _sendMedia(MediaKind.video, bytes, 'video/mp4', x.name);
  }

  Future<void> _pickFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    await _sendMedia(MediaKind.file, f.bytes!, 'application/octet-stream', f.name);
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
      await _audio.play(BytesSource(bytes));
      if (mounted) setState(() => _playingAudioId = m.id);
    } catch (_) {/* ignore */}
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
      backgroundColor: Colors.white,
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
          _action(ctx, Icons.reply, 'Reply', () => setState(() => _replyTo = m)),
          _action(ctx, Icons.push_pin_outlined, 'Pin message', () => _pinMessage(m)),
          _action(ctx, m.starred ? Icons.star : Icons.star_border,
              m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
          if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
            _action(ctx, Icons.edit_outlined, 'Edit', () => _startEdit(m)),
          _action(ctx, Icons.forward, 'Forward', () => _forward(m)),
          _action(ctx, Icons.delete_outline, 'Delete for me', () => _deleteForMe(m)),
          _action(ctx, Icons.delete_forever, 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
        ]),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
      ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        leading: Icon(icon, color: danger ? AvaColors.danger : AvaColors.ink),
        title: Text(label,
            style: TextStyle(fontWeight: FontWeight.w600, color: danger ? AvaColors.danger : AvaColors.ink)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

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
    if (!widget.chat.seed.startsWith('npub1')) return;
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
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Forward to', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 8),
          if (contacts.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 20),
                child: Text('No contacts yet — add someone first', style: TextStyle(color: AvaColors.sub)))
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 320),
              child: ListView(shrinkWrap: true, children: [
                for (final c in contacts)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Avatar(seed: c.seed, name: c.name, size: 40),
                    title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w700)),
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
      final client = NostrClient(kNostrRelayUrl)..connect();
      final (gifts, _) = Nip17.wrapBoth(
          senderPriv: id.privHex, senderPub: id.pubHex, peerPub: peerHex, payload: jsonEncode(payload));
      for (final g in gifts) {
        client.publish(g);
      }
      Future.delayed(const Duration(seconds: 2), client.dispose);
      PushService.notifyMessage([c.npub], _myName ?? 'AvaTOK');
    } catch (_) {}
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
  }

  // ---- header overflow ----
  void _overflow() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          _action(ctx, Icons.search, 'Search',
              () { Navigator.pop(ctx); setState(() { _searchMode = true; _searchQuery = ''; }); }),
          _action(ctx, Icons.perm_media_outlined, 'Media, links & docs',
              () { Navigator.pop(ctx); _openMediaLibrary(); }),
          if (_convKey != null)
            _action(ctx, Icons.timer_outlined,
                _disappearSecs == 0 ? 'Disappearing messages' : 'Disappearing: ${_disappearLabel(_disappearSecs)}',
                _pickDisappear),
          if (_convKey != null)
            _action(ctx, Icons.wallpaper, 'Chat theme', _pickWallpaper),
          if (_convKey != null)
            _action(ctx, Icons.archive_outlined, 'Archive chat', () async {
              await ChatFlagsStore().toggle('archived', _convKey!);
              if (mounted) Navigator.pop(context);
            }),
          if (_convKey != null)
            _action(ctx, Icons.notifications_off_outlined, 'Mute chat',
                () => ChatFlagsStore().toggle('muted', _convKey!)),
          if (_convKey != null && !widget.chat.group)
            _action(ctx, Icons.block, 'Block user', () async {
              await ChatFlagsStore().toggle('blocked', _convKey!);
              if (mounted) Navigator.pop(context);
            }, danger: true),
          _action(ctx, Icons.delete_sweep_outlined, 'Delete chat', () => Navigator.pop(context)),
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
      context: context, backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Padding(padding: EdgeInsets.all(14),
            child: Text('Disappearing messages', style: TextStyle(fontWeight: FontWeight.w800))),
        for (final opt in [['Off', 0], ['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]])
          ListTile(
            title: Text(opt[0] as String),
            trailing: _disappearSecs == opt[1] ? const Icon(Icons.check, color: AvaColors.brand) : null,
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
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, Icons.photo_outlined, 'Photo', const Color(0xFF6C5CE7), () => _pickImage(ImageSource.gallery)),
            _attachItem(ctx, Icons.photo_camera_outlined, 'Camera', const Color(0xFF00B894), () => _pickImage(ImageSource.camera)),
            _attachItem(ctx, Icons.videocam_outlined, 'Video', const Color(0xFFE17055), () => _pickVideo(ImageSource.camera)),
            _attachItem(ctx, Icons.insert_drive_file_outlined, 'File', const Color(0xFF0984E3), _pickFile),
            _attachItem(ctx, Icons.location_on_outlined, 'Location', const Color(0xFFD63031), _shareLocation),
            _attachItem(ctx, Icons.person_outline, 'Contact', const Color(0xFF6C5CE7), _shareContactCard),
            _attachItem(ctx, Icons.poll_outlined, 'Poll', const Color(0xFF00B894), _createPoll),
            _attachItem(ctx, Icons.emoji_emotions_outlined, 'Sticker', const Color(0xFFFD9644), _stickerPicker),
          ]),
        ),
      ),
    );
  }

  Widget _attachItem(BuildContext ctx, IconData icon, String label, Color color, VoidCallback onTap) =>
      GestureDetector(
        onTap: () { Navigator.pop(ctx); onTap(); },
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Container(width: 56, height: 56,
                decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(18)),
                child: Icon(icon, color: color)),
            const SizedBox(height: 6),
            Text(label, style: const TextStyle(fontSize: 12, color: AvaColors.sub)),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final c = widget.chat;
    return Scaffold(
      backgroundColor: AvaColors.soft,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Container(
              height: 56,
              color: Colors.white,
              padding: const EdgeInsets.only(left: 4, right: 10),
              child: _searchMode ? _searchBar() : Row(children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left, size: 28, color: AvaColors.ink),
                  onPressed: () => Navigator.pop(context),
                ),
                Avatar(seed: c.seed, name: c.name, size: 38, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
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
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                      Text(
                          _peerTyping
                              ? (c.group ? '${_typingWho ?? "Someone"} is typing…' : 'typing…')
                              : (c.group ? '${c.members} members · tap to manage'
                                  : (_peerOnline ? 'online' : 'tap for contact info')),
                          style: TextStyle(fontSize: 11.5,
                              color: (_peerTyping || _peerOnline)
                                  ? (_peerOnline && !_peerTyping ? AvaColors.success : AvaColors.brand)
                                  : const Color(0xFF8A9099))),
                    ],
                  ),
                  ),
                ),
                IconButton(icon: const Icon(Icons.search, color: AvaColors.ink),
                    onPressed: () => setState(() { _searchMode = true; _searchQuery = ''; })),
                if (!c.group) ...[
                  IconButton(icon: const Icon(Icons.call, color: AvaColors.ink), onPressed: () => _call('voice')),
                  IconButton(icon: const Icon(Icons.videocam, color: AvaColors.ink), onPressed: () => _call('video')),
                ],
                IconButton(icon: const Icon(Icons.more_vert, color: AvaColors.ink), onPressed: _overflow),
              ]),
            ),
            if (_pinned != null) _pinBanner(),
            Expanded(
              child: DecoratedBox(
                decoration: BoxDecoration(gradient: wallpaperGradient(_wallpaperId)),
                child: Builder(builder: (_) {
                final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
                var visible = _msgs.where((m) => m.expireAt == null || m.expireAt! >= nowS).toList();
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

  Widget _inputBar() {
    if (_recording) {
      return Container(
        color: Colors.white,
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 10),
        child: Row(children: [
          const Icon(Icons.fiber_manual_record, color: AvaColors.danger, size: 16),
          const SizedBox(width: 8),
          const Expanded(child: Text('Recording… tap to send', style: TextStyle(color: AvaColors.ink))),
          GestureDetector(
            onTap: _toggleRecord,
            child: Container(width: 44, height: 44,
                decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle),
                child: const Icon(Icons.send, color: Colors.white, size: 20)),
          ),
        ]),
      );
    }
    return Container(
      color: Colors.white,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_replyTo != null || _editing != null) _replyBanner(),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 12, 10),
          child: Row(children: [
        IconButton(icon: const Icon(Icons.add_circle_outline, color: AvaColors.brand, size: 28), onPressed: _attach),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(22)),
            child: TextField(
              controller: _ctrl,
              onChanged: _onInputChanged,
              onSubmitted: (_) => _send(),
              decoration: const InputDecoration(
                  hintText: 'Message', border: InputBorder.none, isDense: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 12)),
            ),
          ),
        ),
        const SizedBox(width: 8),
        GestureDetector(
          onTap: _hasText ? _send : _toggleRecord,
          child: Container(width: 44, height: 44,
              decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle),
              child: Icon(_hasText ? Icons.arrow_upward : Icons.mic, color: Colors.white, size: 22)),
        ),
          ]),
        ),
      ]),
    );
  }

  Widget _replyBanner() {
    final isEdit = _editing != null;
    final preview = isEdit ? _editing!.text : (_replyTo?.text ?? '');
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
      child: Row(children: [
        Container(width: 3, height: 32, color: AvaColors.brand),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(isEdit ? 'Editing' : 'Replying to ${_replyTo!.me ? "yourself" : (_replyTo!.senderLabel ?? widget.chat.name)}',
                style: const TextStyle(color: AvaColors.brand, fontSize: 11.5, fontWeight: FontWeight.w700)),
            Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
          ]),
        ),
        IconButton(
          icon: const Icon(Icons.close, size: 18, color: AvaColors.sub),
          onPressed: () => setState(() {
            _replyTo = null;
            if (_editing != null) { _editing = null; _ctrl.clear(); _hasText = false; }
          }),
        ),
      ]),
    );
  }

  Widget _searchBar() => Row(children: [
        IconButton(icon: const Icon(Icons.arrow_back, color: AvaColors.ink),
            onPressed: () => setState(() { _searchMode = false; _searchQuery = ''; })),
        Expanded(child: TextField(
          autofocus: true,
          onChanged: (v) => setState(() => _searchQuery = v),
          decoration: const InputDecoration(hintText: 'Search messages', border: InputBorder.none),
        )),
      ]);

  void _pickWallpaper() {
    showModalBottomSheet(context: context, backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Chat wallpaper', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
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
                      border: Border.all(color: _wallpaperId == id ? AvaColors.brand : const Color(0xFFE0E2E6),
                          width: _wallpaperId == id ? 3 : 1)),
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
        color: Colors.white,
        constraints: const BoxConstraints(maxHeight: 160),
        child: ListView(shrinkWrap: true, children: [
          for (final n in _mentionMatches)
            ListTile(
              dense: true,
              leading: Avatar(seed: n, name: n, size: 32),
              title: Text(n, style: const TextStyle(fontWeight: FontWeight.w600)),
              onTap: () => _insertMention(n),
            ),
        ]),
      );

  Widget _pinBanner() => Container(
        color: const Color(0xFFFFF8E1),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          const Icon(Icons.push_pin, size: 15, color: Color(0xFFE6B800)),
          const SizedBox(width: 8),
          Expanded(child: Text('Pinned: ${_pinned!['text'] ?? ''}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: AvaColors.ink))),
          GestureDetector(onTap: _unpin, child: const Icon(Icons.close, size: 16, color: AvaColors.sub)),
          const SizedBox(width: 8),
        ]),
      );

  Widget _bubble(_Msg m) {
    final hasMedia = m.media != null || m.localBytes != null;
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => _onBubbleLongPress(m),
        child: Column(
          crossAxisAlignment: m.me ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              padding: hasMedia && (m.media?.kind == MediaKind.image)
                  ? const EdgeInsets.all(4)
                  : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.76),
              decoration: BoxDecoration(
                color: m.me ? AvaColors.brand : Colors.white,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(18),
                  topRight: const Radius.circular(18),
                  bottomLeft: Radius.circular(m.me ? 18 : 4),
                  bottomRight: Radius.circular(m.me ? 4 : 18),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (m.forwarded)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 1),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(Icons.shortcut, size: 12, color: m.me ? Colors.white70 : const Color(0xFF9AA1AC)),
                        const SizedBox(width: 3),
                        Text('Forwarded', style: TextStyle(fontSize: 10.5, fontStyle: FontStyle.italic,
                            color: m.me ? Colors.white70 : const Color(0xFF9AA1AC))),
                      ]),
                    ),
                  if (m.senderLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(m.senderLabel!,
                          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
                    ),
                  if (m.replyTo != null)
                    Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
                      decoration: BoxDecoration(
                          color: (m.me ? Colors.white : AvaColors.brand).withValues(alpha: 0.14),
                          border: Border(left: BorderSide(color: m.me ? Colors.white : AvaColors.brand, width: 3)),
                          borderRadius: BorderRadius.circular(6)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text((m.replyTo!['who'] ?? '').toString(),
                            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700,
                                color: m.me ? Colors.white : AvaColors.brand)),
                        Text((m.replyTo!['preview'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11.5, color: m.me ? Colors.white70 : AvaColors.sub)),
                      ]),
                    ),
                  if (m.special != null) _specialContent(m)
                  else if (hasMedia) _mediaContent(m)
                  else Text(m.text,
                      style: TextStyle(color: m.me ? Colors.white : AvaColors.ink, fontSize: 14.5, height: 1.3)),
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2, right: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (m.starred) ...[
                        Icon(Icons.star, size: 11, color: m.me ? Colors.white : const Color(0xFFE6B800)),
                        const SizedBox(width: 3),
                      ],
                      if (m.edited) ...[
                        Text('edited ', style: TextStyle(fontSize: 10, fontStyle: FontStyle.italic,
                            color: m.me ? Colors.white60 : const Color(0xFF9AA1AC))),
                      ],
                      Text(m.time,
                          style: TextStyle(fontSize: 10.5,
                              color: m.me ? Colors.white70 : const Color(0xFF9AA1AC))),
                      if (m.expireAt != null) ...[
                        const SizedBox(width: 4),
                        Icon(Icons.timer_outlined, size: 11, color: m.me ? Colors.white70 : const Color(0xFF9AA1AC)),
                      ],
                      if (m.me && _realMode && !_isGroup && m.ts > 0) ...[
                        const SizedBox(width: 4),
                        if (_peerReadTs > 0 && m.ts <= _peerReadTs)
                          const Icon(Icons.done_all, size: 13, color: Color(0xFF8BE9FD)) // read
                        else if (_peerDeliveredTs > 0 && m.ts <= _peerDeliveredTs)
                          const Icon(Icons.done_all, size: 13, color: Colors.white70)    // delivered
                        else
                          const Icon(Icons.done, size: 13, color: Colors.white70),       // sent
                      ],
                      if (m.uploading) ...[
                        const SizedBox(width: 6),
                        SizedBox(width: 10, height: 10,
                            child: CircularProgressIndicator(strokeWidth: 1.5,
                                color: m.me ? Colors.white70 : AvaColors.sub)),
                      ],
                      if (m.failed) ...[
                        const SizedBox(width: 8),
                        GestureDetector(
                          onTap: () {
                            if (m.localBytes != null) {
                              final kind = m.media?.kind ?? MediaKind.file;
                              _upload(m, m.localBytes!, kind, 'application/octet-stream', m.text);
                            }
                          },
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            Icon(Icons.refresh, size: 13, color: m.me ? Colors.white : AvaColors.danger),
                            Text(' Retry',
                                style: TextStyle(fontSize: 11,
                                    color: m.me ? Colors.white : AvaColors.danger,
                                    fontWeight: FontWeight.w700)),
                          ]),
                        ),
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
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12),
                    boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 6)]),
                child: Text(m.reaction!, style: const TextStyle(fontSize: 14)),
              ),
          ],
        ),
      ),
    );
  }

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
              if (snap.hasError) return _fileChip(m, Icons.broken_image, 'Photo');
              return Container(
                width: 220, height: 140, alignment: Alignment.center,
                child: const CircularProgressIndicator(strokeWidth: 2),
              );
            },
          );
        }
        return _fileChip(m, Icons.image, 'Photo');
      case MediaKind.audio:
        final playing = _playingAudioId == m.id;
        return GestureDetector(
          onTap: () => _playAudio(m),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(playing ? Icons.pause_circle_filled : Icons.play_circle_fill,
                color: m.me ? Colors.white : AvaColors.brand, size: 30),
            const SizedBox(width: 8),
            Text('Voice message',
                style: TextStyle(color: m.me ? Colors.white : AvaColors.ink, fontWeight: FontWeight.w600)),
          ]),
        );
      case MediaKind.video:
        return GestureDetector(onTap: () => _openVideo(m), child: _fileChip(m, Icons.play_circle_fill, 'Video'));
      case MediaKind.file:
        return _fileChip(m, Icons.insert_drive_file, m.text.replaceFirst('📎 ', ''));
    }
  }

  Widget _fileChip(_Msg m, IconData icon, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: m.me ? Colors.white : AvaColors.brand),
        const SizedBox(width: 8),
        Flexible(child: Text(label,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: TextStyle(color: m.me ? Colors.white : AvaColors.ink, fontWeight: FontWeight.w600))),
      ]);
}
