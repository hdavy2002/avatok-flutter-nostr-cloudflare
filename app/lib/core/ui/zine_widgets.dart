import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../font_scale.dart';
import 'avatok_dark.dart';
import 'messenger_theme.dart';

// =============================================================================
// Shared component recipes — DARK (AvaTOK Dark v2).
//
// [UI-ZINE-DARK-1 2026-08-05] These widgets keep their historical `Zine*` names
// because ~700 call sites use them, but they are NO LONGER light-themed. Every
// surface, border, shadow, radius and type style now comes from `AD` /
// `ADText` / `Msg`.
//
// WHY: this file was the last thing still painting the old cream-paper design
// system. Screens migrated to `AD.bg` (near-black) were drawing near-WHITE
// `ZineCard`s with dark-brown borders and hard offset shadows on top of a
// near-black page — a live, visible regression on every part-migrated screen.
//
// Rules followed here:
//   * radii are Msg.rSm / rMd / rLg only; Msg.rPill is reserved for genuine
//     pills (chips, tags, status dots, the toggle track, round icon buttons)
//   * borders are 1px hairlines, never 2.5px ink
//   * shadows are Msg.none by default, Msg.lift for genuinely floating things.
//     The old HARD offset shadows are gone — they were a paper idiom
//   * motion is Msg.fast / base / slow
//   * icons are Phosphor
//
// PUBLIC API IS UNCHANGED. Every class name, constructor and parameter is the
// same as before, so no call site had to move. This is a re-skin.
// =============================================================================

// ---------------------------------------------------------------- type helpers
// Thin wrappers over ADText so nothing in this file reaches for the light
// `ZineText` scale. Metrics (size/height/tracking) are deliberately kept close
// to the originals: this file feeds FIXED-height bands (see ZineAppBar), so a
// type change that grows a line box would throw a RenderFlex overflow.

TextStyle _tHero(double size, [Color c = AD.textPrimary]) => ADText.appTitle(c: c)
    .copyWith(fontSize: size, height: 1.08, letterSpacing: -0.02 * size);

TextStyle _tTitle([Color c = AD.textPrimary]) => ADText.threadName(c: c);

TextStyle _tButton(double size, Color c) =>
    ADText.rowName(c: c).copyWith(fontSize: size, height: 1.0, letterSpacing: -0.2);

TextStyle _tSub({double size = 15, Color c = AD.textSecondary}) =>
    ADText.preview(c: c).copyWith(fontSize: size, height: 1.42);

TextStyle _tInput({double size = 16, Color c = AD.textPrimary}) =>
    ADText.bubbleBody(c: c).copyWith(fontSize: size, letterSpacing: -0.18);

TextStyle _tKicker([Color c = AD.textTertiary]) => ADText.sectionLabel(c: c);

TextStyle _tTag({double size = 12, Color c = AD.textPrimary}) =>
    ADText.tabLabel(c: c).copyWith(fontSize: size, letterSpacing: 0.02 * size);

TextStyle _tLink({double size = 13, Color c = Msg.accent}) =>
    ADText.rowName(c: c).copyWith(fontSize: size);

/// Readable ink for an arbitrary caller-supplied fill.
///
/// Call sites pass every kind of accent — the pale legacy poster colours
/// (`Zine.lime`, `Zine.blue`, …) as well as the saturated dark-v2 tokens — so
/// this cannot be a fixed colour. Luminance decides: dark ink on a light fill,
/// white on a dark one.
Color _inkOn(Color fill) =>
    fill.computeLuminance() > 0.5 ? AD.textOnInput : Colors.white;

/// Sentence case for a display label.
///
/// [UI-ZINE-DARK-1] Replaces the `.toUpperCase()` this file used to apply to
/// every field label, tag and sticker. Call sites pass lowercase strings
/// ('email', 'password', 'available'), so simply dropping the transform would
/// render them lowercase; this capitalises the first letter and leaves the rest
/// of the string exactly as the caller wrote it (so 'AI', 'SMS' and the like
/// survive intact).
String _sentence(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

/// Tap wrapper. Renders [child] inside a bordered box; on press the box shifts
/// 1px and swaps to its pressed fill.
class ZinePressable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final Color color;
  final Color? pressedColor;
  final BorderRadius radius;
  final List<BoxShadow> boxShadow;
  final double borderWidth;
  final Color borderColor;
  final EdgeInsetsGeometry padding;
  const ZinePressable({
    super.key,
    required this.child,
    this.onTap,
    this.color = AD.card,
    this.pressedColor,
    this.radius = const BorderRadius.all(Radius.circular(Msg.rMd)),
    this.boxShadow = Msg.none,
    this.borderWidth = 2,
    this.borderColor = AD.borderControl,
    this.padding = EdgeInsets.zero,
  });
  @override
  State<ZinePressable> createState() => _ZinePressableState();
}

