import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'data.dart';
import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-5] Booking flow pieces, built to the owner-approved canvas previews "5 · Book a time",
/// "5b · Confirm booking" and "5c · Booked!" (2026-10-22). Shared by the demo and real booking screens.

/// Back circle, plum title and a marigold on the right.
class BookHeader extends StatelessWidget {
  const BookHeader(this.title, {super.key});
  final String title;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
        child: Row(children: [
          const BackBtn(),
          const SizedBox(width: 10),
          Expanded(child: Semantics(header: true, child: Text(title, style: t(24, color: C.maroon, w: FontWeight.w900)))),
          const Marigold(size: 38),
        ]),
      );
}

/// Pink strip: round photo with a rani ring, name, gold rate chip and a white chip.
class BookPerson extends StatelessWidget {
  const BookPerson({super.key, required this.who, required this.name, required this.rate, required this.chip});
  final Influencer who;
  final String name;
  final String rate;
  final String chip;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFF8C4D9), width: 1.5),
          gradient: const LinearGradient(colors: [Color(0xFFFFF0F6), Color(0xFFFFF6EA)]),
        ),
        child: Stack(children: [
          const Positioned(right: -10, bottom: -12, child: Hibiscus(size: 44)),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 30, 12),
            child: Row(children: [
              Container(
                padding: const EdgeInsets.all(3),
                decoration: const BoxDecoration(color: C.rani, shape: BoxShape.circle),
                child: Avatar(who, size: 56),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(20, w: FontWeight.w900)),
                  const SizedBox(height: 4),
                  Wrap(spacing: 6, runSpacing: 4, children: [
                    DesiChip(rate, tone: DesiTone.gold),
                    _WhiteChip(chip),
                  ]),
                ]),
              ),
            ]),
          ),
        ]),
      );
}

class _WhiteChip extends StatelessWidget {
  const _WhiteChip(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: t(14, color: C.muted, w: FontWeight.w800)),
      );
}

enum BookTone { gold, tea, lav }

/// A numbered step card: gold (date), teal (time) or lavender (topic).
class BookStep extends StatelessWidget {
  const BookStep({super.key, required this.n, required this.title, required this.sub, required this.tone, required this.child});
  final String n;
  final String title;
  final String sub;
  final BookTone tone;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final (tint, edge, ink) = switch (tone) {
      BookTone.gold => (C.goldtint, const Color(0xFFF3DFB3), C.saffron),
      BookTone.tea => (C.teatint, const Color(0xFFB9E2E5), C.peacock),
      BookTone.lav => (C.lavtint, const Color(0xFFDDD2FB), C.lav),
    };
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: edge, width: 1.5),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, tint]),
      ),
      child: Stack(children: [
        if (tone == BookTone.gold) const Positioned(right: -14, top: -14, child: Marigold(size: 50, yellow: true)),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                width: 34,
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: ink, shape: BoxShape.circle),
                child: Text(n, style: t(16, color: C.white, w: FontWeight.w900)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: t(18, w: FontWeight.w900)),
                  Text(sub, style: t(14, color: C.muted, w: FontWeight.w700)),
                ]),
              ),
            ]),
            const SizedBox(height: 12),
            child,
          ]),
        ),
      ]),
    );
  }
}

/// Time pill (teal; chosen one solid teal).
class BookSlotPill extends StatelessWidget {
  const BookSlotPill({super.key, required this.label, required this.on, required this.onTap});
  final String label;
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => _Pill(label: label, on: on, onTap: onTap, onColor: C.peacock, offInk: const Color(0xFF0B5F66), edge: const Color(0xFFB9E2E5));
}

/// Topic pill (lavender edge; chosen one plum with a tick).
class BookTopicPill extends StatelessWidget {
  const BookTopicPill({super.key, required this.label, required this.on, required this.onTap});
  final String label;
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => _Pill(label: label, on: on, onTap: onTap, onColor: C.maroon, offInk: C.maroon, edge: const Color(0xFFDDD2FB), tick: true);
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.on, required this.onTap, required this.onColor, required this.offInk, required this.edge, this.tick = false});
  final String label;
  final bool on;
  final VoidCallback onTap;
  final Color onColor;
  final Color offInk;
  final Color edge;
  final bool tick;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        selected: on,
        child: Material(
          color: on ? onColor : C.white,
          shape: StadiumBorder(side: BorderSide(color: on ? onColor : edge, width: 1.5)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 46),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (tick && on) ...[const Icon(Icons.check_rounded, size: 18, color: C.white), const SizedBox(width: 6)],
                Flexible(child: Text(label, style: t(15, color: on ? C.white : offInk, w: FontWeight.w800))),
              ]),
            ),
          ),
        ),
      );
}

