import 'package:flutter/material.dart';

import 'data.dart';
import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-6] Call flow pieces, built to the owner-approved canvas previews "6 · Call confirm sheet", "6b · On call"
/// and "6c · Call ended" (2026-10-22). Shared by the demo and real call screens.

// ------------------------------------------------------------------------------------------------ confirm sheet

/// Cream bottom sheet with a flower string along the top and a handle.
class CallSheetFrame extends StatelessWidget {
  const CallSheetFrame({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(color: C.ivory, borderRadius: BorderRadius.vertical(top: Radius.circular(30))),
        clipBehavior: Clip.antiAlias,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              for (var i = 0; i < 13; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 3), child: Jasmine(size: 16)),
            ]),
          ),
          const SizedBox(height: 6),
          Container(width: 44, height: 5, decoration: BoxDecoration(color: const Color(0xFFE7D9C9), borderRadius: BorderRadius.circular(3))),
          const SizedBox(height: 12),
          child,
        ]),
      );
}

/// Photo in a rani ring with an Online label underneath, and the title.
class CallSheetHead extends StatelessWidget {
  const CallSheetHead({super.key, required this.who, required this.title});
  final Influencer who;
  final String title;
  @override
  Widget build(BuildContext context) => Column(children: [
        SizedBox(
          width: 104,
          height: 112,
          child: Stack(alignment: Alignment.topCenter, clipBehavior: Clip.none, children: [
            Container(padding: const EdgeInsets.all(4), decoration: const BoxDecoration(color: C.rani, shape: BoxShape.circle), child: Avatar(who, size: 88)),
            if (who.online)
              Positioned(
                bottom: 0,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  decoration: BoxDecoration(color: C.onlineBg, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.white, width: 2)),
                  child: Text('● Online', style: t(14, color: C.onlineInk, w: FontWeight.w800)),
                ),
              ),
          ]),
        ),
        const SizedBox(height: 8),
        Text(title, textAlign: TextAlign.center, style: t(26, color: C.maroon, w: FontWeight.w900)),
      ]);
}

/// Dark plum "Hisaab": Rate, Your wallet (white), then a big gold Talk time line.
class CallSheetHisaab extends StatelessWidget {
  const CallSheetHisaab({super.key, required this.rate, required this.wallet, required this.talk});
  final String rate;
  final String wallet;
  final String talk;

  Widget _line(String a, String b, Color c) => Container(
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0x2EFFFFFF)))),
        child: Row(children: [
          Expanded(child: Text(a, style: t(15, color: const Color(0xFFF7E6F0), w: FontWeight.w700))),
          Text(b, style: t(17, color: c, w: FontWeight.w900)),
        ]),
      );

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
              _line('Rate', rate, C.lemon),
              _line('Your wallet', wallet, C.white),
              Padding(
                padding: const EdgeInsets.only(top: 10, bottom: 2),
                child: Row(children: [
                  Expanded(child: Text('Talk time', style: t(16, color: C.lemon, w: FontWeight.w800))),
                  Text(talk, style: t(24, color: C.lemon, w: FontWeight.w900)),
                ]),
              ),
            ]),
          ),
        ]),
      );
}

/// Teal "both numbers stay private" note.
class CallPrivacyNote extends StatelessWidget {
  const CallPrivacyNote({super.key, required this.first});
  final String first;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.teatint]),
        ),
        child: Row(children: [
          Container(width: 38, height: 38, decoration: const BoxDecoration(color: C.peacock, shape: BoxShape.circle), child: const Icon(Icons.lock_rounded, color: C.white, size: 18)),
          const SizedBox(width: 12),
          Expanded(child: Text('We ring $first first, then your phone. Both numbers stay private.', style: t(14, w: FontWeight.w700, h: 1.4))),
        ]),
      );
}

enum CallPillKind { rani, plum, gold, red, ghost }

