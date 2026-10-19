import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/demo_mode.dart';
import '../data/repos/auth_repo.dart';
import '../data/services.dart';
import 'data.dart';
import 'screens/sheets.dart';
import 'state.dart';
import 'theme.dart';

/// Picture from the Rang Bazaar art pack (claude/hello-fraands-rang-bazaar-app-artwork-prompts.md).
/// Until the owner saves the file, [fallback] (a drawn stand-in) is shown instead.
class Art extends StatelessWidget {
  const Art(this.path, {super.key, this.fit = BoxFit.contain, this.fallback, this.width, this.height, this.alignment = Alignment.center, this.repeat = ImageRepeat.noRepeat});

  final String path;
  final ImageRepeat repeat;
  final BoxFit fit;
  final Widget? fallback;
  final double? width;
  final double? height;
  final Alignment alignment;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/images/bazaar/$path',
      fit: fit,
      width: width,
      height: height,
      alignment: alignment,
      repeat: repeat,
      errorBuilder: (context, error, stack) => SizedBox(width: width, height: height, child: fallback ?? const SizedBox.shrink()),
    );
  }
}

/// Labelled placeholder used when a picture has not been generated yet.
class ArtStandIn extends StatelessWidget {
  const ArtStandIn(this.label, {super.key, this.color = C.sand, this.ink = C.deep, this.radius = 20});

  final String label;
  final Color color;
  final Color ink;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: ink.withValues(alpha: 0.5), width: 2),
      ),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(8),
      child: Text('[ $label ]', textAlign: TextAlign.center, style: t(14, color: ink, ls: 0.06)),
    );
  }
}

/// Dashed vertical line (ticket perforation).
class DashedLine extends StatelessWidget {
  const DashedLine({super.key, this.color = C.maroon, this.width = 3, this.vertical = true});

  final Color color;
  final double width;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: vertical ? Size(width, double.infinity) : Size(double.infinity, width),
      painter: _DashPainter(color, width, vertical),
    );
  }
}

class _DashPainter extends CustomPainter {
  _DashPainter(this.color, this.width, this.vertical);
  final Color color;
  final double width;
  final bool vertical;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..strokeWidth = width;
    const dash = 6.0;
    const gap = 5.0;
    final len = vertical ? size.height : size.width;
    var pos = 0.0;
    while (pos < len) {
      final end = (pos + dash).clamp(0, len).toDouble();
      if (vertical) {
        canvas.drawLine(Offset(size.width / 2, pos), Offset(size.width / 2, end), p);
      } else {
        canvas.drawLine(Offset(pos, size.height / 2), Offset(end, size.height / 2), p);
      }
      pos += dash + gap;
    }
  }

  @override
  bool shouldRepaint(covariant _DashPainter old) => old.color != color;
}

/// The fabric-tag button: body + stitched line + tag end. Used for Call now, Continue, Pay.
class TicketButton extends StatelessWidget {
  const TicketButton({
    super.key,
    required this.label,
    required this.onTap,
    this.stubTop,
    this.stubBottom,
    this.stubIcon,
    this.icon,
    this.maroon = false,
    this.height = 64,
    this.enabled = true,
    this.stubWidth = 92,
    this.labelSize = 20,
  });

  final String label;
  final VoidCallback onTap;
  final String? stubTop;
  final String? stubBottom;
  final IconData? stubIcon;
  final IconData? icon;
  final bool maroon;
  final double height;
  final bool enabled;
  final double stubWidth;
  final double labelSize;