/// Month calendar for the gold step: open days gold, chosen day plum, past days faded.
class BookMonth extends StatelessWidget {
  const BookMonth({super.key, required this.month, required this.selected, required this.fill, required this.onPick, required this.onMonth, this.dots = const {}, this.allowPast = false});
  final DateTime month;
  final DateTime? selected;
  final Set<String> fill;

  /// [HF-APP-DESI-12] Days with bookings: white cell with a gold edge and a pink dot (influencer calendar).
  final Set<String> dots;
  final bool allowPast;
  final ValueChanged<DateTime> onPick;
  final ValueChanged<DateTime> onMonth;

  Widget _nav(String tip, IconData icon, VoidCallback onTap) => Tooltip(
        message: tip,
        child: Semantics(
          button: true,
          label: tip,
          child: GestureDetector(
            onTap: onTap,
            behavior: HitTestBehavior.opaque,
            child: SizedBox(
              width: 48,
              height: 48,
              child: Center(
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: C.white, shape: BoxShape.circle, border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5)),
                  child: Icon(icon, color: C.amber),
                ),
              ),
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final first = DateTime(month.year, month.month, 1);
    final daysInMonth = DateTime(month.year, month.month + 1, 0).day;
    final lead = first.weekday - 1;
    final today = dayOnly(DateTime.now());
    return Column(children: [
      Row(children: [
        _nav('Previous month', Icons.chevron_left_rounded, () => onMonth(DateTime(month.year, month.month - 1, 1))),
        Expanded(child: Text('${monthLong[month.month - 1]} ${month.year}', textAlign: TextAlign.center, style: t(17, w: FontWeight.w900))),
        _nav('Next month', Icons.chevron_right_rounded, () => onMonth(DateTime(month.year, month.month + 1, 1))),
      ]),
      const SizedBox(height: 6),
      GridView.count(
        crossAxisCount: 7,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 4,
        crossAxisSpacing: 4,
        childAspectRatio: 1.05,
        padding: EdgeInsets.zero,
        children: [
          for (final w in weekdayShort) Center(child: Text(w.substring(0, 1), style: t(14, color: C.amber, w: FontWeight.w800))),
          for (var i = 0; i < lead; i++) const SizedBox.shrink(),
          for (var d = 1; d <= daysInMonth; d++) _day(DateTime(month.year, month.month, d), today),
        ],
      ),
    ]);
  }

  Widget _day(DateTime d, DateTime today) {
    final past = d.isBefore(today);
    final on = selected != null && dayKey(selected!) == dayKey(d);
    final open = fill.contains(dayKey(d));
    final dot = dots.contains(dayKey(d));
    final bg = on ? C.maroon : (open ? C.goldtint : (dot ? C.white : C.clear));
    final edge = on ? C.maroon : (open || dot ? const Color(0xFFF3DFB3) : C.clear);
    final fg = on ? C.white : (past && !allowPast ? const Color(0xFFC9B8C6) : (open || dot ? C.deep : (past ? const Color(0xFFC9B8C6) : C.muted)));
    return GestureDetector(
      onTap: past && !allowPast ? null : () => onPick(d),
      child: Container(
        alignment: Alignment.center,
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: edge, width: 2)),
        child: Stack(alignment: Alignment.center, children: [
          Text('${d.day}', style: t(15, color: fg, w: FontWeight.w800)),
          if (dot) Positioned(bottom: 3, child: Container(width: 6, height: 6, decoration: BoxDecoration(shape: BoxShape.circle, color: on ? C.lemon : C.rani))),
        ]),
      ),
    );
  }
}