/// Full-width rounded call button; [tag] is a small see-through chip after the label (the rate).
class CallPill extends StatelessWidget {
  const CallPill({super.key, required this.label, required this.onTap, this.kind = CallPillKind.rani, this.icon, this.tag, this.height = 60});
  final String label;
  final VoidCallback? onTap;
  final CallPillKind kind;
  final IconData? icon;
  final String? tag;
  final double height;
  @override
  Widget build(BuildContext context) {
    final (List<Color>? g, Color ink, Color? glow, Color? edge) = switch (kind) {
      CallPillKind.rani => (const [Color(0xFFD81B72), Color(0xFFF0408F)], C.white, const Color(0xE6D81B72), null),
      CallPillKind.plum => (const [Color(0xFF4A1747), Color(0xFF6B2468)], C.white, const Color(0xB34A1747), null),
      CallPillKind.gold => (const [Color(0xFFF59E0B), Color(0xFFEA6A12)], const Color(0xFF3B1600), null, null),
      CallPillKind.red => (const [Color(0xFFC0262D), Color(0xFFE0454B)], C.white, const Color(0xE6C0262D), null),
      CallPillKind.ghost => (null, C.white, null, const Color(0x80FFFFFF)),
    };
    return Opacity(
      opacity: onTap == null ? .55 : 1,
      child: Semantics(
        button: true,
        enabled: onTap != null,
        child: Container(
          height: height,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            gradient: g == null ? null : LinearGradient(colors: g),
            border: edge == null ? null : Border.all(color: edge, width: 1.5),
            boxShadow: glow == null ? null : [BoxShadow(color: glow, offset: const Offset(0, 14), blurRadius: 26, spreadRadius: -14)],
          ),
          child: Material(
            color: C.clear,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: onTap,
              child: Center(
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (icon != null) ...[Icon(icon, color: ink, size: 22), const SizedBox(width: 10)],
                  Text(label, style: t(19, color: ink, w: FontWeight.w900)),
                  if (tag != null) ...[
                    const SizedBox(width: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                      decoration: BoxDecoration(color: const Color(0x38FFFFFF), borderRadius: BorderRadius.circular(999)),
                      child: Text(tag!, style: t(14, color: ink, w: FontWeight.w800)),
                    ),
                  ],
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ call screen

/// Dark plum call background: gold dots, flower string on top, marigold and hibiscus at the edges.
class CallBackdrop extends StatelessWidget {
  const CallBackdrop({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Stack(fit: StackFit.expand, children: [
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(center: Alignment(0, -.64), radius: 1.2, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .45, 1]),
          ),
        ),
        const CustomPaint(painter: _Dots()),
        const Positioned(left: -24, bottom: 150, child: Marigold(size: 80)),
        const Positioned(right: -20, top: 300, child: Hibiscus(size: 64)),
        SafeArea(
          child: Stack(children: [
            Positioned(
              left: 12,
              right: 12,
              top: 0,
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                for (var i = 0; i < 13; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 3), child: Jasmine(size: 16)),
              ]),
            ),
            Positioned.fill(child: child),
          ]),
        ),
      ]);
}

class _Dots extends CustomPainter {
  const _Dots();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = const Color(0x24FBBF24);
    for (var y = 9.0; y < size.height; y += 18) {
      for (var x = 9.0; x < size.width; x += 18) {
        canvas.drawCircle(Offset(x, y), 1.5, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Her photo inside soft marigold rings (pulsing while [active]); a smaller plain photo once the call is over.
class CallPortrait extends StatelessWidget {
  const CallPortrait({super.key, required this.who, required this.pulse, required this.active, this.small = false});
  final Influencer who;
  final Animation<double> pulse;
  final bool active;
  final bool small;
  @override
  Widget build(BuildContext context) {
    final photo = Container(padding: const EdgeInsets.all(4), decoration: const BoxDecoration(color: C.lemon, shape: BoxShape.circle), child: Avatar(who, size: small ? 112 : 142));
    if (small) return photo;
    return SizedBox(
      width: 230,
      height: 230,
      child: Stack(alignment: Alignment.center, children: [
        Container(decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x24F59E0B))),
        Container(margin: const EdgeInsets.all(22), decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x38F59E0B))),
        if (active)
          AnimatedBuilder(
            animation: pulse,
            builder: (_, __) => Container(
              width: 150 + 80 * pulse.value,
              height: 150 + 80 * pulse.value,
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: C.lemon.withValues(alpha: .6 * (1 - pulse.value)), width: 3)),
            ),
          ),
        photo,
      ]),
    );
  }
}

