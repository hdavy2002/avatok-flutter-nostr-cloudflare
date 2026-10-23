import 'package:flutter/material.dart';

import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-8] Wallet, Top up and Payment pieces, built to the owner-approved canvas previews "8 · My wallet",
/// "8b · Top up" and "8c · Payment received" (2026-10-22).

Widget _garland(int n) => Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
      for (var i = 0; i < n; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 3), child: Jasmine(size: 16)),
    ]);

/// Dark plum "Gullak": flower string, gold dots, balance, little chips, orange Top up and white Withdraw.
class GullakCard extends StatelessWidget {
  const GullakCard({super.key, required this.balance, this.chips = const [], required this.onTopUp, required this.onWithdraw});
  final String balance;

  /// (text, gold?) pairs.
  final List<(String, bool)> chips;
  final VoidCallback onTopUp;
  final VoidCallback onWithdraw;

  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(28),
          gradient: const RadialGradient(center: Alignment(.6, -1), radius: 1.6, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .5, 1]),
          boxShadow: const [BoxShadow(color: Color(0xCC4A1747), offset: Offset(0, 18), blurRadius: 34, spreadRadius: -18)],
        ),
        child: Stack(children: [
          const Positioned.fill(child: CustomPaint(painter: _GoldDots())),
          const Positioned(right: -24, top: 34, child: Marigold(size: 84)),
          Positioned(left: 14, bottom: -16, child: ExcludeSemantics(child: Text('GULLAK', style: tOutline(76, color: const Color(0x29FBBF24), stroke: 2)))),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _garland(11),
              const SizedBox(height: 14),
              Text('YOUR BALANCE', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .08)),
              Padding(
                padding: const EdgeInsets.only(right: 60),
                child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(balance, maxLines: 1, style: t(48, color: C.white, w: FontWeight.w900, h: 1.05))),
              ),
              if (chips.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final c in chips)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                      decoration: BoxDecoration(color: c.$2 ? const Color(0x2EFBBF24) : const Color(0x1FFFFFFF), borderRadius: BorderRadius.circular(999)),
                      child: Text(c.$1, style: t(14, color: c.$2 ? const Color(0xFFFDE68A) : C.white, w: FontWeight.w800)),
                    ),
                ]),
              ],
              const SizedBox(height: 16),
              Row(children: [
                Expanded(child: MoneyPill(label: 'TOP UP', icon: Icons.add_rounded, gold: true, onTap: onTopUp, height: 54)),
                const SizedBox(width: 10),
                Expanded(child: MoneyPill(label: 'WITHDRAW', outline: true, onTap: onWithdraw, height: 54)),
              ]),
            ]),
          ),
        ]),
      );
}

class _GoldDots extends CustomPainter {
  const _GoldDots();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = const Color(0x24FBBF24);
    for (var y = 8.0; y < size.height; y += 16) {
      for (var x = 8.0; x < size.width; x += 16) {
        canvas.drawCircle(Offset(x, y), 1.5, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Rounded money button: gold, rani, plum or white outline (on dark).
class MoneyPill extends StatelessWidget {
  const MoneyPill({super.key, required this.label, required this.onTap, this.icon, this.gold = false, this.rani = false, this.outline = false, this.height = 58});
  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool gold;
  final bool rani;
  final bool outline;
  final double height;
  @override
  Widget build(BuildContext context) {
    final List<Color>? g = gold
        ? const [Color(0xFFF59E0B), Color(0xFFEA6A12)]
        : rani
            ? const [Color(0xFFD81B72), Color(0xFFF0408F)]
            : outline
                ? null
                : const [Color(0xFF4A1747), Color(0xFF6B2468)];
    final ink = gold ? const Color(0xFF3B1600) : C.white;
    return Semantics(
      button: true,
      child: Container(
        height: height,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          gradient: g == null ? null : LinearGradient(colors: g),
          border: outline ? Border.all(color: const Color(0x80FFFFFF), width: 1.5) : null,
          boxShadow: rani ? const [BoxShadow(color: Color(0xCCD81B72), offset: Offset(0, 14), blurRadius: 26, spreadRadius: -14)] : null,
        ),
        child: Material(
          color: C.clear,
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: Center(
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (icon != null) ...[Icon(icon, color: ink, size: 20), const SizedBox(width: 6)],
                Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17, color: ink, w: FontWeight.w900))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// "History · Latest first".
class HistoryTitle extends StatelessWidget {
  const HistoryTitle({super.key});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6, bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Expanded(child: Text('History', style: t(20, color: C.maroon, w: FontWeight.w900))),
          Text('Latest first', style: t(14, color: C.amber, w: FontWeight.w700)),
        ]),
      );
}

/// One wallet entry: gold ＋ tile for money in, pink phone tile for money out, amount on the right.
class LedgerRow extends StatelessWidget {
  const LedgerRow({super.key, required this.title, required this.sub, required this.amount, required this.amountText});
  final String title;
  final String sub;
  final double amount;
  final String amountText;
  @override
  Widget build(BuildContext context) {
    final inflow = amount >= 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: C.line, width: 1.5)),
      child: Row(children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(color: inflow ? C.goldtint : C.blush, borderRadius: BorderRadius.circular(14)),
          child: Icon(inflow ? Icons.add_rounded : Icons.call_rounded, color: inflow ? C.amber : const Color(0xFFB0145B), size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w900)),
            Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
        const SizedBox(width: 8),
        Text(amountText, style: t(16, color: inflow ? C.maroon : C.ruby, w: FontWeight.w900)),
      ]),
    );
  }
}

