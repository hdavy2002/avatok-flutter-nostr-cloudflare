import 'package:flutter/material.dart';

/// Explore-only surfaces; the saved theme and global defaults are unchanged.
class HfExploreStyle {
  const HfExploreStyle._(this.dark);

  factory HfExploreStyle.of(BuildContext context) =>
      HfExploreStyle._(Theme.of(context).brightness == Brightness.dark);

  final bool dark;
  Color get page => dark ? const Color(0xFF000000) : const Color(0xFFF6F3EE);
  Color get surface => dark ? const Color(0xFF343438) : const Color(0xFFFFFDF9);
  Color get ink => dark ? const Color(0xFFF8F6FF) : const Color(0xFF17131F);
  Color get muted => dark ? const Color(0xFFE0DBEB) : const Color(0xFF4C4740);
  Color get line => dark ? const Color(0xFF5C5C66) : const Color(0xFFD8D1C9);
  Color get soft => dark ? const Color(0xFF484850) : const Color(0xFFE8E2DA);
  Color get accent => dark ? const Color(0xFFD1B8FF) : const Color(0xFF7040AD);
  static const call = Color(0xFFF28C28);

  List<BoxShadow> get shadows => [
    BoxShadow(
      color: Colors.black.withValues(alpha: dark ? 0.55 : 0.14),
      blurRadius: 18,
      offset: const Offset(0, 6),
    ),
    if (dark)
      const BoxShadow(color: Color(0x245C5C66), blurRadius: 8),
  ];

  BoxDecoration get card => BoxDecoration(
    color: surface,
    border: Border.all(color: line),
    borderRadius: BorderRadius.circular(28),
    boxShadow: shadows,
  );

  BoxDecoration get imageFrame => BoxDecoration(
    color: Colors.white,
    border: Border.all(color: Colors.white, width: 2),
    borderRadius: BorderRadius.circular(30),
    boxShadow: shadows,
  );
}
