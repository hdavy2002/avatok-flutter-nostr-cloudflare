import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/app_registry.dart';
import '../core/ui/zine.dart';
import '../core/ui/zine_widgets.dart';

/// Placeholder for an app whose screens aren't built yet. Keeps the app's
/// brand header so navigation feels complete.
class ComingSoon extends StatelessWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  const ComingSoon({super.key, required this.title, required this.subtitle, required this.icon, required this.color});

  /// Phase-1 ComingSoonScreen(appId): styled from the app registry so every
  /// not-yet-shipped standard app navigates somewhere branded.
  factory ComingSoon.forApp(String appId, {Key? key}) {
    final e = AppRegistry.byId(appId);
    return ComingSoon(
      key: key,
      title: e?.title ?? appId,
      subtitle: e?.tagline ?? 'Coming soon',
      icon: e?.icon ?? PhosphorIcons.lightning(PhosphorIconsStyle.fill),
      color: e?.color ?? Zine.blue,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ZineAppBar(title: title, tag: subtitle),
      body: ZinePaper(
        child: SizedBox.expand(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 84, height: 84,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(Zine.r),
                    border: Zine.border,
                    boxShadow: Zine.shadowSm,
                  ),
                  child: Icon(icon, color: Zine.ink, size: 38),
                ),
                const SizedBox(height: 18),
                Text(title, style: ZineText.hero(size: 28), textAlign: TextAlign.center),
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: Text(subtitle, style: ZineText.sub(), textAlign: TextAlign.center),
                ),
                const SizedBox(height: 16),
                ZineSticker(
                  'on the way — check back soon',
                  kind: ZineStickerKind.hint,
                  icon: PhosphorIcons.hammer(PhosphorIconsStyle.bold),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
