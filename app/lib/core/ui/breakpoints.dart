import 'dart:math' as math;

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

  // ---------------------------------------------------------------------------
  // [RESP-SHORT-1 2026-08-21] THE HEIGHT AXIS.
  // ---------------------------------------------------------------------------
  //
  // Everything above this line keys off WIDTH, and that misses an entire class
  // of device. The tester's phone is a BlackBerry-style Android QWERTY handset
  // (KEYone/KEY2 class, 1080x1620px at 3:2, ~4.5"): roughly **393 x 590 dp**.
  // Normal width, about two thirds the usual height, because a hardware
  // keyboard occupies the bottom third of the chassis. It therefore classifies
  // `regular`, takes the full 1.22 type bump and gets `chromeScale` 1.0 — every
  // lever [RESP-SMALL-1] and [RESP-SMALL-2] added misses it completely. See
  // Specs/AUDIT-SHORT-SCREEN-2026-08-21.md for the measurements these
  // thresholds come from.
  //
  // Same structural decision as [xcompactMax]: this does NOT become a fourth
  // variant of [ZineWidthClass], and there is deliberately no `ZineHeightClass`
  // enum either. That enum is exhaustively switched on at ~20 call sites and
  // there is no local Dart compiler on this machine, so a new variant surfaces
  // as ~20 non-exhaustive-switch errors 40-80 minutes later in CI. The height
  // helpers read the size directly, exactly as [chromeScale] does.
  //
  // WHICH HEIGHT, AND WHY IT MATTERS. Every helper below reads the RAW
  // `MediaQuery.sizeOf(context).height` — the full window — and deliberately
  // NOT `height - viewInsets.bottom`. Three reasons, in order of how much they
  // would hurt:
  //
  //  1. The tier describes the CHASSIS, not the moment. A phone does not become
  //     a different physical device because a text field took focus.
  //  2. Subtracting the insets would make an ordinary 852dp handset with a
  //     ~300dp soft keyboard read as 552dp, i.e. `short` — so every screen with
  //     a composer would flip tiers the instant the keyboard rose, shrink its
  //     hero and its chrome, and grow them back on dismiss. A visible layout
  //     jump on every keystroke-adjacent interaction, on the majority of
  //     phones, in exchange for nothing.
  //  3. It would be unstable in the other direction too: the value would depend
  //     on which keyboard the user has installed.
  //
  // The one thing raw height does NOT do is tell a caller how much room is left
  // RIGHT NOW. A caller that needs that (a `minHeight`, a sheet cap) must
  // subtract `MediaQuery.viewInsetsOf(context).bottom` itself at the point of
  // use — and clamp the result at 0, because on a 590dp screen that arithmetic
  // goes negative (call_screen.dart's `.clamp(0.0, ...)`, [RESP-SMALL-3]
  // finding 4). These helpers pick a TIER; they do not measure free space.
  //
  // Reference points: 590dp = the KEYone/KEY2 class; 480dp = the genuinely tiny
  // phone; an ordinary modern handset is 780-930dp. 640 is the "short" line
  // because no mainstream phone sits between ~660 and ~780, so the boundary
  // falls in empty space rather than through the middle of a popular device.
  static const double shortMax = 640;
  static const double xshortMax = 520;

  /// Pure form of [isShort] — takes the height directly so it is testable
  /// without pumping a widget, the same way [classify] takes a width.
  static bool isShortHeight(double height) => height < shortMax;

  static bool isShort(BuildContext context) =>
      isShortHeight(MediaQuery.sizeOf(context).height);

  /// Pure form of [heroHeightFraction].
  static double heroHeightFractionFor(double height) {
    if (height < xshortMax) return 0.34;
    if (height < shortMax) return 0.42;
    return 1.0;
  }

  /// The fraction of the viewport a DECORATIVE hero may occupy. 1.0 on a normal
  /// screen, so a caller that adopts this changes nothing on the phones the
  /// design was signed off on; 0.42 when short, 0.34 when very short.
  ///
  /// Intended use is a cap, not a size: `h = min(h, heroHeightFraction(ctx) *
  /// MediaQuery.sizeOf(ctx).height)`, with the width re-derived from the capped
  /// height so the artwork keeps its aspect ratio.
  static double heroHeightFraction(BuildContext context) =>
      heroHeightFractionFor(MediaQuery.sizeOf(context).height);

  /// Pure form of the vertical half of [chromeScaleHV]. Same 1.0 / 0.85 / 0.72
  /// ladder as [chromeScale], so the two axes are directly comparable.
  static double verticalChromeScaleFor(double height) {
    if (height < xshortMax) return 0.72;
    if (height < shortMax) return 0.85;
    return 1.0;
  }

  /// Chrome multiplier that takes the SMALLER of the width and height reliefs,
  /// so a short-but-normal-width phone finally gets some.
  ///
  /// OPT-IN ON PURPOSE. This is a new name rather than a redefinition of
  /// [chromeScale], because folding height into [chromeScale] would silently
  /// change every one of its existing call sites at once, on every short
  /// device, and with no local compiler none of that could be checked before
  /// CI. Migrate call sites one at a time, deliberately.
  ///
  /// Scope note, inherited verbatim from [chromeScale] and if anything MORE
  /// important here:
  ///
  ///  * HEIGHT NEVER SCALES TYPE. Text scaling is already handled once,
  ///    app-wide, in `main.dart`'s MaterialApp `builder` ([RESP-SMALL-1]).
  ///    Multiplying this in on top of that compounds into unreadably small text
  ///    on exactly the device the height tier exists to help — a short screen is
  ///    a reason to remove chrome, never a reason to shrink the words.
  ///  * HEIGHT NEVER SHRINKS TAP TARGETS. A 44px target dropping to 33px fails
  ///    accessibility and is harder to hit on the smallest screen, which is
  ///    precisely backwards.
  ///
  /// Fixed-height chrome only: seam strips, header band heights, tab-strip
  /// padding. Callers that scale a band containing a fixed-size control must
  /// still FLOOR the result so the control cannot overflow it.
  static double chromeScaleHV(BuildContext context) => math.min(
        chromeScale(context),
        verticalChromeScaleFor(MediaQuery.sizeOf(context).height),
      );
}