/// Full-width pill at the bottom of a booking screen: pink (next) or plum (confirm).
class BookBottomButton extends StatelessWidget {
  const BookBottomButton({super.key, required this.label, required this.onTap, this.enabled = true, this.plum = false, this.icon = Icons.arrow_forward_rounded, this.padding = const EdgeInsets.fromLTRB(16, 8, 16, 20), this.height = 60});
  final String label;
  final VoidCallback onTap;
  final bool enabled;
  final bool plum;
  final IconData? icon;
  final EdgeInsets padding;
  final double height;
  @override
  Widget build(BuildContext context) => Padding(
        padding: padding,
        child: Opacity(
          opacity: enabled ? 1 : .5,
          child: Semantics(
            button: true,
            enabled: enabled,
            child: Container(
              height: height,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                gradient: LinearGradient(colors: plum ? const [Color(0xFF4A1747), Color(0xFF6B2468)] : const [Color(0xFFD81B72), Color(0xFFF0408F)]),
                boxShadow: const [BoxShadow(color: Color(0xB34A1747), offset: Offset(0, 14), blurRadius: 26, spreadRadius: -14)],
              ),
              child: Material(
                color: C.clear,
                child: InkWell(
                  customBorder: const StadiumBorder(),
                  onTap: enabled ? onTap : null,
                  child: Center(
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(label, style: t(18, color: C.white, w: FontWeight.w900)),
                      if (icon != null) ...[const SizedBox(width: 10), Icon(icon, color: C.white, size: 20)],
                    ]),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
}

/// Ticket card: plum top with photo and "Call with", dashed tear line, gold Date and teal Time tiles.
class BookTicket extends StatelessWidget {
  const BookTicket({super.key, required this.who, required this.name, required this.sub, required this.date, required this.time});
  final Influencer who;
  final String name;
  final String sub;
  final String date;
  final String time;

  Widget _tile(Color tint, Color edge, Color ink, IconData icon, String label, String value) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(18), border: Border.all(color: edge, width: 1.5)),
        child: Column(children: [
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(icon, size: 16, color: ink), const SizedBox(width: 4), Text(label, style: t(14, color: ink, w: FontWeight.w800))]),
          const SizedBox(height: 2),
          FittedBox(fit: BoxFit.scaleDown, child: Text(value, style: t(18, w: FontWeight.w900))),
        ]),
      );

  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          color: C.white,
          borderRadius: BorderRadius.circular(26),
          border: Border.all(color: C.line),
          boxShadow: const [BoxShadow(color: Color(0x8C4A1747), offset: Offset(0, 16), blurRadius: 30, spreadRadius: -18)],
        ),
        child: Column(children: [
          ClipRRect(
            borderRadius: const BorderRadius.vertical(top: Radius.circular(25)),
            child: Container(
              decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF4A1747), Color(0xFF6B2468)])),
              child: Stack(children: [
                const Positioned(right: -16, top: -16, child: Marigold(size: 64, yellow: true)),
                Padding(
                  padding: const EdgeInsets.all(18),
                  child: Row(children: [
                    Container(padding: const EdgeInsets.all(3), decoration: const BoxDecoration(color: C.lemon, shape: BoxShape.circle), child: Avatar(who, size: 72)),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('CALL WITH', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .06)),
                        Text(name, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(26, color: C.white, w: FontWeight.w900, h: 1.1)),
                        Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.white, w: FontWeight.w700)),
                      ]),
                    ),
                  ]),
                ),
              ]),
            ),
          ),
          const _TearLine(),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              Expanded(child: _tile(C.goldtint, const Color(0xFFF3DFB3), C.amber, Icons.event_rounded, 'Date', date)),
              const SizedBox(width: 10),
              Expanded(child: _tile(C.teatint, const Color(0xFFB9E2E5), C.peacock, Icons.schedule_rounded, 'Time', time)),
            ]),
          ),
        ]),
      );
}

class _TearLine extends StatelessWidget {
  const _TearLine();
  @override
  Widget build(BuildContext context) => SizedBox(height: 4, child: CustomPaint(painter: _DashPainter(), size: const Size(double.infinity, 4)));
}

class _DashPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = C.line
      ..strokeWidth = 2.5;
    for (var x = 18.0; x < size.width - 18; x += 10) {
      canvas.drawLine(Offset(x, size.height / 2), Offset(x + 5, size.height / 2), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Dark plum "Hisaab" card: label/value lines in haldi; [strong] lines larger; the last line white.
class HisaabCard extends StatelessWidget {
  const HisaabCard({super.key, required this.lines, this.strong = const {}});
  final List<(String, String)> lines;
  final Set<String> strong;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF2B1530), Color(0xFF4A1747)]),
        ),
        child: Stack(children: [
          const Positioned(right: -14, top: -14, child: Marigold(size: 50)),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('HISAAB', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 4),
              for (var i = 0; i < lines.length; i++)
                Container(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: BoxDecoration(border: i == lines.length - 1 ? null : const Border(bottom: BorderSide(color: Color(0x2EFFFFFF)))),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Expanded(child: Text(lines[i].$1, style: t(15, color: const Color(0xFFF7E6F0), w: FontWeight.w700))),
                    Text(lines[i].$2,
                        style: t(strong.contains(lines[i].$1) ? 20 : 17, color: i == lines.length - 1 ? C.white : C.lemon, w: FontWeight.w900)),
                  ]),
                ),
            ]),
          ),
        ]),
      );
}

