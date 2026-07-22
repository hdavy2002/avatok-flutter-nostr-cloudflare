// [WALLET-REDESIGN-1] AvaWallet redesign — reusable widget kit.
//
// Every piece of chrome the redesigned wallet screens need, built on the tokens
// in `wallet_theme.dart`. Design intent, in one line: flat saturated poster
// fills, PURE-black hard borders (1.5 / 2 / 2.5px), HARD un-blurred offset
// shadows (`blurRadius: 0`), pill geometry, Nunito w700/w800.
//
// Rules the whole kit follows, so screens stay consistent:
//   * a shadow is ALWAYS `BoxShadow(color: Colors.black, offset: ..., blurRadius: 0)`
//     — never a blur. Blur belongs to the `AD` dark system, not this one.
//   * a "hard" element gets a black border; a "quiet" element gets `AW.hair`.
//   * anything sitting on a bright accent uses `AW.glyph` ink, except coral,
//     which is the one fill that takes white (inherited from the Zine rules).
//
// Nothing here talks to the network or to app state — these are pure
// presentation widgets, so the screen owns all data and callbacks.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'wallet_theme.dart';

/// Hard offset shadow helper — the single place the blur-0 rule is expressed.
List<BoxShadow> _hardShadow(Offset offset) => [
      BoxShadow(color: Colors.black, offset: offset, blurRadius: 0),
    ];

// =============================================================================
// 1. WalletCard
// =============================================================================

/// The base surface for every wallet block.
///
/// Two modes:
///  * quiet (default) — `AW.hair` 2px border, no shadow. For list containers
///    and anything that shouldn't shout.
///  * `hardBorder: true` — 2.5px pure-black border plus a hard offset shadow
///    (default `Offset(6, 7)`). This is the poster treatment; reserve it for
///    hero elements (balance card, featured stats) so it stays special.
class WalletCard extends StatelessWidget {
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;

  /// Fill. Defaults to [AW.surf]; pass an accent for a poster card.
  final Color? color;

  /// Poster treatment: black border + hard shadow.
  final bool hardBorder;

  /// Hard-shadow offset. Only used when [hardBorder] is true.
  final Offset? shadow;

  const WalletCard({
    super.key,
    required this.child,
    this.radius = 18,
    this.padding = const EdgeInsets.all(16),
    this.color,
    this.hardBorder = false,
    this.shadow,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: color ?? AW.surf,
        borderRadius: BorderRadius.circular(radius),
        border: hardBorder
            ? Border.all(color: Colors.black, width: 2.5)
            : Border.all(color: AW.hair, width: 2),
        boxShadow: hardBorder ? _hardShadow(shadow ?? const Offset(6, 7)) : null,
      ),
      child: child,
    );
  }
}

// =============================================================================
// 2. WalletBadge
// =============================================================================

/// Rounded-square accent tile holding one glyph — the leading element of a
/// transaction row and of most stat cards.
///
/// Always flat fill + black outline; the ink flips to white on coral because
/// dark glyph on coral fails contrast (same rule as the Zine system).
class WalletBadge extends StatelessWidget {
  final IconData icon;
  final Color color;
  final double size;
  final double radius;

  /// Glyph point-size inside the tile.
  final double glyph;

  const WalletBadge({
    super.key,
    required this.icon,
    required this.color,
    this.size = 40,
    this.radius = 12,
    this.glyph = 19,
  });

  @override
  Widget build(BuildContext context) {
    final ink = color == AW.coral ? Colors.white : AW.glyph;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: Colors.black, width: 2),
      ),
      child: Icon(icon, size: glyph, color: ink),
    );
  }
}

// =============================================================================
// 3. WalletChipTrack
// =============================================================================

/// Segmented pill selector (e.g. 7D / 30D / ALL).
///
/// The whole track is one quiet pill; only the active segment gets a fill, so
/// the control reads as a single object rather than a row of loose buttons.
class WalletChipTrack extends StatelessWidget {
  final List<String> labels;
  final int activeIndex;
  final ValueChanged<int> onPick;