class _ZinePressableState extends State<ZinePressable> {
  bool _down = false;
  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    final reduce = MediaQuery.of(context).disableAnimations;
    final dx = _down && enabled ? 1.0 : 0.0;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: enabled ? (_) => setState(() => _down = true) : null,
      onTapCancel: enabled ? () => setState(() => _down = false) : null,
      onTapUp: enabled ? (_) => setState(() => _down = false) : null,
      onTap: widget.onTap,
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : Msg.fast,
        curve: Msg.curve,
        transform: Matrix4.translationValues(dx, dx, 0),
        padding: widget.padding,
        decoration: BoxDecoration(
          color: _down && enabled ? (widget.pressedColor ?? widget.color) : widget.color,
          borderRadius: widget.radius,
          border: Border.all(color: widget.borderColor, width: widget.borderWidth),
          boxShadow: _down && enabled ? Msg.none : widget.boxShadow,
        ),
        child: widget.child,
      ),
    );
  }
}

enum ZineButtonVariant { lime, blue, coral, ghost }

/// Primary button. `lime` is the accent (orange) action — ONE per screen.
class ZineButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final ZineButtonVariant variant;
  final IconData? icon;
  final bool trailingIcon;
  final bool loading;
  final bool fullWidth;
  final double fontSize;
  const ZineButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = ZineButtonVariant.lime,
    this.icon,
    this.trailingIcon = true,
    this.loading = false,
    this.fullWidth = false,
    this.fontSize = 19,
  });

  // The variant names are historical (they were poster-paint names). What each
  // one MEANS is unchanged: lime = the primary action, blue = a secondary/
  // grouping action, coral = destructive, ghost = outline.
  Color get _fill => switch (variant) {
        ZineButtonVariant.lime => AD.primaryBadge,
        ZineButtonVariant.blue => AD.newGroup,
        ZineButtonVariant.coral => AD.destructiveBg,
        ZineButtonVariant.ghost => AD.card,
      };
  Color get _fg => variant == ZineButtonVariant.ghost ? AD.textPrimary : Colors.white;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;
    final fg = disabled ? AD.textTertiary : _fg;
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
            const SizedBox(width: Msg.s2),
          ],
          Flexible(
            child: Text(label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: _tButton(fontSize, fg)),
          ),
          if (icon != null && trailingIcon) ...[
            const SizedBox(width: Msg.s2),
            Icon(icon, size: fontSize + 2, color: fg),
          ],
        ],
      ],
    );
    if (disabled) {
      return Container(
        width: fullWidth ? double.infinity : null,
        padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 21 ? 17 : 14),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl, width: 2),
        ),
        child: content,
      );
    }
    return ZinePressable(
      onTap: onPressed,
      color: _fill,
      borderColor: variant == ZineButtonVariant.ghost ? AD.borderControl : _fill,
      radius: Msg.brMd,
      padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 21 ? 17 : 14),
      child: content,
    );
  }
}

/// Card: card surface, 1px hairline border, 16px radius, flat.
class ZineCard extends StatelessWidget {
  final Widget child;
  final Color color;
  final EdgeInsetsGeometry padding;
  final double radius;
  final List<BoxShadow> boxShadow;
  final VoidCallback? onTap;
  const ZineCard({
    super.key,
    required this.child,
    this.color = AD.card,
    this.padding = const EdgeInsets.all(Msg.s4),
    this.radius = Msg.rLg,
    this.boxShadow = Msg.none,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    if (onTap != null) {
      return ZinePressable(
        onTap: onTap, color: color, padding: padding,
        pressedColor: color == AD.card ? AD.cardHover : null,
        radius: BorderRadius.circular(radius), boxShadow: boxShadow,
        child: child,
      );
    }
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AD.borderControl, width: 2),
        boxShadow: boxShadow,
      ),
      child: child,
    );
  }
}

