import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme.dart';
import '../../identity/identity.dart';
import '../tok/tok_home.dart';
import '../live/live_home.dart';

/// The AvaTalk launcher — one identity, many apps. AvaTok + AvaLive are live;
/// the rest are shown locked until their stages ship.
class HomeLauncher extends StatelessWidget {
  final Identity identity;
  const HomeLauncher({super.key, required this.identity});

  void _showProfile(BuildContext context) {
    bool revealed = false;
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Your identity', style: Theme.of(ctx).textTheme.titleLarge),
              const SizedBox(height: 16),
              const Text('Public key (npub)',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
              const SizedBox(height: 6),
              SelectableText(identity.npub,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              const SizedBox(height: 8),
              TextButton.icon(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy npub'),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: identity.npub));
                  ScaffoldMessenger.of(ctx).showSnackBar(
                      const SnackBar(content: Text('Copied')));
                },
              ),
              const Divider(height: 28),
              const Text('Secret key (nsec) — never share',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.danger)),
              const SizedBox(height: 6),
              if (!revealed)
                TextButton.icon(
                  style: TextButton.styleFrom(padding: EdgeInsets.zero),
                  icon: const Icon(Icons.visibility, size: 16),
                  label: const Text('Reveal secret key'),
                  onPressed: () => setSheet(() => revealed = true),
                )
              else
                SelectableText(identity.nsec,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }

  static const _apps = <_AppTile>[
    _AppTile('AvaTok', '1:1 video calls', Icons.videocam, AvaColors.brand, true),
    _AppTile('AvaLive', 'Go live', Icons.sensors, AvaColors.danger, true),
    _AppTile('AvaChat', 'Messaging', Icons.chat_bubble, Color(0xFF7C5CFC), false),
    _AppTile('AvaTweet', 'Posts', Icons.tag, Color(0xFF1DA1F2), false),
    _AppTile('AvaGram', 'Photos', Icons.photo_camera, Color(0xFFE1306C), false),
    _AppTile('AvaTube', 'Video', Icons.smart_display, Color(0xFFFF0000), false),
    _AppTile('AvaBook', 'Social', Icons.groups, Color(0xFF1877F2), false),
    _AppTile('AvaDate', 'Dating', Icons.favorite, Color(0xFFFF5864), false),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('AvaTalk', style: AvaTheme.wordmark(34)),
                          const SizedBox(height: 2),
                          const Text('One identity. Every social format.',
                              style: TextStyle(color: AvaColors.sub, fontSize: 13)),
                        ],
                      ),
                    ),
                    GestureDetector(
                      onTap: () => _showProfile(context),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.person, size: 16, color: AvaColors.brand),
                            const SizedBox(width: 6),
                            Text(identity.shortNpub,
                                style: const TextStyle(
                                    fontSize: 11, fontFamily: 'monospace')),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverGrid(
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  mainAxisSpacing: 14,
                  crossAxisSpacing: 14,
                  childAspectRatio: 1.15,
                ),
                delegate: SliverChildBuilderDelegate(
                  (context, i) => _AppCard(app: _apps[i]),
                  childCount: _apps.length,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AppTile {
  final String name;
  final String tagline;
  final IconData icon;
  final Color color;
  final bool live;
  const _AppTile(this.name, this.tagline, this.icon, this.color, this.live);
}

class _AppCard extends StatelessWidget {
  final _AppTile app;
  const _AppCard({required this.app});

  void _open(BuildContext context) {
    if (!app.live) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${app.name} is coming soon')),
      );
      return;
    }
    final page = app.name == 'AvaTok' ? const TokHome() : const LiveHome();
    Navigator.push(context, MaterialPageRoute(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: app.live ? 1 : 0.55,
      child: GestureDetector(
        onTap: () => _open(context),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [
              BoxShadow(color: Color(0x0F0F1115), blurRadius: 14, offset: Offset(0, 2)),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Container(
                    width: 46, height: 46,
                    decoration: BoxDecoration(
                      color: app.color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(app.icon, color: app.color),
                  ),
                  if (!app.live)
                    const Icon(Icons.lock, size: 16, color: AvaColors.sub)
                  else
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AvaColors.brand50,
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Text('LIVE',
                          style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w800,
                              color: Color(0xFF0F8A8A))),
                    ),
                ],
              ),
              const Spacer(),
              Text(app.name, style: Theme.of(context).textTheme.titleMedium),
              Text(app.tagline,
                  style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
            ],
          ),
        ),
      ),
    );
  }
}
