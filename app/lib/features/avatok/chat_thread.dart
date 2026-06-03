import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import 'call_screen.dart';
import 'data.dart';

/// AvaTok conversation thread with call buttons → CallScreen.
class ChatThreadScreen extends StatefulWidget {
  final Chat chat;
  const ChatThreadScreen({super.key, required this.chat});
  @override
  State<ChatThreadScreen> createState() => _ChatThreadScreenState();
}

class _Msg {
  final bool me;
  final String text;
  final String time;
  _Msg(this.me, this.text, this.time);
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _ctrl = TextEditingController();
  final _scroll = ScrollController();
  late final List<_Msg> _msgs = [
    _Msg(false, 'Hey! Are we still on for the shoot?', '13:20'),
    _Msg(true, 'Yes — 1:30 works great. Bringing the new presets.', '13:24'),
    _Msg(false, 'Sounds good — talk at 1:30 then 👋', '13:31'),
  ];

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    setState(() {
      _msgs.add(_Msg(true, t, 'now'));
      _ctrl.clear();
    });
    Future.delayed(const Duration(milliseconds: 1100), () {
      if (mounted) setState(() => _msgs.add(_Msg(false, 'got it 🙌', 'now')));
      _jump();
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
              padding: const EdgeInsets.symmetric(horizontal: 10),
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
                        Text(c.online ? 'Active now' : 'Offline',
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
                  IconButton(
                    icon: const Icon(Icons.videocam, color: AvaColors.ink),
                    onPressed: () => _call('video'),
                  ),
                ],
              ),
            ),
            // messages
            Expanded(
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.all(16),
                itemCount: _msgs.length,
                itemBuilder: (c, i) => _bubble(_msgs[i]),
              ),
            ),
            // input
            Container(
              color: Colors.white,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      decoration: BoxDecoration(
                          color: AvaColors.soft, borderRadius: BorderRadius.circular(22)),
                      child: TextField(
                        controller: _ctrl,
                        decoration: const InputDecoration(
                            hintText: 'Message', border: InputBorder.none, isDense: true,
                            contentPadding: EdgeInsets.symmetric(vertical: 12)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: _send,
                    child: Container(
                      width: 44, height: 44,
                      decoration: const BoxDecoration(color: AvaColors.brand, shape: BoxShape.circle),
                      child: const Icon(Icons.arrow_upward, color: Colors.white, size: 22),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bubble(_Msg m) {
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
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
        child: Text(m.text,
            style: TextStyle(
                color: m.me ? Colors.white : AvaColors.ink, fontSize: 14.5, height: 1.3)),
      ),
    );
  }
}