/// Icon badge preceding a card title: 34px, accent fill, hairline border.
class ZineIconBadge extends StatelessWidget {
  final IconData icon;
  final Color color;
  final double size;
  const ZineIconBadge({super.key, required this.icon, this.color = AD.newGroup, this.size = 34});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: size, height: size,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(Msg.rSm),
        border: Border.all(color: AD.borderControl, width: 2),
      ),
      child: Icon(icon, size: size * 0.53, color: _inkOn(color)),
    );
  }
}

/// Card head row: icon badge + title + optional right-hand tag.
class ZineCardHead extends StatelessWidget {
  final IconData icon;
  final Color accent;
  final String title;
  final String? tag;
  const ZineCardHead({super.key, required this.icon, required this.title, this.accent = AD.newGroup, this.tag});
  @override
  Widget build(BuildContext context) {
    return Row(children: [
      ZineIconBadge(icon: icon, color: accent),
      const SizedBox(width: Msg.s3),
      Expanded(child: Text(title, style: _tTitle())),
      if (tag != null)
        Text(_sentence(tag!), style: _tTag(size: 11, c: AD.textTertiary)),
    ]);
  }
}

/// Text field: dark card surface, hairline border, optional accent lead cell.
class ZineField extends StatefulWidget {
  final TextEditingController? controller;
  final String? label;
  final IconData? labelIcon;
  final String? hint;
  /// Leading cell content: a short string ("@", "$") or an icon.
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
  // RESPUI-2: keeps this field visible above the keyboard when focused —
  // matters most on short screens where the default 20px isn't enough
  // clearance once other fields/buttons are stacked below it.
  final EdgeInsets scrollPadding;
  const ZineField({
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
    this.scrollPadding = const EdgeInsets.all(80),
  });
  @override
  State<ZineField> createState() => _ZineFieldState();
}

class _ZineFieldState extends State<ZineField> {
  final _focus = FocusNode();
  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final focused = _focus.hasFocus;
    // The old design signalled focus/error with a coloured HARD offset shadow.
    // On the dark surface that reads as a smear, so state now lives in the
    // border colour — the standard dark-v2 idiom (see AdField).
    final borderColor = widget.error
        ? AD.danger
        : focused
            ? Msg.accent
            : AD.borderControl;
    final reduce = MediaQuery.of(context).disableAnimations;
    final hasLead = widget.leadText != null || widget.leadIcon != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.label != null) ...[
        Row(children: [
          if (widget.labelIcon != null) ...[
            Icon(widget.labelIcon, size: 14, color: AD.textSecondary),
            const SizedBox(width: Msg.s2),
          ],
          Flexible(
            child: Text(_sentence(widget.label!),
                style: _tKicker(), overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: Msg.s2),
      ],
      AnimatedContainer(
        duration: reduce ? Duration.zero : Msg.fast,
        curve: Msg.curve,
        decoration: BoxDecoration(
          color: widget.enabled ? AD.card : AD.headerFooter,
          borderRadius: Msg.brMd,
          border: Border.all(color: borderColor, width: 2),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(crossAxisAlignment: (widget.maxLines == null || widget.maxLines! > 1) ? CrossAxisAlignment.start : CrossAxisAlignment.center, children: [
          if (hasLead)
            Container(
              width: 50,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                color: AD.primaryBadge,
                border: Border(right: BorderSide(color: AD.borderControl, width: 1)),
              ),
              alignment: Alignment.center,
              child: widget.leadText != null
                  ? Text(widget.leadText!,
                      style: const TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600, fontSize: 22, color: Colors.white))
                  : Icon(widget.leadIcon, size: 22, color: Colors.white),
            ),
          Expanded(
            child: TextField(
              controller: widget.controller,
              focusNode: _focus,
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
              scrollPadding: widget.scrollPadding,
              cursorColor: Msg.accent,
              style: _tInput(),
              decoration: InputDecoration(
                isDense: true,
                counterText: '',
                hintText: widget.hint,
                hintStyle: _tInput(c: AD.textFaint),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                contentPadding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
              ),
            ),
          ),
          if (widget.trailing != null)
            Container(
              width: 52,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                border: Border(left: BorderSide(color: AD.borderControl, width: 1)),
              ),
              alignment: Alignment.center,
              child: widget.trailing,
            ),
        ]),
      ),
    ]);
  }
}

