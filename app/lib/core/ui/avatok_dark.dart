import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// AvaTOK Dark v2 design tokens.
///
/// Canonical source: `theme/avatok-tokens.json` (mirror of the design bundle
/// `design/black-mobile/AvaTOK App Dark v2.dc.html`). This is the dark-black
/// redesign language — near-black surfaces, hairline borders, soft (blurred)
/// elevation, pale accent cards, multicolor glyphs, colored Chats/Groups/Calls
/// tabs, and Nunito everywhere (weights 400/600/700/800/900).
///
/// Every re-skinned screen should pull colors, radii, spacing, type and avatar
/// families from here so the whole app stays consistent as it migrates off the
/// legacy light `Zine` system. Do NOT hard-code hex in screens.
class AD {
  AD._();

  // ---------------------------------------------------------------- surfaces
  /// App / page background — near-black.
  static const bg = Color(0xFF0B0B0D);
  /// Header + footer bars.
  static const headerFooter = Color(0xFF131316);
  /// Card / list-row surface.
  static const card = Color(0xFF17171B);
  /// Card hover / pressed.
  static const cardHover = Color(0xFF1D1D23);
  /// Bottom-sheet overlay surface.
  static const overlaySheet = Color(0xFF141418);
  /// Dropdown menu surface.
  static const menu = Color(0xFF17171B);
  /// Popover surface.
  static const popover = Color(0xFF1B1B20);
  /// White input field (search dock etc.).
  static const inputField = Color(0xFFFFFFFF);
  /// Modal scrim — black @65%.
  static const scrim = Color(0xA6000000);

  // ------------------------------------------------------------------ border
  static const borderHairline = Color(0xFF232329);
  static const borderCard = Color(0xFF26262D);
  static const borderControl = Color(0xFF2C2C33);
  static const borderAvatar = Color(0xFFFFFFFF);

  // -------------------------------------------------------------------- text
  static const textPrimary = Color(0xFFFFFFFF);
  static const textSecondary = Color(0x99FFFFFF); // white 60%
  static const textTertiary = Color(0x73FFFFFF); // white 45%
  static const textFaint = Color(0x4DFFFFFF); // white 30%
  static const textOnInput = Color(0xFF17171B);
  static const placeholderOnWhite = Color(0x73000000); // black 45%

  // -------------------------------------------------------------------- tabs
  static const tabChats = Color(0xFFE8833A);
  static const tabGroups = Color(0xFF2FA98C);
  static const tabCalls = Color(0xFF8B6FD6);
  static const double tabInactiveTintAlpha = 0.22;
  static const tabActiveLabel = Color(0xFFFFFFFF);

  /// Background fill for a colored tab pill given its accent + active state.
  /// Active = full accent; inactive = the accent at 22% over the header bar.
  static Color tabBg(Color accent, bool active) =>
      active ? accent : accent.withValues(alpha: tabInactiveTintAlpha);

  // ------------------------------------------------------------------- icons
  static const iconSearch = Color(0xFF6FA8E8);
  static const iconBell = Color(0xFFF2A65A);
  static const iconShield = Color(0xFF6FCF97);
  static const iconPhone = Color(0xFF4FD0BD);
  static const iconVideo = Color(0xFFA78BFA);
  static const iconCamera = Color(0xFFE58BB0);
  static const iconCameraOnWhite = Color(0xFFC14E77);
  static const iconClipOnWhite = Color(0xFF3E6CA6);
  static const iconEmoji = Color(0xFFF2C94C);
  static const iconMic = Color(0xFF5B3FB8);
  static const iconStar = Color(0xFFE58BB0);

  // ----------------------------------------------------------------- buttons
  static const primaryBadge = Color(0xFFE8833A);
  static const newGroup = Color(0xFF2FA98C);
  static const sendActiveBg = Color(0xFFCDEBD3);
  static const sendActiveInk = Color(0xFF1C3324);
  static const micIdleBg = Color(0xFFE4DDF7);
  static const micIdleInk = Color(0xFF5B3FB8);
  static const destructiveBg = Color(0xFFC0533F);
  static const destructiveBgHover = Color(0xFFCE5C47);
  static const destructiveInk = Color(0xFFFFFFFF);

  // ------------------------------------------------------------------ status
  static const online = Color(0xFF57B865);
  static const outgoingCall = Color(0xFFF2A65A);
  static const incomingCall = Color(0xFF6FCF97);
  static const missedCall = Color(0xFFE5735C);
  static const danger = Color(0xFFE5735C);
  static const unreadAccent = Color(0xFFF2A65A);

