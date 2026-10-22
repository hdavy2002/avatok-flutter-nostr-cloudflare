import 'package:flutter/material.dart';

import 'desi.dart';
import 'money_kit.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-11] Influencer home, bar and Online/Offline pieces, built to the owner-approved canvas previews
/// "11 · Influencer home + new influencer bar", "11b · Online status" and "11c · Offline status" (2026-10-22).

/// Pink "Namaste, <name>" header with Rangili on her swing.
class InfHero extends StatelessWidget {
  const InfHero({super.key, required this.name});
  final String name;
  @override
  Widget build(BuildContext context) => DesiHero(
        eyebrow: 'Namaste',
        title: name,
        sub: 'Your stage for calls, bookings and reels.',
        ghost: 'Manch',
        tone: DesiTone.rani,
        minHeight: 170,
        art: const SizedBox(width: 132, height: 160, child: Art('influencer/online-mode.webp', fit: BoxFit.contain)),
      );
}

/// "You are ONLINE / OFFLINE" card (Online uses the Online tokens; offline is plain cream).
class PresenceCard extends StatelessWidget {
  const PresenceCard({super.key, required this.online, required this.onTap});
  final bool online;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final ink = online ? C.onlineInk : C.deep;
    return Semantics(
      button: true,
      child: Material(
        color: C.clear,
        child: InkWell(
          borderRadius: BorderRadius.circular(22),
          onTap: onTap,
          child: Ink(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: online ? C.onlineBg : C.white,
              borderRadius: BorderRadius.circular(22),
              border: Border.all(color: online ? C.onlineLine : C.line, width: 2),
            ),
            child: Row(children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(color: online ? C.white : C.lavtint, shape: BoxShape.circle),
                child: Icon(online ? Icons.wifi_tethering_rounded : Icons.nightlight_round, color: online ? C.onlineInk : C.maroon, size: 26),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(online ? 'You are ONLINE' : 'You are OFFLINE', style: t(20, color: ink, w: FontWeight.w900)),
                  Text(online ? 'Fans see your reels and can call you now.' : 'No calls now. Fans can still book you.', style: t(14, color: online ? C.onlineInk : C.muted, w: FontWeight.w700)),
                ]),
              ),
              Icon(Icons.chevron_right_rounded, color: ink),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Plum / lavender / gold today tiles.
class InfTodayTiles extends StatelessWidget {
  const InfTodayTiles({super.key, required this.calls, required this.minutes, required this.earned});
  final String calls;
  final String minutes;
  final String earned;

  Widget _tile(String v, String l, {Gradient? g, Color? edge, required Color ink, bool dark = false}) => Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        decoration: BoxDecoration(gradient: g, borderRadius: BorderRadius.circular(18), border: edge == null ? null : Border.all(color: edge, width: 1.5)),
        child: Column(children: [
          FittedBox(fit: BoxFit.scaleDown, child: Text(v, style: t(22, color: dark ? C.white : C.deep, w: FontWeight.w900))),
          FittedBox(fit: BoxFit.scaleDown, child: Text(l, style: t(14, color: ink, w: FontWeight.w800))),
        ]),
      );

  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(flex: 10, child: _tile(calls, 'Calls today', g: const LinearGradient(colors: [Color(0xFF4A1747), Color(0xFF6B2468)]), ink: C.lemon, dark: true)),
        const SizedBox(width: 8),
        Expanded(flex: 10, child: _tile(minutes, 'Minutes', g: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.lavtint]), edge: const Color(0xFFDDD2FB), ink: C.lav)),
        const SizedBox(width: 8),
        Expanded(flex: 12, child: _tile(earned, 'Earned today', g: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]), edge: const Color(0xFFF3DFB3), ink: C.amber)),
      ]);
}