/// Error line under a field.
class ZineErrorMsg extends StatelessWidget {
  final String text;
  const ZineErrorMsg(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Msg.s2),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.regular), size: 15, color: AD.danger),
        const SizedBox(width: Msg.s1),
        Expanded(child: Text(text, style: _tTag(size: 12, c: AD.danger))),
      ]),
    );
  }
}

/// Filter / segmented chip. Active = accent fill + check.
class ZineChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback? onTap;
  const ZineChip({super.key, required this.label, this.active = false, this.onTap});
  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap,
      color: active ? AD.primaryBadge : AD.card,
      borderColor: active ? AD.primaryBadge : AD.borderControl,
      // A chip IS one of the shapes Msg.rPill is reserved for.
      radius: Msg.brPill,
      boxShadow: Msg.none,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (active) ...[
          PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.regular), size: 13, color: Colors.white),
          const SizedBox(width: Msg.s1),
        ],
        Text(label,
            style: _tTag(size: 12, c: active ? Colors.white : AD.textSecondary)),
      ]),
    );
  }
}

enum ZineStickerKind { ok, no, hint, plain }

/// Sticker / tag pill — availability states, suggestion chips, eyebrows.
class ZineSticker extends StatelessWidget {
  final String text;
  final ZineStickerKind kind;
  final IconData? icon;
  final VoidCallback? onTap;
  const ZineSticker(this.text, {super.key, this.kind = ZineStickerKind.plain, this.icon, this.onTap});
  @override
  Widget build(BuildContext context) {
    final (fill, fg) = switch (kind) {
      ZineStickerKind.ok => (AD.online, Colors.white),
      ZineStickerKind.no => (AD.destructiveBg, Colors.white),
      ZineStickerKind.hint => (AD.card, AD.textSecondary),
      ZineStickerKind.plain => (AD.card, AD.textPrimary),
    };
    final hint = kind == ZineStickerKind.hint;
    final core = Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: fill,
        // A tag IS one of the shapes Msg.rPill is reserved for.
        borderRadius: Msg.brPill,
        border: Border.all(color: hint ? AD.borderHairline : AD.borderControl, width: 2),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: Msg.s1),
        ],
        Flexible(
          child: Text(_sentence(text),
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: _tTag(size: 12, c: fg)),
        ),
      ]),
    );
    if (onTap == null) return core;
    return GestureDetector(onTap: onTap, child: core);
  }
}

/// Back / icon button: 42px circle, card fill, hairline border.
class ZineBackButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData? icon;
  const ZineBackButton({super.key, this.onTap, this.icon});
  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap ?? () => Navigator.of(context).maybePop(),
      pressedColor: AD.cardHover,
      // A round icon button is genuinely round.
      radius: Msg.brPill,
      child: SizedBox(
        width: 42, height: 42,
        child: Center(
          child: PhosphorIcon(
            icon ?? PhosphorIcons.arrowLeft(PhosphorIconsStyle.regular),
            size: 20, color: AD.textPrimary,
          ),
        ),
      ),
    );
  }
}

/// Step indicator: pip row + "Step n / m" label.
class ZineStepPips extends StatelessWidget {
  final int total;
  final int active; // 1-based
  const ZineStepPips({super.key, required this.total, required this.active});
  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      for (var i = 1; i <= total; i++) ...[
        Container(
          width: 9, height: 9,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: i == active ? AD.primaryBadge : AD.card,
            border: Border.all(color: AD.borderControl, width: 2),
          ),
        ),
        const SizedBox(width: Msg.s2),
      ],
      const SizedBox(width: Msg.s1),
      Text('Step $active / $total', style: _tKicker()),
    ]);
  }
}

/// Halftone dot patch — decorative texture block.
class ZineDotPatch extends StatelessWidget {
  final double width;
  final double height;
  final double opacity;
  const ZineDotPatch({super.key, this.width = 70, this.height = 56, this.opacity = 0.8});
  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: opacity,
      child: CustomPaint(size: Size(width, height), painter: _DotsPainter()),
    );
  }
}