  /// Muted-thread bell-slash glyph. Deliberately a BRIGHT red — not the softer
  /// coral `danger` — so a muted thread is unmissable in the list
  /// (owner request 2026-07-14, [ISSUE-MUTE-ICON-RED-1]).
  static const iconMuted = Color(0xFFFF3B30);

  // ------------------------------------------------------------------ brand
  static const brandYoutube = Color(0xFFC7523F);
  static const brandInstagram = Color(0xFFA94F6F);
  static const brandFacebook = Color(0xFF3E6CA6);

  // ------------------------------------------------------------------ radii
  static const double rPhone = 44;
  static const double rSheet = 22;
  static const double rMenu = 18;
  static const double rDialog = 16;
  static const double rListCard = 14;
  static const double rStatCard = 11;
  static const double rInput = 11;
  static const double rIconButton = 10;
  static const double rTab = 10;
  static const double rChip = 7;
  static const double rBadge = 9;

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
  static const bubbleOutBg = Color(0xFFCDEBD3);
  static const bubbleOutInk = Color(0xFF1C3324);
  static const bubbleOutMeta = Color(0xFF567E63);
  static const bubbleOutPlay = Color(0xFF3E8E5A);
  static const BorderRadius bubbleOutRadius = BorderRadius.only(
    topLeft: Radius.circular(14),
    topRight: Radius.circular(4),
    bottomLeft: Radius.circular(14),
    bottomRight: Radius.circular(14),
  );
  static const bubbleInBg = Color(0xFFE6E3F6);
  static const bubbleInInk = Color(0xFF2A2640);
  static const bubbleInMeta = Color(0xFF7B76A0);
  static const bubbleInPlay = Color(0xFF6A63B8);
  static const BorderRadius bubbleInRadius = BorderRadius.only(
    topLeft: Radius.circular(4),
    topRight: Radius.circular(14),
    bottomLeft: Radius.circular(14),
    bottomRight: Radius.circular(14),
  );
  static const mediaPlaceholderBg = Color(0xFFD9DCE6);
  static const mediaPlaceholderLabel = Color(0xFF70778C);

  // ----------------------------------------------------------- avatar self
  static const selfAvatarBg = Color(0xFFE8833A);
  static const selfAvatarInk = Color(0xFFFFFFFF);

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
    'lilac':   AvatarFamily(chipBg: Color(0xFF3A2F63), chipInk: Color(0xFFCBBCF2), solid: Color(0xFF6E5BA8)),
    'peach':   AvatarFamily(chipBg: Color(0xFF59392A), chipInk: Color(0xFFF2B98E), solid: Color(0xFFC07A4E)),
    'mint':    AvatarFamily(chipBg: Color(0xFF274536), chipInk: Color(0xFFA5E3C2), solid: Color(0xFF4E9A6E)),
    'butter':  AvatarFamily(chipBg: Color(0xFF544625), chipInk: Color(0xFFEBD48A), solid: Color(0xFFA98B34)),
    'rose':    AvatarFamily(chipBg: Color(0xFF553144), chipInk: Color(0xFFF0B3C9), solid: Color(0xFFB76A85)),
    'sky':     AvatarFamily(chipBg: Color(0xFF2A425C), chipInk: Color(0xFFA8CBEE), solid: Color(0xFF5583B0)),
    'mustard': AvatarFamily(chipBg: Color(0xFF544625), chipInk: Color(0xFFEBC575), solid: Color(0xFFB08A34)),
    'sage':    AvatarFamily(chipBg: Color(0xFF38462B), chipInk: Color(0xFFC2DBA0), solid: Color(0xFF7A9455)),
    'aqua':    AvatarFamily(chipBg: Color(0xFF1E4A44), chipInk: Color(0xFF8AE3D6), solid: Color(0xFF3E9E90)),
    'terra':   AvatarFamily(chipBg: Color(0xFF54332A), chipInk: Color(0xFFF0A886), solid: Color(0xFFB06A4A)),
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

/// Nunito type scale for the dark v2 system. All weights are bundled
/// (400/600/700/800/900 — see app/pubspec.yaml).
class ADText {
  ADText._();
  static const String family = 'Nunito';

  static TextStyle _s(double size, FontWeight w, Color c,
          {double? spacing, double height = 1.2}) =>
      TextStyle(fontFamily: family, fontSize: size, fontWeight: w,
          color: c, letterSpacing: spacing, height: height);

