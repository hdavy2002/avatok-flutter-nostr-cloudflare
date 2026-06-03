/// AvaTok chat/contact model. Static now; backed by Nostr NIP-17 DMs + contacts later.
class Chat {
  final String name;
  final String seed;
  final String last;
  final String time;
  final int unread;
  final bool online;
  final bool group;
  final int members; // group size (0 for 1:1)
  const Chat({
    required this.name,
    required this.seed,
    required this.last,
    required this.time,
    this.unread = 0,
    this.online = false,
    this.group = false,
    this.members = 0,
  });
}

const kChats = <Chat>[
  Chat(name: 'Dr. Willow', seed: 'willow', last: 'Sounds good — talk at 1:30 then 👋', time: '13:31', unread: 2, online: true),
  Chat(name: 'Priya Sharma', seed: 'priya', last: 'the photos turned out amazing!', time: '12:05', online: true),
  Chat(name: 'Alex Chen', seed: 'alex', last: 'check this PR when you get a sec', time: '11:20', unread: 1),
  Chat(name: 'Maya Patel', seed: 'maya', last: "let's sync at 5pm tomorrow", time: '10:02', online: true),
  Chat(name: 'Design Team', seed: 'design', last: 'Lisa: new mockups are up 🎨', time: 'Yesterday', group: true),
  Chat(name: 'Arjun Mehta', seed: 'arjun', last: '🎙️ Voice message · 0:14', time: 'Yesterday'),
];

/// A deterministic gradient seed → color index for avatars.
int seedGradient(String seed) {
  var h = 0;
  for (final c in seed.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return h % 5;
}