  const WalletChipTrack({
    super.key,
    required this.labels,
    required this.activeIndex,
    required this.onPick,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AW.surf,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AW.hair, width: 1.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < labels.length; i++)
            GestureDetector(
              onTap: () => onPick(i),
              behavior: HitTestBehavior.opaque,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(
                  color: i == activeIndex ? AW.lime : Colors.transparent,
                  borderRadius: BorderRadius.circular(100),
                ),
                child: Text(
                  labels[i],
                  style: AWText.chipLabel(
                    c: i == activeIndex ? AW.glyph : AW.txMute,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// =============================================================================
// 4. WalletBarChart
// =============================================================================

/// Weekly spend bars.
///
/// Deliberately hand-rolled rather than pulled from a charting package: the
/// poster look needs a black outline on every bar and a flat coral fill, which
/// no chart lib gives cheaply. Heights are computed in pixels against a fixed
/// [chartHeight] so the widget never depends on an unbounded parent.
class WalletBarChart extends StatelessWidget {
  /// One entry per column: the axis label and its magnitude.
  final List<({String label, num value})> bars;

  /// Pixel height of the tallest bar.
  static const double chartHeight = 110;

  const WalletBarChart({super.key, required this.bars});

  @override
  Widget build(BuildContext context) {
    if (bars.isEmpty) return const SizedBox(height: chartHeight);

    var max = 0.0;
    for (final b in bars) {
      final v = b.value.toDouble();
      if (v > max) max = v;
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (var i = 0; i < bars.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _fmt(bars[i].value),
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: AWText.barLabel(c: AW.txSoft),
                ),
                const SizedBox(height: 6),
                SizedBox(
                  height: _barHeight(bars[i].value.toDouble(), max),
                  child: Container(
                    decoration: BoxDecoration(
                      color: AW.coral,
                      border: Border.all(color: Colors.black, width: 2),
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(7),
                        bottom: Radius.circular(4),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  bars[i].label,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: AWText.barLabel(c: AW.txMute),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  // A 2px floor keeps an empty day visible as a deliberate stub rather than
  // silently vanishing (which reads as a rendering bug).
  static double _barHeight(double value, double max) {
    if (max <= 0 || value <= 0) return 2;
    return math.max(2.0, (value / max) * chartHeight);
  }

  static String _fmt(num v) {
    if (v == v.roundToDouble()) return v.round().toString();
    return v.toStringAsFixed(1);
  }
}

// =============================================================================
// 5. WalletDonut
// =============================================================================

/// Spend-by-category ring with a value in the middle.
///
/// Butt caps and no gaps: adjacent segments meet edge-to-edge, which is what
/// makes it read as a flat poster ring rather than a soft dashboard chart.
class WalletDonut extends StatelessWidget {
  final List<({Color color, num value})> segments;

  /// Big number rendered in the hole.
  final String centerValue;

  final double size;

  const WalletDonut({
    super.key,
    required this.segments,
    required this.centerValue,
    this.size = 132,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Positioned.fill(
            child: CustomPaint(painter: _DonutPainter(segments)),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(centerValue, style: AWText.donutCenter()),
              const SizedBox(height: 2),
              Text('TOKENS', style: AWText.caption(c: AW.txMute)),
            ],
          ),
        ],
      ),
    );
  }
}

class _DonutPainter extends CustomPainter {
  final List<({Color color, num value})> segments;
  const _DonutPainter(this.segments);

  static const double _stroke = 22;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - _stroke / 2;
    if (radius <= 0) return;
    final rect = Rect.fromCircle(center: center, radius: radius);

    // Track ring — always drawn, so a zero-total donut still has a shape.
    final track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _stroke
      ..strokeCap = StrokeCap.butt
      ..color = Colors.white.withValues(alpha: 0.06);
    canvas.drawCircle(center, radius, track);

    var total = 0.0;
    for (final s in segments) {
      final v = s.value.toDouble();
      if (v > 0) total += v;
    }
    if (total <= 0) return;

    var start = -math.pi / 2; // 12 o'clock
    for (final s in segments) {
      final v = s.value.toDouble();
      if (v <= 0) continue;
      final sweep = (v / total) * 2 * math.pi;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = _stroke
        ..strokeCap = StrokeCap.butt
        ..color = s.color;
      canvas.drawArc(rect, start, sweep, false, paint);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DonutPainter old) =>
      old.segments.length != segments.length ||
      () {
        for (var i = 0; i < segments.length; i++) {
          if (old.segments[i].color != segments[i].color ||
              old.segments[i].value != segments[i].value) {
            return true;
          }
        }
        return false;
      }();
}

// =============================================================================
// 6. WalletLegendRow
// =============================================================================

/// One line of the donut legend: swatch, label, value.
///
/// The swatch carries the same black outline as every other filled element so
/// pale accents (blue, mint) don't dissolve into the dark surface.
class WalletLegendRow extends StatelessWidget {
  final Color color;
  final String label;
  final String value;

  const WalletLegendRow({
    super.key,
    required this.color,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 11,
          height: 11,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Colors.black, width: 1.5),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AWText.legendLabel(),
          ),
        ),
        Text(value, style: AWText.legendValue()),
      ],
    );
  }
}

// =============================================================================
// 7. WalletSearchField
// =============================================================================

/// Quiet pill search field for the transaction list.
///
/// Quiet on purpose — a black-bordered poster field here would compete with
/// the balance card, which must stay the loudest thing on the screen.
class WalletSearchField extends StatelessWidget {
  final TextEditingController controller;
  final ValueChanged<String> onSubmitted;

  /// When non-null, a clear "x" appears once there's text.
  final VoidCallback? onClear;

  const WalletSearchField({
    super.key,
    required this.controller,
    required this.onSubmitted,
    this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
      decoration: BoxDecoration(
        color: AW.surf,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AW.hair, width: 1.5),
      ),
      child: Row(
        children: [
          PhosphorIcon(
            PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 16,
            color: AW.txMute,
          ),
          const SizedBox(width: 9),
          Expanded(
            child: TextField(
              controller: controller,
              onSubmitted: onSubmitted,
              textInputAction: TextInputAction.search,
              cursorColor: AW.lime,
              style: AWText.searchText(),
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: EdgeInsets.zero,
                hintText: 'Search transactions',
                hintStyle: AWText.searchText(c: AW.txMute),
              ),
            ),
          ),
          if (onClear != null) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: onClear,
              behavior: HitTestBehavior.opaque,
              child: PhosphorIcon(
                PhosphorIcons.x(PhosphorIconsStyle.bold),
                size: 15,
                color: AW.txMute,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// =============================================================================
// 8. WalletCircleButton
// =============================================================================

/// Quiet 40px circular icon button — header actions (back, filter, calendar).
class WalletCircleButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;

  const WalletCircleButton({
    super.key,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AW.surf,
          shape: BoxShape.circle,
          border: Border.all(color: AW.hair, width: 1.5),
        ),
        child: Icon(icon, size: 18, color: AW.tx),
      ),
    );
  }
}

// =============================================================================
// 9. WalletTxnRow
// =============================================================================

/// A single transaction line.
///
/// The divider is drawn as a TOP border on each row (rather than a separator
/// widget between rows) so a list can be built with a plain `for` loop and the
/// first row simply passes `showDivider: false`.
///
/// Direction is carried by COLOR, not by a +/- glyph: mint = money in, coral =
/// money out. Callers still format [amountLabel] with its own sign.
class WalletTxnRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String sub;
  final String amountLabel;

  /// true = incoming (mint), false = outgoing (coral).
  final bool isIn;

  final String time;
  final VoidCallback onTap;
  final bool showDivider;

  const WalletTxnRow({
    super.key,
    required this.icon,
    required this.color,
    required this.title,
    required this.sub,
    required this.amountLabel,
    required this.isIn,
    required this.time,
    required this.onTap,
    this.showDivider = true,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 14),
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(
              color: showDivider ? AW.hair : Colors.transparent,
              width: 1.5,
            ),
          ),
        ),
        child: Row(
          children: [
            WalletBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AWText.rowTitle(),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AWText.rowSub(c: AW.txMute),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  amountLabel,
                  style: AWText.amount(c: isIn ? AW.mint : AW.coral),
                ),
                const SizedBox(height: 2),
                Text(time, style: AWText.rowTime(c: AW.txMute)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// =============================================================================
// 10. WalletStatusPill
// =============================================================================

/// Status badge on the transaction-detail screen.
///
/// Status → color mapping is centralised here (and case-insensitive) so no
/// screen re-invents "what colour is refunded".
class WalletStatusPill extends StatelessWidget {
  final String status;

  const WalletStatusPill({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final key = status.trim().toLowerCase();
    final Color fill;
    final Color ink;
    final IconData icon;
    switch (key) {
      case 'pending':
        fill = AW.lime;
        ink = AW.glyph;
        icon = PhosphorIcons.clock(PhosphorIconsStyle.fill);
        break;
      case 'refunded':
        fill = AW.coral;
        ink = Colors.white;
        icon = PhosphorIcons.arrowUUpLeft(PhosphorIconsStyle.bold);
        break;
      case 'completed':
      default:
        fill = AW.mint;
        ink = AW.glyph;
        icon = PhosphorIcons.checkCircle(PhosphorIconsStyle.fill);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: Colors.black, width: 2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          PhosphorIcon(icon, size: 14, color: ink),
          const SizedBox(width: 6),
          Text(status.toUpperCase(), style: AWText.pillLabel(c: ink)),
        ],
      ),
    );
  }
}

// =============================================================================
// 11. WalletBreakdownBox
// =============================================================================

/// "duration × rate = total" cost maths for a call charge.
///
/// Shown as an equation rather than a table because it answers the one question
/// a user actually has about a charge ("why this much?") in a single glance.
class WalletBreakdownBox extends StatelessWidget {
  final String duration;
  final String rate;
  final String total;

  /// Ink for the total cell — usually [AW.coral] for a spend.
  final Color totalColor;

  const WalletBreakdownBox({
    super.key,
    required this.duration,
    required this.rate,
    required this.total,
    required this.totalColor,
  });

  Widget _cell(String value, String caption, {Color? valueColor}) {
    return Expanded(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: AWText.breakdownValue(c: valueColor),
          ),
          const SizedBox(height: 4),
          Text(
            caption,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: AWText.caption(c: AW.txMute),
          ),
        ],
      ),
    );
  }

  Widget _glyph(String g) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Text(g, style: AWText.sectionHead(c: AW.txMute)),
      );

