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

  /// [RESP-SMALL-1 2026-08-21] The extra-small tier. `compactMax` (360) covers
  /// "small phone"; this covers "very small phone" — the ~3x4 inch device a
  /// tester reported, where content ran off screen with nothing to scroll.
  ///
  /// Deliberately NOT added to [ZineWidthClass]: that enum is exhaustively
  /// switched on at ~20 call sites, and with no local Dart compiler a new
  /// variant would surface as ~20 non-exhaustive-switch errors 40-80 minutes
  /// later in CI. A fourth tier that only chrome cares about does not justify
  /// that; [chromeScale] reads the width directly instead.
  static const double xcompactMax = 320;

  static bool isXCompact(BuildContext context) =>
      MediaQuery.sizeOf(context).width < xcompactMax;

  /// Multiplier for FIXED-HEIGHT CHROME — seam strips, tab-strip heights,
  /// header paddings. Chrome is the part of the screen the user cannot scroll,
  /// so on a short device every pixel of it is taken straight out of the
  /// content area.
  ///
  /// Scope note: this is for chrome only. Do NOT reach for it to shrink type —
  /// text scaling is already handled once, app-wide, in `main.dart`'s
  /// MaterialApp `builder` ([RESP-SMALL-1]), and multiplying the two would
  /// compound into unreadably small text on exactly the device this is meant
  /// to help. Body text, list rows and tap targets keep their full size; a
  /// 44px tap target that shrinks to 33px fails accessibility and is harder to
  /// hit on the smallest screen, which is precisely backwards.
  static double chromeScale(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    if (w < xcompactMax) return 0.72;
    if (w < compactMax) return 0.85;
    return 1.0;
  }
}