/// Dark plum "Ready to withdraw" card with an orange Payout pill.
class EarningsGullak extends StatelessWidget {
  const EarningsGullak({super.key, required this.ready, required this.hold, required this.onTap});
  final String ready;
  final String hold;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(24),
            gradient: const RadialGradient(center: Alignment(.6, -1), radius: 1.6, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .5, 1]),
          ),
          child: Stack(children: [
            const Positioned(right: -16, top: -16, child: Marigold(size: 60, yellow: true)),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('READY TO WITHDRAW', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .06)),
                    FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(ready, style: t(32, color: C.white, w: FontWeight.w900))),
                    Text(hold, style: t(14, color: const Color(0xFFF7E6F0), w: FontWeight.w700)),
                  ]),
                ),
                const SizedBox(width: 8),
                SizedBox(width: 104, child: MoneyPill(label: 'PAYOUT', gold: true, height: 48, onTap: onTap)),
              ]),
            ),
          ]),
        ),
      );
}

/// Plum section title with a pink action on the right.
class InfSectionHead extends StatelessWidget {
  const InfSectionHead({super.key, required this.title, this.action, this.onAction});
  final String title;
  final String? action;
  final VoidCallback? onAction;
  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(child: Text(title, style: t(20, color: C.maroon, w: FontWeight.w900))),
        if (action != null)
          TextButton(
            onPressed: onAction,
            style: TextButton.styleFrom(minimumSize: const Size(48, 44)),
            child: Text(action!, style: t(15, color: C.rani, w: FontWeight.w800)),
          ),
      ]);
}

const _edges = [Color(0xFFF8C4D9), Color(0xFFB9E2E5), Color(0xFFDDD2FB), Color(0xFFF3DFB3)];

/// One fan booking on the influencer side: gold time stub, fan handle, line(s) and a round icon.
class InfBookingCard extends StatelessWidget {
  const InfBookingCard({super.key, required this.index, required this.time, required this.fan, required this.line, this.extra, this.icon = Icons.call_rounded, this.iconInk = C.peacock, this.onTap});
  final int index;
  final String time;
  final String fan;
  final String line;
  final String? extra;
  final IconData icon;
  final Color iconInk;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final parts = time.split(' ');
    final card = Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: _edges[index % _edges.length], width: 2)),
      child: Row(children: [
        Container(
          width: 64,
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(14)),
          child: Column(children: [
            FittedBox(fit: BoxFit.scaleDown, child: Text(parts.first, style: t(17, color: C.maroon, w: FontWeight.w900))),
            if (parts.length > 1) Text(parts.last, style: t(14, color: C.amber, w: FontWeight.w800)),
          ]),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(fan, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w900)),
            Text(line, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
            if (extra != null && extra!.isNotEmpty) Text(extra!, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: iconInk.withValues(alpha: .12), shape: BoxShape.circle),
          child: Icon(icon, color: iconInk, size: 20),
        ),
      ]),
    );
    return onTap == null ? card : GestureDetector(onTap: onTap, child: card);
  }
}

/// A reel thumbnail with a coloured border and a gold ✓ (in the feed) or red ✕ badge.
class InfReelThumb extends StatelessWidget {
  const InfReelThumb({super.key, required this.index, required this.child, required this.ok});
  final int index;
  final Widget child;
  final bool ok;
  @override
  Widget build(BuildContext context) => Container(
        width: 82,
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: _edges[index % _edges.length], width: 2)),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: Stack(fit: StackFit.expand, children: [
            child,
            Positioned(
              right: 5,
              top: 5,
              child: Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(color: ok ? C.lemon : C.ruby, shape: BoxShape.circle),
                child: Icon(ok ? Icons.check_rounded : Icons.close_rounded, size: 15, color: C.white),
              ),
            ),
          ]),
        ),
      );
}

/// Flower string along the top of the status screen.
class FlowerString extends StatelessWidget {
  const FlowerString({super.key, this.n = 13});
  final int n;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          for (var i = 0; i < n; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 3), child: Jasmine(size: 16)),
        ]),
      );
}

// ------------------------------------------------------------------------------------------------ [HF-APP-DESI-12]
// Influencer Bookings and Availability, built to the owner-approved canvas previews "12 · Booked with me" and
// "12b · Availability" (2026-10-22).