/// Gold "Gullak bharo" header with the thread spools.
class TopUpHero extends StatelessWidget {
  const TopUpHero({super.key});
  @override
  Widget build(BuildContext context) => const DesiHero(
        eyebrow: 'Top up',
        title: 'Gullak bharo',
        sub: 'Add money for calls and bookings.',
        ghost: 'Paisa',
        tone: DesiTone.gold,
        minHeight: 140,
        art: SizedBox(width: 124, height: 120, child: Art('topup/thread-spools.webp', fit: BoxFit.contain)),
      );
}

/// White amount box: question, big ₹ field and the quick-amount pills.
class AmountBox extends StatelessWidget {
  const AmountBox({super.key, required this.controller, required this.value, required this.onChanged, required this.onPick, this.quick = const [100, 250, 500, 1000], required this.label});
  final TextEditingController controller;
  final int value;
  final ValueChanged<String> onChanged;
  final ValueChanged<int> onPick;
  final List<int> quick;
  final String Function(int) label;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: const Color(0xFFF3DFB3), width: 2)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('How much do you want to pay?', style: t(15, color: C.muted, w: FontWeight.w800)),
          TextField(
            controller: controller,
            keyboardType: TextInputType.number,
            onChanged: onChanged,
            style: t(44, w: FontWeight.w900),
            decoration: InputDecoration(
              filled: false,
              prefixIcon: Padding(padding: const EdgeInsets.only(right: 6), child: Text('₹', style: t(38, color: C.amber, w: FontWeight.w900))),
              prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
              contentPadding: const EdgeInsets.symmetric(vertical: 4),
              border: const UnderlineInputBorder(borderSide: BorderSide(color: C.marigold, width: 3)),
              enabledBorder: const UnderlineInputBorder(borderSide: BorderSide(color: C.marigold, width: 3)),
              focusedBorder: const UnderlineInputBorder(borderSide: BorderSide(color: C.saffron, width: 3)),
            ),
          ),
          const SizedBox(height: 14),
          Row(children: [
            for (var i = 0; i < quick.length; i++) ...[
              Expanded(
                child: Semantics(
                  button: true,
                  selected: value == quick[i],
                  child: Material(
                    color: value == quick[i] ? C.maroon : C.goldtint,
                    shape: StadiumBorder(side: BorderSide(color: value == quick[i] ? C.maroon : const Color(0xFFF3DFB3), width: 1.5)),
                    child: InkWell(
                      customBorder: const StadiumBorder(),
                      onTap: () => onPick(quick[i]),
                      child: SizedBox(
                        height: 48,
                        child: Center(
                          child: FittedBox(fit: BoxFit.scaleDown, child: Text(label(quick[i]), style: t(15, color: value == quick[i] ? C.white : C.amber, w: FontWeight.w900))),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (i < quick.length - 1) const SizedBox(width: 8),
            ],
          ]),
        ]),
      );
}

/// Dark plum "Hisaab" with a big gold last line.
class MoneyHisaab extends StatelessWidget {
  const MoneyHisaab({super.key, required this.lines, required this.total});
  final List<(String, String)> lines;
  final (String, String) total;
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
              for (final l in lines)
                Container(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0x2EFFFFFF)))),
                  child: Row(children: [
                    Expanded(child: Text(l.$1, style: t(15, color: const Color(0xFFF7E6F0), w: FontWeight.w700))),
                    Text(l.$2, style: t(17, color: C.white, w: FontWeight.w900)),
                  ]),
                ),
              Padding(
                padding: const EdgeInsets.only(top: 10, bottom: 2),
                child: Row(children: [
                  Expanded(child: Text(total.$1, style: t(16, color: C.lemon, w: FontWeight.w800))),
                  Text(total.$2, style: t(26, color: C.lemon, w: FontWeight.w900)),
                ]),
              ),
            ]),
          ),
        ]),
      );
}

