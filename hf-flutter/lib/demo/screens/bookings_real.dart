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
import '../../data/telemetry.dart'; // [HF-BOOK-APPROVE]
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
  String? _topic; // [HF-BOOK-APPROVE] the influencer's topic slug the fan picked

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
            if (_state is AsyncData<HostSlots>) _nextButton((_state as AsyncData<HostSlots>).value),
          ],
        ),
      ),
    );
  }

  /// NEXT needs a date, a time and, when the influencer offers topics, one topic.
  Widget _nextButton(HostSlots s) {
    final needTopic = s.topics.isNotEmpty;
    final topicOk = !needTopic || _topic != null;
    final topicQuery = needTopic && _topic != null ? '&topic=${Uri.encodeQueryComponent(_topic!)}' : '';
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: TicketButton(
        label: _slot == null ? 'PICK A TIME' : (topicOk ? 'NEXT' : 'PICK A TOPIC'),
        enabled: _day != null && _slot != null && topicOk,
        stubIcon: Icons.arrow_forward_rounded,
        onTap: () => context.push('/book/${widget.id}/confirm?day=${isoDay(_day!)}&slot=${Uri.encodeComponent(_slot!)}$topicQuery'),
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
                  height: 48,
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
        // [HF-BOOK-APPROVE] Step 3: what the call is about. Only while the server sends topics (feature on); one is required.
        if (s.topics.isNotEmpty) ...[
          const SizedBox(height: 18),
          _step('3', 'What is the call about?', 'Pick one.'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final tp in s.topics)
                GestureDetector(
                  key: ValueKey('topic-${tp.slug}'),
                  onTap: () => setState(() => _topic = tp.slug),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 48),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(
                      color: tp.slug == _topic ? C.maroon : C.paper,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: C.maroon, width: 2),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (tp.slug == _topic) ...[const Icon(Icons.check_rounded, size: 18, color: C.gold), const SizedBox(width: 6)],
                        Flexible(child: Text(tp.label, style: t(15, color: tp.slug == _topic ? C.gold : C.maroon))),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ],
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
  const RealBookConfirmScreen({super.key, required this.id, required this.day, required this.slot, this.topic, this.repo, this.walletRepo, this.reelsRepo});

  final String id;
  final String day; // YYYY-MM-DD
  final String slot; // HH:MM

  /// [HF-BOOK-APPROVE] The chosen topic slug, when the influencer offers topics.
  final String? topic;
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
      // [HF-BOOK-APPROVE-QA-2] The first wallet read after sign-in is often slow/refused and the line stayed "—": try 3 times.
      for (var attempt = 0; attempt < 3 && mounted && _walletPaise == null; attempt++) {
        try {
          final w = await (widget.walletRepo ?? Services.instance.walletRepo).fetch(limit: 1);
          if (mounted) setState(() => _walletPaise = w.balancePaise + w.testCreditPaise);
        } catch (_) {
          await Future<void>.delayed(Duration(milliseconds: 800 * (attempt + 1)));
        }
      }
    }
  }

  String get _approver => _name.isEmpty ? 'the influencer' : _name.split(' ').first;

  String? _topicLabel(HostSlots s) {
    for (final x in s.topics) {
      if (x.slug == widget.topic) return x.label;
    }
    return null;
  }

  Future<void> _confirm(HostSlots s) async {
    if (_busy) return;
    if (s.topics.isNotEmpty && widget.topic == null) {
      toast(context, 'Pick what the call is about first.');
      context.canPop() ? context.pop() : context.go('/reels');
      return;
    }
    final wallet = _walletPaise;
    if (wallet != null && wallet < s.holdPaise) {
      toast(context, 'Not enough in your wallet. Top up first.');
      context.push('/topup');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await _repo.bookRequest(widget.id, istToInstant(widget.day, widget.slot), note: _note.text, topic: widget.topic);
      Telemetry.event('hf_app_booking_requested', {
        'mode': r.needsApproval ? 'manual' : (s.approvalMode == 'auto' ? 'auto' : 'direct'),
        'has_topic': widget.topic != null,
        'outcome': 'ok',
      });
      if (!mounted) return;
      final waiting = r.needsApproval ? '&approval=1&text=${Uri.encodeComponent(r.approvalText ?? '')}' : '';
      // [HF-BOOK-APPROVE-QA-1] Drop the date/time form too, so Back from "Booked" returns to the profile, not to a stale form.
      final router = GoRouter.of(context);
      final to = '/booked/${widget.id}?day=${widget.day}&slot=${Uri.encodeComponent(widget.slot)}&name=${Uri.encodeComponent(_name)}$waiting';
      if (router.canPop()) router.pop();
      router.pushReplacement(to);
    } catch (e) {
      Telemetry.event('hf_app_booking_requested', {
        'mode': s.needsApproval ? 'manual' : 'direct',
        'has_topic': widget.topic != null,
        'outcome': 'failed',
        'reason': e is ApiException ? e.code : 'error',
      });
      if (!mounted) return;
      setState(() => _busy = false);
      switch (bookingProblemOf(e)) {
        case BookingProblem.tooSoon:
        case BookingProblem.badTopic:
          // The time (or topic) has to change: say why and go back to pick again.
          toast(context, _why(e));
          context.canPop() ? context.pop() : context.go('/reels');
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
                          if (_topicLabel(s) != null) ...[_line('About', _topicLabel(s)!), const SizedBox(height: 8)],
                          _line('Held now (${s.minutes} min)', paiseText(s.holdPaise)),
                          const SizedBox(height: 8),
                          _line('Your wallet', _walletPaise == null ? '—' : paiseText(_walletPaise!)),
                        ],
                      ),
                    ),
                    // [HF-BOOK-APPROVE] Manual approval: say plainly what happens if nobody accepts.
                    if (s.needsApproval) ...[
                      const SizedBox(height: 14),
                      Container(
                        key: const ValueKey('approval-notice'),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.saffron, width: 2)),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.hourglass_top_rounded, color: C.deep),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                "Needs $_approver's approval. If it isn't accepted within 24 hours, the full ${paiseText(s.holdPaise)} returns to your wallet.",
                                style: t(15, h: 1.4),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
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
                      s.needsApproval
                          ? 'Once accepted, at ${slotLabel(widget.slot)} India time we ring ${_name.isEmpty ? 'her' : _name.split(' ').first} first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You can cancel any time while you wait, and free until 1 hour before the call.'
                          : 'At ${slotLabel(widget.slot)} India time we ring ${_name.isEmpty ? 'her' : _name.split(' ').first} first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You can cancel free until 1 hour before. You get a WhatsApp reminder an hour before.',
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
                  label: _busy ? 'BOOKING…' : (_state is AsyncData<HostSlots> && (_state as AsyncData<HostSlots>).value.needsApproval ? 'SEND REQUEST' : 'CONFIRM BOOKING'),
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
  const RealBookedScreen({super.key, required this.day, required this.slot, this.name = '', this.approval = false, this.approvalText = ''});

  final String day;
  final String slot;
  final String name;

  /// [HF-BOOK-APPROVE] The booking waits for the influencer: show "Request sent" with the server's [approvalText].
  final bool approval;
  final String approvalText;

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
              if (approval)
                const Headline(solid: 'REQUEST', outline: 'SENT!', size: 40, align: TextAlign.center)
              else
                const Headline(solid: 'BOOKED!', size: 46, align: TextAlign.center),
              const SizedBox(height: 8),
              Text('${name.isEmpty ? '' : '$name\n'}${dayLabel(d)} · ${slotLabel(slot)}', textAlign: TextAlign.center, style: t(20, color: C.deep, h: 1.35)),
              const SizedBox(height: 10),
              if (approval)
                Text(
                  approvalText.isNotEmpty
                      ? approvalText
                      : "Sent for approval. If it isn't accepted within 24 hours, your money returns to your wallet.",
                  key: const ValueKey('approval-text'),
                  textAlign: TextAlign.center,
                  style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4),
                )
              else
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
  const RealBookingsScreen({super.key, this.repo, this.highlightId});

  final BookingsRepo? repo;

  /// [HF-BOOK-APPROVE] A booking to bring into view (from a link). Falls back to `?booking=` of the current route.
  final String? highlightId;

  @override
  State<RealBookingsScreen> createState() => _RealBookingsScreenState();
}