/// Gold "Aapke fans ka samay" header with the calendar art.
class BookedWithMeHero extends StatelessWidget {
  const BookedWithMeHero({super.key});
  @override
  Widget build(BuildContext context) => const DesiHero(
        eyebrow: 'Booked with me',
        title: 'Aapke fans ka samay',
        sub: 'Accept, decline and see every call booked with you.',
        ghost: 'Samay',
        tone: DesiTone.gold,
        minHeight: 130,
        art: SizedBox(width: 124, height: 96, child: Art('influencer/calendar-header.webp', fit: BoxFit.contain)),
      );
}

/// Soft gold card around a month calendar.
class CalendarCard extends StatelessWidget {
  const CalendarCard({super.key, required this.child, this.white = false});
  final Widget child;
  final bool white;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: const Color(0xFFF3DFB3), width: white ? 2 : 1.5),
          color: white ? C.white : null,
          gradient: white ? null : const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
        ),
        child: child,
      );
}

/// Pink-track switch used on the influencer screens.
class DesiSwitch extends StatelessWidget {
  const DesiSwitch({super.key, required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool>? onChanged;
  @override
  Widget build(BuildContext context) => Switch(
        value: value,
        onChanged: onChanged,
        activeThumbColor: C.white,
        activeTrackColor: C.rani,
        inactiveThumbColor: C.white,
        inactiveTrackColor: const Color(0xFFE8DDE6),
        trackOutlineColor: const WidgetStatePropertyAll(C.clear),
      );
}

/// Teal card holding switch rows (title, line, switch) split by dashed lines.
class InfSettingsCard extends StatelessWidget {
  const InfSettingsCard({super.key, required this.rows, this.footer});
  final List<Widget> rows;
  final Widget? footer;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.teatint]),
        ),
        child: Stack(children: [
          const Positioned(right: -12, top: -12, child: Marigold(size: 46)),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            child: Column(children: [
              for (var i = 0; i < rows.length; i++) ...[
                if (i > 0) const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: SizedBox(height: 1, child: DashedLine(vertical: false, color: Color(0xFFB9E2E5), width: 1))),
                rows[i],
              ],
              if (footer != null) footer!,
            ]),
          ),
        ]),
      );
}

/// One switch row: bold title, muted line, switch on the right.
class InfSwitchRow extends StatelessWidget {
  const InfSwitchRow({super.key, required this.title, required this.line, required this.toggle, this.titleKey});
  final String title;
  final String line;
  final Widget toggle;
  final Key? titleKey;
  @override
  Widget build(BuildContext context) => MergeSemantics(
        child: Row(children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, key: titleKey, style: t(17, w: FontWeight.w900)),
                const SizedBox(height: 2),
                Text(line, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.35)),
              ]),
            ),
          ),
          toggle,
        ]),
      );
}

