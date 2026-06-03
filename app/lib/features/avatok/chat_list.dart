import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../avalive/live_screen.dart';
import '../onboarding/welcome_screen.dart';
import 'chat_thread.dart';
import 'data.dart';

/// AvaTok home — chat + calls list (the AvaChat "ChatList" design).
class ChatListScreen extends StatefulWidget {
  const ChatListScreen({super.key});
  @override
  State<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends State<ChatListScreen> {
  final _store = IdentityStore();
  Identity? _id;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    var id = await _store.load();
    id ??= await _store.createAndStore();
    if (mounted) setState(() => _id = id);
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
            const Divider(height: 28),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                    foregroundColor: AvaColors.danger,
                    side: const BorderSide(color: Color(0xFFE0E2E6)),
                    padding: const EdgeInsets.symmetric(vertical: 14)),
                onPressed: () {
                  Navigator.pop(ctx);
                  Navigator.pushAndRemoveUntil(context,
                      MaterialPageRoute(builder: (_) => const WelcomeScreen()), (_) => false);
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
    final online = kChats.where((c) => c.online).toList();
    return Scaffold(
      backgroundColor: Colors.white,
      floatingActionButton: FloatingActionButton(
        backgroundColor: AvaColors.danger,
        onPressed: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const LiveScreen())),
        child: const Icon(Icons.sensors, color: Colors.white),
      ),
      body: SafeArea(
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
                  _circleBtn(Icons.person_add_alt_1),
                  const SizedBox(width: 8),
                  _circleBtn(Icons.edit_outlined),
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
                  _activeAdd(),
                  for (final c in online) _activeAvatar(context, c),
                ],
              ),
            ),
            // chats
            Expanded(
              child: ListView.builder(
                itemCount: kChats.length,
                itemBuilder: (c, i) => _ChatRow(chat: kChats[i]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _circleBtn(IconData i) => Container(
        width: 36, height: 36,
        decoration: const BoxDecoration(color: AvaColors.soft, shape: BoxShape.circle),
        child: Icon(i, size: 18, color: AvaColors.ink),
      );

  Widget _activeAdd() => Padding(
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
      );

  Widget _activeAvatar(BuildContext context, Chat c) => Padding(
        padding: const EdgeInsets.only(right: 14),
        child: GestureDetector(
          onTap: () => Navigator.push(context,
              MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: c))),
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
  const _ChatRow({required this.chat});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat))),
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
                  Text(chat.name,
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5)),
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