class _DotsPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // Dots must be LIGHTER than the page now, not darker.
    final p = Paint()..color = AD.textFaint;
    const step = 15.0;
    for (double y = 2; y < size.height; y += step) {
      for (double x = 2; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 1.5, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Tape strip: translucent accent, slight rotation. One per screen.
class ZineTape extends StatelessWidget {
  final double width;
  final double height;
  final double angleDeg;
  const ZineTape({super.key, this.width = 92, this.height = 25, this.angleDeg = -4});
  @override
  Widget build(BuildContext context) {
    return Transform.rotate(
      angle: angleDeg * math.pi / 180,
      child: Container(
        width: width, height: height,
        decoration: BoxDecoration(
          color: AD.primaryBadge.withValues(alpha: 0.35),
          border: const Border(
            left: BorderSide(color: AD.borderControl, width: 1),
            right: BorderSide(color: AD.borderControl, width: 1),
          ),
        ),
      ),
    );
  }
}

/// The AvaTOK mark (Λ + accent dot) — used inside the crest.
class ZineLogoMark extends StatelessWidget {
  final double size;
  const ZineLogoMark({super.key, this.size = 58});
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size, height: size * 0.92,
      child: CustomPaint(painter: _ZineLogoPainter()),
    );
  }
}

class _ZineLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size s) {
    final stroke = s.width * 0.185;
    final p = Paint()
      ..color = AD.textPrimary
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round;
    final path = Path()
      ..moveTo(stroke * 0.6, s.height - stroke * 0.6)
      ..lineTo(s.width / 2, stroke * 0.7)
      ..lineTo(s.width - stroke * 0.6, s.height - stroke * 0.6);
    canvas.drawPath(path, p);
    // NOTE: this dot was a hard-coded 0xFFFF5350 red. Re-pointed at the brand
    // accent token so it can't drift from the rest of the app.
    canvas.drawCircle(
        Offset(s.width / 2, s.height * 0.68), s.width * 0.07, Paint()..color = AD.primaryBadge);
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Hero crest: circle badge holding the logo, with tape on top, a dot patch
/// behind a corner, and an accent star beside it.
class ZineCrest extends StatelessWidget {
  final double size;
  final Widget? child;
  const ZineCrest({super.key, this.size = 116, this.child});
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size + 68, height: size + 24,
      child: Stack(alignment: Alignment.center, clipBehavior: Clip.none, children: [
        Positioned(
          right: 0, bottom: -6,
          child: ZineDotPatch(width: size * 0.6, height: size * 0.48),
        ),
        Container(
          width: size, height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: AD.newGroup,
            border: Border.all(color: AD.borderControl, width: 2),
            boxShadow: Msg.lift,
          ),
          child: Center(child: child ?? ZineLogoMark(size: size * 0.5)),
        ),
        Positioned(top: -10, child: ZineTape(width: size * 0.8)),
        Positioned(
          left: 2, top: 10,
          child: PhosphorIcon(PhosphorIcons.starFour(PhosphorIconsStyle.fill), size: 22, color: AD.primaryBadge),
        ),
      ]),
    );
  }
}

