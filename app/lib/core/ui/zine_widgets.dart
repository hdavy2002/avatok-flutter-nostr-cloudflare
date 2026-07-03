import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../font_scale.dart';
import 'zine.dart';

// =============================================================================
// AvaTOK design system — component recipes (AVATOK-DESIGN-SYSTEM.md §5–§8).
// Physics: objects press INTO the paper on tap (translate down-right, shadow
// shrinks). Every contained element: ink border >= 2.5px + hard offset shadow.
// =============================================================================

/// Press-into-the-paper interaction wrapper (§5).
/// Renders [child] inside a bordered, hard-shadowed box; on press the box
/// translates (2,2) and the shadow collapses to 1px.
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
    this.color = Zine.card,
    this.pressedColor,
    this.radius = const BorderRadius.all(Radius.circular(Zine.rSm)),
    this.boxShadow = Zine.shadowSm,
    this.borderWidth = Zine.bw,
    this.borderColor = Zine.ink,
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
    final dx = _down && enabled ? 2.0 : 0.0;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: enabled ? (_) => setState(() => _down = true) : null,
      onTapCancel: enabled ? () => setState(() => _down = false) : null,
      onTapUp: enabled ? (_) => setState(() => _down = false) : null,
      onTap: widget.onTap,
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : Zine.dur,
        curve: Curves.ease,
        transform: Matrix4.translationValues(dx, dx, 0),
        padding: widget.padding,
        decoration: BoxDecoration(
          color: _down && enabled ? (widget.pressedColor ?? widget.color) : widget.color,
          borderRadius: widget.radius,
          border: Border.all(color: widget.borderColor, width: widget.borderWidth),
          boxShadow: _down && enabled ? Zine.shadowPressed : widget.boxShadow,
        ),
        child: widget.child,
      ),
    );
  }
}

enum ZineButtonVariant { lime, blue, coral, ghost }

/// Primary button — lime pill (§7.1). ONE lime button per screen.
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

  Color get _fill => switch (variant) {
        ZineButtonVariant.lime => Zine.lime,
        ZineButtonVariant.blue => Zine.blue,
        ZineButtonVariant.coral => Zine.coral,
        ZineButtonVariant.ghost => Zine.card,
      };
  // White text is allowed ONLY on coral fills (§2).
  Color get _fg => variant == ZineButtonVariant.coral ? Colors.white : Zine.ink;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;
    final fg = disabled ? Zine.inkMute : _fg;
    final content = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: fontSize + 2, height: fontSize + 2,
            child: CircularProgressIndicator(strokeWidth: 2.6, color: fg),
          )
        else ...[
          if (icon != null && !trailingIcon) ...[
            Icon(icon, size: fontSize + 2, color: fg),
            const SizedBox(width: 10),
          ],
          Flexible(
            child: Text(label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.button(size: fontSize, color: fg)),
          ),
          if (icon != null && trailingIcon) ...[
            const SizedBox(width: 10),
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
          color: Zine.paper2,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.inkMute, width: Zine.bw),
        ),
        child: content,
      );
    }
    return ZinePressable(
      onTap: onPressed,
      color: _fill,
      radius: BorderRadius.circular(100),
      padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 21 ? 17 : 14),
      child: content,
    );
  }
}

/// Card (§7.3): card fill, 2.5px ink border, 22px radius, small hard shadow.
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
    this.color = Zine.card,
    this.padding = const EdgeInsets.all(18),
    this.radius = Zine.r,
    this.boxShadow = Zine.shadowSm,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    if (onTap != null) {
      return ZinePressable(
        onTap: onTap, color: color, padding: padding,
        radius: BorderRadius.circular(radius), boxShadow: boxShadow,
        child: child,
      );
    }
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Zine.border,
        boxShadow: boxShadow,
      ),
      child: child,
    );
  }
}

/// Icon badge preceding a card title (§6): 34px, accent fill, ink border.
class ZineIconBadge extends StatelessWidget {
  final IconData icon;
  final Color color;
  final double size;
  const ZineIconBadge({super.key, required this.icon, this.color = Zine.blue, this.size = 34});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: size, height: size,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(Zine.rBadge),
        border: Zine.border,
      ),
      child: Icon(icon, size: size * 0.53, color: color == Zine.coral ? Colors.white : Zine.ink),
    );
  }
}

/// Card head row: icon badge + Nunito title + optional right mono tag (§7.3).
class ZineCardHead extends StatelessWidget {
  final IconData icon;
  final Color accent;
  final String title;
  final String? tag;
  const ZineCardHead({super.key, required this.icon, required this.title, this.accent = Zine.blue, this.tag});
  @override
  Widget build(BuildContext context) {
    return Row(children: [
      ZineIconBadge(icon: icon, color: accent),
      const SizedBox(width: 11),
      Expanded(child: Text(title, style: ZineText.cardTitle())),
      if (tag != null)
        Text(tag!.toUpperCase(), style: ZineText.tag(size: 11, color: Zine.inkSoft)),
    ]);
  }
}

