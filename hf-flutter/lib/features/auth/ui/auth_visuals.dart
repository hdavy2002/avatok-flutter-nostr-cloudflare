import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../../core/motion/motion.dart';
import '../../../core/theme/hf_theme.dart';

enum AuthPhotoKind {
  welcome,
  login,
  secondWhatsapp,
  whatsappOtp,
  email,
  emailOtp,
  name,
  username,
  kyc,
  policies,
}

extension on AuthPhotoKind {
  String get asset => 'assets/images/auth/${switch (this) {
    AuthPhotoKind.welcome => 'welcome',
    AuthPhotoKind.login => 'login',
    AuthPhotoKind.secondWhatsapp => 'second-whatsapp',
    AuthPhotoKind.whatsappOtp => 'whatsapp-otp',
    AuthPhotoKind.email => 'email',
    AuthPhotoKind.emailOtp => 'email-otp',
    AuthPhotoKind.name => 'name',
    AuthPhotoKind.username => 'username',
    AuthPhotoKind.kyc => 'kyc',
    AuthPhotoKind.policies => 'policies',
  }}.webp';
}

/// The auth storyboards are 425 logical pixels wide. On larger windows the
/// composition remains readable instead of stretching; on smaller windows it
/// follows the available constraints and keeps every control scrollable.
class AuthViewport extends StatelessWidget {
  const AuthViewport({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => AuthBackdrop(
    child: SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) => Center(
          child: SizedBox(
            width: constraints.maxWidth.clamp(0, 425).toDouble(),
            height: constraints.maxHeight,
            child: child,
          ),
        ),
      ),
    ),
  );
}

class AuthBackRow extends StatelessWidget {
  const AuthBackRow({super.key, required this.onBack, this.step});

  final VoidCallback onBack;
  final int? step;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      IconButton(
        tooltip: 'Back',
        onPressed: onBack,
        icon: const Icon(Icons.arrow_back_rounded),
      ),
      const SizedBox(width: 2),
      if (step != null) ...[
        Expanded(child: AuthProgress(step: step!)),
        const SizedBox(width: 12),
        Text('$step/7', style: HfText.of(context, HfText.badge)),
      ] else
        const Spacer(),
    ],
  );
}

class AuthProgress extends StatelessWidget {
  const AuthProgress({super.key, required this.step});

  final int step;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      for (var i = 0; i < 7; i++)
        Expanded(
          child: Container(
            height: 7,
            margin: const EdgeInsets.symmetric(horizontal: 2),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(99),
              color: i < step
                  ? HfColors.primary
                  : (HfBrightness.isDark(context)
                        ? HfColors.darkSelected
                        : HfColors.lavender),
            ),
          ),
        ),
    ],
  );
}

class AuthPhoto extends StatelessWidget {
  const AuthPhoto({
    super.key,
    required this.kind,
    this.height = 212,
    this.alignment = Alignment.center,
    this.sticker,
  });

  final AuthPhotoKind kind;
  final double height;
  final Alignment alignment;
  final Widget? sticker;

  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    children: [
      Container(
        height: height,
        width: double.infinity,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(44),
          color: HfColors.lavender,
          boxShadow: HfShadows.cardFor(context),
        ),
        foregroundDecoration: BoxDecoration(
          borderRadius: BorderRadius.circular(44),
          border: Border.all(color: HfColors.white, width: 2),
        ),
        clipBehavior: Clip.antiAlias,
        child: Image.asset(
          kind.asset,
          fit: BoxFit.cover,
          alignment: alignment,
          filterQuality: FilterQuality.high,
        ),
      ),
      if (sticker != null) Positioned(right: -4, top: 24, child: sticker!),
    ],
  );
}

class AuthIdentityHero extends StatelessWidget {
  const AuthIdentityHero({
    super.key,
    required this.title,
    required this.subtitle,
    required this.photo,
    this.photoHeight = 188,
    this.sticker,
    this.guide,
  });

  final String title;
  final String subtitle;
  final AuthPhotoKind photo;
  final double photoHeight;
  final Widget? sticker;

