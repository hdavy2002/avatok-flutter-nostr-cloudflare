import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// AvaTOK Dark v2 design tokens.
///
/// Canonical source: `theme/avatok-tokens.json` (mirror of the design bundle
/// `design/black-mobile/AvaTOK App Dark v2.dc.html`). This is the dark-black
/// redesign language — near-black surfaces, hairline borders, soft (blurred)
/// elevation, pale accent cards, multicolor glyphs, colored Chats/Groups/Calls
/// tabs, and platform-native UI typography.
///
/// Every re-skinned screen should pull colors, radii, spacing, type and avatar
/// families from here so the whole app stays consistent as it migrates off the
/// legacy light `Zine` system. Do NOT hard-code hex in screens.
class AD {
  AD._();

  // ---------------------------------------------------------------- surfaces
  /// App / page background — near-black.
  static const bg = Color(0xFFFBF3E2);
  /// Header + footer bars.
  static const headerFooter = Color(0xFF5CB8A6);
  /// Card / list-row surface.
  static const card = Color(0xFFFFFAF0);
  /// Card hover / pressed.
  static const cardHover = Color(0xFFF4E8D2);
  /// Bottom-sheet overlay surface.
  static const overlaySheet = Color(0xFFFFFAF0);
  /// Dropdown menu surface.
  static const menu = Color(0xFFFFFAF0);
  /// Popover surface.
  static const popover = Color(0xFFFFFAF0);
  /// White input field (search dock etc.).
  static const inputField = Color(0xFFFFFAF0);
  /// Modal scrim — black @65%.
  static const scrim = Color(0xA616110D);

  // ------------------------------------------------------------------ border
  static const borderHairline = Color(0xFF16110D);
  static const borderCard = Color(0xFF16110D);
  static const borderControl = Color(0xFF16110D);
  static const borderAvatar = Color(0xFF16110D);

  // -------------------------------------------------------------------- text
  static const textPrimary = Color(0xFF16110D);
  static const textSecondary = Color(0x9916110D); // ink 60%
  static const textTertiary = Color(0x7316110D); // ink 45%
  static const textFaint = Color(0x4D16110D); // ink 30%
  static const textOnInput = Color(0xFF16110D);
  static const placeholderOnWhite = Color(0x7316110D); // ink 45%

  // -------------------------------------------------------------------- tabs
  static const tabChats = Color(0xFF5CB8A6);
  static const tabGroups = Color(0xFFC9316E);
  static const tabCalls = Color(0xFF2E4A8C);
  static const double tabInactiveTintAlpha = 0.22;
  static const tabActiveLabel = Color(0xFFFBF3E2);

  /// Background fill for a colored tab pill given its accent + active state.
  /// Active = full accent; inactive = the accent at 22% over the header bar.
  static Color tabBg(Color accent, bool active) =>
      active ? accent : accent.withValues(alpha: tabInactiveTintAlpha);

  // ------------------------------------------------------------------- icons
  //
  // [UI-PALETTE-1 2026-08-05] COLLAPSED to one neutral + one accent.
  //
  // There used to be eight unrelated icon hues here — search-blue, bell-orange,
  // shield-green, phone-teal, video-purple, camera-pink, emoji-yellow,
  // mic-purple — each picked in isolation. On screen that reads as a toybox:
  // eight competing colours with no meaning attached to any of them, which was
  // one of the concrete findings in UI-AUDIT-2026-08-05.md. Colour should mean
  // something. Here it means exactly one thing: "this is the action".
  //
  // The eight names are KEPT AS ALIASES on purpose. They have ~100 call sites
  // across the app, and rewriting every one of them by hand — with no local
  // compiler to catch a typo — is a far bigger risk than pointing them at the
  // right value. Anything that was decorative becomes neutral; the two things
  // that genuinely are the primary action on their surface (search field
  // affordance, mic) keep the accent. New code should use `iconNeutral` /
  // `iconAccent` directly and NOT reach for the legacy names.
  static const iconNeutral = Color(0xFF16110D);
  static const iconAccent = primaryBadge;       // the single accent, #E8833A

