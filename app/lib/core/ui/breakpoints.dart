import 'package:flutter/material.dart';

/// RESPUI-3: width breakpoints so screens key spacing/type off device class
/// instead of hard-coded px. Thresholds per
/// Specs/MULTI-ACCOUNT-AND-RESPONSIVE-UI-PLAN-2026-07-04.md Part 2 — compact
/// <360dp (small phones, e.g. reported squeezed sign-in), regular 360–600dp
/// (typical phones), expanded >600dp (tablets/foldables/desktop).
///
/// [UI-ZINE-SPLIT-1 2026-08-05] These two types used to live inside
/// `core/ui/zine.dart`, the LIGHT design-system token file. They are pure
/// layout utilities — nothing here has anything to do with colour — so every
/// screen that wanted a responsive gutter had to import the whole light
/// palette, which is one of the reasons `Zine.*` kept leaking back into
/// already-migrated dark screens. The class names are deliberately UNCHANGED
/// so no call site had to move.
enum ZineWidthClass { compact, regular, expanded }

class ZineBreakpoints {
  ZineBreakpoints._();

  static const double compactMax = 360;
  static const double regularMax = 600;

  static ZineWidthClass classify(double width) {
    if (width < compactMax) return ZineWidthClass.compact;
    if (width < regularMax) return ZineWidthClass.regular;
    return ZineWidthClass.expanded;
  }

  static ZineWidthClass of(BuildContext context) =>
      classify(MediaQuery.sizeOf(context).width);

  /// Horizontal page padding — tightens on compact widths so content isn't
  /// squeezed further by wide fixed gutters.
  static double pagePadding(BuildContext context) => switch (of(context)) {
        ZineWidthClass.compact => 16,
        ZineWidthClass.regular => 24,
        ZineWidthClass.expanded => 32,
      };

  /// Vertical rhythm unit — spacing ramp keys off this instead of fixed px.
  static double spacingUnit(BuildContext context) => switch (of(context)) {
        ZineWidthClass.compact => 12,
        ZineWidthClass.regular => 16,
        ZineWidthClass.expanded => 20,
      };

  /// Hero/title type-size ramp (e.g. ZineMarkTitle fontSize on the sign-in /
  /// onboarding screens) — smaller ceiling on compact widths so a 36px hero
  /// title doesn't force wraps/overflow at high text scale on a <360dp phone.
  static double heroTextSize(BuildContext context, {double regular = 36}) =>
      switch (of(context)) {
        ZineWidthClass.compact => regular - 6,
        ZineWidthClass.regular => regular,
        ZineWidthClass.expanded => regular + 4,
      };
}