  /// App wordmark / screen title — 22 / 900.
  static TextStyle appTitle({Color c = AD.textPrimary}) =>
      _s(22, FontWeight.w900, c, spacing: -0.01 * 22, height: 1.05);
  /// Thread name in header — 15 / 800.
  static TextStyle threadName({Color c = AD.textPrimary}) =>
      _s(15, FontWeight.w800, c);
  /// Chat-row name — 14 / 800.
  static TextStyle rowName({Color c = AD.textPrimary}) =>
      _s(14, FontWeight.w800, c);
  /// Chat bubble body — 13.5 / 600.
  static TextStyle bubbleBody({Color c = AD.textPrimary}) =>
      _s(13.5, FontWeight.w600, c, height: 1.35);
  /// Message preview line — 12.5 / 600.
  static TextStyle preview({Color c = AD.textSecondary}) =>
      _s(12.5, FontWeight.w600, c);
  /// Colored tab label — 13 / 800.
  static TextStyle tabLabel({Color c = AD.textPrimary}) =>
      _s(13, FontWeight.w800, c);
  /// Bottom-nav label (active) — 11.5 / 800.
  static TextStyle navLabelPrimary({Color c = AD.textPrimary}) =>
      _s(11.5, FontWeight.w800, c);
  /// Bottom-nav label — 11 / 700.
  static TextStyle navLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w700, c);
  /// Section header (PINNED / MESSAGES) — 11 / 800 uppercase.
  static TextStyle sectionLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w800, c, spacing: 0.08 * 11);
  /// Timestamp — 10.5 / 700.
  static TextStyle timestamp({Color c = AD.textTertiary}) =>
      _s(10.5, FontWeight.w700, c);
  /// Bubble meta (time/ticks) — 9.5 / 700.
  static TextStyle bubbleMeta({Color c = AD.bubbleOutMeta}) =>
      _s(9.5, FontWeight.w700, c);
  /// Stat caption — 9 / 700.
  static TextStyle statCaption({Color c = AD.textTertiary}) =>
      _s(9, FontWeight.w700, c);
}

// =============================================================================
// Dark v2 component recipes — the dark counterparts of the shared Zine* widgets.
// Use these inside AvaTOK screens instead of ZineButton/ZineCard/etc. so the
// dark re-skin is self-contained (the light Zine widgets stay untouched for the
// apps that haven't migrated yet). Soft/flat elevation, hairline borders, Nunito.
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
  Color get _fg => variant == AdButtonVariant.ghost ? AD.textPrimary : Colors.white;

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
            const SizedBox(width: 9),
          ],
          Flexible(
            child: Text(label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
                    fontSize: fontSize, color: fg)),
          ),
          if (icon != null && trailingIcon) ...[
            const SizedBox(width: 9),
            Icon(icon, size: fontSize + 2, color: fg),
          ],
        ],
      ],
    );
    return GestureDetector(
      onTap: disabled ? null : onPressed,
      child: Container(
        width: fullWidth ? double.infinity : null,
        padding: EdgeInsets.symmetric(horizontal: 22, vertical: fontSize >= 17 ? 15 : 12),
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
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: active ? AD.primaryBadge : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: active ? AD.primaryBadge : AD.borderControl, width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (active) ...[
            PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 13, color: Colors.white),
            const SizedBox(width: 6),
          ] else if (icon != null) ...[
            Icon(icon, size: 14, color: AD.textSecondary),
            const SizedBox(width: 6),
          ],
          Text(label, style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
              fontSize: 12.5, color: active ? Colors.white : AD.textSecondary)),
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
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(text.toUpperCase(),
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
                  fontSize: 11, letterSpacing: 0.4, color: fg)),
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
      padding: const EdgeInsets.only(top: 9),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold), size: 15, color: AD.danger),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: TextStyle(fontFamily: ADText.family,
            fontWeight: FontWeight.w700, fontSize: 12, color: AD.danger))),
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
            const SizedBox(width: 7),
          ],
          Flexible(
            child: Text(widget.label!.toUpperCase(),
                style: ADText.sectionLabel(c: AD.textSecondary), overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: 9),
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
                        fontWeight: FontWeight.w800, fontSize: 20, color: AD.textOnInput))
                    : Icon(widget.leadIcon, size: 20, color: AD.textOnInput),
              ),
            Expanded(
              child: TextField(
                controller: widget.controller,
                enabled: widget.enabled,
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
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700,
                    fontSize: 15, color: AD.textOnInput),
                decoration: InputDecoration(
                  isDense: true,
                  counterText: '',
                  hintText: widget.hint,
                  hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
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
          const SizedBox(width: 6),
          widget.trailing!,
        ],
        if (widget.showClear && hasText) ...[
          const SizedBox(width: 6),
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