  // NOTE `iconSearch` is NEUTRAL, not accent, despite the name. It is reused as
  // the read/unheard tick colour in the AvaDialer inbox (inbox_list_screen /
  // inbox_thread_screen, where the comments still call it "blue"), so pointing
  // it at the accent turned those ticks orange on a pale-green card. Semantics
  // beat the token's name here.
  static const iconSearch = iconNeutral;
  static const iconBell = iconNeutral;
  static const iconShield = iconNeutral;
  static const iconPhone = iconNeutral;
  static const iconVideo = iconNeutral;
  static const iconCamera = iconNeutral;
  static const iconCameraOnWhite = iconNeutral;
  static const iconClipOnWhite = iconNeutral;
  static const iconEmoji = iconNeutral;
  static const iconMic = iconAccent;
  static const iconStar = iconNeutral;

  // ----------------------------------------------------------------- buttons
  static const primaryBadge = Color(0xFFC9316E);
  static const newGroup = Color(0xFF5CB8A6);
  static const sendActiveBg = Color(0xFFC9316E);
  static const sendActiveInk = Color(0xFFFBF3E2);
  static const micIdleBg = Color(0xFFE9A227);
  static const micIdleInk = Color(0xFF16110D);
  static const destructiveBg = Color(0xFFD33A2C);
  static const destructiveBgHover = Color(0xFFD33A2C);
  static const destructiveInk = Color(0xFFFBF3E2);

  // ------------------------------------------------------------------ status
  static const online = Color(0xFF2E7D68);
  static const outgoingCall = Color(0xFF2E4A8C);
  static const incomingCall = Color(0xFF5CB8A6);
  static const missedCall = Color(0xFFD33A2C);
  static const danger = Color(0xFFD33A2C);
  static const unreadAccent = Color(0xFFC9316E);

  /// Muted-thread bell-slash glyph. Deliberately a BRIGHT red — not the softer
  /// coral `danger` — so a muted thread is unmissable in the list
  /// (owner request 2026-07-14, [ISSUE-MUTE-ICON-RED-1]).
  static const iconMuted = Color(0xFFD33A2C);

  // ------------------------------------------------------------------ brand
  static const brandYoutube = Color(0xFFD33A2C);
  static const brandInstagram = Color(0xFFC9316E);
  static const brandFacebook = Color(0xFF2E4A8C);

  // ------------------------------------------------------------------ radii
  //
  // [UI-RADII-1 2026-08-05] SNAPPED ONTO THE 8 / 12 / 16 SCALE.
  //
  // These eleven values used to be eleven different numbers — 44, 22, 18, 16,
  // 14, 11, 11, 10, 10, 7, 9 — each eyeballed in isolation. Eleven corner radii
  // on one surface is not a scale, it is noise, and it is a large part of why
  // the product read as soft/toy in UI-AUDIT-2026-08-05.md.
  //
  // The names are KEPT (there are ~285 call sites and no local compiler to
  // catch a rename typo) and only the NUMBERS moved, so every existing
  // `AD.rListCard` etc. is snapped in one place with no call-site churn. They
  // now mirror `Msg.rSm` / `rMd` / `rLg` exactly — the literals are repeated
  // rather than imported because `messenger_theme.dart` imports THIS file, so
  // referencing `Msg` here would be a circular import.
  //
  // New code should prefer `Msg.rSm/rMd/rLg` directly.
  /// Device-frame mock only — not a UI surface, so it stays off the scale.
  static const double rPhone = 44;
  static const double rSheet = 16;      // was 22 — sheets are Msg.rLg
  static const double rMenu = 16;       // was 18 — menus are Msg.rLg
  static const double rDialog = 16;     // dialogs are Msg.rLg (unchanged)
  static const double rListCard = 12;   // was 14 — list rows are Msg.rMd
  static const double rStatCard = 12;   // was 11 — Msg.rMd
  static const double rInput = 12;      // was 11 — inputs are Msg.rMd
  static const double rIconButton = 8;  // was 10 — inline control, Msg.rSm
  static const double rTab = 8;         // was 10 — inline control, Msg.rSm
  static const double rChip = 8;        // was 7  — chips are Msg.rSm
  static const double rBadge = 8;       // was 9  — small badge, Msg.rSm

