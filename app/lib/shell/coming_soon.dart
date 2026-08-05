import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/app_registry.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
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
      color: e?.color ?? AD.primaryBadge,
    );
  }

  @override
  Widget build(BuildContext context) {
    // Callers pass every kind of accent (the AppRegistry hexes as well as AD
    // tokens), so the glyph colour is decided by the fill's luminance rather
    // than fixed — a white glyph on a pale fill would vanish.
    final glyph = color.computeLuminance() > 0.5 ? AD.textOnInput : Colors.white;
    return Scaffold(
      appBar: ZineAppBar(title: title, tag: subtitle),
      body: ZinePaper(
        child: SizedBox.expand(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(Msg.s5),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 84, height: 84,
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: Msg.brLg,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: Icon(icon, color: glyph, size: 38),
                ),
                const SizedBox(height: Msg.s4),
                Text(title,
                    style: ADText.appTitle().copyWith(fontSize: 28),
                    textAlign: TextAlign.center),
                const SizedBox(height: Msg.s2),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: Text(subtitle, style: ADText.preview(), textAlign: TextAlign.center),
                ),
                const SizedBox(height: Msg.s4),
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
