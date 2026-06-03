import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:uuid/uuid.dart';

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/profile_store.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../../identity/nostr_keys.dart';
import '../../nostr/ava_dm.dart';
import '../../nostr/nostr_client.dart';
import 'call_screen.dart';
import 'contacts.dart';
import 'data.dart';
import 'media.dart';
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
  String? reaction;
  ChatMedia? media;
  Uint8List? localBytes; // instant preview of self-sent media
  bool uploading;
  bool failed;
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.reaction, this.media, this.localBytes,
       this.uploading = false, this.failed = false});
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _ctrl = TextEditingController();
  final _scroll = ScrollController();
  final _picker = ImagePicker();
  final _audio = AudioPlayer();
  final _sfx = AudioPlayer();
  final _recorder = AudioRecorder();
  final _idStore = IdentityStore();
  String? _myNpub;
  String? _myName;
  int _seq = 0;
  bool _hasText = false;
  bool _recording = false;
  String? _recPath;

  // Real end-to-end DM (NIP-44 over the relay) for npub contacts.
  AvaDm? _dm;
  NostrClient? _nostr;
  bool _realMode = false;
  final Set<String> _seenEv = {};
  int? _playingAudioId;

  @override
  void initState() {
    super.initState();
    _audio.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playingAudioId = null);
    });
    _idStore.load().then((id) {
      if (!mounted || id == null) return;
      setState(() { _myNpub = id.npub; _myName = id.shortNpub; });
      _setupDm(id);
    });
    ProfileStore().load().then((p) {
      if (mounted && p.displayName.isNotEmpty) setState(() => _myName = p.displayName);
    });
  }

  void _setupDm(Identity id) {
    if (widget.chat.group) return; // group DM (NIP-104) is a later milestone
    final seed = widget.chat.seed;
    final peerHex = seed.startsWith('npub1') ? NostrKeys.npubToHex(seed) : null;
    if (peerHex == null) return; // demo contact → keep local echo
    _realMode = true;
    setState(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = NostrClient(kNostrRelayUrl);
    _dm = AvaDm(client: _nostr!, myPriv: id.privHex, myPub: id.pubHex, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.start();
  }

  void _onDm(DmMessage m) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    // Parse our envelope: {"t":"text","body":...} or {"t":"media",...}.
    String text = m.payload;
    ChatMedia? media;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'media') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
      } else if (env is Map && env['t'] == 'text') {
        text = env['body'].toString();
      }
    } catch (_) {/* legacy/plain text */}
    setState(() {
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
  }

  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  late final List<_Msg> _msgs = [
    _Msg(_seq++, false, 'Hi! ready for our 1:1 today?', '13:20'),
    _Msg(_seq++, true, 'Yes! just wrapped a shoot 🎬', '13:21'),
    _Msg(_seq++, false, 'Perfect. Want to hop on a quick call?', '13:22'),
    _Msg(_seq++, true, "Give me 2 mins and I'll call you 🙌", '13:23'),
    _Msg(_seq++, false, 'Sounds good — talk soon 👋', '13:24'),
  ];

  @override
  void dispose() {
    _ctrl.dispose();
    _scroll.dispose();
    _audio.dispose();
    _sfx.dispose();
    _recorder.dispose();
    _dm?.stop();
    _nostr?.dispose();
    super.dispose();
  }

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    if (_realMode && _dm != null) {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final id = _dm!.send(jsonEncode({'t': 'text', 'body': t})); // gift-wrap + publish
      _seenEv.add(id);
      setState(() {
        _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, evId: id));
        _ctrl.clear();
        _hasText = false;
      });
      _jump();
      return;
    }
    setState(() {
      _msgs.add(_Msg(_seq++, true, t, 'now'));
      _ctrl.clear();
      _hasText = false;
    });
    _jump();
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
        final res = await http.post(Uri.parse(kCallUrl),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'to': to,
              'from': _myNpub ?? '',
              'fromName': _myName ?? 'AvaTOK',
              'callId': room,
              'kind': video ? 'video' : 'audio',
            }));
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
      // Real contacts: deliver the media reference + key inside an encrypted DM.
      if (_realMode && _dm != null) {
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
          _action(ctx, Icons.forward, 'Forward', () => _forward(m)),
          _action(ctx, Icons.delete_outline, 'Delete for me', () => _deleteForMe(m)),
          _action(ctx, Icons.delete_forever, 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
        ]),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, color: danger ? AvaColors.danger : AvaColors.ink),
        title: Text(label,
            style: TextStyle(fontWeight: FontWeight.w600, color: danger ? AvaColors.danger : AvaColors.ink)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

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
                    onTap: () {
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
                    },
                  ),
              ]),
            ),
        ]),
      ),
    );
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
          _action(ctx, Icons.delete_sweep_outlined, 'Delete chat', () => Navigator.pop(context)),
          _action(ctx, Icons.archive_outlined, 'Archive chat',
              () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Chat archived')))),
          _action(ctx, Icons.block, 'Block user',
              () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${widget.chat.name} blocked'))),
              danger: true),
        ]),
      ),
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
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Row(children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left, size: 28, color: AvaColors.ink),
                  onPressed: () => Navigator.pop(context),
                ),
                Avatar(seed: c.seed, name: c.name, size: 38),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                      Text(c.group ? '${c.members} members' : (c.online ? 'Active now' : 'Offline'),
                          style: TextStyle(fontSize: 11.5,
                              color: c.online ? AvaColors.success : const Color(0xFF8A9099))),
                    ],
                  ),
                ),
                if (!c.group) ...[
                  IconButton(icon: const Icon(Icons.call, color: AvaColors.ink), onPressed: () => _call('voice')),
                  IconButton(icon: const Icon(Icons.videocam, color: AvaColors.ink), onPressed: () => _call('video')),
                ],
                IconButton(icon: const Icon(Icons.more_vert, color: AvaColors.ink), onPressed: _overflow),
              ]),
            ),
            Expanded(
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                itemCount: _msgs.length,
                itemBuilder: (c, i) => _bubble(_msgs[i]),
              ),
            ),
            _inputBar(),
          ],
        ),
      ),
    );
  }

  Widget _inputBar() {
    if (_recording) {
      return Container(
        color: Colors.white,
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 20),
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
      padding: const EdgeInsets.fromLTRB(8, 8, 12, 16),
      child: Row(children: [
        IconButton(icon: const Icon(Icons.add_circle_outline, color: AvaColors.brand, size: 28), onPressed: _attach),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(22)),
            child: TextField(
              controller: _ctrl,
              onChanged: (v) => setState(() => _hasText = v.trim().isNotEmpty),
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
    );
  }

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
                  if (hasMedia) _mediaContent(m),
                  if (!hasMedia)
                    Text(m.text,
                        style: TextStyle(color: m.me ? Colors.white : AvaColors.ink, fontSize: 14.5, height: 1.3)),
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2, right: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(m.time,
                          style: TextStyle(fontSize: 10.5,
                              color: m.me ? Colors.white70 : const Color(0xFF9AA1AC))),
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