  // ---------------------------------------------------------------- spacing
  static const double screenPad = 20;
  static const double listGutter = 12;
  static const double rowGap = 6;
  static const EdgeInsets rowPadding =
      EdgeInsets.symmetric(horizontal: 12, vertical: 10);
  static const double bubbleGap = 10;
  static const double bubbleAvatarGap = 6;
  static const double footerHeight = 58;

  // --------------------------------------------------------------- elevation
  /// Soft phone-frame drop shadow.
  static const List<BoxShadow> phoneShadow = [
    BoxShadow(color: Color(0xB3000000), offset: Offset(0, 24), blurRadius: 60),
  ];
  /// Bottom-sheet / overlay shadow.
  static const List<BoxShadow> overlayShadow = [
    BoxShadow(color: Color(0xA6000000), offset: Offset(0, 16), blurRadius: 48),
  ];
  /// Dialog shadow.
  static const List<BoxShadow> dialogShadow = [
    BoxShadow(color: Color(0xA6000000), offset: Offset(0, 20), blurRadius: 60),
  ];
  /// Toast / snackbar shadow.
  static const List<BoxShadow> toastShadow = [
    BoxShadow(color: Color(0x8C000000), offset: Offset(0, 8), blurRadius: 30),
  ];

  // ---------------------------------------------------------- chat bubbles
  static const bubbleOutBg = Color(0xFF2E4A8C);
  static const bubbleOutInk = Color(0xFFFBF3E2);
  static const bubbleOutMeta = Color(0xFFFBF3E2);
  static const bubbleOutPlay = Color(0xFFE9A227);
  // [UI-RADII-1 2026-08-05] 14 → 12 (Msg.rMd) so these match the already-
  // migrated `bubble_theme.dart`, which draws the same shape with `Msg.rMd`
  // plus the 4px tail corner. The tail stays at 4 — that IS the tail.
  static const BorderRadius bubbleOutRadius = BorderRadius.only(
    topLeft: Radius.circular(12),
    topRight: Radius.circular(4),
    bottomLeft: Radius.circular(12),
    bottomRight: Radius.circular(12),
  );
  static const bubbleInBg = Color(0xFFFFFAF0);
  static const bubbleInInk = Color(0xFF16110D);
  static const bubbleInMeta = Color(0xFF5C5148);
  static const bubbleInPlay = Color(0xFFC9316E);
  static const BorderRadius bubbleInRadius = BorderRadius.only(
    topLeft: Radius.circular(4),
    topRight: Radius.circular(12),
    bottomLeft: Radius.circular(12),
    bottomRight: Radius.circular(12),
  );
  static const mediaPlaceholderBg = Color(0xFFF0E3CC);
  static const mediaPlaceholderLabel = Color(0xFF5C5148);
  /// [AVAGRP-CARDS-1] (owner decision 2026-07-17, pale-bubbles-on-white):
  /// checked, not replaced — these two were audited for use as a media
  /// LOADING-state fill (`ChatVideoCard`'s pre-thumbnail square) sitting
  /// INSIDE a pale bubble instead of directly on the old dark canvas. Ink-on-
  /// bg contrast is ~3.4:1 (icon/glyph-only content, not body text, so >=3:1
  /// is the relevant bar — WCAG large-text/graphical-object threshold) and
  /// the fill itself is neutral enough not to clash with any of the 12
  /// `kGroupSenderPalette` tints or `kBubbleMine`/`kBubbleTheirs`/`kBubbleAva`.
  /// No new token added.

  // ----------------------------------------------------------- avatar self
  static const selfAvatarBg = Color(0xFFC9316E);
  static const selfAvatarInk = Color(0xFFFBF3E2);

