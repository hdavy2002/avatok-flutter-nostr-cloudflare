import 'package:flutter/material.dart';

import '../../../core/brand.dart';
import '../../../core/motion/motion.dart';
import '../../../core/theme/hf_theme.dart';
import 'auth_visuals.dart';

/// Styling belongs only to the returning-user login entry screen.
class LoginColors {
  const LoginColors(this.dark);

  final bool dark;
  Color get background => dark ? Colors.black : const Color(0xFFF6F3EE);
  Color get ink => dark ? const Color(0xFFF3F0FF) : Colors.black;
  Color get muted => dark ? const Color(0xFFABA6C6) : Colors.black;
  Color get brand => dark ? const Color(0xFFFFB3CB) : const Color(0xFFB1325F);
  Color get field => dark ? HfColors.darkCard : HfColors.surface;
  Color get line => dark ? HfColors.darkLine : HfColors.line;
  Color get track => dark ? const Color(0xFF343438) : const Color(0xFFD8D2CA);
  Color get selected => dark ? const Color(0xFFE7E1FF) : const Color(0xFFF1ECE5);
  Color get action => HfColors.primary;
  Color get onAction => HfColors.onPrimary;
  Color get link => dark ? const Color(0xFFCFC4FF) : Colors.black;

  static LoginColors of(BuildContext context) =>
      LoginColors(HfBrightness.isDark(context));

  TextStyle text(double size, {FontWeight weight = FontWeight.w400}) =>
      TextStyle(fontFamily: 'Roboto', fontSize: size, fontWeight: weight,
        color: ink, height: 1.45);

  InputDecoration input({required String hint, String? error, Widget? prefix}) {
    OutlineInputBorder border(Color color) => OutlineInputBorder(
      borderRadius: BorderRadius.circular(18),
      borderSide: BorderSide(color: color),
    );
    return InputDecoration(
      hintText: hint,
      hintStyle: text(16).copyWith(
        color: dark ? muted : const Color(0xFF4C4740)),
      filled: true,
      fillColor: field,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 17),
      border: border(line),
      enabledBorder: border(line),
      focusedBorder: border(action),
      errorText: error,
      errorMaxLines: 3,
      prefixIcon: prefix,
    );
  }
}

class LoginViewport extends StatelessWidget {
  const LoginViewport({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => AuthBackdrop(
    child: SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) => Center(
          child: SizedBox(
            width: constraints.maxWidth.clamp(0, 390).toDouble(),
            height: constraints.maxHeight,
            child: child,
          ),
        ),
      ),
    ),
  );
}

class LoginHero extends StatelessWidget {
  const LoginHero({super.key, this.pose = BeaverPose.idle});

  /// The beaver guide's pose: idle, oops after an error, thumbs once verified.
  final BeaverPose pose;

  /// What the beaver says on the login entry (the screen's own welcome-back line).
  static const String bubble =
      'Pick up where you left off. A good conversation is waiting.';

  @override
  Widget build(BuildContext context) {
    final colors = LoginColors.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Center(
        child: BeaverGuide(
          key: AuthGuide.guideKey,
          pose: pose,
          size: 120,
          message: bubble,
        ),
      ),
      const SizedBox(height: 18),
      Text(Brand.nameUpper, textAlign: TextAlign.center,
        style: colors.text(16, weight: FontWeight.w700).copyWith(
          color: colors.brand, letterSpacing: 1.3)),
      const SizedBox(height: 8),
      Text('Welcome back.', textAlign: TextAlign.center,
        style: colors.text(34, weight: FontWeight.w500).copyWith(
          height: 1.12, letterSpacing: -1)),
      const SizedBox(height: 22),
    ]);
  }
}

class LoginMethodSelector extends StatelessWidget {
  const LoginMethodSelector({super.key, required this.email,
    required this.onChanged});
  final bool email;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = LoginColors.of(context);
    Widget choice(String label, IconData icon, bool isEmail) {
      final selected = email == isEmail;
      return Expanded(child: Semantics(
        selected: selected,
        child: Container(
          decoration: BoxDecoration(
            color: selected ? colors.selected : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
            boxShadow: selected && !colors.dark ? const [
              BoxShadow(color: Color(0x3033291D), blurRadius: 8,
                offset: Offset(0, 3)),
            ] : null,
          ),
          child: TextButton(
            onPressed: onChanged == null ? null : () => onChanged!(isEmail),
            style: TextButton.styleFrom(
              foregroundColor: selected && colors.dark
                  ? const Color(0xFF1D1A33) : colors.ink,
              disabledForegroundColor: selected
                  ? const Color(0xFF1D1A33).withValues(alpha: .6)
                  : colors.ink.withValues(alpha: .6),
              textStyle: colors.text(15),
              minimumSize: const Size(0, 48),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(icon, size: 18),
              const SizedBox(width: 7),
              Flexible(child: Text(label)),
            ]),
          ),
        ),
      ));
    }
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: colors.track,
        borderRadius: BorderRadius.circular(16),
        boxShadow: colors.dark ? null : const [
          BoxShadow(color: Color(0x1233291D), blurRadius: 12,
            offset: Offset(0, 5)),
        ],
      ),
      child: Row(children: [
        choice('Email', Icons.mail_outline, true),
        const SizedBox(width: 4),
        choice('WhatsApp', Icons.chat_bubble_outline_rounded, false),
      ]),
    );
  }
}

class LoginPrimaryButton extends StatelessWidget {
  const LoginPrimaryButton({super.key, required this.label,
    required this.onPressed, this.loading = false});
  final String label;
  final VoidCallback? onPressed;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final colors = LoginColors.of(context);
    return ElevatedButton(
      onPressed: loading ? null : onPressed,
      style: ElevatedButton.styleFrom(
        backgroundColor: colors.action,
        foregroundColor: colors.onAction,
        disabledBackgroundColor: colors.action.withValues(alpha: .5),
        disabledForegroundColor: colors.onAction.withValues(alpha: .7),
        textStyle: colors.text(15),
        minimumSize: const Size(double.infinity, 54),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Flexible(child: Text(label)),
        const SizedBox(width: 10),
        if (loading)
          SizedBox(width: 18, height: 18, child: CircularProgressIndicator(
            strokeWidth: 2, color: colors.onAction,
            semanticsLabel: 'Sending code'))
        else
          const Icon(Icons.arrow_forward_rounded, size: 18),
      ]),
    );
  }
}