class _RealBookingsScreenState extends State<RealBookingsScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<List<AppBooking>> _state = const AsyncLoading();
  final GlobalKey _highlightKey = GlobalKey();
  Timer? _tick;
  String? _routeHighlight;

  String? get _highlightId => widget.highlightId ?? _routeHighlight;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // Keeps "auto-cancels in 17 h" honest while the screen stays open.
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      final s = _state;
      if (mounted && s is AsyncData<List<AppBooking>> && s.value.any((b) => b.isPending)) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _routeHighlight = routeBookingParam(context);
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() => _state = const AsyncLoading());
    try {
      final active = await _repo.mine();
      var past = const <AppBooking>[];
      if (Services.instance.bookingApprovalEnabled || active.any((b) => b.statusText != null)) {
        // [HF-BOOK-APPROVE] cancelled / refunded ones stay visible, with the server's own sentence.
        try {
          past = await _repo.mine(status: 'past');
        } catch (_) {}
      }
      if (!mounted) return;
      setState(() => _state = AsyncData([...active, ...past]));
      if (_highlightId != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          final c = _highlightKey.currentContext;
          if (c != null) unawaited(Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300)));
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (quiet && _state is AsyncData<List<AppBooking>>) {
        toast(context, _why(e));
      } else {
        setState(() => _state = AsyncFailure(e));
      }
    }
  }

  Future<void> _cancel(AppBooking b) async {
    final blocked = !b.canCancel;
    final ok = await hfConfirm(
      context,
      title: blocked ? 'Too late to cancel' : (b.isPending ? 'Cancel this request?' : 'Cancel this booking?'),
      body: blocked
          ? (b.cancelBlockedText ?? b.cancelRule)
          : b.isPending
              ? 'Nothing is lost: the full ${paiseText(b.holdPaise)} comes back to your wallet.'
              : 'The ${paiseText(b.holdPaise)} hold comes back to your wallet. ${b.cancelRule}',
      confirmLabel: blocked ? null : 'Cancel',
      cancelLabel: blocked ? 'OK' : 'Keep it',
      destructive: true,
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
                builder: (context, list) {
                  final now = DateTime.now();
                  final current = [for (final b in list) if (!(b.statusText != null && b.isPast)) b];
                  final earlier = [for (final b in list) if (b.statusText != null && b.isPast) b];
                  return RefreshIndicator(
                    onRefresh: () => _load(quiet: true),
                    child: ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                      children: [
                        for (final b in current) _tile(b, now),
                        if (earlier.isNotEmpty) ...[
                          Padding(padding: const EdgeInsets.only(top: 10, bottom: 10), child: Text('Earlier', style: t(18, color: C.maroon))),
                          for (final b in earlier) _tile(b, now),
                        ],
                      ],
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// "Waiting for approval", "Confirmed", "Cancelled" ... as an icon + words (never colour alone).
  Widget _statusChip(AppBooking b) {
    final (IconData icon, String text, Color bg, Color fg) = switch (b.status) {
      'pending_approval' => (Icons.hourglass_top_rounded, 'Waiting for approval', C.lemon, C.deep),
      'confirmed' || 'starting' || 'active' => (Icons.check_circle_outline_rounded, 'Confirmed', C.cream, C.deep),
      'cancelled' => (Icons.event_busy_rounded, 'Cancelled', C.sand, C.ruby),
      'completed' => (Icons.task_alt_rounded, 'Completed', C.cream, C.deep),
      'failed' => (Icons.error_outline_rounded, 'Did not happen', C.sand, C.ruby),
      _ => (Icons.info_outline_rounded, 'In progress', C.cream, C.deep),
    };
    return Container(
      key: ValueKey('chip-${b.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: fg),
          const SizedBox(width: 6),
          Flexible(child: Text(text, style: t(14, color: fg))),
        ],
      ),
    );
  }

  Widget _tile(AppBooking b, DateTime now) {
    final rich = b.statusText != null; // the approval feature is on: the extra lines below
    final deadline = b.approvalDeadline;
    final highlighted = _highlightId == b.id;
    final tile = Container(
      key: ValueKey('booking-${b.id}'),
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: highlighted ? C.maroon : C.deep, width: highlighted ? 4 : 3)),
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
                          if (b.topic != null) Text('About: ${b.topic!.label}', key: ValueKey('topic-${b.id}'), style: t(14, color: C.tan, w: FontWeight.w700)),
                          Text('${paiseText(b.holdPaise)} ${b.status == 'cancelled' ? 'refunded' : 'held'} · ${b.minutes} min', style: t(14, color: C.muted, w: FontWeight.w700)),
                          if (rich) ...[
                            const SizedBox(height: 6),
                            _statusChip(b),
                            if (b.isPending && deadline != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text(
                                  'Auto-cancels in ${countdownLabel(deadline.difference(now))}',
                                  key: ValueKey('countdown-${b.id}'),
                                  style: t(14, color: C.deep, w: FontWeight.w700),
                                ),
                              ),
                            if (!b.isPending && b.statusText != null && b.statusText!.isNotEmpty)
                              Padding(padding: const EdgeInsets.only(top: 4), child: Text(b.statusText!, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3))),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (!(rich && b.isPast)) ...[
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
          ],
        ),
      ),
    );
    return highlighted ? KeyedSubtree(key: _highlightKey, child: tile) : tile;
  }
}