  // ---------------------------------------------------- avatar families ----
  /// Deterministic accent family for a seed (name/uid) — mirrors the mockup's
  /// 10-family rotation. Use [family] to fetch its colors.
  static const List<String> familyOrder = [
    'lilac', 'peach', 'mint', 'butter', 'rose',
    'sky', 'mustard', 'sage', 'aqua', 'terra',
  ];

  static AvatarFamily family(String seed) {
    final key = familyOrder[seed.hashCode.abs() % familyOrder.length];
    return _families[key]!;
  }

  static AvatarFamily familyByName(String name) =>
      _families[name] ?? _families['sky']!;

  static const Map<String, AvatarFamily> _families = {
    'lilac':   AvatarFamily(chipBg: Color(0xFF2E4A8C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E4A8C)),
    'peach':   AvatarFamily(chipBg: Color(0xFFC9316E), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFC9316E)),
    'mint':    AvatarFamily(chipBg: Color(0xFF5CB8A6), chipInk: Color(0xFF16110D), solid: Color(0xFF5CB8A6)),
    'butter':  AvatarFamily(chipBg: Color(0xFFE9A227), chipInk: Color(0xFF16110D), solid: Color(0xFFE9A227)),
    'rose':    AvatarFamily(chipBg: Color(0xFFC9316E), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFC9316E)),
    'sky':     AvatarFamily(chipBg: Color(0xFF2E4A8C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E4A8C)),
    'mustard': AvatarFamily(chipBg: Color(0xFFE9A227), chipInk: Color(0xFF16110D), solid: Color(0xFFE9A227)),
    'sage':    AvatarFamily(chipBg: Color(0xFF2E7D68), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E7D68)),
    'aqua':    AvatarFamily(chipBg: Color(0xFF5CB8A6), chipInk: Color(0xFF16110D), solid: Color(0xFF5CB8A6)),
    'terra':   AvatarFamily(chipBg: Color(0xFFD33A2C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFD33A2C)),
  };
}

/// One avatar accent family: dark chip background + light ink (dark-mode chip),
/// plus the saturated `solid` variant for filled avatar circles.
class AvatarFamily {
  final Color chipBg;
  final Color chipInk;
  final Color solid;
  const AvatarFamily({required this.chipBg, required this.chipInk, required this.solid});
}

/// Native-platform type scale for the dark v2 system.
///
/// [UI-WHATSAPP-STABLE-1] The UI deliberately leaves [TextStyle.fontFamily]
/// unset so Flutter selects the system face (Roboto on Android, SF on Apple
/// platforms). This keeps dense chat text familiar and stable instead of using
/// a rounded display face for every control.
///
/// Hierarchy comes from contrast and a small Regular/Medium weight step, not
/// from bold text throughout the conversation:
///   body          → 400
///   secondary     → 400/500, muted colour
///   contact names → 500
///   screen titles → 700
///   timestamps    → 400, small and muted
///
/// Sizes are whole numbers only — the old half-pixel values were eyeball-
/// tuning, not a stable scale.
class ADText {
  ADText._();
  /// Null intentionally inherits Flutter's platform-native default font.
  static const String? family = null;

  static TextStyle _s(double size, FontWeight w, Color c,
          {double? spacing, double height = 1.2}) =>
      TextStyle(fontFamily: family, fontSize: size, fontWeight: w,
          color: c, letterSpacing: spacing, height: height);