/// Title with the brand `.mark` highlighter stripe behind ONE word.
/// Usage: ZineMarkTitle(pre: 'Pick your ', mark: 'handle').
class ZineMarkTitle extends StatelessWidget {
  final String pre;
  final String mark;
  final String post;
  final double fontSize;
  final Color markColor;
  final TextAlign textAlign;
  /// RESPUI-11: optional line clamp + overflow handling. Null (the default)
  /// preserves every existing call site's unbounded-wrap behaviour (hero
  /// titles on onboarding/sign-in screens, which sit inside a scrollable
  /// column and are fine wrapping to 2+ lines). Callers that place this
  /// inside a FIXED-height band (e.g. ZineAppBar's title slot) must pass
  /// maxLines so a long title at high OS text-scale can't blow past that
  /// fixed band and throw a RenderFlex overflow.
  final int? maxLines;
  final TextOverflow? overflow;
  const ZineMarkTitle({
    super.key,
    this.pre = '',
    required this.mark,
    this.post = '',
    this.fontSize = 36,
    this.markColor = AD.primaryBadge,
    this.textAlign = TextAlign.center,
    this.maxLines,
    this.overflow,
  });
  @override
  Widget build(BuildContext context) {
    final style = _tHero(fontSize);
    // RESPUI-13: when the mark word IS the whole title (pre and post both
    // empty — e.g. ZineAppBar's `title == markWord` case, such as Settings'
    // title:'Settings', markWord:'Settings'), do NOT wrap the mark in a
    // Text.rich paragraph at all. A WidgetSpan that is the sole span in a
    // paragraph inflates the line box via paragraph/placeholder metrics
    // regardless of alignment mode — both `baseline` (RESPUI-11 era) and
    // `middle` (RESPUI-12) blew ZineAppBar's fixed 54px title budget by
    // exactly one fontSize (CI runs 28682020489 + 28682944950: constant
    // "overflowed by 27 pixels" at every screen size/text scale, because the
    // app-bar band clamps its text scale to 1.15 in both test configs).
    // Returning the Stack directly sizes the title to the inner Text's own
    // line height (fontSize * 1.08 * scale), which fits the band. The
    // pre/post-populated hero-title case (e.g. "Pick your handle") keeps the
    // original Text.rich + baseline WidgetSpan, which is the tested, working
    // alignment against real surrounding text.
    final soleSpan = pre.isEmpty && post.isEmpty;
    final markWidget = Stack(clipBehavior: Clip.none, children: [
      Positioned(
        left: -3, right: -3, bottom: fontSize * 0.02, height: fontSize * 0.40,
        child: Transform.rotate(
          angle: -1.2 * math.pi / 180,
          child: Container(
            // On the dark surface the title text is WHITE, so a full-strength
            // accent stripe behind it drops contrast to ~2.4:1. Held at 45% so
            // the highlight still reads as a highlight and the word stays
            // legible.
            decoration: BoxDecoration(
                color: markColor.withValues(alpha: 0.45),
                borderRadius: Msg.brSm),
          ),
        ),
      ),
      Text(
        mark,
        style: style,
        maxLines: soleSpan ? maxLines : null,
        overflow: soleSpan && maxLines != null ? (overflow ?? TextOverflow.ellipsis) : null,
      ),
    ]);
    if (soleSpan) return markWidget;
    return Text.rich(
      TextSpan(children: [
        if (pre.isNotEmpty) TextSpan(text: pre),
        WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: markWidget,
        ),
        if (post.isNotEmpty) TextSpan(text: post),
      ]),
      style: style,
      textAlign: textAlign,
      maxLines: maxLines,
      overflow: overflow ?? TextOverflow.clip,
    );
  }
}

/// Link: accent text with a thick accent underline.
class ZineLink extends StatelessWidget {
  final String text;
  final VoidCallback? onTap;
  final Color underline;
  final double fontSize;
  const ZineLink(this.text, {super.key, this.onTap, this.underline = AD.primaryBadge, this.fontSize = 13});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.only(bottom: 1),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: underline, width: 2)),
        ),
        child: Text(text, style: _tLink(size: fontSize)),
      ),
    );
  }
}

/// Toggle — pill track, hairline border, accent when on.
class ZineToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const ZineToggle({super.key, required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : Msg.fast,
        curve: Msg.curve,
        width: 56, height: 32,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.primaryBadge : AD.card,
          // A switch track is genuinely a pill.
          borderRadius: Msg.brPill,
          border: Border.all(color: value ? AD.primaryBadge : AD.borderControl, width: 2),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : Msg.fast,
          curve: Msg.curve,
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 20, height: 20,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: value ? Colors.white : AD.textTertiary,
              border: Border.all(color: AD.borderControl, width: 2),
            ),
          ),
        ),
      ),
    );
  }
}

/// Dropdown wrapped in the field chrome.
class ZineDropdown<T> extends StatelessWidget {
  final T? value;
  final String? label;
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?>? onChanged;
  final String? hint;
  const ZineDropdown({super.key, required this.items, this.value, this.onChanged, this.label, this.hint});
  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (label != null) ...[
        Text(_sentence(label!), style: _tKicker()),
        const SizedBox(height: Msg.s2),
      ],
      Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl, width: 2),
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: value,
            isExpanded: true,
            hint: hint == null ? null : Text(hint!, style: _tInput(c: AD.textFaint)),
            icon: PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.regular), size: 18, color: AD.textSecondary),
            style: _tInput(size: 16),
            dropdownColor: AD.menu,
            borderRadius: Msg.brMd,
            items: items,
            onChanged: onChanged,
          ),
        ),
      ),
    ]);
  }
}

