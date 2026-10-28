import 'package:flutter/material.dart';

import '../../../core/brand.dart';
import '../../../data/call_flags.dart';
import '../../../data/demo_mode.dart';
import '../../../data/services.dart';
import '../../desi.dart';
import '../../theme.dart';

/// [HF-INTRO-A1] Tokens and small widgets shared by the influencer onboarding screens.
/// [HF-DESI-ONB] Restyled to the owner's desi designs (2026-10-28): parchment page, white cards with a sand border and soft plum
/// shadow, a plum hero card on every step, marigold corners that never sit over text, SOLID saffron gota-patti buttons (no
/// gradients), rose selected chips and rangoli step numbers. Names kept so the screens did not change shape.
abstract final class IO {
  static const ink = Color(0xFF2A1530); // text
  static const plum = Color(0xFF4A1747); // headings on white, ghost-button text, numbers
  static const line = Color(0xFFD8C5A9); // card, chip and field borders
  static const pink = Color(0xFFD81B72); // rani: selected chip border, focus, eyebrow on white
  static const pinkInk = Color(0xFF8A1250); // text on a selected chip / rose note
  static const pinkFill = Color(0xFFF8D3E2); // selected chip fill, Women-to-Women note
  static const orange = Color(0xFFEA6A12); // progress fill start, dashed tip border
  static const yellow = Color(0xFFF59E0B); // solid saffron: the one main button
  static const onYellow = Color(0xFF3B1600); // text on saffron
  static const gold = Color(0xFFFBBF24); // eyebrow on the plum hero
  static const heroBody = Color(0xD9FFFAF3); // body text on the plum hero (~85%)
  static const muted = Color(0xFF6F5B6F); // helper text (passes 4.5:1 on white and the page)
  static const white = Color(0xFFFFFFFF);
  static const cream = Color(0xFFFFF4E3); // tip and "please avoid" cards, idea rows
  static const pinkWash = Color(0xFFF8D3E2); // Women-to-Women note
  static const orangeInk = Color(0xFFB45309); // "Please avoid" heading
  static const tagBg = Color(0xFFF8EEE6); // little tags on the call option cards
  static const bookingsIcon = Color(0xFFF1EBFF); // Bookings only icon tile
  static const ok = C.onlineInk; // "Verified" text (the one allowed green)
  static const cameraBg = Color(0xFF2A0F2E); // behind the camera: deep plum
  static const recDot = Color(0xFFFF3B3B); // REC dot
  static const onCamera = Color(0xFFFFFFFF);
  static const onCameraSoft = Color(0xD9FFFFFF);
  static const camScrim = Color(0x993A1238); // translucent plum: round buttons and strips on the camera
  static const camLine = Color(0xFFF59E0B); // saffron ring / outline on the camera
  static const camTrack = Color(0x33FFFFFF);
  static const softLine = Color(0xFFD8C5A9); // divider
  static const youtubeRed = Color(0xFFD62B2B); // brand tile colours of the three login rows
  static const facebookBlue = Color(0xFF2F4FB5);
  static const heroGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF4A1747), Color(0xFF7A2470), Color(0xFFB0216F)],
    stops: [0, .6, 1],
  );
  static List<BoxShadow> get shadow => desiShadow;
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

/// [HF-CALL-SAFETY-APP] How many steps the flow has: 7, or 8 while `hfCallRecordingEnabled` is on (step 7 "Our call rules" sits
/// between "How do you want to take calls?" and "Sent for approval").
int onbTotalSteps() => CallFlags.callRecording ? 8 : 7;

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
  const OnbDashed({super.key, required this.child, this.color = IO.line, this.radius = 18, this.width = 1.5, this.fill});

  final Widget child;
  final Color color;
  final double radius;
  final double width;
  final Color? fill;

  @override
  Widget build(BuildContext context) => CustomPaint(
        foregroundPainter: DesiDashedRRectPainter(color: color, radius: radius, width: width),
        child: DecoratedBox(
          decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(radius)),
          child: child,
        ),
      );
}

/// The one main button: solid saffron gota-patti pill, 58 dp, a marigold at each end of the label.
class OnbPrimaryButton extends StatelessWidget {
  const OnbPrimaryButton({super.key, required this.label, required this.onTap, this.enabled = true, this.busy = false});

  final String label;
  final VoidCallback? onTap;
  final bool enabled;
  final bool busy;

  @override
  Widget build(BuildContext context) => GotaButton(label: label, onTap: onTap, enabled: enabled, busy: busy);
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
          borderRadius: BorderRadius.circular(12),
          child: SizedBox(
            height: 48,
            width: double.infinity,
            child: Center(
              child: Text(label, textAlign: TextAlign.center, style: t(16, color: IO.plum, w: FontWeight.w800).copyWith(decoration: TextDecoration.underline, decorationColor: IO.plum)),
            ),
          ),
        ),
      );
}

/// A pill the person can tick (categories, topics). Selected: rose fill and border with a tick. [pinkOutline] gives the
/// Women-to-Women chip its rose border and text while unselected. [soft] is kept for callers; the look is the same.
class OnbChip extends StatelessWidget {
  const OnbChip({super.key, required this.label, required this.selected, required this.onTap, this.soft = false, this.pinkOutline = false});

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool soft;
  final bool pinkOutline;