/// Text field (§7.2): pill-ish bordered box with optional lime leading cell.
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
    final shadow = widget.error
        ? Zine.shadowError
        : focused
            ? Zine.shadowFocus
            : Zine.shadowSm;
    final reduce = MediaQuery.of(context).disableAnimations;
    final hasLead = widget.leadText != null || widget.leadIcon != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.label != null) ...[
        Row(children: [
          if (widget.labelIcon != null) ...[
            Icon(widget.labelIcon, size: 14, color: Zine.inkSoft),
            const SizedBox(width: 7),
          ],
          Text(widget.label!.toUpperCase(), style: ZineText.kicker()),
        ]),
        const SizedBox(height: 9),
      ],
      AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 140),
        curve: Curves.ease,
        transform: Matrix4.translationValues(focused ? -1 : 0, focused ? -1 : 0, 0),
        decoration: BoxDecoration(
          color: widget.enabled ? Zine.card : Zine.paper2,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Zine.border,
          boxShadow: shadow,
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(crossAxisAlignment: (widget.maxLines == null || widget.maxLines! > 1) ? CrossAxisAlignment.start : CrossAxisAlignment.center, children: [
          if (hasLead)
            Container(
              width: 50,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                color: Zine.lime,
                border: Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
              ),
              alignment: Alignment.center,
              child: widget.leadText != null
                  ? Text(widget.leadText!,
                      style: const TextStyle(fontFamily: ZineText.display, fontWeight: FontWeight.w600, fontSize: 24, color: Zine.ink))
                  : Icon(widget.leadIcon, size: 22, color: Zine.ink),
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
              cursorColor: Zine.blueInk,
              style: ZineText.input(),
              decoration: InputDecoration(
                isDense: true,
                counterText: '',
                hintText: widget.hint,
                hintStyle: ZineText.input().copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              ),
            ),
          ),
          if (widget.trailing != null)
            Container(
              width: 52,
              constraints: const BoxConstraints(minHeight: 56),
              decoration: const BoxDecoration(
                border: Border(left: BorderSide(color: Zine.ink, width: Zine.bw)),
              ),
              alignment: Alignment.center,
              child: widget.trailing,
            ),
        ]),
      ),
    ]);
  }
}

/// Error line under a field — Nunito coral with warning icon (§7.2).
class ZineErrorMsg extends StatelessWidget {
  final String text;
  const ZineErrorMsg(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 9),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold), size: 15, color: Zine.coral),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: ZineText.tag(size: 12, color: Zine.coral))),
      ]),
    );
  }
}

/// Filter / segmented chip (§7.4). Active = lime + check + shadow.
class ZineChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback? onTap;
  const ZineChip({super.key, required this.label, this.active = false, this.onTap});
  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap,
      color: active ? Zine.lime : Zine.card,
      radius: BorderRadius.circular(100),
      boxShadow: active ? Zine.shadowSm : const <BoxShadow>[],
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (active) ...[
          PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 13, color: Zine.ink),
          const SizedBox(width: 6),
        ],
        Text(label, style: ZineText.tag(size: 12.5)),
      ]),
    );
  }
}

enum ZineStickerKind { ok, no, hint, plain }

/// Sticker / tag pill (§7.5) — availability states, suggestion chips, eyebrows.
class ZineSticker extends StatelessWidget {
  final String text;
  final ZineStickerKind kind;
  final IconData? icon;
  final VoidCallback? onTap;
  const ZineSticker(this.text, {super.key, this.kind = ZineStickerKind.plain, this.icon, this.onTap});
  @override
  Widget build(BuildContext context) {
    final (fill, fg) = switch (kind) {
      ZineStickerKind.ok => (Zine.lime, Zine.ink),
      ZineStickerKind.no => (Zine.coral, Colors.white),
      ZineStickerKind.hint => (Zine.card, Zine.inkSoft),
      ZineStickerKind.plain => (Zine.card, Zine.ink),
    };
    final hint = kind == ZineStickerKind.hint;
    final core = Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        // Hint stickers read as "ghost": muted border, no shadow (§7.5).
        border: Border.all(color: hint ? Zine.inkMute : Zine.ink, width: Zine.bw),
        boxShadow: hint ? null : Zine.shadowXs,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(text.toUpperCase(),
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.tag(size: 12, color: fg)),
        ),
      ]),
    );
    if (onTap == null) return core;
    return GestureDetector(onTap: onTap, child: core);
  }
}

