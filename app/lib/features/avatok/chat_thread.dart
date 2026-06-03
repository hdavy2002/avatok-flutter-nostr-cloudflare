import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import 'call_screen.dart';
import 'contacts.dart';
import 'data.dart';

/// AvaTok conversation thread — bubbles, call buttons, long-press reactions,
/// forward / delete, attach menu, and a ⋮ overflow (delete/archive/block).
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
  String? reaction;
  _Msg(this.id, this.me, this.text, this.time, {this.reaction});
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _ctrl = TextEditingController();
  final _scroll = ScrollController();
  int _seq = 0;
  bool _hasText = false;
  late final List<_Msg> _msgs = [
    _Msg(_seq++, false, 'Hi! ready for our 1:1 today?', '13:20'),
    _Msg(_seq++, true, 'Yes! just wrapped a shoot 🎬', '13:21'),
    _Msg(_seq++, false, 'Perfect. Want to hop on a quick call?', '13:22'),
    _Msg(_seq++, true, "Give me 2 mins and I'll call you 🙌", '13:23'),
    _Msg(_seq++, false, 'Sounds good — talk soon 👋', '13:24'),
  ];

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
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

  void _call(String kind) => Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CallScreen(
            room: 'avatok-${widget.chat.seed}',
            title: widget.chat.name,
            seed: widget.chat.seed,
            video: kind == 'video',
          ),
        ),
      );

  // ---- bubble long-press actions ----
  void _onBubbleLongPress(_Msg m) {
    HapticFeedback.mediumImpact();
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          // reactions row (emoji → reaction + sound)
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
          _action(ctx, Icons.delete_forever, 'Delete for everyone',
              () => _deleteForEveryone(m), danger: true),
        ]),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap,
          {bool danger = false}) =>
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, color: danger ? AvaColors.danger : AvaColors.ink),
        title: Text(label,
            style: TextStyle(
                fontWeight: FontWeight.w600,
                color: danger ? AvaColors.danger : AvaColors.ink)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

  void _react(_Msg m, String emoji) {
    setState(() => m.reaction = m.reaction == emoji ? null : emoji);
    // TODO(media-pass): play the matching reaction sound (👏 → clap, etc.).
    HapticFeedback.lightImpact();
  }

  void _deleteForMe(_Msg m) => setState(() => _msgs.removeWhere((x) => x.id == m.id));

  void _deleteForEveryone(_Msg m) => setState(() {
        m.text = 'You deleted this message';
        m.reaction = null;
      });

  Future<void> _forward(_Msg m) async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Forward to', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 8),
          if (contacts.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Text('No contacts yet — add someone first',
                  style: TextStyle(color: AvaColors.sub)),
            )
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
                      ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Forwarded to ${c.name}')));
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
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          _action(ctx, Icons.delete_sweep_outlined, 'Delete chat',
              () { Navigator.pop(context); }),
          _action(ctx, Icons.archive_outlined, 'Archive chat',
              () => ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Chat archived')))),
          _action(ctx, Icons.block, 'Block user',
              () => ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('${widget.chat.name} blocked'))),
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
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, Icons.photo_outlined, 'Photo', const Color(0xFF6C5CE7)),
            _attachItem(ctx, Icons.videocam_outlined, 'Video', const Color(0xFFE17055)),
            _attachItem(ctx, Icons.insert_drive_file_outlined, 'File', const Color(0xFF0984E3)),
            _attachItem(ctx, Icons.photo_camera_outlined, 'Camera', const Color(0xFF00B894)),
            _attachItem(ctx, Icons.mic_none, 'Voice clip', AvaColors.brand),
          ]),
        ),
      ),
    );
  }

  Widget _attachItem(BuildContext ctx, IconData icon, String label, Color color) => GestureDetector(
        onTap: () {
          Navigator.pop(ctx);
          ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Media sending arrives in the next pass')));
        },
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Container(width: 56, height: 56,
                decoration: BoxDecoration(color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(18)),
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
            // header
            Container(
              height: 56,
              color: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Row(
                children: [
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
                        Text(c.name,
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                        Text(c.group ? '${c.name} group' : (c.online ? 'Active now' : 'Offline'),
                            style: TextStyle(
                                fontSize: 11.5,
                                color: c.online ? AvaColors.success : const Color(0xFF8A9099))),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.call, color: AvaColors.ink),
                    onPressed: () => _call('voice'),
                  ),
                  if (!c.group)
                    IconButton(
                      icon: const Icon(Icons.videocam, color: AvaColors.ink),
                      onPressed: () => _call('video'),
                    ),
                  IconButton(
                    icon: const Icon(Icons.more_vert, color: AvaColors.ink),
                    onPressed: _overflow,
                  ),
                ],
              ),
            ),
            // messages
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

  Widget _inputBar() => Container(
        color: Colors.white,
        padding: const EdgeInsets.fromLTRB(8, 8, 12, 16),
        child: Row(
          children: [
            IconButton(
              icon: const Icon(Icons.add_circle_outline, color: AvaColors.brand, size: 28),
              onPressed: _attach,
            ),
            Expanded(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                decoration: BoxDecoration(
                    color: AvaColors.soft, borderRadius: BorderRadius.circular(22)),
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
              onTap: _hasText
                  ? _send
                  : () => ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Hold to record — voice messages arrive next pass'))),
              child: Container(
                width: 44, height: 44,
                decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle),
                child: Icon(_hasText ? Icons.arrow_upward : Icons.mic,
                    color: Colors.white, size: 22),
              ),
            ),
          ],
        ),
      );

  Widget _bubble(_Msg m) {
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => _onBubbleLongPress(m),
        child: Column(
          crossAxisAlignment: m.me ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
                  Text(m.text,
                      style: TextStyle(
                          color: m.me ? Colors.white : AvaColors.ink, fontSize: 14.5, height: 1.3)),
                  const SizedBox(height: 3),
                  Text(m.time,
                      style: TextStyle(
                          fontSize: 10.5,
                          color: m.me ? Colors.white70 : const Color(0xFF9AA1AC))),
                ],
              ),
            ),
            if (m.reaction != null)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 6)]),
                child: Text(m.reaction!, style: const TextStyle(fontSize: 14)),
              ),
          ],
        ),
      ),
    );
  }
}
