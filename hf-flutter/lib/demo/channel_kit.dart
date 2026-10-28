import 'package:flutter/material.dart';

import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-13] Join as influencer and Channels pieces, built to the owner-approved canvas previews "13 · Join step 1",
/// "13b · Join step 2 / Channels list", "13c · Add a channel", "13d · Connect + code" and "13e · Channel checked" (2026-10-22).

/// Numbered circles for Details · Channels · WhatsApp with lines between.
class JoinStepper extends StatelessWidget {
  const JoinStepper({super.key, required this.step});
  final int step;
  @override
  Widget build(BuildContext context) {
    const labels = ['Details', 'Social media', 'WhatsApp'];
    Widget dot(int i) {
      final done = i < step;
      final now = i == step;
      return Expanded(
        flex: 10,
        child: Column(children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: now ? C.rani : (done ? C.maroon : C.white),
              border: now || done ? null : Border.all(color: C.line, width: 2),
            ),
            child: done ? const Icon(Icons.check_rounded, size: 18, color: C.lemon) : Text('${i + 1}', style: t(15, color: now ? C.white : C.muted, w: FontWeight.w900)),
          ),
          const SizedBox(height: 4),
          FittedBox(fit: BoxFit.scaleDown, child: Text(labels[i], style: t(14, color: now ? C.rani : C.muted, w: FontWeight.w800))),
        ]),
      );
    }

    Widget line(int i) => Expanded(
          flex: 6,
          child: Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Container(height: 3, decoration: BoxDecoration(color: i < step ? C.maroon : C.line, borderRadius: BorderRadius.circular(3))),
          ),
        );
    return Semantics(
      label: 'Step ${step + 1} of 3, ${labels[step]}',
      child: ExcludeSemantics(
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [dot(0), line(0), dot(1), line(1), dot(2)]),
      ),
    );
  }
}

/// "1/3" gold badge for the header.
class StepBadge extends StatelessWidget {
  const StepBadge(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: t(16, color: C.amber, w: FontWeight.w900)),
      );
}

/// Back circle, title and a right-hand widget (badge or marigold).
class ChannelHeader extends StatelessWidget {
  const ChannelHeader(this.title, {super.key, this.trailing});
  final String title;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
        child: Row(children: [
          const BackBtn(),
          const SizedBox(width: 10),
          Expanded(child: Semantics(header: true, child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(22, color: C.maroon, w: FontWeight.w900)))),
          trailing ?? const Marigold(size: 38),
        ]),
      );
}

/// White rounded box with a small lavender label over a borderless text field.
class DesiField extends StatelessWidget {
  const DesiField({super.key, required this.label, required this.field});
  final String label;
  final Widget field;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFDDD2FB), width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: t(14, color: C.lav, w: FontWeight.w800)),
          Theme(
            data: Theme.of(context).copyWith(
              inputDecorationTheme: const InputDecorationTheme(
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 8),
              ),
            ),
            child: field,
          ),
        ]),
      );
}

/// Gold tip with a hibiscus.
class DesiTip extends StatelessWidget {
  const DesiTip(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Hibiscus(size: 30),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: t(14, w: FontWeight.w700, h: 1.4))),
        ]),
      );
}

/// Platform tile colours.
Gradient platformGradient(String platform) => switch (platform) {
      'instagram' => const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.rani, C.marigold]),
      'youtube' => const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFC0262D), Color(0xFFE0454B)]),
      'facebook' => const LinearGradient(colors: [Color(0xFF1877F2), Color(0xFF1877F2)]),
      _ => const LinearGradient(colors: [C.lav, C.lav]),
    };

/// Rounded icon square in the platform's colours (greyed when [off]).
class PlatformSquare extends StatelessWidget {
  const PlatformSquare({super.key, required this.platform, required this.icon, this.size = 46, this.off = false});
  final String platform;
  final IconData icon;
  final double size;
  final bool off;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(size * .3),
          gradient: off ? null : platformGradient(platform),
          color: off ? const Color(0xFFE8DDE6) : null,
        ),
        child: Icon(icon, color: C.white, size: size * .5),
      );
}

/// Full-width pill with a dashed pink edge (+ ADD A CHANNEL).
class DashedAddButton extends StatelessWidget {
  const DashedAddButton({super.key, required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.white,
          shape: const StadiumBorder(),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: CustomPaint(
              painter: _DashedPill(),
              child: SizedBox(height: 56, child: Center(child: Text(label, style: t(17, color: C.rani, w: FontWeight.w900)))),
            ),
          ),
        ),
      );
}