  @override
  Widget build(BuildContext context) {
    return WalletCard(
      radius: 18,
      padding: const EdgeInsets.all(16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          _cell(duration, 'DURATION'),
          _glyph('×'),
          _cell(rate, 'PER MIN'),
          _glyph('='),
          _cell(total, '', valueColor: totalColor),
        ],
      ),
    );
  }
}

// =============================================================================
// 12. WalletInfoRow
// =============================================================================

/// Key/value detail line. Same top-border divider trick as [WalletTxnRow].
class WalletInfoRow extends StatelessWidget {
  final String label;
  final String value;
  final bool showDivider;

  const WalletInfoRow({
    super.key,
    required this.label,
    required this.value,
    this.showDivider = true,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(
            color: showDivider ? AW.hair : Colors.transparent,
            width: 1.5,
          ),
        ),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: AWText.infoLabel(c: AW.txMute)),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AWText.infoValue(c: AW.tx),
            ),
          ),
        ],
      ),
    );
  }
}

// =============================================================================
// 13. WalletCalendar
// =============================================================================

/// Compact month picker used as a popover over the transaction list.
///
/// Gets the full poster treatment (black 2.5px border + hard shadow) because it
/// floats above other content and needs to read as a physically separate card,
/// not as another panel in the scroll.
///
/// Fully controlled: it renders [month] and [selectedDay] and calls back — it
/// keeps no state of its own, so the host screen owns the navigation.
class WalletCalendar extends StatelessWidget {
  /// Any date within the month to display.
  final DateTime month;