  @override
  Widget build(BuildContext context) {
    final body = maroon ? C.maroon : C.marigold;
    final ink = maroon ? C.gold : C.deep;
    final stub = maroon ? C.marigold : C.maroon;
    final stubInk = maroon ? C.deep : C.gold;
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: Semantics(
        button: true,
        label: label,
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          child: Container(
            height: height,
            decoration: const BoxDecoration(
              boxShadow: [BoxShadow(color: C.deep, offset: Offset(0, 6))],
              borderRadius: BorderRadius.all(Radius.circular(16)),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      color: body,
                      alignment: Alignment.center,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (icon != null) ...[Icon(icon, color: ink, size: 24), const SizedBox(width: 8)],
                          Flexible(
                            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(labelSize, color: ink, ls: 0.06)),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Container(color: body, width: 3, child: DashedLine(color: maroon ? C.gold : C.maroon)),
                  Container(
                    width: stubWidth,
                    color: stub,
                    alignment: Alignment.center,
                    child: stubIcon != null
                        ? Icon(stubIcon, color: stubInk, size: 26)
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (stubTop != null) Text(stubTop!, style: t(14, color: stubInk, ls: 0.12)),
                              if (stubBottom != null) Text(stubBottom!, style: t(16, color: stubInk)),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Plain chunky button (secondary actions).
class ChunkyButton extends StatelessWidget {
  const ChunkyButton({super.key, required this.label, required this.onTap, this.filled = true, this.dark = false, this.height = 58, this.icon});

  final String label;
  final VoidCallback? onTap;
  final bool filled;
  final bool dark;
  final double height;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final bg = filled ? (dark ? C.maroon : C.marigold) : C.clear;
    final fg = filled ? (dark ? C.gold : C.deep) : (dark ? C.gold : C.maroon);
    final border = filled ? bg : (dark ? C.gold : C.maroon);
    return SizedBox(
      height: height,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: border, width: 3)),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[Icon(icon, color: fg, size: 22), const SizedBox(width: 8)],
                Text(label, style: t(18, color: fg, ls: 0.06)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Round mirror-work button (feed side buttons, menu medallions). Uses feed/mirror-button.webp when saved.
class BrassKnob extends StatelessWidget {
  const BrassKnob({super.key, required this.child, this.onTap, this.size = 52, required this.label});

  final Widget child;
  final VoidCallback? onTap;
  final double size;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: onTap != null,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        // [HF-WIRE-12] a tappable knob always has a 48 dp hit area, whatever its drawn size
        child: SizedBox(
          width: onTap != null && size < 48 ? 48 : size,
          height: onTap != null && size < 48 ? 48 : size,
          child: Center(
            child: SizedBox(
          width: size,
          height: size,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Positioned.fill(
                child: Art(
                  'feed/mirror-button.webp',
                  fallback: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: const Color(0xFFFFFFFF), width: 3),
                      boxShadow: const [BoxShadow(color: C.maroon, spreadRadius: 2)],
                      gradient: const RadialGradient(
                        center: Alignment(-0.3, -0.4),
                        colors: [Color(0xFFBFF3FF), C.turquoise, C.brassDark],
                        stops: [0, 0.6, 1],
                      ),
                    ),
                  ),
                ),
              ),
              child,
            ],
          ),
        ),
          ),
        ),
      ),
    );
  }
}

/// Round avatar: the influencer's portrait art when saved, else tones + initials.
class Avatar extends StatelessWidget {
  const Avatar(this.who, {super.key, this.size = 56, this.ring = true});

  final Influencer who;
  final double size;
  final bool ring;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      decoration: BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: who.tones, begin: Alignment.topLeft, end: Alignment.bottomRight)),
      alignment: Alignment.center,
      child: Text(who.initials, style: t(size * 0.36, color: C.gold)),
    );
    final face = ClipOval(
      child: who.avatarUrl != null
          ? Image.network(who.avatarUrl!, fit: BoxFit.cover, alignment: Alignment.topCenter, errorBuilder: (_, __, ___) => fallback)
          : who.portrait == null
          ? fallback
          : Container(
              color: who.tones.first,
              child: Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter, fallback: fallback),
            ),
    );
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(ring ? size * 0.05 : 0),
      decoration: ring ? const BoxDecoration(shape: BoxShape.circle, gradient: SweepGradient(colors: [C.marigold, C.rani, C.marigold])) : null,
      child: Container(
        decoration: ring ? BoxDecoration(shape: BoxShape.circle, border: Border.all(color: C.cinema, width: 2)) : null,
        child: face,
      ),
    );
  }
}

/// Online / offline pill.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.online, this.dark = true});

  final bool online;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(color: dark ? C.deep : C.paper, borderRadius: BorderRadius.circular(999), border: dark ? null : Border.all(color: C.sand, width: 2)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(shape: BoxShape.circle, color: online ? C.rani : C.cream, boxShadow: online ? [BoxShadow(color: C.rani.withValues(alpha: 0.35), spreadRadius: 3)] : null),
          ),
          const SizedBox(width: 7),
          Text(online ? 'ONLINE NOW' : 'OFFLINE', style: t(14, color: dark ? C.gold : C.muted, ls: 0.06)),
        ],
      ),
    );
  }
}

/// Bandhani band with a gota scallop edge (intro/bandhani-border.webp when saved).
class Valance extends StatelessWidget {
  const Valance({super.key, this.height = 74});