  /// App wordmark / screen title — 22 / 700. The heaviest weight in the app.
  static TextStyle appTitle({Color c = AD.textPrimary}) =>
      _s(22, FontWeight.w700, c, spacing: -0.01 * 22, height: 1.05);
  /// Thread name in header — 16 / 500.
  static TextStyle threadName({Color c = AD.textPrimary}) =>
      _s(16, FontWeight.w500, c);
  /// Chat-row contact name — 15 / 500.
  static TextStyle rowName({Color c = AD.textPrimary}) =>
      _s(15, FontWeight.w500, c);
  /// Chat bubble body — 16 / 400. Slightly larger than the original stable-UI
  /// pass for comfortable reading without restoring global scale inflation.
  static TextStyle bubbleBody({Color c = AD.textPrimary}) =>
      _s(16, FontWeight.w400, c, height: 1.35);
  /// Message preview line — 14 / 400, muted. Sits UNDER rowName in weight,
  /// size and colour, which is what makes the name read as the heading.
  static TextStyle preview({Color c = AD.textSecondary}) =>
      _s(14, FontWeight.w400, c);
  /// Colored tab label — 13 / 500.
  static TextStyle tabLabel({Color c = AD.textPrimary}) =>
      _s(13, FontWeight.w500, c);
  /// Bottom-nav label (active) — 11 / 500.
  static TextStyle navLabelPrimary({Color c = AD.textPrimary}) =>
      _s(11, FontWeight.w500, c);
  /// Bottom-nav label (inactive) — 11 / 500.
  static TextStyle navLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w500, c);
  /// Section header (Pinned / Messages) — 11 / 500, lightly tracked.
  /// Sentence case at the call site; the caps were part of the shouting.
  static TextStyle sectionLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w500, c, spacing: 0.06 * 11);
  /// Timestamp — 12 / 400, muted.
  static TextStyle timestamp({Color c = AD.textTertiary}) =>
      _s(12, FontWeight.w400, c);
  /// Bubble meta (time/ticks) — 11 / 400.
  static TextStyle bubbleMeta({Color c = AD.bubbleOutMeta}) =>
      _s(11, FontWeight.w400, c);
  /// Stat caption — 11 / 400.
  static TextStyle statCaption({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w400, c);
}

// =============================================================================
// Dark v2 component recipes — the dark counterparts of the shared Zine* widgets.
// Use these inside AvaTOK screens instead of ZineButton/ZineCard/etc. so the
// dark re-skin is self-contained (the light Zine widgets stay untouched for the
// apps that haven't migrated yet). Soft/flat elevation and hairline borders.
// =============================================================================

enum AdButtonVariant { primary, teal, danger, ghost }

/// Pill button. primary = orange, teal = group actions, danger = red, ghost = outline.
class AdButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final AdButtonVariant variant;
  final IconData? icon;
  final bool trailingIcon;
  final bool loading;
  final bool fullWidth;
  final double fontSize;
  const AdButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = AdButtonVariant.primary,
    this.icon,
    this.trailingIcon = true,
    this.loading = false,
    this.fullWidth = false,
    this.fontSize = 15,
  });

  Color get _fill => switch (variant) {
        AdButtonVariant.primary => AD.primaryBadge,
        AdButtonVariant.teal => AD.newGroup,
        AdButtonVariant.danger => AD.destructiveBg,
        AdButtonVariant.ghost => AD.card,
      };
  /// [UI-CONTRAST-1 2026-08-05] Foreground ink, chosen PER FILL rather than
  /// "white unless ghost".
  ///
  /// WHY: `primary` fills with `AD.primaryBadge` (#E8833A). White on that is
  /// **2.5:1** — below the WCAG AA minimum of 4.5:1 for body text and below
  /// even the 3:1 large-text floor. This is the app's main call-to-action, so
  /// the single least accessible thing in the product was also the thing every
  /// user is meant to press. `teal` (#2FA98C) is the same story at ~2.9:1.
  ///
  /// Dark ink fixes both without touching the fills, so the buttons keep their
  /// colour identity:
  ///   orange #E8833A + #17171B ink  ≈ 7.1:1
  ///   teal   #2FA98C + #17171B ink  ≈ 6.2:1
  /// `danger` (#C0533F) is a dark fill and genuinely needs white (~5.1:1);
  /// `ghost` is a dark card and keeps `textPrimary`.
  ///
  /// Do NOT "simplify" this back to a single white — the whole point is that
  /// the right ink depends on how light the fill is.
  Color get _fg => switch (variant) {
        AdButtonVariant.primary => AD.textOnInput,
        AdButtonVariant.teal => AD.textOnInput,
        AdButtonVariant.danger => AD.destructiveInk,
        AdButtonVariant.ghost => AD.textPrimary,
      };

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;
    final fg = disabled ? AD.textTertiary : _fg;
    final bg = disabled ? AD.card : _fill;
    final content = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: fontSize + 2, height: fontSize + 2,
            child: CircularProgressIndicator(strokeWidth: 2.4, color: fg),
          )
        else ...[
          if (icon != null && !trailingIcon) ...[
            Icon(icon, size: fontSize + 2, color: fg),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Text(label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: fontSize, color: fg)),
          ),
          if (icon != null && trailingIcon) ...[
            const SizedBox(width: 8),
            Icon(icon, size: fontSize + 2, color: fg),
          ],
        ],
      ],
    );
    return GestureDetector(
      onTap: disabled ? null : onPressed,
      child: Container(
        width: fullWidth ? double.infinity : null,
        // 4px grid (Msg.s1..s6): was 22 / 15|12.
        padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 17 ? 16 : 12),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(100),
          border: variant == AdButtonVariant.ghost || disabled
              ? Border.all(color: AD.borderControl, width: 1)
              : null,
        ),
        child: content,
      ),
    );
  }
}

