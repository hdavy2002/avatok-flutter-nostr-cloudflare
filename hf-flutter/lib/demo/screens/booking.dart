import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Book a slot: pick a day and time; 10 minutes × rate is held from the wallet.
class BookScreen extends StatefulWidget {
  const BookScreen({super.key, required this.id, this.day, this.slot});

  final String id;
  final String? day;
  final String? slot;

  @override
  State<BookScreen> createState() => _BookScreenState();
}

class _BookScreenState extends State<BookScreen> {
  static const _days = ['Mon 20', 'Tue 21', 'Wed 22', 'Thu 23', 'Fri 24', 'Sat 25'];
  static const _slots = ['10:00 am', '11:30 am', '1:00 pm', '4:00 pm', '6:30 pm', '9:00 pm'];
  late String _day = widget.day ?? _days.first;
  late String? _slot = widget.slot;

  void _confirm(Influencer who) {
    requireAccount(context, () async {
      final hold = who.rate * 10.0;
      if (demo.balance < hold) {
        toast(context, 'Not enough in your wallet — top up first.');
        await context.push('/topup');
        return;
      }
      demo.book(who, _day, _slot!);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (d) => AlertDialog(
          backgroundColor: C.ivory,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: const BorderSide(color: C.deep, width: 3)),
          title: Text('Booked!', style: t(28, color: C.maroon)),
          content: Text(
            '$_day at $_slot with ${who.name}.\nWe will WhatsApp you a reminder and ring your phone at that minute.',
            style: t(16, w: FontWeight.w700, h: 1.45),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(d).pop(), child: Text('OK', style: t(18, color: C.maroon))),
          ],
        ),
      );
      if (mounted) context.go('/me');
      if (mounted) context.push('/bookings');
    }, reason: 'to book');
  }

  @override
  Widget build(BuildContext context) {
    final who = influencerById(widget.id);
    final hold = who.rate * 10.0;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Book a time'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                children: [
                  Row(
                    children: [
                      Avatar(who, size: 64),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(who.name, style: t(22, color: C.maroon)),
                            Text('₹${who.rate}/min · ${who.niche}', style: t(15, color: C.tan)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Text('Day', style: t(18, color: C.maroon)),
                  const SizedBox(height: 10),
                  Wrap(spacing: 8, runSpacing: 8, children: [for (final d in _days) _chip(d, d == _day, () => setState(() => _day = d))]),
                  const SizedBox(height: 22),
                  Text('Time', style: t(18, color: C.maroon)),
                  const SizedBox(height: 10),
                  Wrap(spacing: 8, runSpacing: 8, children: [for (final s in _slots) _chip(s, s == _slot, () => setState(() => _slot = s))]),
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(16)),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('Held from your wallet', style: t(16, color: C.cream, w: FontWeight.w700))),
                            Text(inr(hold, paise: false), style: t(22, color: C.gold)),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text('10 minutes at ₹${who.rate}/min. You pay only for the minutes you talk; the rest comes back.', style: t(14, color: C.ivory, w: FontWeight.w600, h: 1.4)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
              child: TicketButton(
                label: _slot == null ? 'PICK A TIME' : 'BOOK $_day',
                enabled: _slot != null,
                stubTop: 'RATE',
                stubBottom: _slot ?? '--',
                onTap: () => _confirm(who),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _chip(String label, bool on, VoidCallback tap) {
    return GestureDetector(
      onTap: tap,
      child: Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: on ? C.maroon : C.paper,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: C.maroon, width: 2),
        ),
        child: Center(widthFactor: 1, child: Text(label, style: t(15, color: on ? C.gold : C.maroon))),
      ),
    );
  }
}