/// `?booking=<id>` of the screen's current route, or null (also null outside a router, as in tests).
String? routeBookingParam(BuildContext context) {
  try {
    final id = GoRouterState.of(context).uri.queryParameters['booking'];
    return id == null || id.isEmpty ? null : id;
  } catch (_) {
    return null;
  }
}

// ======================================================================================== influencer: bookings calendar

AppBookingTile _tileOf(AppBooking b, {bool showDay = false, VoidCallback? onTap}) => AppBookingTile(b, showDay: showDay, onTap: onTap);

/// One fan booking row for the influencer: time, fan handle (never a number), minutes and note.
class AppBookingTile extends StatelessWidget {
  const AppBookingTile(this.b, {super.key, this.showDay = false, this.onTap, this.showStarts = false, this.extra});

  final AppBooking b;
  final bool showDay;
  final VoidCallback? onTap;

  /// [HF-BOOK-APPROVE] Adds "starts in 25 min" (upcoming rows).
  final bool showStarts;

  /// [HF-BOOK-APPROVE] One more line under the details (a past row's status sentence).
  final String? extra;

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
                  Text(label.split(' ').last, style: t(14, color: C.tan)),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(b.fanHandle ?? 'A fan', style: t(16)),
                  Text(
                      '${showDay ? '${dayLabel(b.date)} · ' : ''}${b.minutes} min'
                      '${b.topic == null ? '' : ' · ${b.topic!.label}'}'
                      '${showStarts && !b.isPast ? ' · ${startsInLabel(b.startAt, DateTime.now())}' : ''}'
                      '${b.note.isEmpty ? '' : ' · ${b.note}'}',
                      maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
                  if (extra != null && extra!.isNotEmpty) Text(extra!, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
                ],
              ),
            ),
            Icon(
              b.isPending ? Icons.hourglass_top_rounded : (b.isCancelled || b.status == 'failed') ? Icons.event_busy_rounded : b.isPast ? Icons.task_alt_rounded : Icons.call_rounded,
              color: b.isPending ? C.saffron : (b.isCancelled || b.status == 'failed') ? C.ruby : C.turquoise,
            ),
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
    builder: (d) => HfDialog(
      title: '${b.fanHandle ?? 'A fan'} · ${slotLabel(b.time)}',
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${dayLabel(b.date)} · ${b.minutes} minute call', style: t(15, w: FontWeight.w700)),
          if (b.topic != null) ...[
            const SizedBox(height: 8),
            Text('Topic: ${b.topic!.label}', style: t(15, color: C.tan, w: FontWeight.w700)),
          ],
          if (b.note.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Note: ${b.note}', style: t(15, color: C.muted, w: FontWeight.w700)),
          ],
          const SizedBox(height: 8),
          Text(b.cancelRule, style: t(14, color: C.muted, w: FontWeight.w700)),
        ],
      ),
      actions: [
        HfDialogAction(label: 'Close', onTap: () => Navigator.of(d).pop(false)),
        if (b.canCancel)
          HfDialogAction(
            key: const ValueKey('host-cancel'),
            kind: HfActionKind.destructive,
            label: 'Cancel booking',
            onTap: () async {
              try {
                final r = await repo.cancel(b.id);
                if (d.mounted) Navigator.of(d).pop(true);
                if (context.mounted) toast(context, r.message);
              } catch (e) {
                if (context.mounted) toast(context, _why(e));
              }
            },
          ),
      ],
    ),
  );
  return cancelled == true;
}

