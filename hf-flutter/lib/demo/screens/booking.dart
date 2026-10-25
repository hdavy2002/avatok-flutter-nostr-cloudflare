import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/call_flags.dart'; // [HF-CALL-MODES-E2]
import '../booking_kit.dart';
import '../data.dart';
import '../desi.dart';
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
    // [HF-APP-DESI-5] approved "Book a time" layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Book a time'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  BookPerson(who: who, name: who.name, rate: '₹${who.rate}/min', chip: '${defaultBookingMinutes()} minute call'),
                  const SizedBox(height: 14),
                  BookStep(
                    n: '1',
                    title: 'Pick a date',
                    sub: 'Yellow dates are open.',
                    tone: BookTone.gold,
                    child: BookMonth(
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
                  ),
                  const SizedBox(height: 14),
                  BookStep(
                    n: '2',
                    title: 'Pick a time',
                    sub: _day == null ? 'Choose a date first.' : '${dayLabel(_day!)} · India time',
                    tone: BookTone.tea,
                    child: Wrap(spacing: 8, runSpacing: 8, children: [
                      for (final s in slots) BookSlotPill(label: s, on: s == _slot, onTap: () => setState(() => _slot = s)),
                    ]),
                  ),
                  const SizedBox(height: 14),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(
              label: _slot == null ? 'PICK A TIME' : 'NEXT',
              enabled: _day != null && _slot != null,
              onTap: () => context.push('/book/${who.id}/confirm?day=${dayKey(_day!)}&slot=${Uri.encodeComponent(_slot!)}'),
            ),
          ],
        ),
      ),
    );
  }
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
    final mins = defaultBookingMinutes(); // [HF-CALL-MODES-E2] 10 minutes, or 15 while booking lengths are on
    final hold = who.rate * mins.toDouble();
    final first = who.name.split(' ').first;
    // [HF-APP-DESI-5] approved "Confirm booking" layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Confirm booking'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  BookTicket(who: who, name: who.name, sub: '$mins minute call', date: dayLabel(d), time: slot),
                  const SizedBox(height: 14),
                  HisaabCard(lines: [('Rate', '₹${who.rate}/min'), ('Held now ($mins min)', inr(hold, paise: false)), ('Your wallet', inr(demo.balance))], strong: {'Held now ($mins min)'}),
                  const SizedBox(height: 14),
                  Text(
                    'At ${slot.toLowerCase()} we ring $first first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You get a WhatsApp reminder an hour before.',
                    style: t(15, color: C.muted, w: FontWeight.w700, h: 1.45),
                  ),
                  const SizedBox(height: 14),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(
              label: 'CONFIRM BOOKING',
              plum: true,
              icon: Icons.check_rounded,
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
          ],
        ),
      ),
    );
  }
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
    // [HF-APP-DESI-5] approved "Booked!" layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            BookedCard(title: 'Booked!', line: "Your call is in ${who.name.split(' ').first}'s diary.", name: who.name, when: '${dayLabel(d)} · $slot'),
            const SizedBox(height: 14),
            const BookedActions(notice: 'We will WhatsApp you a reminder and ring your phone at that minute.'),
          ],
        ),
      ),
    );
  }
}