  final double height;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      width: double.infinity,
      child: Art(
        'intro/bandhani-border.webp',
        fit: BoxFit.fitHeight,
        alignment: Alignment.topLeft,
        fallback: CustomPaint(painter: _ValancePainter()),
      ),
    );
  }
}

class _ValancePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // Bandhani: a rani-pink band with rows of tiny white tie-dye dots, a lemon gota lace edge with
    // rounded scallops, and small turquoise tassels.
    final band = size.height * 0.66;
    canvas.drawRect(Rect.fromLTWH(0, 0, size.width, band), Paint()..color = C.maroon);
    final dot = Paint()..color = const Color(0xFFFFFFFF);
    final dotY = Paint()..color = C.lemon;
    var row = 0;
    for (var y = 8.0; y < band - 8; y += 11, row++) {
      for (var x = (row.isEven ? 6.0 : 12.0); x < size.width; x += 12) {
        canvas.drawCircle(Offset(x, y), 1.8, (x ~/ 12 + row) % 5 == 0 ? dotY : dot);
      }
    }
    canvas.drawRect(Rect.fromLTWH(0, band - 6, size.width, 6), Paint()..color = C.marigold);
    final r = (size.height - band) * 0.8;
    var i = 0;
    for (var x = 0.0; x < size.width + r; x += r * 2, i++) {
      canvas.drawCircle(Offset(x + r, band), r * 0.85, Paint()..color = C.marigold);
      if (i.isOdd) canvas.drawCircle(Offset(x + r, band + r * 0.95), r * 0.32, Paint()..color = C.turquoise);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Leheriya-striped side rail (feed/leheriya-rail.webp when saved).
class SprocketRail extends StatelessWidget {
  const SprocketRail({super.key, this.width = 10});

  final double width;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Opacity(
        opacity: 0.9,
        child: Art('feed/leheriya-rail.webp', fit: BoxFit.fitWidth, alignment: Alignment.topCenter, repeat: ImageRepeat.repeatY, fallback: CustomPaint(painter: _RailPainter())),
      ),
    );
  }
}

class _RailPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // Leheriya: diagonal waves of colour, like a Rajasthani tie-dye turban.
    const colours = [C.maroon, C.marigold, C.turquoise, C.saffron, C.violet];
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    var i = 0;
    for (var y = -size.width; y < size.height + size.width; y += 9, i++) {
      final path = Path()
        ..moveTo(0, y)
        ..lineTo(size.width, y - size.width * 0.8)
        ..lineTo(size.width, y - size.width * 0.8 + 9)
        ..lineTo(0, y + 9)
        ..close();
      canvas.drawPath(path, Paint()..color = colours[i % colours.length]);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Round back button.
class BackBtn extends StatelessWidget {
  const BackBtn({super.key, this.dark = false});

  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Back',
      child: GestureDetector(
        onTap: () => context.canPop() ? context.pop() : context.go('/reels'),
        behavior: HitTestBehavior.opaque,
        // [HF-WIRE-12] 48 dp tap target around the 44 dp circle
        child: SizedBox(
          width: 48,
          height: 48,
          child: Center(
            child: Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(shape: BoxShape.circle, color: dark ? C.ivory.withValues(alpha: 0.15) : const Color(0xFFFFE3F0)),
              child: Icon(Icons.arrow_back_rounded, color: dark ? C.gold : C.deep),
            ),
          ),
        ),
      ),
    );
  }
}

/// Big two-tone headline: solid line(s) + outline line.
class Headline extends StatelessWidget {
  const Headline({super.key, required this.solid, this.outline, this.size = 46, this.color = C.maroon, this.align = TextAlign.left});

  final String solid;
  final String? outline;
  final double size;
  final Color color;
  final TextAlign align;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(children: [
        TextSpan(text: solid, style: t(size, color: color, ls: 0.04, h: 1.02)),
        if (outline != null) TextSpan(text: '\n$outline', style: tOutline(size, color: color)),
      ]),
      textAlign: align,
    );
  }
}

