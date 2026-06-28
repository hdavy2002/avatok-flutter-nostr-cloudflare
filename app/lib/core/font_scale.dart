import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// App-wide font-size preference (Settings → Display & fonts).
///
/// A single device-level multiplier (NOT account-scoped — it's a display
/// preference) applied on top of the app's base text bump and the OS accessibility
/// setting, at the [MaterialApp] root. 1.0 = default; range 0.85–1.6.
class FontScale {
  static const _key = 'app_font_scale_v1';
  static const _ss = FlutterSecureStorage();
  static const double min = 0.85;
  static const double max = 1.60;

  /// Live value — the root listens to this so changes apply instantly app-wide.
  static final ValueNotifier<double> scale = ValueNotifier<double>(1.0);

  static Future<void> load() async {
    try {
      final s = await _ss.read(key: _key);
      final v = double.tryParse(s ?? '');
      if (v != null) scale.value = v.clamp(min, max);
    } catch (_) {/* default 1.0 */}
  }

  static Future<void> set(double v) async {
    final c = v.clamp(min, max);
    scale.value = c;
    try { await _ss.write(key: _key, value: c.toStringAsFixed(2)); } catch (_) {/* best-effort */}
  }

  /// Friendly label for the current/standard steps.
  static String labelFor(double v) {
    if (v <= 0.9) return 'Small';
    if (v < 1.08) return 'Default';
    if (v < 1.28) return 'Large';
    if (v < 1.48) return 'Larger';
    return 'Largest';
  }
}

/// Pins a subtree's text to the OS + base app scale, REMOVING the user's
/// Display-&-fonts slider multiplier ([FontScale.scale]). The root applies the
/// slider app-wide (so chat/message/contact/menu body text grows); wrapping the
/// big page titles + headings in this keeps them a fixed size while everything
/// else still responds to the slider (owner request 2026-06-28, pic 3: "the big
/// titles remain the same"). Icons already ignore text scaling, so they're
/// unaffected either way. Live: rebuilds when the root MediaQuery re-scales.
class NoUserFontScale extends StatelessWidget {
  final Widget child;
  const NoUserFontScale({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final user = FontScale.scale.value;           // the slider multiplier
    final cur = mq.textScaler.scale(1.0);         // OS × base × user (root-applied)
    final pinned = user <= 0 ? cur : cur / user;  // divide the user factor back out
    return MediaQuery(
      data: mq.copyWith(textScaler: TextScaler.linear(pinned)),
      child: child,
    );
  }
}