  /// Day-of-month currently selected, or null.
  final int? selectedDay;

  final ValueChanged<int> onPick;
  final VoidCallback onPrev;
  final VoidCallback onNext;

  const WalletCalendar({
    super.key,
    required this.month,
    required this.selectedDay,
    required this.onPick,
    required this.onPrev,
    required this.onNext,
  });

  static const List<String> _months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  static const List<String> _dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  static int _daysInMonth(int year, int m) =>
      DateTime(year, m + 1, 0).day;

  @override
  Widget build(BuildContext context) {
    final year = month.year;
    final m = month.month;
    final days = _daysInMonth(year, m);
    // DateTime.weekday: Mon=1 … Sun=7. The grid starts on Sunday, so Sunday
    // maps to 0 leading blanks.
    final lead = DateTime(year, m, 1).weekday % 7;

    // Flatten to a single cell list, then chunk into rows of 7.
    final cells = <int?>[
      ...List<int?>.filled(lead, null),
      ...List<int?>.generate(days, (i) => i + 1),
    ];
    while (cells.length % 7 != 0) {
      cells.add(null);
    }

    final rows = <Widget>[];
    for (var r = 0; r < cells.length ~/ 7; r++) {
      rows.add(Row(
        children: [
          for (var c = 0; c < 7; c++) Expanded(child: _dayCell(cells[r * 7 + c])),
        ],
      ));
    }

    return Container(
      width: 250,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AW.surf2,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.black, width: 2.5),
        boxShadow: _hardShadow(const Offset(5, 6)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              GestureDetector(
                onTap: onPrev,
                behavior: HitTestBehavior.opaque,
                child: PhosphorIcon(
                  PhosphorIcons.caretLeft(PhosphorIconsStyle.bold),
                  size: 14,
                  color: AW.txMute,
                ),
              ),
              Flexible(
                child: Text(
                  '${_months[m - 1]} $year',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AWText.sectionHead(),
                ),
              ),
              GestureDetector(
                onTap: onNext,
                behavior: HitTestBehavior.opaque,
                child: PhosphorIcon(
                  PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                  size: 14,
                  color: AW.txMute,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              for (final d in _dow)
                Expanded(
                  child: SizedBox(
                    height: 20,
                    child: Center(
                      child: Text(d, style: AWText.barLabel(c: AW.txMute)),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 2),
          ...rows,
        ],
      ),
    );
  }

  Widget _dayCell(int? day) {
    if (day == null) return const SizedBox(height: 28);
    final selected = day == selectedDay;
    return GestureDetector(
      onTap: () => onPick(day),
      behavior: HitTestBehavior.opaque,
      child: Container(
        height: 28,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? AW.lime : Colors.transparent,
          borderRadius: BorderRadius.circular(100),
        ),
        child: Text(
          '$day',
          style: AWText.chipLabel(c: selected ? AW.glyph : AW.tx),
        ),
      ),
    );
  }
}