/// Dark card surface — hairline border, optional tap + soft shadow.
class AdCard extends StatelessWidget {
  final Widget child;
  final Color color;
  final EdgeInsetsGeometry padding;
  final double radius;
  final List<BoxShadow> boxShadow;
  final VoidCallback? onTap;
  const AdCard({
    super.key,
    required this.child,
    this.color = AD.card,
    this.padding = const EdgeInsets.all(16),
    this.radius = AD.rListCard,
    this.boxShadow = const [],
    this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AD.borderControl, width: 1),
        boxShadow: boxShadow,
      ),
      child: child,
    );
    if (onTap == null) return box;
    return GestureDetector(onTap: onTap, behavior: HitTestBehavior.opaque, child: box);
  }
}

/// Filter / action chip. Active = orange fill + check.
class AdChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback? onTap;
  final IconData? icon;
  const AdChip({super.key, required this.label, this.active = false, this.onTap, this.icon});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: active ? AD.primaryBadge : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: active ? AD.primaryBadge : AD.borderControl, width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (active) ...[
            PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 13, color: Colors.white),
            const SizedBox(width: 8),
          ] else if (icon != null) ...[
            Icon(icon, size: 14, color: AD.textSecondary),
            const SizedBox(width: 8),
          ],
          Text(label, style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
              fontSize: 13, color: active ? Colors.white : AD.textSecondary)),
        ]),
      ),
    );
  }
}

enum AdStickerKind { ok, no, hint, plain }

/// Tag / status pill.
class AdSticker extends StatelessWidget {
  final String text;
  final AdStickerKind kind;
  final IconData? icon;
  final VoidCallback? onTap;
  const AdSticker(this.text, {super.key, this.kind = AdStickerKind.plain, this.icon, this.onTap});
  @override
  Widget build(BuildContext context) {
    final (fill, fg) = switch (kind) {
      AdStickerKind.ok => (AD.online, Colors.white),
      AdStickerKind.no => (AD.destructiveBg, Colors.white),
      AdStickerKind.hint => (AD.card, AD.textSecondary),
      AdStickerKind.plain => (AD.card, AD.textPrimary),
    };
    final core = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(text,
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                  fontSize: 11, letterSpacing: 0.2, color: fg)),
        ),
      ]),
    );
    if (onTap == null) return core;
    return GestureDetector(onTap: onTap, child: core);
  }
}

/// Circular back / icon button — transparent on the dark header.
class AdBackButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData? icon;
  const AdBackButton({super.key, this.onTap, this.icon});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap ?? () => Navigator.of(context).maybePop(),
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        width: 40, height: 40,
        child: Center(
          child: PhosphorIcon(
            icon ?? PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
            size: 20, color: AD.textPrimary,
          ),
        ),
      ),
    );
  }
}