/// Gold notice with a round icon (approval, reminder).
class BookNotice extends StatelessWidget {
  const BookNotice({super.key, required this.text, this.icon = Icons.hourglass_top_rounded, this.teal = false, this.textKey});
  final String text;
  final IconData icon;
  final bool teal;
  final Key? textKey;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: teal ? const Color(0xFFB9E2E5) : const Color(0xFFF3DFB3), width: 1.5),
          gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, teal ? C.teatint : C.goldtint]),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: teal ? C.peacock : C.marigold, shape: BoxShape.circle),
            child: Icon(icon, color: C.white, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(child: Padding(padding: const EdgeInsets.only(top: 2), child: Text(text, key: textKey, style: t(15, w: FontWeight.w700, h: 1.4)))),
        ]),
      );
}

/// White rounded note box around a text field.
class BookNoteField extends StatelessWidget {
  const BookNoteField({super.key, required this.controller, required this.label});
  final TextEditingController controller;
  final String label;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFDDD2FB), width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: t(14, color: C.lav, w: FontWeight.w800)),
          TextField(
            controller: controller,
            maxLength: 200,
            maxLines: 2,
            style: t(16, w: FontWeight.w700),
            decoration: InputDecoration(
              isDense: true,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              filled: false,
              hintText: 'Say what you want to talk about…',
              hintStyle: t(16, color: const Color(0xFFB9A8B8), w: FontWeight.w700),
              helperText: 'No phone numbers or links please.',
              helperStyle: t(14, color: C.muted, w: FontWeight.w700),
            ),
          ),
        ]),
      );
}

/// Pink celebration card: flower string, Tara art, big title, line, and a dashed stub with name and time.
class BookedCard extends StatelessWidget {
  const BookedCard({super.key, required this.title, required this.line, required this.name, required this.when});
  final String title;
  final String line;
  final String name;
  final String when;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(30),
          border: Border.all(color: const Color(0xFFF8C4D9), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFFFE0EC), Color(0xFFFFF0F6), Color(0xFFFFEFD9)]),
        ),
        child: Stack(children: [
          const Positioned(left: -18, bottom: 90, child: Marigold(size: 60)),
          const Positioned(right: -14, top: 120, child: Hibiscus(size: 48)),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 22),
            child: Column(children: [
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                for (var i = 0; i < 11; i++) i.isEven ? const Marigold(size: 22, yellow: true) : const Padding(padding: EdgeInsets.only(top: 6), child: Jasmine(size: 18)),
              ]),
              const SizedBox(height: 8),
              const SizedBox(width: 240, height: 240, child: Art('booking/booked-tara.webp', fit: BoxFit.contain)),
              Text(title, textAlign: TextAlign.center, style: t(title.length > 10 ? 44 : 56, color: C.rani, w: FontWeight.w900, h: 1)),
              const SizedBox(height: 8),
              Text(line, textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700)),
              const SizedBox(height: 14),
              CustomPaint(
                painter: _DashedBox(),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    if (name.isNotEmpty) Text(name, textAlign: TextAlign.center, style: t(20, w: FontWeight.w900)),
                    Text(when, textAlign: TextAlign.center, style: t(17, color: C.amber, w: FontWeight.w800)),
                  ]),
                ),
              ),
            ]),
          ),
        ]),
      );
}

class _DashedBox extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final r = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(20));
    canvas.drawRRect(r, Paint()..color = C.white);
    final p = Paint()
      ..color = const Color(0xFFF3DFB3)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final path = Path()..addRRect(r);
    for (final m in path.computeMetrics()) {
      for (var d = 0.0; d < m.length; d += 10) {
        canvas.drawPath(m.extractPath(d, d + 5), p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The rest of the Booked screen: reminder card, My bookings, Back to reels, mogra.
class BookedActions extends StatelessWidget {
  const BookedActions({super.key, required this.notice, this.noticeKey});
  final String notice;
  final Key? noticeKey;
  @override
  Widget build(BuildContext context) => Column(children: [
        BookNotice(text: notice, icon: Icons.notifications_active_rounded, teal: true, textKey: noticeKey),
        const SizedBox(height: 14),
        BookBottomButton(label: 'MY BOOKINGS', plum: true, icon: null, height: 58, padding: EdgeInsets.zero, onTap: () => context.pushReplacement('/bookings')),
        const SizedBox(height: 6),
        TextButton(onPressed: () => context.go('/reels'), child: Text('Back to reels', style: t(16, color: C.maroon, w: FontWeight.w800))),
        const SizedBox(height: 6),
        const DesiMogra(),
      ]);
}
