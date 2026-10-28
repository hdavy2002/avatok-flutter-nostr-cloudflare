import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/brand.dart';
import '../../../data/call_flags.dart';
import '../../../data/demo_mode.dart';
import '../../../data/services.dart';
import '../../theme.dart';

/// [HF-INTRO-A1] Tokens and small widgets shared by the influencer onboarding screens. The values are the owner-approved screen designs
/// (Specs/hf-intro-screens/*.dc.html): ink, rose, saffron and marigold on the "Deep parchment" page ([C.page]).
abstract final class IO {
  static const ink = Color(0xFF30245F); // text, borders, hard shadows
  static const pink = Color(0xFFBE246E); // eyebrow, selected chip, "pick" cards
  static const orange = Color(0xFFFF793C); // progress fill
  static const yellow = Color(0xFFFBD447); // the one main button
  static const muted = Color(0xFF6B5A8A); // helper text (passes 4.5:1 on the page)
  static const white = Color(0xFFFFFFFF);
  static const cream = Color(0xFFFFF7E2); // tip and "please avoid" cards
  static const pinkWash = Color(0xFFFDE8F2); // Women-to-Women note
  static const orangeInk = Color(0xFFB8471A); // "Please avoid" heading
  static const tagBg = Color(0xFFF1ECFB); // little tags on the call option cards
  static const bookingsIcon = Color(0xFFBFC2EE); // Bookings only icon tile
  static const ok = C.onlineInk; // "Verified" text (the one allowed green)
  static const cameraBg = Color(0xFF1B1430); // behind the camera
  static const recDot = Color(0xFFFF3B3B); // REC dot and the stop button
  static const onCamera = Color(0xFFFFFFFF);
  static const onCameraSoft = Color(0xD9FFFFFF);
  static const camScrim = Color(0x66000000); // round buttons and the hint strip on the camera
  static const camLine = Color(0x88FFFFFF);
  static const camTrack = Color(0x33FFFFFF);
  static const softLine = Color(0x5530245F); // dashed-looking divider above the "needs an Aadhaar check" group
  static const youtubeRed = Color(0xFFD62B2B); // brand tile colours of the three login rows
  static const facebookBlue = Color(0xFF2F4FB5);
}

/// The steps of the flow. `n` is the number shown in "n of 7" (0 = no number).
enum OnbStep {
  categories(1),
  social(2),
  aadhaar(3),
  prep(4),
  record(5),
  profile(5),
  option(6),
  sent(7);

  const OnbStep(this.n);
  final int n;
}

/// Where the rest of the app asks "should this person land in onboarding?".
abstract final class IntroOnbEntry {
  /// True when the intro-video onboarding is on and this person already has a draft or rejected influencer row, so she must go back into
  /// the flow (not the dashboard) until a person on our team approves her.
  static bool get pending {
    if (DemoMode.on || !CallFlags.introOnboarding) return false;
    final s = Services.instance.me?.hostStatus;
    return s == 'draft' || s == 'pending_host' || s == 'pending_review' || s == 'rejected';
  }

  /// The route of the flow.
  static const String route = '/influencer/join';
}

/// The live onboarding screen, if any. The Instagram / Facebook login runs in an in-app browser and comes back as the deep link
/// `<scheme>://channels?ig|fb=connected|error&reason=...`; while the flow is open the deep-link handler hands that link here
/// instead of opening the Channels screen.
abstract final class IntroOnbSession {
  static bool active = false;

  /// Bumped for every social login that came back; read [lastPlatform], [lastResult] and [lastReason] after a bump.
  static final ValueNotifier<int> socialReturn = ValueNotifier<int>(0);
  static String? lastPlatform;
  static String? lastResult;
  static String? lastReason;

  /// True when [uri] was a social login result and the open flow took it.
  static bool handleSocialReturn(Uri uri) {
    if (!active) return false;
    if (uri.scheme.toLowerCase() != Brand.scheme || uri.host.toLowerCase() != 'channels') return false;
    final q = uri.queryParameters;
    final platform = q['ig'] != null ? 'instagram' : (q['fb'] != null ? 'facebook' : null);
    if (platform == null) return false;
    final result = q[platform == 'instagram' ? 'ig' : 'fb'];
    lastPlatform = platform;
    lastResult = result == 'connected' ? 'connected' : 'error';
    final reason = q['reason'] ?? '';
    lastReason = RegExp(r'^[a-z_]{1,30}$').hasMatch(reason) ? reason : null;
    socialReturn.value = socialReturn.value + 1;
    return true;
  }
}

