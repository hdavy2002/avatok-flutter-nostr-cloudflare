import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'avatar.dart';
import 'ui/zine.dart';

/// Full-screen enlarged view of someone's profile picture, opened by tapping any
/// avatar. The picture is wrapped so the user CANNOT trivially lift it:
///   • secondary-tap (right-click) and long-press are swallowed — no "save image"
///     / context menu;
///   • the barrier is opaque so nothing behind it leaks into a grab.
///
/// NOTE on screenshots: fully blocking OS screenshots needs a platform flag
/// (Android `FLAG_SECURE` / iOS secure overlay) which requires a native plugin.
/// [ScreenshotGuard.protect] is the single hook to wire that in once the plugin
/// is added; today it is a no-op so the build stays dependency-free. The gesture
/// guards above already stop the easy "press-and-save" path.
Future<void> showAvatarViewer(
  BuildContext context, {
  required String seed,
  required String name,
  String? avatarUrl,
}) {
  return showGeneralDialog(
    context: context,
    barrierLabel: 'Profile photo',
    barrierColor: Colors.black.withValues(alpha: 0.86),
    barrierDismissible: true,
    transitionDuration: const Duration(milliseconds: 160),
    pageBuilder: (ctx, _, __) => _AvatarViewer(seed: seed, name: name, avatarUrl: avatarUrl),
    transitionBuilder: (ctx, anim, _, child) =>
        FadeTransition(opacity: anim, child: ScaleTransition(
            scale: Tween(begin: 0.92, end: 1.0).animate(
                CurvedAnimation(parent: anim, curve: Curves.easeOutBack)),
            child: child)),
  );
}

class _AvatarViewer extends StatelessWidget {
  final String seed;
  final String name;
  final String? avatarUrl;
  const _AvatarViewer({required this.seed, required this.name, this.avatarUrl});

  @override
  Widget build(BuildContext context) {
    final side = (MediaQuery.of(context).size.shortestSide * 0.78).clamp(220.0, 360.0);
    return ScreenshotGuard(
      child: GestureDetector(
        onTap: () => Navigator.of(context).maybePop(),
        // Swallow right-click / long-press so the OS image context menu and the
        // "save / copy image" affordance never appear.
        onSecondaryTap: () {},
        onLongPress: () {},
        behavior: HitTestBehavior.opaque,
        child: Stack(children: [
          Center(
            child: GestureDetector(
              onTap: () {}, // taps on the photo itself don't dismiss
              onSecondaryTap: () {},
              onLongPress: () {},
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.fromBorderSide(BorderSide(color: Zine.paper, width: 3)),
                    boxShadow: Zine.shadow,
                  ),
                  child: ClipOval(
                    child: SizedBox(
                      width: side, height: side,
                      child: Avatar(seed: seed, name: name, size: side, avatarUrl: avatarUrl),
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                Text(name,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.cardTitle(size: 19, color: Zine.paper)),
              ]),
            ),
          ),
          Positioned(
            top: MediaQuery.of(context).padding.top + 10, right: 14,
            child: GestureDetector(
              onTap: () => Navigator.of(context).maybePop(),
              child: Container(
                width: 40, height: 40,
                decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.16), shape: BoxShape.circle),
                child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                    size: 20, color: Zine.paper),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

/// Applies the platform secure-screen flag while its [child] is on screen, then
/// clears it on dispose. On Android this sets `FLAG_SECURE` (blocks screenshots +
/// screen recording, blanks the app-switcher preview) via the `avatok/secure_screen`
/// MethodChannel implemented in MainActivity. iOS has no equivalent OS-level block,
/// so the call simply no-ops there (handled by notImplemented / catch).
class ScreenshotGuard extends StatefulWidget {
  final Widget child;
  const ScreenshotGuard({super.key, required this.child});

  static const MethodChannel _channel = MethodChannel('avatok/secure_screen');

  /// Turn the secure-screen flag ON. Best-effort — never throws into the UI.
  static Future<void> protect() async {
    try { await _channel.invokeMethod('protect'); } catch (_) {/* iOS / not wired */}
  }

  /// Turn the secure-screen flag OFF.
  static Future<void> unprotect() async {
    try { await _channel.invokeMethod('unprotect'); } catch (_) {/* iOS / not wired */}
  }

  @override
  State<ScreenshotGuard> createState() => _ScreenshotGuardState();
}

class _ScreenshotGuardState extends State<ScreenshotGuard> {
  @override
  void initState() {
    super.initState();
    ScreenshotGuard.protect();
  }

  @override
  void dispose() {
    ScreenshotGuard.unprotect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