/// App bar band for dashboard screens: header surface, hairline bottom border,
/// back button + title (with .mark) + tag underneath.
class ZineAppBar extends StatelessWidget implements PreferredSizeWidget {
  final String title;
  /// Word inside [title] that takes the marker highlight (optional).
  final String? markWord;
  final String? tag;
  final VoidCallback? onBack;
  final List<Widget> actions;
  final bool showBack;
  /// Optional leading widget (e.g. a hamburger menu button) shown in place of the
  /// back button. When set, [showBack] is ignored.
  final Widget? leading;
  const ZineAppBar({
    super.key,
    required this.title,
    this.markWord,
    this.tag,
    this.onBack,
    this.actions = const [],
    this.showBack = true,
    this.leading,
  });

  @override
  Size get preferredSize => Size.fromHeight(tag == null ? 76 : 92);

  /// Title size inside the FIXED-height band. Dropped 27 -> 22 to match
  /// ADText.appTitle; the band height is unchanged, so this only ever buys
  /// headroom (never costs it) at high OS text scale.
  static const double _titleSize = 22;

  @override
  Widget build(BuildContext context) {
    Widget titleW;
    final mw = markWord;
    if (mw != null && title.contains(mw)) {
      final i = title.indexOf(mw);
      // RESPUI-11: this title sits in a FIXED-height app-bar band
      // (preferredSize above), unlike the hero use of ZineMarkTitle on
      // onboarding/sign-in screens which scrolls freely. Without a line
      // clamp, a longer title (e.g. "Complete your profile") wrapping to
      // multiple lines at high OS text-scale on a narrow phone blew past the
      // fixed band and threw a RenderFlex overflow (CI run 28681435747).
      // Clamp to 1 line + ellipsis, same as the plain-Text branch below.
      titleW = ZineMarkTitle(
        pre: title.substring(0, i),
        mark: mw,
        post: title.substring(i + mw.length),
        fontSize: _titleSize,
        textAlign: TextAlign.left,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    } else {
      titleW = Text(title, style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis);
    }
    return Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s3),
          child: Row(children: [
            if (leading != null) ...[
              leading!,
              const SizedBox(width: Msg.s3),
            ] else if (showBack) ...[
              ZineBackButton(onTap: onBack),
              const SizedBox(width: Msg.s3),
            ],
            // Big page title + kicker stay a FIXED size — the Display & fonts
            // slider only grows body/chat/contact/menu text, not headings
            // (owner request 2026-06-28, pic 3).
            // RESPUI-11: NoUserFontScale only strips the app's OWN Display &
            // fonts slider — it does NOT touch the OS accessibility text
            // scale, which the overflow tests push to 1.3x/2.0x. This band
            // has a FIXED preferredSize height (76/92px), so on top of the
            // maxLines:1 clamp on titleW above, also cap the OS scale applied
            // here so a maxed-out accessibility setting can't inflate a
            // single line of title text past the fixed band. 1.15x still
            // gives real accessibility benefit over a hard 1.0x pin while
            // easily fitting the available ~54px vertical budget.
            Expanded(
              child: Builder(builder: (context) {
                // Clamp the OS/accessibility text scale feeding this band to
                // 1.15x max (NoUserFontScale below only removes the app's own
                // Display & fonts slider, not the OS scale). 1.15x still gives
                // real accessibility benefit over a hard 1.0x pin while fitting
                // the fixed ~54px vertical budget of this app-bar band.
                final osScale = MediaQuery.textScalerOf(context).scale(1.0);
                final clampedScale = osScale > 1.15 ? 1.15 : osScale;
                return MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(clampedScale)),
                  child: NoUserFontScale(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        titleW,
                        if (tag != null) ...[
                          const SizedBox(height: 2),
                          Text(_sentence(tag!), style: _tKicker()),
                        ],
                      ],
                    ),
                  ),
                );
              }),
            ),
            ...actions,
          ]),
        ),
      ),
    );
  }
}

/// Page background with the faint radial-dot texture.
class ZinePaper extends StatelessWidget {
  final Widget child;
  const ZinePaper({super.key, required this.child});
  @override
  Widget build(BuildContext context) {
    return Container(
      color: AD.bg,
      child: CustomPaint(
        painter: _PaperTexturePainter(),
        child: child,
      ),
    );
  }
}