/// Error line under a field.
class AdErrorMsg extends StatelessWidget {
  final String text;
  const AdErrorMsg(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold), size: 15, color: AD.danger),
        const SizedBox(width: 8),
        // [UI-MSG-TYPE-1] w700 is for titles; an inline error line is emphasis,
        // not a heading — w600 at 12px.
        Expanded(child: Text(text, style: TextStyle(fontFamily: ADText.family,
            fontWeight: FontWeight.w600, fontSize: 12, color: AD.danger))),
      ]),
    );
  }
}

/// White dark-v2 text field (dark ink on white), with optional lead/trailing cells.
class AdField extends StatefulWidget {
  final TextEditingController? controller;
  final String? label;
  final IconData? labelIcon;
  final String? hint;
  final String? leadText;
  final IconData? leadIcon;
  final Widget? trailing;
  final bool obscureText;
  final bool error;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  final int? maxLength;
  final int? maxLines;
  final int? minLines;
  final TextCapitalization textCapitalization;
  final bool autocorrect;
  final bool enabled;
  final bool readOnly;
  final List<TextInputFormatter>? inputFormatters;
  const AdField({
    super.key,
    this.controller,
    this.label,
    this.labelIcon,
    this.hint,
    this.leadText,
    this.leadIcon,
    this.trailing,
    this.obscureText = false,
    this.error = false,
    this.keyboardType,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
    this.maxLength,
    this.maxLines = 1,
    this.minLines,
    this.textCapitalization = TextCapitalization.none,
    this.autocorrect = false,
    this.enabled = true,
    this.readOnly = false,
    this.inputFormatters,
  });
  @override
  State<AdField> createState() => _AdFieldState();
}

class _AdFieldState extends State<AdField> {
  @override
  Widget build(BuildContext context) {
    final hasLead = widget.leadText != null || widget.leadIcon != null;
    final multiline = widget.maxLines == null || (widget.maxLines ?? 1) > 1;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.label != null) ...[
        Row(children: [
          if (widget.labelIcon != null) ...[
            Icon(widget.labelIcon, size: 14, color: AD.textSecondary),
            const SizedBox(width: 8),
          ],
          Flexible(
            // [UI-CASE-1 2026-08-05] The forced `.toUpperCase()` is gone —
            // shouted field labels were part of the "amateur UI" finding.
            // Callers pass sentence case and it renders as written.
            child: Text(widget.label!,
                style: ADText.sectionLabel(c: AD.textSecondary), overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: 8),
      ],
      Container(
        decoration: BoxDecoration(
          color: widget.enabled ? AD.inputField : AD.card,
          borderRadius: BorderRadius.circular(AD.rInput),
          border: Border.all(color: widget.error ? AD.danger : AD.borderControl, width: 1),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(
          crossAxisAlignment: multiline ? CrossAxisAlignment.start : CrossAxisAlignment.center,
          children: [
            if (hasLead)
              Container(
                width: 46,
                constraints: const BoxConstraints(minHeight: 50),
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  border: Border(right: BorderSide(color: Color(0x22000000), width: 1)),
                ),
                child: widget.leadText != null
                    ? Text(widget.leadText!, style: TextStyle(fontFamily: ADText.family,
                        fontWeight: FontWeight.w600, fontSize: 20, color: AD.textOnInput))
                    : Icon(widget.leadIcon, size: 20, color: AD.textOnInput),
              ),
            Expanded(
              child: TextField(
                controller: widget.controller,
                enabled: widget.enabled,
                readOnly: widget.readOnly,
                obscureText: widget.obscureText,
                keyboardType: widget.keyboardType,
                onChanged: widget.onChanged,
                onSubmitted: widget.onSubmitted,
                autofocus: widget.autofocus,
                maxLength: widget.maxLength,
                maxLines: widget.maxLines,
                minLines: widget.minLines,
                textCapitalization: widget.textCapitalization,
                autocorrect: widget.autocorrect,
                inputFormatters: widget.inputFormatters,
                cursorColor: AD.iconSearch,
                // Locked identity fields must remain legible. Flutter applies
                // the disabled theme color when enabled=false, which is black
                // on the dark locked-card background. Use readOnly for fields
                // that are known but immutable so the normal ink style remains.
                // [UI-MSG-TYPE-1] What the user types is BODY copy → w400.
                // It was w700, which made every input read like a headline.
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w400,
                    fontSize: 15, color: AD.textOnInput),
                decoration: InputDecoration(
                  isDense: true,
                  counterText: '',
                  hintText: widget.hint,
                  hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w400,
                      fontSize: 15, color: AD.placeholderOnWhite),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  filled: false,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
                ),
              ),
            ),
            if (widget.trailing != null)
              Container(
                width: 50,
                constraints: const BoxConstraints(minHeight: 50),
                alignment: Alignment.center,
                child: widget.trailing,
              ),
          ],
        ),
      ),
    ]);
  }
}

