import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../ui/motion.dart';
import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

DateTime? _parseKey(String? k) {
  if (k == null || k.isEmpty) return null;
  final p = k.split('-').map(int.tryParse).toList();
  if (p.length != 3 || p.any((x) => x == null)) return null;
  return DateTime(p[0]!, p[1]!, p[2]!);
}

// ---------------------------------------------------------------------------------------------- Step 1–2: date + time

/// Fan booking, step 1 and 2: pick a date the influencer is open (yellow), then a time.
class BookScreen extends StatefulWidget {
  const BookScreen({super.key, required this.id, this.day, this.slot});

  final String id;
  final String? day; // dayKey
  final String? slot;

  @override
  State<BookScreen> createState() => _BookScreenState();
}

class _BookScreenState extends State<BookScreen> {
  late DateTime _month = _parseKey(widget.day) ?? dayOnly(DateTime.now());
  late DateTime? _day = _parseKey(widget.day);
  late String? _slot = widget.slot;

  @override
  Widget build(BuildContext context) {
    final who = influencerById(widget.id);
    final first = DateTime(_month.year, _month.month, 1);
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final today = dayOnly(DateTime.now());
    final openDays = <String>{
      for (var d = 1; d <= days; d++)
        if (!DateTime(first.year, first.month, d).isBefore(today) && slotsFor(who, DateTime(first.year, first.month, d)).isNotEmpty)
          dayKey(DateTime(first.year, first.month, d)),
    };
    final slots = _day == null ? const <String>[] : slotsFor(who, _day!);
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Book a time'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                children: [
                  Row(
                    children: [
                      Avatar(who, size: 60),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(who.name, style: t(21, color: C.maroon)),
                            Text('₹${who.rate}/min · ${who.niche}', style: t(14, color: C.tan)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _step('1', 'Pick a date', 'Yellow dates are open.'),
                  const SizedBox(height: 8),
                  MonthGrid(
                    month: _month,
                    selected: _day,
                    fill: openDays,
                    onPick: (d) => setState(() {
                      if (slotsFor(who, d).isEmpty) {
                        toast(context, '${who.name.split(' ').first} is not taking bookings that day.');
                        return;
                      }
                      _day = d;
                      _slot = null;
                    }),
                    onMonth: (m) => setState(() => _month = m),
                  ),
                  const SizedBox(height: 18),
                  _step('2', 'Pick a time', _day == null ? 'Choose a date first.' : dayLabel(_day!)),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final s in slots)
                        GestureDetector(
                          onTap: () => setState(() => _slot = s),
                          child: HfAnimatedContainer(
                            duration: HfMotion.duration(context, HfMotion.quick),
                            curve: HfMotion.curve,
                            height: 48,
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                            decoration: BoxDecoration(
                              color: s == _slot ? C.maroon : C.paper,
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(color: C.maroon, width: 2),
                            ),
                            child: Center(widthFactor: 1, child: Text(s, style: t(15, color: s == _slot ? C.gold : C.maroon))),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              child: TicketButton(
                label: _slot == null ? 'PICK A TIME' : 'NEXT',
                enabled: _day != null && _slot != null,
                stubIcon: Icons.arrow_forward_rounded,
                onTap: () => context.push('/book/${who.id}/confirm?day=${dayKey(_day!)}&slot=${Uri.encodeComponent(_slot!)}'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _step(String n, String title, String sub) => Row(
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: C.lemon),
            child: Text(n, style: t(15)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: t(18, color: C.maroon)),
                Text(sub, style: t(14, color: C.muted, w: FontWeight.w700)),
              ],
            ),
          ),
        ],
      );
}

// ---------------------------------------------------------------------------------------------- Step 3: confirm

class BookConfirmScreen extends StatelessWidget {
  const BookConfirmScreen({super.key, required this.id, required this.day, required this.slot});

  final String id;
  final String day;
  final String slot;

  @override
  Widget build(BuildContext context) {
    final who = influencerById(id);
    final d = _parseKey(day) ?? dayOnly(DateTime.now());
    final hold = who.rate * 10.0;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Confirm booking'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                children: [
                  Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(20), border: Border.all(color: C.deep, width: 3)),
                    child: Column(
                      children: [
                        Avatar(who, size: 84),
                        const SizedBox(height: 10),
                        Text(who.name, style: t(24, color: C.maroon)),
                        const SizedBox(height: 14),
                        Row(
                          children: [
                            Expanded(child: _box(Icons.event_rounded, dayLabel(d))),
                            const SizedBox(width: 10),
                            Expanded(child: _box(Icons.schedule_rounded, slot)),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(16)),
                    child: Column(
                      children: [
                        _line('Rate', '₹${who.rate}/min'),
                        const SizedBox(height: 8),
                        _line('Held now (10 min)', inr(hold, paise: false)),
                        const SizedBox(height: 8),
                        _line('Your wallet', inr(demo.balance)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'At ${slot.toLowerCase()} we ring ${who.name.split(' ').first} first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You get a WhatsApp reminder an hour before.',
                    style: t(15, color: C.muted, w: FontWeight.w700, h: 1.45),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              child: TicketButton(
                label: 'CONFIRM BOOKING',
                maroon: true,
                labelSize: 18,
                stubIcon: Icons.check_rounded,
                onTap: () => requireAccount(context, () {
                  if (demo.balance < hold) {
                    toast(context, 'Not enough in your wallet — top up first.');
                    context.push('/topup');
                    return;
                  }
                  demo.book(who, dayLabel(d), slot);
                  context.pushReplacement('/booked/${who.id}?day=$day&slot=${Uri.encodeComponent(slot)}');
                }, reason: 'to book'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _box(IconData icon, String text) => Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(14)),
        child: Column(
          children: [
            Icon(icon, color: C.maroon),
            const SizedBox(height: 4),
            Text(text, textAlign: TextAlign.center, style: t(15)),
          ],
        ),
      );

  Widget _line(String a, String b) => Row(
        children: [
          Expanded(child: Text(a, style: t(15, color: C.cream, w: FontWeight.w700))),
          Text(b, style: t(17, color: C.gold)),
        ],
      );
}

// ---------------------------------------------------------------------------------------------- Step 4: booked

class BookedScreen extends StatelessWidget {
  const BookedScreen({super.key, required this.id, required this.day, required this.slot});

  final String id;
  final String day;
  final String slot;

  @override
  Widget build(BuildContext context) {
    final who = influencerById(id);
    final d = _parseKey(day) ?? dayOnly(DateTime.now());
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              const ArtMoment('booking/booked-tara.webp', label: 'TARA\nso happy', size: 240, ring: C.butter),
              const SizedBox(height: 18),
              const Headline(solid: 'BOOKED!', size: 46, align: TextAlign.center),
              const SizedBox(height: 8),
              Text('${who.name}\n${dayLabel(d)} · $slot', textAlign: TextAlign.center, style: t(20, color: C.deep, h: 1.35)),
              const SizedBox(height: 10),
              Text('We will WhatsApp you a reminder and ring your phone at that minute.', textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
              const Spacer(),
              SizedBox(width: double.infinity, child: ChunkyButton(label: 'MY BOOKINGS', dark: true, onTap: () => context.pushReplacement('/bookings'))),
              const SizedBox(height: 10),
              TextButton(onPressed: () => context.go('/reels'), child: Text('Back to reels', style: t(16, color: C.maroon))),
            ],
          ),
        ),
      ),
    );
  }
}