class _DashedPill extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final r = RRect.fromRectAndRadius((Offset.zero & size).deflate(1), Radius.circular(size.height / 2));
    final p = Paint()
      ..color = C.rani
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    for (final m in (Path()..addRRect(r)).computeMetrics()) {
      for (var d = 0.0; d < m.length; d += 12) {
        canvas.drawPath(m.extractPath(d, d + 7), p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Small rounded button for channel cards: ghost (lavender edge) or gold.
class ChannelPill extends StatelessWidget {
  const ChannelPill({super.key, required this.label, required this.onTap, this.gold = false});
  final String label;
  final VoidCallback? onTap;
  final bool gold;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Container(
          height: 46,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            gradient: gold ? const LinearGradient(colors: [Color(0xFFF59E0B), Color(0xFFEA6A12)]) : null,
            color: gold ? null : C.white,
            border: gold ? null : Border.all(color: const Color(0xFFDDD2FB), width: 1.5),
          ),
          child: Material(
            color: C.clear,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: onTap,
              child: Center(child: FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: t(15, color: gold ? const Color(0xFF3B1600) : C.maroon, w: FontWeight.w900)))),
            ),
          ),
        ),
      );
}

/// Tick-box row: gold when ticked; the check icons stay so the box reads as a checkbox.
class ConsentTick extends StatelessWidget {
  const ConsentTick({super.key, required this.label, required this.value, required this.onTap});
  final String label;
  final bool value;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        checked: value,
        label: label,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: value ? C.goldtint : C.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: value ? C.marigold : C.line, width: 2),
            ),
            child: Row(children: [
              Icon(value ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded, color: C.maroon, size: 28),
              const SizedBox(width: 10),
              Expanded(child: Text(label, style: t(15, w: FontWeight.w700, h: 1.35))),
            ]),
          ),
        ),
      );
}

/// Dark plum "One last step" card holding the message, the code box and the line under it.
class CodeStepCard extends StatelessWidget {
  const CodeStepCard({super.key, required this.message, required this.code, required this.line});
  final String message;
  final Widget code;
  final String line;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(26),
          gradient: const RadialGradient(center: Alignment(.6, -1), radius: 1.6, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .5, 1]),
        ),
        child: Stack(children: [
          const Positioned(right: -14, top: -14, child: Marigold(size: 56, yellow: true)),
          Padding(
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('ONE LAST STEP', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 6),
              Text(message, style: t(16, color: C.white, w: FontWeight.w700, h: 1.4)),
              const SizedBox(height: 14),
              code,
              const SizedBox(height: 10),
              Text(line, style: t(14, color: const Color(0xFFF7E6F0), w: FontWeight.w700, h: 1.4)),
            ]),
          ),
        ]),
      );
}

/// Pink celebration card (approved) or a calm cream card for the other results.
class ResultCard extends StatelessWidget {
  const ResultCard({super.key, required this.title, required this.message, this.art, this.happy = false, this.extra});
  final String title;
  final String message;
  final String? art;
  final bool happy;
  final Widget? extra;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(30),
          border: Border.all(color: happy ? const Color(0xFFF8C4D9) : const Color(0xFFF3DFB3), width: 1.5),
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: happy ? const [Color(0xFFFFE0EC), Color(0xFFFFF0F6), Color(0xFFFFF6EA)] : const [Color(0xFFFFF1D6), Color(0xFFFFF8F0)],
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 22),
          child: Column(children: [
            ExcludeSemantics(
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                for (var i = 0; i < 11; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 3), child: Jasmine(size: 16)),
              ]),
            ),
            const SizedBox(height: 6),
            if (art != null) SizedBox(width: 210, height: 210, child: Art(art!, fit: BoxFit.contain)),
            if (art == null) const SizedBox(height: 16),
            Text(title, textAlign: TextAlign.center, style: t(happy ? 44 : 28, color: happy ? C.rani : C.maroon, w: FontWeight.w900, h: 1.05)),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center, style: t(16, color: happy ? C.muted : C.deep, w: FontWeight.w700, h: 1.4)),
            if (extra != null) ...[const SizedBox(height: 16), extra!],
          ]),
        ),
      );
}

/// Gold or plum full-width button used on the channel screens.
class ChannelBigButton extends StatelessWidget {
  const ChannelBigButton({super.key, required this.label, required this.onTap, this.ghost = false});
  final String label;
  final VoidCallback? onTap;
  final bool ghost;
  @override
  Widget build(BuildContext context) => Opacity(
        opacity: onTap == null ? .55 : 1,
        child: Semantics(
          button: true,
          child: Container(
            height: 58,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              gradient: ghost ? null : const LinearGradient(colors: [Color(0xFF4A1747), Color(0xFF6B2468)]),
              color: ghost ? C.white : null,
              border: ghost ? Border.all(color: C.maroon, width: 2) : null,
              boxShadow: ghost ? null : const [BoxShadow(color: Color(0xB34A1747), offset: Offset(0, 14), blurRadius: 26, spreadRadius: -14)],
            ),
            child: Material(
              color: C.clear,
              child: InkWell(
                customBorder: const StadiumBorder(),
                onTap: onTap,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: t(17, color: ghost ? C.maroon : C.white, w: FontWeight.w900))),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
}