/// Warm payment card: flower string, a big round mark (tick, spinner or info), title, dashed stub and a line.
class PaymentCard extends StatelessWidget {
  const PaymentCard({super.key, required this.mark, required this.title, this.stub, this.line});
  final Widget mark;
  final String title;
  final String? stub;
  final String? line;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(30),
          border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFFFE9C8), Color(0xFFFFF6EA), Color(0xFFFFF0F6)]),
        ),
        child: Stack(children: [
          const Positioned(left: -20, bottom: -20, child: Marigold(size: 60)),
          const Positioned(right: -14, top: 90, child: Hibiscus(size: 48)),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
            child: Column(children: [
              _garland(11),
              const SizedBox(height: 26),
              mark,
              const SizedBox(height: 18),
              Text(title, textAlign: TextAlign.center, style: t(title.length > 22 ? 22 : 34, color: C.maroon, w: FontWeight.w900, h: 1.2)),
              if (stub != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                  decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFF3DFB3), width: 2)),
                  child: Text(stub!, textAlign: TextAlign.center, style: t(18, w: FontWeight.w900)),
                ),
              ],
              if (line != null) ...[
                const SizedBox(height: 10),
                Text(line!, textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
              ],
            ]),
          ),
        ]),
      );
}

/// Gold disc with a tick, an info mark or a spinner inside.
class PaymentMark extends StatelessWidget {
  const PaymentMark({super.key, this.icon, this.spinning = false});
  final IconData? icon;
  final bool spinning;
  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const RadialGradient(center: Alignment(-.3, -.4), colors: [Color(0xFFFDE68A), Color(0xFFF59E0B)], stops: [0, .7]),
          border: Border.all(color: C.white, width: 5),
          boxShadow: const [BoxShadow(color: Color(0xCCB45309), offset: Offset(0, 14), blurRadius: 30, spreadRadius: -14)],
        ),
        child: Center(
          child: spinning
              ? const SizedBox(width: 56, height: 56, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 6))
              : Icon(icon ?? Icons.check_rounded, color: C.maroon, size: 64),
        ),
      );
}

// ------------------------------------------------------------------------------------------------ payout
// [HF-APP-DESI-9] Withdraw and ID check, built to the owner-approved canvas previews "9 · Withdraw" and
// "9b · ID check before first payout" (2026-10-22).

/// Teal "Paisa apne UPI mein" header with the potli bag.
class PayoutHero extends StatelessWidget {
  const PayoutHero({super.key});
  @override
  Widget build(BuildContext context) => const DesiHero(
        eyebrow: 'Withdraw',
        title: 'Paisa apne UPI mein',
        sub: 'Send your money to your UPI.',
        ghost: 'Potli',
        tone: DesiTone.tea,
        minHeight: 130,
        art: SizedBox(width: 118, height: 112, child: Art('payout/potli-bag.webp', fit: BoxFit.contain)),
      );
}