/// White search dock — dark ink on white, the dark-v2 search idiom.
///
/// Modelled on `search_screen.dart`'s private `_searchDock`, so the inline
/// search bars on Chats / Groups / Calls all share ONE implementation
/// ([ISSUE-INLINE-SEARCH-1], owner request 2026-07-14). Use this rather than
/// hand-rolling another dock.
///
/// NOTE: `search_screen.dart` and `invite_screen.dart` still carry their own
/// private `_searchDock` copies — they predate this widget and were left alone
/// to keep this change scoped. Migrating them here is a clean follow-up.
///
/// Filtering is expected to be INSTANT — wire [onChanged] straight to a
/// `setState` filter, no debounce. (Debounce belongs only on the full
/// `SearchScreen`, which hits the network.)
class AdSearchDock extends StatefulWidget {
  final TextEditingController controller;
  final String hint;
  final ValueChanged<String> onChanged;
  final bool autofocus;

  /// Extra trailing widget, shown left of the built-in clear button.
  final Widget? trailing;

  /// Show the built-in "x" clear button once there is text.
  final bool showClear;

  const AdSearchDock({
    super.key,
    required this.controller,
    required this.hint,
    required this.onChanged,
    this.autofocus = false,
    this.trailing,
    this.showClear = true,
  });

  @override
  State<AdSearchDock> createState() => _AdSearchDockState();
}

class _AdSearchDockState extends State<AdSearchDock> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
  }

  @override
  void didUpdateWidget(covariant AdSearchDock old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    super.dispose();
  }

  // Rebuilds only this dock so the clear button appears/disappears; the host
  // screen's own filtering is driven by widget.onChanged, not by this.
  void _onText() {
    if (mounted) setState(() {});
  }

  void _clear() {
    widget.controller.clear();
    widget.onChanged('');
    FocusScope.of(context).unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final hasText = widget.controller.text.isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: AD.inputField,
        borderRadius: BorderRadius.circular(AD.rInput),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 18, color: AD.iconSearch),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: widget.controller,
            autofocus: widget.autofocus,
            onChanged: widget.onChanged,
            textInputAction: TextInputAction.search,
            cursorColor: AD.iconSearch,
            style: ADText.rowName(c: AD.textOnInput),
            decoration: InputDecoration(
              isDense: true,
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(vertical: 13),
              hintText: widget.hint,
              hintStyle: ADText.preview(c: AD.placeholderOnWhite),
            ),
          ),
        ),
        if (widget.trailing != null) ...[
          const SizedBox(width: 8),
          widget.trailing!,
        ],
        if (widget.showClear && hasText) ...[
          const SizedBox(width: 8),
          InkWell(
            onTap: _clear,
            borderRadius: BorderRadius.circular(AD.rIconButton),
            child: Padding(
              padding: const EdgeInsets.all(3),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                  size: 16, color: AD.placeholderOnWhite),
            ),
          ),
        ],
      ]),
    );
  }
}