/// Gold-bordered "waiting for you" card: fan, time, topic, note, hold, countdown and the two buttons.
class WaitingCard extends StatelessWidget {
  const WaitingCard({
    super.key,
    required this.fan,
    required this.when,
    this.topic,
    this.note,
    required this.held,
    this.countdown,
    this.countdownKey,
    required this.accept,
    required this.decline,
    this.warning,
    this.highlighted = false,
  });
  final String fan;
  final String when;
  final String? topic;
  final String? note;
  final String held;
  final String? countdown;
  final Key? countdownKey;
  final Widget accept;
  final Widget decline;
  final String? warning;
  final bool highlighted;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(top: 10),
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: highlighted ? C.maroon : C.marigold, width: highlighted ? 3 : 2),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]),
        ),
        child: Stack(children: [
          const Positioned(right: -10, top: -10, child: Hibiscus(size: 42)),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(fan, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(18, w: FontWeight.w900))),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
                  decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(999)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.hourglass_top_rounded, size: 15, color: C.amber),
                    const SizedBox(width: 4),
                    Text('Waiting', style: t(14, color: C.amber, w: FontWeight.w800)),
                  ]),
                ),
                const SizedBox(width: 30),
              ]),
              const SizedBox(height: 4),
              Text(when, style: t(16, color: C.maroon, w: FontWeight.w800)),
              if (topic != null) Text('Topic: $topic', style: t(15, color: C.amber, w: FontWeight.w700)),
              if (note != null && note!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text('Note: $note', style: t(15, color: C.muted, w: FontWeight.w700))),
              Text(held, style: t(14, color: C.muted, w: FontWeight.w700)),
              if (countdown != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(color: C.maroon, borderRadius: BorderRadius.circular(999)),
                    child: Text(countdown!, key: countdownKey, style: t(15, color: C.lemon, w: FontWeight.w900)),
                  ),
                ),
              const SizedBox(height: 12),
              Row(children: [Expanded(flex: 13, child: accept), const SizedBox(width: 8), Expanded(flex: 10, child: decline)]),
              if (warning != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(warning!, style: t(14, color: C.ruby, w: FontWeight.w700))),
            ]),
          ),
        ]),
      );
}

/// Round gold − / ＋ button for the rate card.
class RateKnob extends StatelessWidget {
  const RateKnob({super.key, required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null,
        label: label,
        child: Opacity(
          opacity: onTap == null ? .45 : 1,
          child: Material(
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: Ink(
              width: 52,
              height: 52,
              decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFFDE68A), C.marigold])),
              child: InkWell(onTap: onTap, child: Icon(icon, color: C.maroon, size: 26)),
            ),
          ),
        ),
      );
}

/// Dark plum "Your rate" card: knobs either side, a line under it and an optional child (Save rate).
class RateCard extends StatelessWidget {
  const RateCard({super.key, required this.rate, required this.line, required this.onLower, required this.onRaise, this.child});
  final String rate;
  final String line;
  final VoidCallback? onLower;
  final VoidCallback? onRaise;
  final Widget? child;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          gradient: const RadialGradient(center: Alignment(.6, -1), radius: 1.6, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .5, 1]),
        ),
        child: Stack(children: [
          const Positioned(right: -14, top: -14, child: Marigold(size: 54, yellow: true)),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(children: [
              Text('YOUR RATE', style: t(14, color: C.lemon, w: FontWeight.w800, ls: .08)),
              const SizedBox(height: 8),
              Row(children: [
                RateKnob(icon: Icons.remove_rounded, label: 'Lower rate', onTap: onLower),
                Expanded(child: Center(child: FittedBox(fit: BoxFit.scaleDown, child: Text(rate, style: t(34, color: C.white, w: FontWeight.w900))))),
                RateKnob(icon: Icons.add_rounded, label: 'Raise rate', onTap: onRaise),
              ]),
              const SizedBox(height: 6),
              Text(line, textAlign: TextAlign.center, style: t(14, color: const Color(0xFFF7E6F0), w: FontWeight.w700)),
              if (child != null) ...[const SizedBox(height: 10), child!],
            ]),
          ),
        ]),
      );
}

/// Teal time chip for Availability (keeps [FilterChip] so keys and selection behave as before).
FilterChip availabilityChip({Key? key, required String label, required bool selected, bool partial = false, bool locked = false, ValueChanged<bool>? onSelected}) => FilterChip(
      key: key,
      avatar: locked ? Icon(Icons.lock_rounded, size: 16, color: selected ? C.white : C.peacock) : null,
      label: Text(label, style: t(14, color: selected ? C.white : const Color(0xFF0B5F66), w: FontWeight.w800)),
      selected: selected,
      showCheckmark: false,
      selectedColor: C.peacock,
      backgroundColor: partial ? C.teatint : C.white,
      side: BorderSide(color: selected ? C.peacock : (partial ? C.peacock : const Color(0xFFB9E2E5)), width: 1.5),
      shape: const StadiumBorder(),
      onSelected: onSelected,
    );