class _PaperTexturePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // Light dots on a near-black page (was dark ink on cream).
    final p = Paint()..color = AD.textPrimary.withValues(alpha: 0.03);
    const step = 22.0;
    for (double y = 0; y < size.height; y += step) {
      for (double x = 0; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 1, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Full-screen success overlay: dark page, rotated accent seal, headline,
/// short sub, optional CTA.
class ZineSuccessOverlay extends StatelessWidget {
  /// Nullable ONLY because the default has to be resolved at build time:
  /// `PhosphorIcons.check(...)` is a function call, so it cannot be a const
  /// default parameter the way the old `Icons.check_rounded` could. Passing an
  /// explicit icon behaves exactly as before.
  final IconData? icon;
  final String headline;
  final String? accentLine;
  final String? sub;
  final String? ctaLabel;
  final VoidCallback? onCta;
  const ZineSuccessOverlay({
    super.key,
    required this.headline,
    this.icon,
    this.accentLine,
    this.sub,
    this.ctaLabel,
    this.onCta,
  });
  @override
  Widget build(BuildContext context) {
    return ZinePaper(
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(Msg.s6),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Transform.rotate(
                angle: -4 * math.pi / 180,
                child: Container(
                  width: 120, height: 120,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AD.primaryBadge,
                    border: Border.all(color: AD.borderControl, width: 2),
                    boxShadow: Msg.lift,
                  ),
                  child: Icon(
                    icon ?? PhosphorIcons.check(PhosphorIconsStyle.regular),
                    size: 56, color: Colors.white,
                  ),
                ),
              ),
              const SizedBox(height: Msg.s5),
              Text(headline, style: _tHero(34), textAlign: TextAlign.center),
              if (accentLine != null) ...[
                const SizedBox(height: Msg.s2),
                Text(accentLine!, style: _tLink(size: 18)),
              ],
              if (sub != null) ...[
                const SizedBox(height: Msg.s3),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: Text(sub!, style: _tSub(), textAlign: TextAlign.center),
                ),
              ],
              if (ctaLabel != null) ...[
                const SizedBox(height: Msg.s5),
                ZineButton(
                  label: ctaLabel!,
                  onPressed: onCta,
                  icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.regular),
                ),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

/// Empty state: dashed glyph tile + one short reassuring line.
class ZineEmptyState extends StatelessWidget {
  final IconData icon;
  final String text;
  const ZineEmptyState({super.key, required this.icon, required this.text});
  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 64, height: 64,
        decoration: BoxDecoration(
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl, width: 2),
        ),
        child: Icon(icon, size: 30, color: AD.textTertiary),
      ),
      const SizedBox(height: Msg.s3),
      Text(text, style: _tSub(size: 14), textAlign: TextAlign.center),
    ]);
  }
}

/// Responsive, overflow-proof body wrapper.
///
/// Wraps a [child] Column (typically one that uses `Spacer()`s and a pinned
/// bottom button) so it NEVER clips on any screen height:
///   SafeArea → LayoutBuilder → SingleChildScrollView(ClampingScrollPhysics)
///   → ConstrainedBox(minHeight: viewport) → IntrinsicHeight → child.
///
/// - When there is room to spare, `IntrinsicHeight` lets `Spacer()`s expand so
///   the layout looks exactly as before (bottom button pinned to the bottom).
/// - When the screen is short (large system UI, small phone, big font scale),
///   the `SingleChildScrollView` scrolls instead of overflowing, so nothing —
///   text or button — is ever cut off.
///
/// The [child] MUST be a widget that stretches to the incoming height, e.g. a
/// `Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [...])`
/// containing `Spacer()`s. Pass the screen's own [padding] (defaults to 24 all
/// round) instead of wrapping the child in a Padding yourself.
class ZineScrollBody extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;

  /// SafeArea insets — set to false on an edge that owns a full-bleed element
  /// (e.g. a camera preview). Defaults to insetting all sides.
  final bool safeTop;
  final bool safeBottom;

  const ZineScrollBody({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(Msg.s5),
    this.safeTop = true,
    this.safeBottom = true,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: safeTop,
      bottom: safeBottom,
      child: LayoutBuilder(
        builder: (context, constraints) {
          return SingleChildScrollView(
            physics: const ClampingScrollPhysics(),
            padding: padding,
            child: ConstrainedBox(
              // Subtract the padding so IntrinsicHeight/Spacer target the true
              // content viewport (avoids a spurious extra scroll of padding).
              constraints: BoxConstraints(
                minHeight: constraints.maxHeight -
                    padding.resolve(TextDirection.ltr).vertical,
              ),
              child: IntrinsicHeight(child: child),
            ),
          );
        },
      ),
    );
  }
}
