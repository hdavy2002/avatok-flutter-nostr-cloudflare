import 'package:flutter/material.dart';

import '../../core/theme.dart';
import '../tok/tok_home.dart';
import '../live/live_home.dart';

/// The AvaTalk launcher — one identity, many apps. AvaTok + AvaLive are live;
/// the rest are shown locked until their stages ship.
class HomeLauncher extends StatelessWidget {
  const HomeLauncher({super.key});

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
