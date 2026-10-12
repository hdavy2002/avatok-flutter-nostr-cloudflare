import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

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
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: HfBrightness.isDark(context) ? HfColors.darkBg : HfColors.page,
      gradient: HfBrightness.isDark(context)
          ? null
          : const RadialGradient(
              center: Alignment(0.78, 0.82),
              radius: 1.18,
              colors: [Color(0xFFE4DDFF), Color(0xFFF9F7FF), Color(0xFFFFFFFF)],
              stops: [0, .55, 1],
            ),
    ),
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
                  ? HfColors.lavenderDeep
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
          boxShadow: HfBrightness.isDark(context) ? null : HfShadows.card,
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
  });

  final String title;
  final String subtitle;
  final AuthPhotoKind photo;
  final double photoHeight;
  final Widget? sticker;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(title, textAlign: TextAlign.center, style: HfText.of(context, HfText.headline)),
      const SizedBox(height: 6),
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
          color: (HfBrightness.isDark(context) ? HfColors.darkCard : HfColors.white)
              .withValues(alpha: .92),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: HfBrightness.isDark(context) ? HfColors.darkLine : HfColors.line,
          ),
          boxShadow: HfBrightness.isDark(context) ? null : HfShadows.field,
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
    decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(18)),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: const BoxDecoration(color: HfColors.white, shape: BoxShape.circle),
          child: Icon(icon, color: HfColors.lavenderDeep),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: HfText.bodyStrong.copyWith(color: HfColors.ink)),
              const SizedBox(height: 2),
              Text(body, style: HfText.note.copyWith(color: HfColors.inkSoft)),
            ],
          ),
        ),
      ],
    ),
  );
}

@visibleForTesting
enum AuthVisualState {
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

/// A deterministic render target for CI visual capture. It deliberately uses
/// the same primitives and assets as the live forms while avoiding network and
/// timers; interaction behavior remains covered by the controller tests.
@visibleForTesting
class AuthVisualCaptureFrame extends StatelessWidget {
  const AuthVisualCaptureFrame({super.key, required this.state});

  final AuthVisualState state;

  @override
  Widget build(BuildContext context) {
    final photo = AuthPhotoKind.values[state.index];
    final title = switch (state) {
      AuthVisualState.welcome => 'Find people, services and conversations that fit you',
      AuthVisualState.login => 'Welcome back',
      AuthVisualState.secondWhatsapp => 'Add your second WhatsApp number',
      AuthVisualState.whatsappOtp => 'Verify WhatsApp',
      AuthVisualState.email => 'Verify your email',
      AuthVisualState.emailOtp => 'Enter email code',
      AuthVisualState.name => 'What should we call you?',
      AuthVisualState.username => 'Choose your username',
      AuthVisualState.kyc => 'Unlock more conversations',
      AuthVisualState.policies => 'Review and accept',
    };
    return Material(
      child: AuthViewport(
        child: ListView(
          key: ValueKey('auth-capture-${state.name}'),
          padding: const EdgeInsets.all(20),
          children: [
            if (state != AuthVisualState.welcome)
              AuthBackRow(onBack: () {}, step: state.index >= 3 ? state.index - 2 : null),
            AuthIdentityHero(
              title: title,
              subtitle: 'A clear, secure step in your account journey.',
              photo: photo,
              photoHeight: state == AuthVisualState.welcome ? 310 : 190,
            ),
            const AuthSurfaceCard(
              child: SizedBox(
                height: 172,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Account details', style: HfText.subsection),
                    SizedBox(height: 12),
                    TextField(decoration: InputDecoration(labelText: 'Information')),
                    SizedBox(height: 12),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