/// Simple screen header used on inner pages: back button + title.
class PageHeader extends StatelessWidget {
  const PageHeader({super.key, required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
        children: [
          const BackBtn(),
          const SizedBox(width: 14),
          Expanded(child: Text(title, style: t(24, color: C.maroon, ls: 0.03))),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// Opens the sign-up sheet when the visitor has no account yet, then runs [then].
/// A real build (HF_DEMO=false) asks the server-backed session; a demo build keeps the dummy account.
Future<void> requireAccount(BuildContext context, VoidCallback then, {String? reason, AuthRepo? repo}) async {
  final real = repo != null || !DemoMode.on;
  if (real ? Services.instance.isSignedIn : demo.signedIn) {
    then();
    return;
  }
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: C.clear,
    builder: (_) => SignUpSheet(reason: reason, repo: repo),
  );
  if (ok == true && context.mounted) then();
}

void toast(BuildContext context, String msg) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg)));
}

/// Month calendar used by the influencer's Bookings and Availability screens and the fan's
/// booking flow. [fill] tints open days, [dots] marks days with bookings.
class MonthGrid extends StatelessWidget {
  const MonthGrid({
    super.key,
    required this.month,
    required this.selected,
    required this.onPick,
    required this.onMonth,
    this.fill = const {},
    this.dots = const {},
    this.allowPast = false,
  });

  final DateTime month; // any day in the month shown
  final DateTime? selected;
  final ValueChanged<DateTime> onPick;
  final ValueChanged<DateTime> onMonth;
  final Set<String> fill;
  final Set<String> dots;
  final bool allowPast;

  @override
  Widget build(BuildContext context) {
    final first = DateTime(month.year, month.month, 1);
    final daysInMonth = DateTime(month.year, month.month + 1, 0).day;
    final lead = first.weekday - 1; // Monday first
    final today = dayOnly(DateTime.now());
    final cells = <Widget>[
      for (final w in weekdayShort) Center(child: Text(w.substring(0, 2), style: t(14, color: C.tan))),
      for (var i = 0; i < lead; i++) const SizedBox.shrink(),
      for (var d = 1; d <= daysInMonth; d++) _day(DateTime(month.year, month.month, d), today),
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(18), border: Border.all(color: C.sandLine, width: 2)),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                tooltip: 'Previous month',
                onPressed: () => onMonth(DateTime(month.year, month.month - 1, 1)),
                icon: const Icon(Icons.chevron_left_rounded, color: C.maroon),
              ),
              Expanded(child: Text('${monthLong[month.month - 1]} ${month.year}', textAlign: TextAlign.center, style: t(18, color: C.maroon))),
              IconButton(
                tooltip: 'Next month',
                onPressed: () => onMonth(DateTime(month.year, month.month + 1, 1)),
                icon: const Icon(Icons.chevron_right_rounded, color: C.maroon),
              ),
            ],
          ),
          GridView.count(
            crossAxisCount: 7,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 4,
            crossAxisSpacing: 4,
            children: cells,
          ),
        ],
      ),
    );
  }

  Widget _day(DateTime d, DateTime today) {
    final past = d.isBefore(today);
    final isSel = selected != null && dayKey(selected!) == dayKey(d);
    final isOpen = fill.contains(dayKey(d));
    final hasDot = dots.contains(dayKey(d));
    final isToday = dayKey(d) == dayKey(today);
    final bg = isSel ? C.maroon : (isOpen ? C.butter : C.clear);
    final fg = isSel ? C.gold : (past && !allowPast ? C.sandLine : C.deep);
    return GestureDetector(
      onTap: past && !allowPast ? null : () => onPick(d),
      child: Container(
        decoration: BoxDecoration(
          color: bg,
          shape: BoxShape.circle,
          border: isToday && !isSel ? Border.all(color: C.turquoise, width: 2) : null,
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            Text('${d.day}', style: t(15, color: fg)),
            if (hasDot)
              Positioned(
                bottom: 4,
                child: Container(width: 6, height: 6, decoration: BoxDecoration(shape: BoxShape.circle, color: isSel ? C.lemon : C.rani)),
              ),
          ],
        ),
      ),
    );
  }
}

/// Picture with a soft round colour behind it (used for the women illustrations on empty and status screens).
class ArtMoment extends StatelessWidget {
  const ArtMoment(this.path, {super.key, required this.label, this.size = 220, this.ring = C.sand});

  final String path;
  final String label;
  final double size;
  final Color ring;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Container(width: size * 0.92, height: size * 0.92, decoration: BoxDecoration(shape: BoxShape.circle, color: ring)),
          Art(path, fallback: ArtStandIn(label, color: C.paper, ink: C.maroon, radius: size)),
        ],
      ),
    );
  }
}