/// Back / icon button (§7.7): 42px circle, ink border, card fill, hard shadow.
class ZineBackButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData? icon;
  const ZineBackButton({super.key, this.onTap, this.icon});
  @override
  Widget build(BuildContext context) {
    return ZinePressable(
      onTap: onTap ?? () => Navigator.of(context).maybePop(),
      pressedColor: Zine.lime,
      radius: BorderRadius.circular(100),
      child: SizedBox(
        width: 42, height: 42,
        child: Center(
          child: PhosphorIcon(
            icon ?? PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
            size: 20, color: Zine.ink,
          ),
        ),
      ),
    );
  }
}

/// Step indicator (§7.8): pip row + "STEP n / m" mono label.
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
            color: i == active ? Zine.coral : Zine.card,
            border: Border.all(color: Zine.ink, width: 2),
          ),
        ),
        const SizedBox(width: 7),
      ],
      const SizedBox(width: 4),
      Text('STEP $active / $total', style: ZineText.kicker()),
    ]);
  }
}

/// Halftone dot patch (§6) — decorative texture block.
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
    final p = Paint()..color = Zine.ink;
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

/// Tape strip (§6): translucent lime, dashed edges, slight rotation. One per screen.
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
          color: Zine.tape,
          border: const Border(
            left: BorderSide(color: Color(0x2E000000), width: 1),
            right: BorderSide(color: Color(0x2E000000), width: 1),
          ),
        ),
      ),
    );
  }
}

/// The AvaTOK mark (Λ + coral dot) in ink — used inside the crest.
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
      ..color = Zine.ink
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round;
    final path = Path()
      ..moveTo(stroke * 0.6, s.height - stroke * 0.6)
      ..lineTo(s.width / 2, stroke * 0.7)
      ..lineTo(s.width - stroke * 0.6, s.height - stroke * 0.6);
    canvas.drawPath(path, p);
    canvas.drawCircle(
        Offset(s.width / 2, s.height * 0.68), s.width * 0.07, Paint()..color = const Color(0xFFFF5350));
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Hero crest (§7.9): circle badge (blue fill, 3px border, big shadow) holding
/// the logo, with tape on top, dot patch behind a corner, coral star beside.
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
            color: Zine.blue,
            border: Zine.borderLg,
            boxShadow: Zine.shadow,
          ),
          child: Center(child: child ?? ZineLogoMark(size: size * 0.5)),
        ),
        Positioned(top: -10, child: ZineTape(width: size * 0.8)),
        Positioned(
          left: 2, top: 10,
          child: PhosphorIcon(PhosphorIcons.starFour(PhosphorIconsStyle.fill), size: 22, color: Zine.coral),
        ),
      ]),
    );
  }
}

/// Title with the brand `.mark` highlighter stripe behind ONE word (§3).
/// Usage: ZineMarkTitle(pre: 'Pick your ', mark: 'handle').
class ZineMarkTitle extends StatelessWidget {
  final String pre;
  final String mark;
  final String post;
  final double fontSize;
  final Color markColor;
  final TextAlign textAlign;
  const ZineMarkTitle({
    super.key,
    this.pre = '',
    required this.mark,
    this.post = '',
    this.fontSize = 36,
    this.markColor = Zine.lime,
    this.textAlign = TextAlign.center,
  });
  @override
  Widget build(BuildContext context) {
    final style = ZineText.hero(size: fontSize);
    return Text.rich(
      TextSpan(children: [
        if (pre.isNotEmpty) TextSpan(text: pre),
        WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: Stack(clipBehavior: Clip.none, children: [
            Positioned(
              left: -3, right: -3, bottom: fontSize * 0.02, height: fontSize * 0.40,
              child: Transform.rotate(
                angle: -1.2 * math.pi / 180,
                child: Container(
                  decoration: BoxDecoration(color: markColor, borderRadius: BorderRadius.circular(3)),
                ),
              ),
            ),
            Text(mark, style: style),
          ]),
        ),
        if (post.isNotEmpty) TextSpan(text: post),
      ]),
      style: style,
      textAlign: textAlign,
    );
  }
}

/// Mono link (§7.6): Nunito, blue-ink, thick accent underline.
class ZineLink extends StatelessWidget {
  final String text;
  final VoidCallback? onTap;
  final Color underline;
  final double fontSize;
  const ZineLink(this.text, {super.key, this.onTap, this.underline = Zine.blue, this.fontSize = 13});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.only(bottom: 1),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: underline, width: Zine.bw)),
        ),
        child: Text(text, style: ZineText.link(size: fontSize)),
      ),
    );
  }
}