/// Plum "Ready to withdraw" and gold "On hold · 7 days" tiles.
class PayoutTiles extends StatelessWidget {
  const PayoutTiles({super.key, required this.ready, required this.hold});
  final String ready;
  final String hold;
  @override
  Widget build(BuildContext context) => IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(
            child: Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF4A1747), Color(0xFF6B2468)]),
              ),
              child: Stack(children: [
                const Positioned(right: -12, top: -12, child: Marigold(size: 44, yellow: true)),
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Ready to withdraw', style: t(14, color: C.lemon, w: FontWeight.w800)),
                    FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(ready, style: t(28, color: C.white, w: FontWeight.w900))),
                  ]),
                ),
              ]),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5),
                gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('On hold · 7 days', style: t(14, color: C.amber, w: FontWeight.w800)),
                FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(hold, style: t(28, w: FontWeight.w900))),
              ]),
            ),
          ),
        ]),
      );
}

/// White amount box with a ₹ field and an orange ALL pill.
class PayoutAmountBox extends StatelessWidget {
  const PayoutAmountBox({super.key, required this.controller, required this.label, required this.onAll});
  final TextEditingController controller;
  final String label;
  final VoidCallback onAll;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: const Color(0xFFF3DFB3), width: 2)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: t(15, color: C.muted, w: FontWeight.w800)),
          TextField(
            controller: controller,
            keyboardType: TextInputType.number,
            style: t(40, w: FontWeight.w900),
            decoration: InputDecoration(
              filled: false,
              prefixIcon: Padding(padding: const EdgeInsets.only(right: 6), child: Text('₹', style: t(34, color: C.amber, w: FontWeight.w900))),
              prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
              suffixIcon: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: SizedBox(width: 72, child: MoneyPill(label: 'ALL', gold: true, height: 44, onTap: onAll)),
              ),
              suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
              contentPadding: const EdgeInsets.symmetric(vertical: 4),
              border: const UnderlineInputBorder(borderSide: BorderSide(color: C.marigold, width: 3)),
              enabledBorder: const UnderlineInputBorder(borderSide: BorderSide(color: C.marigold, width: 3)),
              focusedBorder: const UnderlineInputBorder(borderSide: BorderSide(color: C.saffron, width: 3)),
            ),
          ),
        ]),
      );
}

/// Lavender UPI card: badge, UPI ID (or "No UPI added yet"), the check line and Add / Change.
class UpiCard extends StatelessWidget {
  const UpiCard({super.key, required this.vpa, this.checkedLine, required this.onTap});
  final String? vpa;
  final String? checkedLine;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFDDD2FB), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.lavtint]),
        ),
        child: Row(children: [
          Container(
            width: 46,
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: C.lav, borderRadius: BorderRadius.circular(14)),
            child: Text('UPI', style: t(14, color: C.white, w: FontWeight.w900)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(vpa ?? 'No UPI added yet', style: t(16, w: FontWeight.w900)),
              if (checkedLine != null) Text(checkedLine!, style: t(14, color: C.muted, w: FontWeight.w700)),
            ]),
          ),
          Semantics(
            button: true,
            child: Material(
              color: C.white,
              shape: const StadiumBorder(side: BorderSide(color: Color(0xFFDDD2FB), width: 1.5)),
              child: InkWell(
                customBorder: const StadiumBorder(),
                onTap: onTap,
                child: Container(
                  constraints: const BoxConstraints(minHeight: 44),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  alignment: Alignment.center,
                  child: Text(vpa == null ? 'Add' : 'Change', style: t(14, color: C.maroon, w: FontWeight.w800)),
                ),
              ),
            ),
          ),
        ]),
      );
}

/// Gold card of short rules with jasmine bullets.
class RulesCard extends StatelessWidget {
  const RulesCard({super.key, required this.lines});
  final List<String> lines;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
        ),
        child: Stack(children: [
          const Positioned(right: -12, bottom: -12, child: Hibiscus(size: 48)),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 30, 14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final l in lines)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Padding(padding: EdgeInsets.only(top: 1), child: Jasmine(size: 18)),
                    const SizedBox(width: 10),
                    Expanded(child: Text(l, style: t(14, w: FontWeight.w700, h: 1.4))),
                  ]),
                ),
            ]),
          ),
        ]),
      );
}

