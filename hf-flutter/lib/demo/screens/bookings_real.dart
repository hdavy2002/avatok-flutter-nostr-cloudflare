import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/demo_mode.dart';
import '../../data/models/booking.dart';
import '../../data/repos/bookings_repo.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../data.dart';
import '../theme.dart';
import '../widgets.dart';
import 'call_real.dart' show callPerson, paiseText;

/// Real bookings (HF-WIRE-8). While [DemoMode.on] the dummy flow in booking.dart / influencer.dart / me.dart stays.
abstract final class BookingsBridge {
  /// Tests set this to exercise the real path without a dart-define.
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

/// 10:00 on [day] in India (UTC+05:30, no daylight saving) as an instant.
DateTime istToInstant(String day, String hhmm) {
  final d = parseDay(day)!;
  final p = hhmm.split(':').map(int.parse).toList();
  return DateTime.utc(d.year, d.month, d.day, p[0], p[1]).subtract(const Duration(hours: 5, minutes: 30));
}

/// The server's sentence when it sent one, otherwise [fallback].
String _why(Object e, [String fallback = 'That did not work. Please try again.']) {
  if (e is ApiException) {
    if (e.isOffline) return ApiException.offlineText;
    final m = e.message;
    if (m != null && m.isNotEmpty) return m;
  }
  return fallback;
}

Future<T?> _guard<T>(Future<T> Function() f, void Function(Object) onError) async {
  try {
    return await f();
  } catch (e) {
    onError(e);
    return null;
  }
}

// ======================================================================================== fan: pick a date + time

/// Fan booking, steps 1 and 2, real: dates and free times come from the influencer's own availability (IST).
class RealBookScreen extends StatefulWidget {
  const RealBookScreen({super.key, required this.id, this.day, this.slot, this.repo, this.reelsRepo});

  final String id; // the influencer's slug
  final String? day;
  final String? slot;
  final BookingsRepo? repo;
  final ReelsRepo? reelsRepo;

  @override
  State<RealBookScreen> createState() => _RealBookScreenState();
}

class _RealBookScreenState extends State<RealBookScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;

  AsyncState<HostSlots> _state = const AsyncLoading();
  String _name = '';
  String? _avatar;
  late DateTime _month = parseDay(widget.day) ?? dayOnly(DateTime.now());
  late DateTime? _day = parseDay(widget.day);
  late String? _slot = widget.slot;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadName());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final s = await _repo.slots(widget.id);
      if (mounted) setState(() => _state = AsyncData(s));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _loadName() async {
    try {
      final p = await (widget.reelsRepo ?? Services.instance.reelsRepo).profile(widget.id);
      if (mounted) {
        setState(() {
          _name = p.host.name;
          _avatar = p.host.avatar;
        });
      }
    } catch (_) {
      // the page still works without her name
    }
  }

  Influencer get _who => callPerson(widget.id, _name.isEmpty ? 'Influencer' : _name).copyWithAvatar(_avatar);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Book a time'),
            Expanded(
              child: AsyncView<HostSlots>(
                state: _state,
                onRetry: () => unawaited(_load()),
                isEmpty: (s) => false,
                builder: (context, slots) => _body(context, slots),
              ),
            ),
            if (_state is AsyncData<HostSlots>)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                child: TicketButton(
                  label: _slot == null ? 'PICK A TIME' : 'NEXT',
                  enabled: _day != null && _slot != null,
                  stubIcon: Icons.arrow_forward_rounded,
                  onTap: () => context.push('/book/${widget.id}/confirm?day=${isoDay(_day!)}&slot=${Uri.encodeComponent(_slot!)}'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, HostSlots s) {
    final first = _name.isEmpty ? 'She' : _name.split(' ').first;
    final fill = {for (final d in s.openDays) dayKey(parseDay(d)!)};
    final times = _day == null ? const <String>[] : s.slotsOn(isoDay(_day!));
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
      children: [
        Row(
          children: [
            Avatar(_who, size: 60),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_name.isEmpty ? 'Book a call' : _name, style: t(21, color: C.maroon)),
                  Text('₹${s.ratePerMin}/min · ${s.minutes} minute call', style: t(14, color: C.tan)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        _step('1', 'Pick a date', s.openDays.isEmpty ? '$first has not opened any times yet.' : 'Yellow dates are open.'),
        const SizedBox(height: 8),
        MonthGrid(
          month: _month,
          selected: _day,
          fill: fill,
          onPick: (d) => setState(() {
            if (!fill.contains(dayKey(d))) {
              toast(context, '$first is not taking bookings that day.');
              return;
            }
            _day = d;
            _slot = null;
          }),
          onMonth: (m) => setState(() => _month = m),
        ),
        const SizedBox(height: 18),
        _step('2', 'Pick a time', _day == null ? 'Choose a date first.' : '${dayLabel(_day!)} · India time'),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final hhmm in times)
              GestureDetector(
                key: ValueKey('slot-$hhmm'),
                onTap: () => setState(() => _slot = hhmm),
                child: Container(
                  height: 46,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  decoration: BoxDecoration(
                    color: hhmm == _slot ? C.maroon : C.paper,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: C.maroon, width: 2),
                  ),
                  child: Center(widthFactor: 1, child: Text(slotLabel(hhmm), style: t(15, color: hhmm == _slot ? C.gold : C.maroon))),
                ),
              ),
          ],
        ),
      ],
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