/// A dashed rounded border around [child] (Flutter has none built in).
class OnbDashed extends StatelessWidget {
  const OnbDashed({super.key, required this.child, this.color = IO.ink, this.radius = 18, this.width = 2, this.fill});

  final Widget child;
  final Color color;
  final double radius;
  final double width;
  final Color? fill;

  @override
  Widget build(BuildContext context) => CustomPaint(
        foregroundPainter: _DashedPainter(color: color, radius: radius, width: width),
        child: DecoratedBox(
          decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(radius)),
          child: child,
        ),
      );
}

class _DashedPainter extends CustomPainter {
  const _DashedPainter({required this.color, required this.radius, required this.width});

  final Color color;
  final double radius;
  final double width;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = width;
    final inset = width / 2;
    final rrect = RRect.fromRectAndRadius(Rect.fromLTWH(inset, inset, size.width - width, size.height - width), Radius.circular(radius));
    final path = Path()..addRRect(rrect);
    const dash = 7.0;
    const gap = 5.0;
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, math.min(d + dash, metric.length)), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedPainter old) => old.color != color || old.radius != radius || old.width != width;
}

/// The one main button: 58 dp, marigold with an ink outline and a hard ink shadow.
class OnbPrimaryButton extends StatelessWidget {
  const OnbPrimaryButton({super.key, required this.label, required this.onTap, this.enabled = true, this.busy = false});

  final String label;
  final VoidCallback? onTap;
  final bool enabled;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final active = enabled && !busy && onTap != null;
    return Semantics(
      button: true,
      enabled: active,
      label: busy ? '$label, please wait' : label,
      onTap: active ? onTap : null,
      excludeSemantics: true,
      child: Opacity(
        opacity: enabled ? 1 : 0.5,
        child: Container(
          height: 58,
          decoration: BoxDecoration(
            color: IO.yellow,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: IO.ink, width: 3),
            boxShadow: const [BoxShadow(color: IO.ink, offset: Offset(5, 5))],
          ),
          child: Material(
            color: C.clear,
            child: InkWell(
              borderRadius: BorderRadius.circular(13),
              onTap: active ? onTap : null,
              child: Center(
                child: busy
                    ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: IO.ink))
                    : Text(label, textAlign: TextAlign.center, style: t(18, color: IO.ink, w: FontWeight.w900)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A quiet underlined text button under the main button ("Skip ...").
class OnbLinkButton extends StatelessWidget {
  const OnbLinkButton({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        onTap: onTap,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            height: 48,
            width: double.infinity,
            child: Center(
              child: Text(label, textAlign: TextAlign.center, style: t(16, color: IO.ink, w: FontWeight.w800).copyWith(decoration: TextDecoration.underline)),
            ),
          ),
        ),
      );
}

/// A pill the person can tick (categories, topics). [soft] draws the dashed outline of the "needs an Aadhaar check" group.
class OnbChip extends StatelessWidget {
  const OnbChip({super.key, required this.label, required this.selected, required this.onTap, this.soft = false, this.pinkOutline = false});

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool soft;
  final bool pinkOutline;

  @override
  Widget build(BuildContext context) {
    final edge = pinkOutline ? IO.pink : IO.ink;
    final ink = selected ? IO.white : edge;
    final content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (selected) ...[const Icon(Icons.check_rounded, size: 18, color: IO.white), const SizedBox(width: 6)],
          Flexible(child: Text(label, style: t(15, color: ink, w: FontWeight.w800))),
        ]),
      ),
    );
    final Widget body = (soft && !selected)
        ? OnbDashed(color: edge, radius: 999, width: 2.5, fill: IO.white, child: content)
        : DecoratedBox(
            decoration: BoxDecoration(
              color: selected ? IO.pink : IO.white,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: selected ? IO.pink : edge, width: 2.5),
            ),
            child: content,
          );
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      onTap: onTap,
      excludeSemantics: true,
      child: Material(
        color: C.clear,
        child: InkWell(customBorder: const StadiumBorder(), onTap: onTap, child: body),
      ),
    );
  }
}

/// White card with an ink outline.
class OnbCard extends StatelessWidget {
  const OnbCard({super.key, required this.child, this.color = IO.white, this.border = IO.ink, this.padding = const EdgeInsets.all(16), this.radius = 22, this.shadow});