/// Green "● On call" label.
class CallOnChip extends StatelessWidget {
  const CallOnChip({super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(color: C.onlineBg, borderRadius: BorderRadius.circular(999)),
        child: Text('● On call', style: t(16, color: C.onlineInk, w: FontWeight.w800)),
      );
}

/// Big gold call clock.
class CallClock extends StatelessWidget {
  const CallClock(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Text(text, style: t(56, color: C.lemon, w: FontWeight.w900, ls: .04).copyWith(fontFeatures: const [FontFeature.tabularFigures()]));
}

/// "So far" (gold) and "Wallet left" (teal) glass tiles.
class CallSpendTiles extends StatelessWidget {
  const CallSpendTiles({super.key, required this.spent, required this.spentSub, this.wallet, this.walletSub = 'in your wallet'});
  final String spent;
  final String spentSub;
  final String? wallet;
  final String walletSub;

  Widget _tile(String label, Color ink, Color fill, Color edge, String value, String sub) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(20), border: Border.all(color: edge, width: 1.5)),
        child: Column(children: [
          Text(label, style: t(14, color: ink, w: FontWeight.w800)),
          FittedBox(fit: BoxFit.scaleDown, child: Text(value, style: t(22, color: C.white, w: FontWeight.w900))),
          Text(sub, textAlign: TextAlign.center, style: t(14, color: const Color(0xD9FFFFFF), w: FontWeight.w700)),
        ]),
      );

  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(child: _tile('So far', C.lemon, const Color(0x1FFFF1D6), const Color(0x80FBBF24), spent, spentSub)),
        if (wallet != null) ...[
          const SizedBox(width: 10),
          Expanded(child: _tile('Wallet left', const Color(0xFF9FE3E8), const Color(0x1AE3F6F6), const Color(0x80B9E2E5), wallet!, walletSub)),
        ],
      ]);
}

/// Cream "Hisaab" after the call: Talked (gold) and Paid (pink) tiles, or a single [message]; a line under it.
class CallEndHisaab extends StatelessWidget {
  const CallEndHisaab({super.key, this.talked, this.paid, this.message, this.messageKey, this.footer});
  final String? talked;
  final String? paid;
  final String? message;
  final Key? messageKey;
  final String? footer;

  Widget _tile(Color tint, Color edge, Color ink, String label, String value) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(18), border: Border.all(color: edge, width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: t(14, color: ink, w: FontWeight.w800)),
          Text(value, style: t(22, w: FontWeight.w900)),
        ]),
      );

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(color: C.ivory, borderRadius: BorderRadius.circular(24)),
        child: Stack(children: [
          const Positioned(right: -12, top: -12, child: Marigold(size: 48, yellow: true)),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('HISAAB', style: t(14, color: C.rani, w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 8),
              if (message != null)
                Padding(padding: const EdgeInsets.only(right: 24), child: Text(message!, key: messageKey, style: t(16, w: FontWeight.w800, h: 1.4)))
              else
                Row(children: [
                  Expanded(child: _tile(C.goldtint, const Color(0xFFF3DFB3), C.amber, 'Talked', talked ?? '')),
                  const SizedBox(width: 10),
                  Expanded(child: _tile(C.blush, const Color(0xFFF8C4D9), C.rani, 'Paid', paid ?? '')),
                ]),
              if (footer != null) ...[
                const SizedBox(height: 8),
                Text(footer!, style: t(14, color: C.muted, w: FontWeight.w700)),
              ],
            ]),
          ),
        ]),
      );
}

/// "How was it?" with five big stars.
class CallStars extends StatelessWidget {
  const CallStars({super.key, required this.value, required this.onPick});
  final int value;
  final ValueChanged<int> onPick;
  @override
  Widget build(BuildContext context) => Column(children: [
        Text('How was it?', style: t(18, color: C.lemon, w: FontWeight.w900)),
        const SizedBox(height: 4),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (var i = 1; i <= 5; i++)
            IconButton(
              iconSize: 42,
              tooltip: '$i stars',
              onPressed: () => onPick(i),
              icon: Icon(Icons.star_rounded, color: i <= value ? C.marigold : const Color(0x59FFFFFF)),
            ),
        ]),
      ]);
}