  /// When set, the beaver guide (in this pose) says [subtitle] in a speech bubble instead of a plain line.
  final BeaverPose? guide;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(title, textAlign: TextAlign.center, style: HfText.of(context, HfText.headline)),
      const SizedBox(height: 6),
      if (guide case final pose?)
        AuthGuide(pose: pose, message: subtitle)
      else
        Text(subtitle, textAlign: TextAlign.center, style: HfText.of(context, HfText.note)),
      const SizedBox(height: 14),
      AuthPhoto(kind: photo, height: photoHeight, sticker: sticker),
      const SizedBox(height: 14),
    ],
  );
}

class AuthSticker extends StatelessWidget {
  const AuthSticker(this.text, {super.key, this.color = const Color(0xFFFFE790)});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Transform.rotate(
    angle: -.06,
    child: Container(
      width: 92,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(24),
        boxShadow: HfShadows.segment,
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: HfText.bodyStrong.copyWith(color: HfColors.ink, height: 1.1),
      ),
    ),
  );
}

class AuthSurfaceCard extends StatelessWidget {
  const AuthSurfaceCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(18),
    child: BackdropFilter(
      filter: ui.ImageFilter.blur(sigmaX: 15, sigmaY: 15),
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          color: (HfBrightness.isDark(context) ? HfColors.darkCard : HfColors.surface)
              .withValues(alpha: .92),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: HfBrightness.isDark(context) ? HfColors.darkLine : HfColors.line,
          ),
          boxShadow: HfShadows.cardFor(context),
        ),
        child: child,
      ),
    ),
  );
}

class AuthCallout extends StatelessWidget {
  const AuthCallout({super.key, required this.icon, required this.title, required this.body, this.tint = HfColors.lavender});

  final IconData icon;
  final String title;
  final String body;
  final Color tint;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: HfSurfaces.card(context, radius: 18),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(color: tint, shape: BoxShape.circle),
          child: Icon(icon, color: HfColors.lavenderDeep),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: HfText.of(context, HfText.bodyStrong)),
              const SizedBox(height: 2),
              Text(body, style: HfText.note.copyWith(color: HfBrightness.isDark(context)
                  ? HfColors.darkText : HfColors.inkSoft)),
            ],
          ),
        ),
      ],
    ),
  );
}

/// Calm warm page behind the auth screens (HF-MOTION-A): the cream-to-butter sky with a low sun hill. In dark
/// mode the plain dark page stays (light text on the orange hill would be hard to read).
class AuthBackdrop extends StatelessWidget {
  const AuthBackdrop({super.key, required this.child});

  /// Hill height as a fraction of the screen. Low, so form text never sits on it for long.
  static const double rise = 0.07;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (HfBrightness.isDark(context)) {
      return ColoredBox(color: HfColors.darkBg, child: child);
    }
    return SunHill(riseFrom: 0, riseTo: rise, child: child);
  }
}

/// The small beaver guide at the top of an auth step, with [message] in its speech bubble. The bubble sits
/// beside the beaver when there is room, above it on narrow screens or with large text.
class AuthGuide extends StatelessWidget {
  const AuthGuide({super.key, required this.pose, required this.message, this.size = 88});

  /// Key of the guide (for tests).
  static const Key guideKey = ValueKey<String>('auth-guide');

  final BeaverPose pose;
  final String message;
  final double size;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(1);
    return LayoutBuilder(
      builder: (context, constraints) {
        final beside = constraints.maxWidth - size >= 180 * scale;
        return Align(
          alignment: beside ? Alignment.centerLeft : Alignment.center,
          child: BeaverGuide(
            key: guideKey,
            pose: pose,
            size: size,
            message: message,
            bubbleSide: beside ? BeaverBubbleSide.beside : BeaverBubbleSide.above,
          ),
        );
      },
    );
  }
}

/// Verified! A tick that draws itself with a small confetti puff, over a soft cream veil. Decoration only:
/// it never takes touches and navigation never waits for it.
class AuthSuccessBurst extends StatelessWidget {
  const AuthSuccessBurst({super.key});

  /// Key of the burst (for tests).
  static const Key burstKey = ValueKey<String>('auth-success');

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return IgnorePointer(
      child: ColoredBox(
        color: (dark ? HfColors.darkBg : HfColors.page).withValues(alpha: 0.72),
        child: const Center(
          child: DrawnCheck(
            key: burstKey,
            size: 104,
            confetti: true,
            semanticLabel: 'Verified',
          ),
        ),
      ),
    );
  }
}