  final Widget child;
  final Color color;
  final Color border;
  final EdgeInsets padding;
  final double radius;
  final Color? shadow;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: padding,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(color: border, width: 2.5),
          boxShadow: shadow == null ? null : [BoxShadow(color: shadow!, offset: const Offset(6, 6))],
        ),
        child: child,
      );
}

/// A red error sentence.
class OnbError extends StatelessWidget {
  const OnbError(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Semantics(
        liveRegion: true,
        child: Text(text, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.35)),
      );
}

/// The text box look of the designs: white, ink outline, rose when focused.
InputDecoration onbInputDecoration(String hint, {bool enabled = true}) => InputDecoration(
      hintText: hint,
      counterText: '',
      filled: true,
      fillColor: enabled ? IO.white : C.sand,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.ink, width: 2.5)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.pink, width: 2.5)),
      disabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: IO.softLine, width: 2.5)),
    );

/// Back arrow in a white circle (48 dp tap target).
class OnbBackButton extends StatelessWidget {
  const OnbBackButton({super.key, required this.onTap, this.dark = false});

  final VoidCallback onTap;
  final bool dark;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: 'Back',
        onTap: onTap,
        excludeSemantics: true,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 48,
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: dark ? IO.camScrim : IO.white, border: dark ? null : Border.all(color: IO.ink, width: 2.5)),
            child: Icon(Icons.chevron_left_rounded, size: 30, color: dark ? IO.onCamera : IO.ink),
          ),
        ),
      );
}

/// The page every step sits on: back arrow + progress bar + "n of 7", eyebrow, title, intro line, a scrolling body, and the buttons at
/// the bottom (a main button, and an optional quiet link under it).
class OnbScaffold extends StatelessWidget {
  const OnbScaffold({
    super.key,
    required this.child,
    required this.title,
    this.step,
    this.eyebrow,
    this.subtitle,
    this.primaryLabel,
    this.onPrimary,
    this.primaryEnabled = true,
    this.primaryBusy = false,
    this.secondaryLabel,
    this.onSecondary,
    this.onBack,
    this.error,
    this.titleSize = 30,
  });

  final Widget child;
  final String title;
  final OnbStep? step;
  final String? eyebrow;
  final String? subtitle;
  final String? primaryLabel;
  final VoidCallback? onPrimary;
  final bool primaryEnabled;
  final bool primaryBusy;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  /// Null hides the arrow.
  final VoidCallback? onBack;
  final String? error;
  final double titleSize;

  @override
  Widget build(BuildContext context) {
    final n = step?.n ?? 0;
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
            child: Row(children: [
              if (onBack != null) OnbBackButton(onTap: onBack!) else const SizedBox(width: 48, height: 48),
              const SizedBox(width: 12),
              Expanded(
                child: Semantics(
                  label: n == 0 ? null : 'Step $n of 7',
                  child: Container(
                    height: 10,
                    decoration: BoxDecoration(color: IO.white, borderRadius: BorderRadius.circular(99), border: Border.all(color: IO.ink, width: 2)),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(99),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: FractionallySizedBox(widthFactor: (n / 7).clamp(0.0, 1.0).toDouble(), heightFactor: 1, child: const ColoredBox(color: IO.orange)),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Text(n == 0 ? '' : '$n of 7', style: t(14, color: IO.ink, w: FontWeight.w800)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (eyebrow != null) Text(eyebrow!.toUpperCase(), style: t(14, color: IO.pink, w: FontWeight.w900, ls: 0.14)),
              Padding(
                padding: const EdgeInsets.only(top: 4, bottom: 4),
                child: Semantics(header: true, child: Text(title, style: t(titleSize, color: IO.ink, w: FontWeight.w900, h: 1.08))),
              ),
              if (subtitle != null) Text(subtitle!, style: t(15, color: IO.ink, w: FontWeight.w600, h: 1.45)),
            ]),
          ),
          Expanded(
            child: SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                child,
                if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: OnbError(error!)),
              ]),
            ),
          ),
          if (primaryLabel != null || secondaryLabel != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (primaryLabel != null) OnbPrimaryButton(label: primaryLabel!, onTap: onPrimary, enabled: primaryEnabled, busy: primaryBusy),
                if (secondaryLabel != null) OnbLinkButton(label: secondaryLabel!, onTap: onSecondary),
              ]),
            ),
        ]),
      ),
    );
  }
}