  @override
  Widget build(BuildContext context) {
    final edge = selected || pinkOutline ? IO.pink : IO.line;
    final ink = selected || pinkOutline ? IO.pinkInk : IO.ink;
    final content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (selected) ...[const Icon(Icons.check_rounded, size: 18, color: IO.pinkInk), const SizedBox(width: 6)],
          Flexible(child: Text(label, style: t(15, color: ink, w: FontWeight.w800))),
        ]),
      ),
    );
    final Widget body = DecoratedBox(
      decoration: BoxDecoration(
        color: selected ? IO.pinkFill : IO.white,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: edge, width: 1.5),
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

/// White card with a sand border and a soft plum shadow. [corner] adds a small orange marigold top-right (give any title
/// inside right padding — see [OnbSection]). [shadow] (a colour) gives a selected card a rose glow.
class OnbCard extends StatelessWidget {
  const OnbCard({
    super.key,
    required this.child,
    this.color = IO.white,
    this.border = IO.line,
    this.padding = const EdgeInsets.all(16),
    this.radius = 24,
    this.shadow,
    this.corner = false,
    this.gradient,
  });

  final Widget child;
  final Color color;
  final Color border;
  final EdgeInsets padding;
  final double radius;
  final Color? shadow;
  final bool corner;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) {
    final box = BoxDecoration(
      color: gradient == null ? color : null,
      gradient: gradient,
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(color: border, width: 1.5),
      boxShadow: shadow == null ? IO.shadow : [BoxShadow(color: shadow!.withValues(alpha: .28), offset: const Offset(0, 10), blurRadius: 24, spreadRadius: -10)],
    );
    if (!corner) return Container(width: double.infinity, padding: padding, decoration: box, child: child);
    return Container(
      width: double.infinity,
      decoration: box,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius - 1.5),
        child: Stack(children: [
          const Positioned(right: -20, top: -20, child: IgnorePointer(child: Marigold(size: 66))),
          Padding(padding: padding, child: child),
        ]),
      ),
    );
  }
}

/// A white card with a section title ("✿ Categories") and the orange marigold corner. The title keeps clear of the flower.
class OnbSection extends StatelessWidget {
  const OnbSection({super.key, required this.title, required this.child, this.color = IO.white, this.border = IO.line, this.gradient});

  final String title;
  final Widget child;
  final Color color;
  final Color border;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) => OnbCard(
        corner: true,
        color: color,
        border: border,
        gradient: gradient,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.only(right: 44, bottom: 12),
            child: Row(children: [
              const Marigold(size: 22),
              const SizedBox(width: 8),
              Flexible(child: Semantics(header: true, child: Text(title, style: t(19, color: IO.ink, w: FontWeight.w800, h: 1.2)))),
            ]),
          ),
          child,
        ]),
      );
}

/// The plum hero card at the top of each step: gold eyebrow, white title, soft body, a yellow marigold top-right (the title and
/// body are padded so they never run under it).
class OnbHero extends StatelessWidget {
  const OnbHero({super.key, required this.title, this.eyebrow, this.subtitle, this.titleSize = 28});

  final String title;
  final String? eyebrow;
  final String? subtitle;
  final double titleSize;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        decoration: BoxDecoration(gradient: IO.heroGradient, borderRadius: BorderRadius.circular(26), boxShadow: IO.shadow),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(26),
          child: Stack(children: [
            const Positioned(right: -22, top: -22, child: IgnorePointer(child: Marigold(size: 86, yellow: true))),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 20, 18, 20),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (eyebrow != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 56, bottom: 6),
                    child: Text(eyebrow!.toUpperCase(), style: t(14, color: IO.gold, w: FontWeight.w800, ls: 0.12)),
                  ),
                Padding(
                  padding: const EdgeInsets.only(right: 56),
                  child: Semantics(header: true, child: Text(title, style: t(titleSize, color: IO.white, w: FontWeight.w800, h: 1.1))),
                ),
                if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(subtitle!, style: t(15, color: IO.heroBody, w: FontWeight.w600, h: 1.4)),
                  ),
              ]),
            ),
          ]),
        ),
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

/// The text box look of the designs: white, sand outline, rose when focused.
InputDecoration onbInputDecoration(String hint, {bool enabled = true}) => InputDecoration(
      hintText: hint,
      counterText: '',
      filled: true,
      fillColor: enabled ? IO.white : C.sand,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: IO.line, width: 1.5)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: IO.pink, width: 2)),
      disabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: IO.line, width: 1.5)),
    );

/// Back arrow in a round white button with a sand border (48 dp tap target).
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
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: dark ? IO.camScrim : IO.white,
              border: Border.all(color: dark ? IO.camLine : IO.line, width: dark ? 2 : 1.5),
            ),
            child: Icon(Icons.chevron_left_rounded, size: 30, color: dark ? IO.onCamera : IO.ink),
          ),
        ),
      );
}

/// The page every step sits on: back button + progress bar + "n of 7", then a scrolling body that starts with the plum hero
/// (eyebrow, title, intro line), and the buttons at the bottom (a main button, and an optional quiet link under it).
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
    this.titleSize = 28,
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
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(children: [
              if (onBack != null) OnbBackButton(onTap: onBack!) else const SizedBox(width: 48, height: 48),
              const SizedBox(width: 12),
              Expanded(
                child: Semantics(
                  label: n == 0 ? null : 'Step $n of ${onbTotalSteps()}',
                  child: Container(
                    height: 10,
                    decoration: BoxDecoration(color: IO.white, borderRadius: BorderRadius.circular(99), border: Border.all(color: IO.line, width: 1.5)),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(99),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: FractionallySizedBox(
                          widthFactor: (n / onbTotalSteps()).clamp(0.0, 1.0).toDouble(),
                          heightFactor: 1,
                          child: const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: [IO.orange, IO.yellow]))),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Text(n == 0 ? '' : '$n of ${onbTotalSteps()}', style: t(14, color: IO.ink, w: FontWeight.w800)),
            ]),
          ),
          Expanded(
            child: SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                OnbHero(title: title, eyebrow: eyebrow, subtitle: subtitle, titleSize: titleSize),
                const SizedBox(height: 12),
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