class RealInfluencerBookingsScreen extends StatefulWidget {
  const RealInfluencerBookingsScreen({super.key, this.repo, this.highlightId});

  final BookingsRepo? repo;

  /// [HF-BOOK-APPROVE] A waiting booking to bring into view (from a link). Falls back to `?booking=` of the current route.
  final String? highlightId;

  @override
  State<RealInfluencerBookingsScreen> createState() => _RealInfluencerBookingsScreenState();
}

class _RealInfluencerBookingsScreenState extends State<RealInfluencerBookingsScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  AsyncState<List<AppBooking>> _state = const AsyncLoading();
  DateTime _month = dayOnly(DateTime.now());
  DateTime _day = dayOnly(DateTime.now());

  // [HF-BOOK-APPROVE] Only filled while the approval feature is on.
  List<AppBooking> _past = const [];
  BookingSettings? _settings;
  bool _savingSettings = false;
  String? _busyId; // the booking being accepted / declined
  final GlobalKey _highlightKey = GlobalKey();
  Timer? _tick;
  String? _routeHighlight;

  String? get _highlightId => widget.highlightId ?? _routeHighlight;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // Keeps "auto-cancels in 17 h" and "starts in 25 min" honest while the page stays open.
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted && _state is AsyncData<List<AppBooking>>) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A link can arrive while this tab is already open (the shell keeps it alive): bring in the new booking.
    final p = routeBookingParam(context);
    final changed = p != null && p != _routeHighlight;
    _routeHighlight = p ?? _routeHighlight;
    if (changed && _state is AsyncData<List<AppBooking>>) unawaited(_load(quiet: true));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// The approval UI shows when the app config says so, or when the server's answer already carries the new fields.
  bool _approvalUi(List<AppBooking> all) => Services.instance.bookingApprovalEnabled || all.any((b) => b.statusText != null);

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() => _state = const AsyncLoading());
    try {
      final l = await _repo.hostBookings();
      var past = const <AppBooking>[];
      BookingSettings? settings = _settings;
      if (_approvalUi(l)) {
        try {
          past = await _repo.hostBookings(status: 'past');
        } catch (_) {}
        try {
          settings = await _repo.bookingSettings();
        } catch (_) {}
      }
      if (!mounted) return;
      setState(() {
        _state = AsyncData(l);
        _past = past;
        _settings = settings;
      });
      if (_highlightId != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          final c = _highlightKey.currentContext;
          if (c != null) unawaited(Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300)));
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (quiet && _state is AsyncData<List<AppBooking>>) {
        toast(context, _why(e));
      } else {
        setState(() => _state = AsyncFailure(e));
      }
    }
  }

  Future<void> _open(AppBooking b) async {
    if (await showHostBookingSheet(context, b, _repo)) unawaited(_load());
  }

  Future<void> _saveSettings({String? approval, bool? openAlerts}) async {
    final before = _settings;
    if (before == null || _savingSettings) return;
    setState(() {
      _savingSettings = true;
      _settings = BookingSettings(approval: approval ?? before.approval, openAlerts: openAlerts ?? before.openAlerts);
    });
    try {
      final saved = await _repo.saveBookingSettings(approval: approval, openAlerts: openAlerts);
      if (approval != null) Telemetry.event('hf_app_booking_mode_changed', {'from': before.approval, 'to': saved.approval, 'outcome': 'ok'});
      if (mounted) setState(() => _settings = saved);
    } catch (e) {
      if (approval != null) {
        Telemetry.event('hf_app_booking_mode_changed', {'from': before.approval, 'to': approval, 'outcome': 'failed', 'reason': e is ApiException ? e.code : 'error'});
      }
      if (mounted) {
        setState(() => _settings = before);
        toast(context, _why(e));
        unawaited(_load(quiet: true));
      }
    } finally {
      if (mounted) setState(() => _savingSettings = false);
    }
  }

  Future<void> _accept(AppBooking b) async {
    if (_busyId != null) return;
    setState(() => _busyId = b.id);
    try {
      await _repo.accept(b.id);
      Telemetry.event('hf_app_booking_accept_tapped', {'booking_id': b.id, 'outcome': 'ok'});
      if (mounted) toast(context, 'Accepted. ${b.fanHandle ?? 'The caller'} will call you at ${slotLabel(b.time)}.');
    } catch (e) {
      Telemetry.event('hf_app_booking_accept_tapped', {'booking_id': b.id, 'outcome': 'failed', 'reason': e is ApiException ? e.code : 'error'});
      if (mounted) toast(context, _why(e));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
    if (mounted) unawaited(_load(quiet: true));
  }

  Future<void> _decline(AppBooking b) async {
    if (_busyId != null) return;
    final ok = await hfConfirm(
      context,
      title: 'Decline this booking?',
      body: 'The caller gets a full refund of ${paiseText(b.holdPaise)} to their wallet.',
      confirmLabel: 'Decline',
      cancelLabel: 'Keep it',
      destructive: true,
      confirmKey: const ValueKey('decline-confirm'),
    );
    if (ok != true) {
      Telemetry.event('hf_app_booking_decline_tapped', {'booking_id': b.id, 'outcome': 'dismissed'});
      return;
    }
    if (!mounted) return;
    setState(() => _busyId = b.id);
    try {
      await _repo.decline(b.id);
      Telemetry.event('hf_app_booking_decline_tapped', {'booking_id': b.id, 'outcome': 'ok'});
      if (mounted) toast(context, 'Declined. The caller was refunded in full.');
    } catch (e) {
      Telemetry.event('hf_app_booking_decline_tapped', {'booking_id': b.id, 'outcome': 'failed', 'reason': e is ApiException ? e.code : 'error'});
      if (mounted) toast(context, _why(e));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
    if (mounted) unawaited(_load(quiet: true));
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
            final approval = _approvalUi(all);
            return RefreshIndicator(
              onRefresh: () => _load(quiet: true),
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      const Expanded(child: Headline(solid: 'BOOKED', outline: 'WITH ME', size: 38)), // [HF-BOOK-APPROVE-QA-1] not 'My bookings' (that is the fan list)
                      SizedBox(width: 110, height: 70, child: Art('influencer/calendar-header.webp', fit: BoxFit.contain)),
                    ],
                  ),
                  const SizedBox(height: 14),
                  if (approval) ..._approvalSections(all) else ..._calendarBlock(all),
                  if (!approval) ...[
                    const SizedBox(height: 22),
                    Text('All upcoming', style: t(18, color: C.maroon)),
                    if (all.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Nothing booked yet.', style: t(15, color: C.muted, w: FontWeight.w700))),
                    for (final b in all) _tileOf(b, showDay: true, onTap: () => unawaited(_open(b))),
                  ],
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  /// The month grid and the chosen day's bookings (the page as it always was).
  List<Widget> _calendarBlock(List<AppBooking> all) {
    final list = all.where((b) => b.day == isoDay(_day)).toList();
    return [
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
    ];
  }

  // ------------------------------------------------------------------------------------ [HF-BOOK-APPROVE]

  List<Widget> _approvalSections(List<AppBooking> all) {
    final now = DateTime.now();
    final waiting = [for (final b in all) if (b.isPending) b];
    final upcoming = [for (final b in all) if (!b.isPending && !b.isPast) b];
    return [
      _settingsCard(),
      const SizedBox(height: 22),
      _sectionTitle('Waiting for you', waiting.length),
      if (waiting.isEmpty) _hint('Nothing is waiting for you.'),
      for (final b in waiting) _waitingCard(b, now),
      const SizedBox(height: 22),
      _sectionTitle('Upcoming', upcoming.length),
      if (upcoming.isEmpty) _hint('No confirmed calls yet.'),
      for (final b in upcoming) _upcomingTile(b, now),
      const SizedBox(height: 22),
      Text('Calendar', style: t(18, color: C.maroon)),
      const SizedBox(height: 10),
      ..._calendarBlock([...waiting, ...upcoming]),
      const SizedBox(height: 22),
      _sectionTitle('Past', _past.length),
      if (_past.isEmpty) _hint('Finished and cancelled bookings show here.'),
      for (final b in _past.take(30)) AppBookingTile(b, showDay: true, extra: b.statusText, onTap: () => unawaited(_open(b))),
    ];
  }

  Widget _sectionTitle(String title, int count) => Text(count > 0 ? '$title ($count)' : title, style: t(18, color: C.maroon));

  Widget _hint(String text) => Padding(padding: const EdgeInsets.only(top: 8), child: Text(text, style: t(15, color: C.muted, w: FontWeight.w700)));

  Widget _settingsCard() {
    final st = _settings;
    final manual = st?.isManual ?? true;
    return Container(
      key: const ValueKey('booking-settings'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.deep, width: 3)),
      child: Column(
        children: [
          MergeSemantics(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('I approve each booking', key: const ValueKey('approval-title'), style: t(18, color: C.maroon)), // [HF-BOOK-APPROVE-QA-1] the switch says on/off; the title stays put
                      const SizedBox(height: 2),
                      Text(
                        manual
                            ? 'On: each booking waits for you to accept. If you do not accept within 24 hours it is cancelled and the caller is refunded.'
                            : 'Off (auto-accept): bookings are confirmed straight away. You can still cancel one later and the caller is refunded.',
                        style: t(14, color: C.muted, w: FontWeight.w700, h: 1.35),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Switch(
                  key: const ValueKey('approval-switch'),
                  value: manual,
                  onChanged: st == null || _savingSettings ? null : (v) => unawaited(_saveSettings(approval: v ? 'manual' : 'auto')),
                  activeThumbColor: C.lemon,
                  activeTrackColor: C.maroon,
                ),
              ],
            ),
          ),
          const Divider(height: 22, color: C.sandLine),
          MergeSemantics(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Open-time alerts', style: t(18, color: C.maroon)),
                      const SizedBox(height: 2),
                      Text('A nudge when your open hours begin, so you are ready for calls.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.35)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Switch(
                  key: const ValueKey('alerts-switch'),
                  value: st?.openAlerts ?? true,
                  onChanged: st == null || _savingSettings ? null : (v) => unawaited(_saveSettings(openAlerts: v)),
                  activeThumbColor: C.lemon,
                  activeTrackColor: C.maroon,
                ),
              ],
            ),
          ),
          if (st == null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Could not load these settings. Pull down to try again.', style: t(14, color: C.ruby, w: FontWeight.w700)),
            ),
        ],
      ),
    );
  }

  Widget _waitingCard(AppBooking b, DateTime now) {
    final busy = _busyId == b.id;
    final deadline = b.approvalDeadline;
    final highlighted = _highlightId == b.id;
    final card = Container(
      key: ValueKey('pending-${b.id}'),
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(16), border: Border.all(color: highlighted ? C.maroon : C.saffron, width: highlighted ? 4 : 2)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(b.fanHandle ?? 'A fan', style: t(18))),
              const Icon(Icons.hourglass_top_rounded, size: 18, color: C.deep),
            ],
          ),
          const SizedBox(height: 4),
          Text('${dayLabel(b.date)} · ${slotLabel(b.time)} · ${b.minutes} min', style: t(16, color: C.maroon)),
          if (b.topic != null) Text('Topic: ${b.topic!.label}', style: t(15, color: C.tan, w: FontWeight.w700)),
          if (b.note.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text('Note: ${b.note}', style: t(15, color: C.muted, w: FontWeight.w700))),
          const SizedBox(height: 2),
          Text('${paiseText(b.holdPaise)} held for this call', style: t(14, color: C.muted, w: FontWeight.w700)),
          if (deadline != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Auto-cancels in ${countdownLabel(deadline.difference(now))}', key: ValueKey('countdown-${b.id}'), style: t(15, color: C.deep)),
            ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: ValueKey('accept-${b.id}'),
              onPressed: b.canAccept && _busyId == null ? () => unawaited(_accept(b)) : null,
              icon: const Icon(Icons.check_rounded),
              label: Text(busy ? 'Please wait…' : 'Accept', style: t(17, color: C.gold)),
              style: FilledButton.styleFrom(
                backgroundColor: C.maroon,
                foregroundColor: C.gold,
                disabledBackgroundColor: C.sandLine,
                minimumSize: const Size.fromHeight(52),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              key: ValueKey('decline-${b.id}'),
              onPressed: b.canDecline && _busyId == null ? () => unawaited(_decline(b)) : null,
              icon: const Icon(Icons.close_rounded),
              label: Text('Decline', style: t(17, color: C.maroon)),
              style: OutlinedButton.styleFrom(
                foregroundColor: C.maroon,
                minimumSize: const Size.fromHeight(52),
                side: const BorderSide(color: C.maroon, width: 2),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          if (!b.canAccept && !b.canDecline)
            Padding(padding: const EdgeInsets.only(top: 6), child: Text('This booking is about to be cancelled.', style: t(14, color: C.ruby, w: FontWeight.w700))),
        ],
      ),
    );
    return highlighted ? KeyedSubtree(key: _highlightKey, child: card) : card;
  }

  Widget _upcomingTile(AppBooking b, DateTime now) => AppBookingTile(b, showDay: true, showStarts: true, onTap: () => unawaited(_open(b)));
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
                            Text(weekdayShort[d.weekday - 1], style: t(14, color: on ? C.gold : C.deep)),
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
              // [HF-BOOK-APPROVE] Say up front that this influencer approves each booking.
              if (s.needsApproval)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text("Each booking needs the influencer's approval. If it isn't accepted within 24 hours, your money returns to your wallet.",
                      key: const ValueKey('cal-approval-note'), style: t(14, color: C.tan, w: FontWeight.w700, h: 1.35)),
                ),
            ],
          );
        },
      ),
    );
  }
}