extension on Influencer {
  Influencer copyWithAvatar(String? url) => url == null
      ? this
      : Influencer(
          id: id, name: name, handle: handle, city: city, niche: niche, bio: bio, rate: rate, likes: likes,
          followers: followers, videos: videos, online: online, tones: tones, portrait: portrait, avatarUrl: url,
        );
}

// ======================================================================================== fan: confirm

class RealBookConfirmScreen extends StatefulWidget {
  const RealBookConfirmScreen({super.key, required this.id, required this.day, required this.slot, this.repo, this.walletRepo, this.reelsRepo});

  final String id;
  final String day; // YYYY-MM-DD
  final String slot; // HH:MM
  final BookingsRepo? repo;
  final WalletRepo? walletRepo;
  final ReelsRepo? reelsRepo;

  @override
  State<RealBookConfirmScreen> createState() => _RealBookConfirmScreenState();
}

class _RealBookConfirmScreenState extends State<RealBookConfirmScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;

  AsyncState<HostSlots> _state = const AsyncLoading();
  int? _walletPaise;
  String _name = '';
  String? _avatar;
  bool _busy = false;
  final _note = TextEditingController();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final s = await _repo.slots(widget.id, from: widget.day, to: widget.day);
      if (mounted) setState(() => _state = AsyncData(s));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
      return;
    }
    try {
      final p = await (widget.reelsRepo ?? Services.instance.reelsRepo).profile(widget.id);
      if (mounted) {
        setState(() {
          _name = p.host.name;
          _avatar = p.host.avatar;
        });
      }
    } catch (_) {}
    if (Services.instance.isSignedIn || widget.walletRepo != null) {
      try {
        final w = await (widget.walletRepo ?? Services.instance.walletRepo).fetch(limit: 1);
        if (mounted) setState(() => _walletPaise = w.balancePaise + w.testCreditPaise);
      } catch (_) {}
    }
  }

  Future<void> _confirm(HostSlots s) async {
    if (_busy) return;
    final wallet = _walletPaise;
    if (wallet != null && wallet < s.holdPaise) {
      toast(context, 'Not enough in your wallet. Top up first.');
      context.push('/topup');
      return;
    }
    setState(() => _busy = true);
    try {
      await _repo.book(widget.id, istToInstant(widget.day, widget.slot), note: _note.text);
      if (!mounted) return;
      context.pushReplacement('/booked/${widget.id}?day=${widget.day}&slot=${Uri.encodeComponent(widget.slot)}&name=${Uri.encodeComponent(_name)}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      switch (bookingProblemOf(e)) {
        case BookingProblem.lowBalance:
          toast(context, _why(e, 'Not enough in your wallet. Top up first.'));
          context.push('/topup');
        case BookingProblem.slotTaken:
          toast(context, _why(e));
          context.canPop() ? context.pop() : context.go('/reels');
        default:
          toast(context, _why(e));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = parseDay(widget.day) ?? dayOnly(DateTime.now());
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Confirm booking'),
            Expanded(
              child: AsyncView<HostSlots>(
                state: _state,
                onRetry: () => unawaited(_load()),
                isEmpty: (s) => false,
                builder: (context, s) => ListView(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                  children: [
                    Container(
                      padding: const EdgeInsets.all(18),
                      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(20), border: Border.all(color: C.deep, width: 3)),
                      child: Column(
                        children: [
                          Avatar(callPerson(widget.id, _name).copyWithAvatar(_avatar), size: 84),
                          const SizedBox(height: 10),
                          Text(_name.isEmpty ? 'Your booking' : _name, style: t(24, color: C.maroon)),
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              Expanded(child: _box(Icons.event_rounded, dayLabel(d))),
                              const SizedBox(width: 10),
                              Expanded(child: _box(Icons.schedule_rounded, slotLabel(widget.slot))),
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
                          _line('Rate', '₹${s.ratePerMin}/min'),
                          const SizedBox(height: 8),
                          _line('Held now (${s.minutes} min)', paiseText(s.holdPaise)),
                          const SizedBox(height: 8),
                          _line('Your wallet', _walletPaise == null ? '—' : paiseText(_walletPaise!)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _note,
                      maxLength: 200,
                      maxLines: 2,
                      style: t(15),
                      decoration: InputDecoration(
                        labelText: 'A note for ${_name.isEmpty ? 'her' : _name.split(' ').first} (optional)',
                        helperText: 'No phone numbers or links please.',
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'At ${slotLabel(widget.slot)} India time we ring ${_name.isEmpty ? 'her' : _name.split(' ').first} first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You can cancel free until 1 hour before. You get a WhatsApp reminder an hour before.',
                      style: t(15, color: C.muted, w: FontWeight.w700, h: 1.45),
                    ),
                  ],
                ),
              ),
            ),
            if (_state is AsyncData<HostSlots>)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                child: TicketButton(
                  label: _busy ? 'BOOKING…' : 'CONFIRM BOOKING',
                  maroon: true,
                  labelSize: 18,
                  stubIcon: Icons.check_rounded,
                  onTap: () => requireAccount(context, () => unawaited(_confirm((_state as AsyncData<HostSlots>).value)), reason: 'to book'),
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

// ======================================================================================== fan: booked

class RealBookedScreen extends StatelessWidget {
  const RealBookedScreen({super.key, required this.day, required this.slot, this.name = ''});

  final String day;
  final String slot;
  final String name;

  @override
  Widget build(BuildContext context) {
    final d = parseDay(day) ?? dayOnly(DateTime.now());
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
              Text('${name.isEmpty ? '' : '$name\n'}${dayLabel(d)} · ${slotLabel(slot)}', textAlign: TextAlign.center, style: t(20, color: C.deep, h: 1.35)),
              const SizedBox(height: 10),
              Text('We will WhatsApp you a reminder an hour before and ring your phone at that minute.', textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
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

// ======================================================================================== fan: my bookings

class RealBookingsScreen extends StatefulWidget {
  const RealBookingsScreen({super.key, this.repo});

  final BookingsRepo? repo;

  @override
  State<RealBookingsScreen> createState() => _RealBookingsScreenState();
}

class _RealBookingsScreenState extends State<RealBookingsScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<List<AppBooking>> _state = const AsyncLoading();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final l = await _repo.mine();
      if (mounted) setState(() => _state = AsyncData(l));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _cancel(AppBooking b) async {
    final blocked = !b.canCancel;
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(blocked ? 'Too late to cancel' : 'Cancel this booking?', style: t(20, color: C.maroon)),
        content: Text(
          blocked
              ? (b.cancelBlockedText ?? b.cancelRule)
              : 'The ${paiseText(b.holdPaise)} hold comes back to your wallet. ${b.cancelRule}',
          style: t(15, w: FontWeight.w700),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text(blocked ? 'OK' : 'Keep it', style: t(16, color: C.maroon))),
          if (!blocked) TextButton(onPressed: () => Navigator.of(d).pop(true), child: Text('Cancel', style: t(16, color: C.ruby))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final r = await _guard(() => _repo.cancel(b.id), (e) {
      if (mounted) toast(context, _why(e));
    });
    if (r != null && mounted) {
      toast(context, r.message);
      unawaited(_load());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'My bookings'),
            Expanded(
              child: AsyncView<List<AppBooking>>(
                state: _state,
                onRetry: () => unawaited(_load()),
                emptyTitle: 'No bookings yet.',
                emptyMessage: 'Book a time with an influencer and it shows here.',
                builder: (context, list) => ListView(
                  padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                  children: [for (final b in list) _tile(b)],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tile(AppBooking b) => Container(
        key: ValueKey('booking-${b.id}'),
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.deep, width: 3)),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      Avatar(callPerson(b.hostSlug, b.hostName), size: 50, ring: false),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(b.hostName ?? 'Influencer', style: t(17)),
                            Text('${dayLabel(b.date)} · ${slotLabel(b.time)}', style: t(15, color: C.maroon)),
                            Text('${paiseText(b.holdPaise)} held · ${b.minutes} min', style: t(14, color: C.muted, w: FontWeight.w700)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 3, child: DashedLine()),
              SizedBox(
                width: 90,
                child: TextButton(
                  key: ValueKey('cancel-${b.id}'),
                  onPressed: () => unawaited(_cancel(b)),
                  child: Text('Cancel', style: t(14, color: b.canCancel ? C.ruby : C.muted)),
                ),
              ),
            ],
          ),
        ),
      );
}

// ======================================================================================== influencer: bookings calendar

AppBookingTile _tileOf(AppBooking b, {bool showDay = false, VoidCallback? onTap}) => AppBookingTile(b, showDay: showDay, onTap: onTap);

/// One fan booking row for the influencer: time, fan handle (never a number), minutes and note.
class AppBookingTile extends StatelessWidget {
  const AppBookingTile(this.b, {super.key, this.showDay = false, this.onTap});

  final AppBooking b;
  final bool showDay;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final label = slotLabel(b.time);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.sandLine, width: 2)),
        child: Row(
          children: [
            Container(
              width: 64,
              padding: const EdgeInsets.symmetric(vertical: 8),
              decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(10)),
              child: Column(
                children: [
                  Text(label.split(' ').first, style: t(16, color: C.maroon)),
                  Text(label.split(' ').last, style: t(12, color: C.tan)),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(b.fanHandle ?? 'A fan', style: t(16)),
                  Text('${showDay ? '${dayLabel(b.date)} · ' : ''}${b.minutes} min${b.note.isEmpty ? '' : ' · ${b.note}'}',
                      maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
                ],
              ),
            ),
            const Icon(Icons.call_rounded, color: C.turquoise),
          ],
        ),
      ),
    );
  }
}

/// Tap a booking: who, when, the note, and Cancel (refunds the fan in full).
Future<bool> showHostBookingSheet(BuildContext context, AppBooking b, BookingsRepo repo) async {
  final cancelled = await showDialog<bool>(
    context: context,
    builder: (d) => AlertDialog(
      title: Text('${b.fanHandle ?? 'A fan'} · ${slotLabel(b.time)}', style: t(20, color: C.maroon)),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${dayLabel(b.date)} · ${b.minutes} minute call', style: t(15, w: FontWeight.w700)),
          if (b.note.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Note: ${b.note}', style: t(15, color: C.muted, w: FontWeight.w700)),
          ],
          const SizedBox(height: 8),
          Text(b.cancelRule, style: t(14, color: C.muted, w: FontWeight.w700)),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text('Close', style: t(16, color: C.maroon))),
        if (b.canCancel)
          TextButton(
            key: const ValueKey('host-cancel'),
            onPressed: () async {
              try {
                final r = await repo.cancel(b.id);
                if (d.mounted) Navigator.of(d).pop(true);
                if (context.mounted) toast(context, r.message);
              } catch (e) {
                if (context.mounted) toast(context, _why(e));
              }
            },
            child: Text('Cancel booking', style: t(16, color: C.ruby)),
          ),
      ],
    ),
  );
  return cancelled == true;
}

class RealInfluencerBookingsScreen extends StatefulWidget {
  const RealInfluencerBookingsScreen({super.key, this.repo});

  final BookingsRepo? repo;

  @override
  State<RealInfluencerBookingsScreen> createState() => _RealInfluencerBookingsScreenState();
}

class _RealInfluencerBookingsScreenState extends State<RealInfluencerBookingsScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<List<AppBooking>> _state = const AsyncLoading();
  DateTime _month = dayOnly(DateTime.now());
  DateTime _day = dayOnly(DateTime.now());

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final l = await _repo.hostBookings();
      if (mounted) setState(() => _state = AsyncData(l));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _open(AppBooking b) async {
    if (await showHostBookingSheet(context, b, _repo)) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: AsyncView<List<AppBooking>>(
          state: _state,
          onRetry: () => unawaited(_load()),
          isEmpty: (l) => false,
          builder: (context, all) {
            final list = all.where((b) => b.day == isoDay(_day)).toList();
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Expanded(child: Headline(solid: 'MY', outline: 'BOOKINGS', size: 38)),
                    SizedBox(width: 110, height: 70, child: Art('influencer/calendar-header.webp', fit: BoxFit.contain)),
                  ],
                ),
                const SizedBox(height: 14),
                MonthGrid(
                  month: _month,
                  selected: _day,
                  allowPast: true,
                  dots: {for (final b in all) dayKey(b.date)},
                  onPick: (d) => setState(() => _day = d),
                  onMonth: (m) => setState(() => _month = m),
                ),
                const SizedBox(height: 18),
                Text(dayLabel(_day), style: t(20, color: C.maroon)),
                if (list.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('No bookings on this day.', style: t(15, color: C.muted, w: FontWeight.w700))),
                for (final b in list) _tileOf(b, onTap: () => unawaited(_open(b))),
                const SizedBox(height: 22),
                Text('All upcoming', style: t(18, color: C.maroon)),
                if (all.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Nothing booked yet.', style: t(15, color: C.muted, w: FontWeight.w700))),
                for (final b in all) _tileOf(b, showDay: true, onTap: () => unawaited(_open(b))),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Home: "Today's bookings".
class RealTodaysBookings extends StatefulWidget {
  const RealTodaysBookings({super.key, this.repo});

  final BookingsRepo? repo;

  @override
  State<RealTodaysBookings> createState() => _RealTodaysBookingsState();
}

class _RealTodaysBookingsState extends State<RealTodaysBookings> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<List<AppBooking>> _state = const AsyncLoading();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final l = await _repo.hostBookings(day: isoDay(DateTime.now()));
      if (mounted) setState(() => _state = AsyncData(l));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    if (s is AsyncLoading<List<AppBooking>>) return Text('Loading…', style: t(15, color: C.muted, w: FontWeight.w700));
    if (s is AsyncFailure<List<AppBooking>>) {
      return GestureDetector(onTap: () => unawaited(_load()), child: Text('Could not load. Tap to try again.', style: t(15, color: C.ruby, w: FontWeight.w700)));
    }
    final list = (s as AsyncData<List<AppBooking>>).value;
    if (list.isEmpty) return Text('No bookings today.', style: t(15, color: C.muted, w: FontWeight.w700));
    return Column(children: [for (final b in list) _tileOf(b)]);
  }
}

// ======================================================================================== influencer: availability + rate

class RealAvailabilityScreen extends StatefulWidget {
  const RealAvailabilityScreen({super.key, this.repo});

  final BookingsRepo? repo;

  @override
  State<RealAvailabilityScreen> createState() => _RealAvailabilityScreenState();
}

class _RealAvailabilityScreenState extends State<RealAvailabilityScreen> {
  static const _defaultSlots = {'10:00', '16:00', '18:00', '20:00'};

  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;

  AsyncState<HostAvailability> _state = const AsyncLoading();
  DateTime _month = dayOnly(DateTime.now());
  DateTime _day = dayOnly(DateTime.now());
  int? _rate; // the unsaved rate, when it differs
  int? _rateGetsPaise;
  bool _saving = false;
  Timer? _previewDebounce;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _previewDebounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final a = await _repo.availability();
      if (mounted) setState(() => _state = AsyncData(a));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  HostAvailability get _a => (_state as AsyncData<HostAvailability>).value;

  bool _inRange(DateTime d) {
    final k = isoDay(d);
    return k.compareTo(_a.today) >= 0 && k.compareTo(_a.lastDay) <= 0;
  }

  /// Sends only the changed dates; the server answers with the whole picture.
  Future<void> _save(Map<String, DayPlan> changes) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final a = await _repo.saveAvailability(changes, expectedVersion: _a.version);
      if (mounted) setState(() => _state = AsyncData(a));
    } catch (e) {
      if (mounted) {
        toast(context, _why(e));
        if (bookingProblemOf(e) != BookingProblem.slotBooked) unawaited(_load());
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _setOpen(bool open) {
    final k = isoDay(_day);
    unawaited(_save({k: DayPlan(open: open, slots: open ? (_a.slotsOn(k).isEmpty ? {..._defaultSlots} : {..._a.slotsOn(k)}) : <String>{})}));
  }

  void _toggle(String slot) {
    final k = isoDay(_day);
    final s = {..._a.slotsOn(k)};
    if (!s.remove(slot)) s.add(slot);
    unawaited(_save({k: DayPlan(open: s.isNotEmpty, slots: s)}));
  }

  /// Weekdays (Mon to Fri) in the window get the same times as the selected day.
  void _copyToWeekdays() {
    final k = isoDay(_day);
    final slots = _a.slotsOn(k);
    if (slots.isEmpty) {
      toast(context, 'Open some times on this day first.');
      return;
    }
    final changes = <String, DayPlan>{};
    final start = parseDay(_a.today)!;
    for (var i = 0; i < _a.horizonDays; i++) {
      final d = start.add(Duration(days: i));
      if (d.weekday > DateTime.friday || isoDay(d) == k) continue;
      changes[isoDay(d)] = DayPlan(open: true, slots: {...slots});
    }
    unawaited(_save(changes));
  }

  void _bumpRate(int delta) {
    final a = _a;
    if (!a.rate.editable) return;
    final next = ((_rate ?? a.rate.ratePerMin) + delta).clamp(a.rate.minRate, a.rate.maxRate);
    setState(() => _rate = next);
    _previewDebounce?.cancel();
    _previewDebounce = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await _repo.previewRate(next);
        if (mounted && _rate == next) setState(() => _rateGetsPaise = r.hostGetsPerMinPaise);
      } catch (_) {}
    });
  }

  Future<void> _saveRate() async {
    final r = _rate;
    if (r == null || _saving) return;
    setState(() => _saving = true);
    try {
      final info = await _repo.setRate(r);
      if (mounted) {
        toast(context, 'Rate saved: ₹${info.ratePerMin}/min.');
        setState(() {
          _rate = null;
          _rateGetsPaise = null;
        });
        unawaited(_load());
      }
    } catch (e) {
      if (mounted) toast(context, _why(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: AsyncView<HostAvailability>(
          state: _state,
          onRetry: () => unawaited(_load()),
          isEmpty: (a) => false,
          builder: (context, a) {
            final k = isoDay(_day);
            final open = a.isOpen(k);
            final slots = a.slotsOn(k);
            final booked = a.booked[k] ?? const <String>{};
            final rate = _rate ?? a.rate.ratePerMin;
            final gets = _rate == null ? a.rate.hostGetsPerMinPaise : (_rateGetsPaise ?? a.rate.hostGetsPerMinPaise);
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
              children: [
                const Headline(solid: 'WHEN CAN', outline: 'FANS BOOK?', size: 36),
                const SizedBox(height: 6),
                Text('Tap a date, then tap the times you are free (India time). Yellow dates are open.', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 14),
                MonthGrid(
                  month: _month,
                  selected: _day,
                  fill: {for (final e in a.days.entries) if (e.value.open) dayKey(parseDay(e.key)!)},
                  onPick: (d) {
                    if (!_inRange(d)) {
                      toast(context, 'You can open dates from today up to ${a.horizonDays} days ahead.');
                      return;
                    }
                    setState(() => _day = d);
                  },
                  onMonth: (m) => setState(() => _month = m),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: Text(dayLabel(_day), style: t(20, color: C.maroon))),
                    Text(open ? 'Open' : 'Closed', style: t(14, color: open ? C.maroon : C.muted)),
                    const SizedBox(width: 6),
                    Switch(
                      key: const ValueKey('day-open'),
                      value: open,
                      onChanged: _inRange(_day) && !_saving ? _setOpen : null,
                      activeThumbColor: C.lemon,
                      activeTrackColor: C.maroon,
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final s in a.slotChoices)
                      FilterChip(
                        key: ValueKey('chip-$s'),
                        label: Text(booked.contains(s) ? '${slotLabel(s)} · booked' : slotLabel(s), style: t(14, color: slots.contains(s) ? C.gold : C.maroon)),
                        selected: slots.contains(s),
                        showCheckmark: false,
                        selectedColor: C.maroon,
                        backgroundColor: C.paper,
                        shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                        onSelected: _inRange(_day) && !_saving ? (_) => _toggle(s) : null,
                      ),
                  ],
                ),
                if (booked.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text('A booked time can only be closed after you cancel that booking.', style: t(13, color: C.muted, w: FontWeight.w700)),
                  ),
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton.icon(
                    key: const ValueKey('copy-weekdays'),
                    onPressed: _saving ? null : _copyToWeekdays,
                    icon: const Icon(Icons.copy_rounded, color: C.maroon),
                    label: Text('Copy to every weekday', style: t(15, color: C.maroon)),
                    style: OutlinedButton.styleFrom(side: const BorderSide(color: C.maroon, width: 2), shape: const StadiumBorder()),
                  ),
                ),
                const SizedBox(height: 26),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(18)),
                  child: Column(
                    children: [
                      Text('YOUR RATE', style: t(13, color: C.gold, ls: 0.14)),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          BrassKnob(label: 'Lower rate', size: 52, onTap: a.rate.editable ? () => _bumpRate(-1) : null, child: const Icon(Icons.remove_rounded, color: C.deep, size: 26)),
                          Expanded(child: Center(child: Text('₹$rate/min', style: t(32, color: C.paper)))),
                          BrassKnob(label: 'Raise rate', size: 52, onTap: a.rate.editable ? () => _bumpRate(1) : null, child: const Icon(Icons.add_rounded, color: C.deep, size: 26)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      if (a.rate.editable)
                        Text('You get about ${paiseText(gets)} a minute', style: t(14, color: C.cream, w: FontWeight.w700))
                      else
                        Text(a.rate.fixedMessage ?? 'Your rate is set for everyone, so you can not change it.', textAlign: TextAlign.center, style: t(14, color: C.cream, w: FontWeight.w700)),
                      if (_rate != null && _rate != a.rate.ratePerMin) ...[
                        const SizedBox(height: 10),
                        ChunkyButton(label: 'SAVE RATE', onTap: _saveRate),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Text('Going online for instant calls is the round button in the middle of your bar.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ======================================================================================== profile: Calendar tab

/// The Calendar tab of a public profile, real: the next open dates and their free times; tap a time to book it.
class RealProfileCalendar extends StatefulWidget {
  const RealProfileCalendar({super.key, required this.slug, this.repo});

  final String slug;
  final BookingsRepo? repo;

  @override
  State<RealProfileCalendar> createState() => _RealProfileCalendarState();
}

class _RealProfileCalendarState extends State<RealProfileCalendar> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<HostSlots> _state = const AsyncLoading();
  int _pick = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final s = await _repo.slots(widget.slug);
      if (mounted) setState(() => _state = AsyncData(s));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      child: AsyncView<HostSlots>(
        state: _state,
        onRetry: () => unawaited(_load()),
        isEmpty: (s) => s.openDays.isEmpty,
        emptyTitle: 'No open times yet',
        emptyMessage: 'She has not opened any times for booking. Check back soon.',
        builder: (context, s) {
          final days = (s.openDays.toList()..sort()).take(10).toList();
          final idx = _pick.clamp(0, days.length - 1);
          final day = days[idx];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: 66,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: days.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (_, i) {
                    final on = i == idx;
                    final d = parseDay(days[i])!;
                    return GestureDetector(
                      key: ValueKey('cal-day-${days[i]}'),
                      onTap: () => setState(() => _pick = i),
                      child: Container(
                        width: 62,
                        decoration: BoxDecoration(
                          color: on ? C.maroon : C.paper,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: on ? C.maroon : C.sand, width: 2),
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(weekdayShort[d.weekday - 1], style: t(12, color: on ? C.gold : C.deep)),
                            Text('${d.day}', style: t(20, color: on ? C.gold : C.deep)),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final hhmm in s.slotsOn(day))
                    ActionChip(
                      key: ValueKey('cal-slot-$hhmm'),
                      label: Text(slotLabel(hhmm), style: t(15, color: C.maroon)),
                      backgroundColor: C.paper,
                      shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                      onPressed: () => context.push('/book/${widget.slug}?day=$day&slot=${Uri.encodeComponent(hhmm)}'),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text('Pick a time (India time). We ring you both at that minute.', style: t(14, color: C.muted, w: FontWeight.w700)),
            ],
          );
        },
      ),
    );
  }
}
