import 'package:flutter/material.dart';

/// The Me presentation only; shared app colours and saved theme stay unchanged.
class HfProfileStyle {
  const HfProfileStyle._(this.dark);

  factory HfProfileStyle.of(BuildContext context) =>
      HfProfileStyle._(Theme.of(context).brightness == Brightness.dark);

  final bool dark;
  Color get page => dark ? const Color(0xFF000000) : const Color(0xFFF6F3EE);
  Color get surface => dark ? const Color(0xFF343438) : const Color(0xFFFFFDF9);
  Color get ink => dark ? const Color(0xFFF8F6FF) : const Color(0xFF000000);
  Color get muted => dark ? const Color(0xFFE0DBEB) : const Color(0xFF4C4740);
  Color get line => dark ? const Color(0xFF5C5C66) : const Color(0xFFD8D1C9);
  Color get soft => dark ? const Color(0xFF484850) : const Color(0xFFE8E2DA);
  Color get accent => dark ? const Color(0xFFFFB3CB) : const Color(0xFFB1325F);
  Color get iconTint => dark ? const Color(0xFF4A4267) : const Color(0xFFE9E3FF);
  Color get selected => const Color(0xFFE7E1FF);
  Color get selectedInk => const Color(0xFF1D1A33);

  List<BoxShadow> get cardShadows => [
    BoxShadow(color: Colors.black.withValues(alpha: dark ? 0.22 : 0.06),
        blurRadius: 16, offset: const Offset(0, 5)),
  ];
  List<BoxShadow> get avatarShadows => [
    BoxShadow(color: Colors.black.withValues(alpha: dark ? 0.35 : 0.16),
        blurRadius: 14, offset: const Offset(0, 5)),
  ];
  List<BoxShadow> get navShadows => [
    BoxShadow(color: Colors.black.withValues(alpha: dark ? 0.35 : 0.09),
        blurRadius: 20, offset: const Offset(0, -4)),
  ];

  TextStyle get body => TextStyle(
      fontFamily: 'Roboto', fontSize: 16, height: 1.4, color: ink);
  TextStyle get note => body.copyWith(fontSize: 14, color: muted);
  TextStyle get heading => body.copyWith(fontSize: 18, fontWeight: FontWeight.w500);
  TextStyle get title => body.copyWith(fontSize: 24, fontWeight: FontWeight.w500);

  BoxDecoration get card => BoxDecoration(
    color: surface,
    border: Border.all(color: line),
    borderRadius: BorderRadius.circular(24),
    boxShadow: cardShadows,
  );
}