enum PayoutKind { paid, requested, checking, notPaid, cancelled }

/// One past payout: amount, date and a coloured chip.
class PayoutRow extends StatelessWidget {
  const PayoutRow({super.key, required this.amount, required this.when, required this.label, required this.kind, this.onCancel});
  final String amount;
  final String when;
  final String label;
  final PayoutKind kind;

  /// Only for a request still waiting for approval: shows "Cancel this request".
  final VoidCallback? onCancel;
  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color bg, Color fg) = switch (kind) {
      PayoutKind.paid => (Icons.check_rounded, C.teatint, const Color(0xFF0B5F66)),
      PayoutKind.requested => (Icons.hourglass_top_rounded, C.goldtint, C.amber),
      PayoutKind.checking => (Icons.hourglass_top_rounded, C.goldtint, C.amber),
      PayoutKind.cancelled => (Icons.remove_circle_outline_rounded, const Color(0xFFF3EEF2), C.muted),
      PayoutKind.notPaid => (Icons.close_rounded, const Color(0xFFF3EEF2), C.ruby),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: C.line, width: 1.5)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(amount, style: t(16, w: FontWeight.w900)),
              Text(when, style: t(14, color: C.muted, w: FontWeight.w700)),
            ]),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 15, color: fg),
                const SizedBox(width: 4),
                Flexible(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: fg, w: FontWeight.w800))),
              ]),
            ),
          ),
        ]),
        if (onCancel != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: onCancel,
              style: TextButton.styleFrom(minimumSize: const Size(48, 48), padding: const EdgeInsets.symmetric(horizontal: 4)),
              child: Text('Cancel this request', style: t(15, color: C.ruby, w: FontWeight.w800)),
            ),
          ),
      ]),
    );
  }
}

/// Lavender ID-check header with a small ID card drawing.
class KycHero extends StatelessWidget {
  const KycHero({super.key, required this.title});
  final String title;
  @override
  Widget build(BuildContext context) => DesiHero(
        eyebrow: 'ID check',
        title: title,
        ghost: 'ID',
        tone: DesiTone.lav,
        minHeight: 140,
        art: Transform.rotate(
          angle: -.1,
          child: Container(
            width: 96,
            height: 68,
            decoration: BoxDecoration(
              color: C.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFDDD2FB), width: 2),
              boxShadow: const [BoxShadow(color: Color(0x804A1747), offset: Offset(0, 10), blurRadius: 20, spreadRadius: -12)],
            ),
            child: Stack(children: [
              Positioned(left: 10, top: 12, child: Container(width: 26, height: 30, decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(8)))),
              Positioned(left: 44, top: 14, child: Container(width: 38, height: 6, decoration: BoxDecoration(color: const Color(0xFFDDD2FB), borderRadius: BorderRadius.circular(3)))),
              Positioned(left: 44, top: 26, child: Container(width: 30, height: 6, decoration: BoxDecoration(color: const Color(0xFFDDD2FB), borderRadius: BorderRadius.circular(3)))),
              Positioned(left: 10, bottom: 10, child: Container(width: 72, height: 5, decoration: BoxDecoration(color: const Color(0xFFF3DFB3), borderRadius: BorderRadius.circular(3)))),
            ]),
          ),
        ),
      );
}

/// Numbered step card (pink, orange, teal in turn).
class KycStep extends StatelessWidget {
  const KycStep({super.key, required this.n, required this.text});
  final int n;
  final String text;
  @override
  Widget build(BuildContext context) {
    const inks = [C.rani, C.saffron, C.peacock];
    const edges = [Color(0xFFF8C4D9), Color(0xFFF3DFB3), Color(0xFFB9E2E5)];
    final i = (n - 1) % 3;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: edges[i], width: 1.5)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: inks[i], shape: BoxShape.circle),
          child: Text('$n', style: t(16, color: C.white, w: FontWeight.w900)),
        ),
        const SizedBox(width: 12),
        Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(text, style: t(15, w: FontWeight.w700, h: 1.4)))),
      ]),
    );
  }
}