/// Toggle in the zine style — pill track, ink border, lime when on.
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
        duration: reduce ? Duration.zero : Zine.dur,
        width: 56, height: 32,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? Zine.lime : Zine.paper2,
          borderRadius: BorderRadius.circular(100),
          border: Zine.border,
          boxShadow: value ? Zine.shadowXs : null,
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : Zine.dur,
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 20, height: 20,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: value ? Zine.ink : Zine.card,
              border: Border.all(color: Zine.ink, width: 2),
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
        Text(label!.toUpperCase(), style: ZineText.kicker()),
        const SizedBox(height: 9),
      ],
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Zine.border,
          boxShadow: Zine.shadowSm,
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: value,
            isExpanded: true,
            hint: hint == null ? null : Text(hint!, style: ZineText.input().copyWith(color: Zine.placeholder)),
            icon: PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
            style: ZineText.input(size: 16),
            dropdownColor: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rSm),
            items: items,
            onChanged: onChanged,
          ),
        ),
      ),
    ]);
  }
}

/// App bar band for dashboard screens (§8): paper-2 fill, ink bottom border,
/// back button + Nunito title (with .mark) + mono tag underneath.
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

  @override
  Widget build(BuildContext context) {
    Widget titleW;
    final mw = markWord;
    if (mw != null && title.contains(mw)) {
      final i = title.indexOf(mw);
      titleW = ZineMarkTitle(
        pre: title.substring(0, i),
        mark: mw,
        post: title.substring(i + mw.length),
        fontSize: 27,
        textAlign: TextAlign.left,
      );
    } else {
      titleW = Text(title, style: ZineText.appbar(), maxLines: 1, overflow: TextOverflow.ellipsis);
    }
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
          child: Row(children: [
            if (leading != null) ...[
              leading!,
              const SizedBox(width: 14),
            ] else if (showBack) ...[
              ZineBackButton(onTap: onBack),
              const SizedBox(width: 14),
            ],
            // Big page title + kicker stay a FIXED size — the Display & fonts
            // slider only grows body/chat/contact/menu text, not headings
            // (owner request 2026-06-28, pic 3).
            Expanded(
              child: NoUserFontScale(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    titleW,
                    if (tag != null) ...[
                      const SizedBox(height: 2),
                      Text(tag!.toUpperCase(), style: ZineText.kicker()),
                    ],
                  ],
                ),
              ),
            ),
            ...actions,
          ]),
        ),
      ),
    );
  }
}

/// Paper page background with the faint radial-dot texture (§6).
class ZinePaper extends StatelessWidget {
  final Widget child;
  const ZinePaper({super.key, required this.child});
  @override
  Widget build(BuildContext context) {
    return Container(
      color: Zine.paper,
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
    final p = Paint()..color = Zine.ink.withValues(alpha: 0.05);
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

/// Full-screen success overlay (§7.13): paper bg, rotated lime seal, Nunito
/// headline, short Nunito sub, optional CTA.
class ZineSuccessOverlay extends StatelessWidget {
  final IconData icon;
  final String headline;
  final String? accentLine;
  final String? sub;
  final String? ctaLabel;
  final VoidCallback? onCta;
  const ZineSuccessOverlay({
    super.key,
    required this.headline,
    this.icon = Icons.check_rounded,
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
            padding: const EdgeInsets.all(40),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Transform.rotate(
                angle: -4 * math.pi / 180,
                child: Container(
                  width: 120, height: 120,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Zine.lime,
                    border: Zine.borderLg,
                    boxShadow: Zine.shadow,
                  ),
                  child: Icon(icon, size: 56, color: Zine.ink),
                ),
              ),
              const SizedBox(height: 24),
              Text(headline, style: ZineText.hero(size: 34), textAlign: TextAlign.center),
              if (accentLine != null) ...[
                const SizedBox(height: 10),
                Text(accentLine!, style: ZineText.link(size: 18)),
              ],
              if (sub != null) ...[
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: Text(sub!, style: ZineText.sub(size: 15), textAlign: TextAlign.center),
                ),
              ],
              if (ctaLabel != null) ...[
                const SizedBox(height: 26),
                ZineButton(
                  label: ctaLabel!,
                  onPressed: onCta,
                  icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                ),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}

/// Empty state (§7.12): dashed glyph tile + one short reassuring line.
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
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Border.all(color: Zine.ink.withValues(alpha: 0.3), width: 2),
        ),
        child: Icon(icon, size: 30, color: Zine.inkMute),
      ),
      const SizedBox(height: 12),
      Text(text, style: ZineText.sub(size: 14.5), textAlign: TextAlign.center),
    ]);
  }
}
