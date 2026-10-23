import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/call_flags.dart'; // [HF-CALL-MODES-E2]
import '../../data/demo_mode.dart';
import '../../data/models/booking.dart';
import '../../data/repos/bookings_repo.dart';
import '../../data/repos/reels_repo.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart'; // [HF-BOOK-APPROVE]
import '../../ui/async_view.dart';
import '../data.dart';
import '../booking_kit.dart';
import '../list_kit.dart';
import '../inf_kit.dart';
import '../call_kit.dart';
import '../settings_kit.dart';
import '../desi.dart';
import '../profile_kit.dart';
import '../theme.dart';
import '../widgets.dart';
import 'call_real.dart' show callPerson, paiseText, recoverHfAgeConfirmation, BookingAgeConfirmation;

/// Real bookings (HF-WIRE-8). While [DemoMode.on] the dummy flow in booking.dart / influencer.dart / me.dart stays.
abstract final class BookingsBridge {
  /// Tests set this to exercise the real path without a dart-define.
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

/// [HF-CALL-MODES-E2] The quote under the booking: what is held now and how the rest is charged.
String bookingHoldNotice(int holdMinutes) =>
    'We hold the cost of the first $holdMinutes minutes now. After that your wallet is charged every 5 minutes while you talk, and only for the minutes you actually talk. Keep enough in your wallet for the whole call.';

/// [HF-CALL-MODES-E2] "45 min" or, with booking lengths on, "1 h" / "2 h".
String _minsText(int m) => CallFlags.bookingLengths ? lengthLabel(m) : '$m min';

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
  int? _length; // [HF-CALL-MODES-E2] the length the fan picked (minutes); only used while booking lengths are on
  bool _lengthBusy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadName());
  }

  /// [HF-CALL-MODES-E2] Lengths are offered only while the flag is on AND the server sent a list.
  bool _showLengths(HostSlots s) => CallFlags.bookingLengths && s.durationsMinutes.isNotEmpty;

  int _lengthOf(HostSlots s) => _length ?? s.minutes;

  /// Picks a length and asks the server for the starts that fit it. The page keeps showing the old times until the new ones arrive.
  Future<void> _pickLength(int minutes) async {
    if (_lengthBusy || minutes == _length) return;
    Telemetry.event('hf_app_booking_length_picked', {'minutes': minutes});
    setState(() {
      _length = minutes;
      _lengthBusy = true;
    });
    try {
      final s = await _repo.slots(widget.id, durationMinutes: minutes);
      if (!mounted) return;
      setState(() {
        _state = AsyncData(s);
        final d = _day;
        if (d != null && _slot != null && !s.slotsOn(isoDay(d)).contains(_slot)) _slot = null;
      });
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _lengthBusy = false);
    }
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      await for (final s in _repo.watchSlots(widget.id)) {
        if (mounted) setState(() => _state = AsyncData(s)); // [HF-APP-CACHE-1] cached times first, then the server's
      }
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
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Book a time'), // [HF-APP-DESI-5]
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
    final topicQuery = (needTopic && _topic != null ? '&topic=${Uri.encodeQueryComponent(_topic!)}' : '') +
        (_showLengths(s) ? '&len=${_lengthOf(s)}' : ''); // [HF-CALL-MODES-E2]
    return BookBottomButton(
      label: _slot == null ? 'PICK A TIME' : (topicOk ? 'NEXT' : 'PICK A TOPIC'),
      enabled: _day != null && _slot != null && topicOk && !_lengthBusy,
      onTap: () => context.push('/book/${widget.id}/confirm?day=${isoDay(_day!)}&slot=${Uri.encodeComponent(_slot!)}$topicQuery'
          // [HF-BOOK-APPROVE-QA-6] hand the name/photo on, so the confirm screen never shows placeholders while it reloads them
          '${_name.isEmpty ? '' : '&name=${Uri.encodeQueryComponent(_name)}'}${_avatar == null ? '' : '&avatar=${Uri.encodeQueryComponent(_avatar!)}'}'),
    );
  }

  Widget _body(BuildContext context, HostSlots s) {
    final first = _name.isEmpty ? 'She' : _name.split(' ').first;
    final fill = {for (final d in s.openDays) dayKey(parseDay(d)!)};
    final times = _day == null ? const <String>[] : s.slotsOn(isoDay(_day!));
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      children: [
        BookPerson(
            who: _who,
            name: _name.isEmpty ? 'Book a call' : _name,
            rate: '₹${s.ratePerMin}/min',
            chip: _showLengths(s) ? '${lengthLabel(_lengthOf(s))} call' : '${s.minutes} minute call'),
        const SizedBox(height: 14),
        // [HF-CALL-MODES-E2] Step 1 (only while booking lengths are on): how long. The other steps move down by one.
        if (_showLengths(s)) ...[
          BookStep(
            n: '1',
            title: 'How long?',
            sub: 'We hold the cost of the first ${s.holdMinutes ?? 15} minutes. After that you are charged every 5 minutes while you talk.',
            tone: BookTone.lav,
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final m in s.durationsMinutes)
                BookSlotPill(key: ValueKey('length-$m'), label: lengthLabel(m), on: m == _lengthOf(s), onTap: () => unawaited(_pickLength(m))),
            ]),
          ),
          const SizedBox(height: 14),
        ],
        BookStep(
          n: _showLengths(s) ? '2' : '1',
          title: 'Pick a date',
          sub: s.openDays.isEmpty ? '$first has not opened any times yet.' : 'Yellow dates are open.',
          tone: BookTone.gold,
          child: BookMonth(
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
        ),
        const SizedBox(height: 14),
        BookStep(
          n: _showLengths(s) ? '3' : '2',
          title: 'Pick a time',
          sub: _day == null ? 'Choose a date first.' : '${dayLabel(_day!)} · India time',
          tone: BookTone.tea,
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            for (final hhmm in times) BookSlotPill(key: ValueKey('slot-$hhmm'), label: slotLabel(hhmm), on: hhmm == _slot, onTap: () => setState(() => _slot = hhmm)),
          ]),
        ),
        // [HF-BOOK-APPROVE] Step 3: what the call is about. Only while the server sends topics (feature on); one is required.
        if (s.topics.isNotEmpty) ...[
          const SizedBox(height: 14),
          BookStep(
            n: _showLengths(s) ? '4' : '3',
            title: 'What is the call about?',
            sub: 'Pick one.',
            tone: BookTone.lav,
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final tp in s.topics) BookTopicPill(key: ValueKey('topic-${tp.slug}'), label: tp.label, on: tp.slug == _topic, onTap: () => setState(() => _topic = tp.slug)),
            ]),
          ),
        ],
        const SizedBox(height: 14),
        const DesiMogra(),
      ],
    );
  }
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
  const RealBookConfirmScreen({super.key, required this.id, required this.day, required this.slot, this.topic, this.length, this.name, this.avatar, this.repo, this.walletRepo, this.reelsRepo});

  /// [HF-CALL-MODES-E2] The length the fan picked (minutes), when booking lengths are on.
  final int? length;

  final String id;
  final String day; // YYYY-MM-DD
  final String slot; // HH:MM

  /// [HF-BOOK-APPROVE] The chosen topic slug, when the influencer offers topics.
  final String? topic;

  /// [HF-BOOK-APPROVE-QA-6] Name and photo from the previous step (shown at once; the profile load only refreshes them).
  final String? name;
  final String? avatar;
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
  bool _walletLoading = true;
  bool _walletFailed = false;
  String _name = '';
  String? _avatar;
  bool _busy = false;
  final _note = TextEditingController();

  @override
  void initState() {
    super.initState();
    _name = (widget.name ?? '').trim();
    _avatar = (widget.avatar ?? '').trim().isEmpty ? null : widget.avatar;
    unawaited(_load());
    unawaited(_loadWallet());
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      await for (final s in _repo.watchSlots(widget.id, from: widget.day, to: widget.day, durationMinutes: _lengthOn ? widget.length : null)) {
        if (mounted) setState(() => _state = AsyncData(s)); // [HF-APP-CACHE-1]
      }
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
  }

  /// [HF-BOOK-APPROVE-QA-4] Same read the Me screen's balance tag makes (`walletRepo.fetch(limit: 1)`), started in initState in
  /// parallel with the slots call. It used to wait for slots + profile and sat behind `Services.instance.isSignedIn` (the cached
  /// Clerk user), which the Me tag never checks; when that was null the line stayed "—" with no read and no error. The repo
  /// already retries once on a transient failure; failures are reported to telemetry instead of swallowed.
  Future<void> _loadWallet() async {
    if (DemoMode.on && widget.walletRepo == null) return;
    if (mounted) setState(() { _walletLoading = true; _walletFailed = false; });
    for (var attempt = 0; attempt < 3 && mounted && _walletPaise == null; attempt++) {
      try {
        final w = await (widget.walletRepo ?? Services.instance.walletRepo).fetch(limit: 1);
        if (mounted) setState(() => _walletPaise = w.balancePaise + w.testCreditPaise);
      } catch (e, st) {
        Telemetry.crash(e, st, source: 'book_confirm_wallet');
        if (attempt < 2) await Future<void>.delayed(Duration(milliseconds: 800 * (attempt + 1)));
      }
    }
    if (mounted) setState(() { _walletLoading = false; _walletFailed = _walletPaise == null; });
  }

  String get _approver => _name.isEmpty ? 'the influencer' : _name.split(' ').first;

  /// [HF-CALL-MODES-E2] Booking lengths are on and a length was picked.
  bool get _lengthOn => CallFlags.bookingLengths && widget.length != null;

  int _minutesOf(HostSlots s) => _lengthOn ? widget.length! : s.minutes;

  /// Minutes the hold covers: the server's number, else the first 15 (or the whole call if shorter).
  int _holdMinutesOf(HostSlots s) => _lengthOn ? (s.holdMinutes ?? (widget.length! < 15 ? widget.length! : 15)) : s.minutes;

  String _callText(HostSlots s) => _lengthOn ? '${lengthLabel(_minutesOf(s))} call' : '${s.minutes} minute call';

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
      final r = await _repo.bookRequest(widget.id, istToInstant(widget.day, widget.slot), note: _note.text, topic: widget.topic, durationMinutes: _lengthOn ? widget.length : null);
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
      if (e is ApiException && e.code == 'age_confirmation_required') {
        await recoverHfAgeConfirmation(context);
        return;
      }
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
    final firstName = _name.isEmpty ? 'the influencer' : _name.split(' ').first;
    // [HF-APP-DESI-5] approved "Confirm booking" layout
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Confirm booking'),
            Expanded(
              child: AsyncView<HostSlots>(
                state: _state,
                onRetry: () => unawaited(_load()),
                isEmpty: (s) => false,
                builder: (context, s) => ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  children: [
                    BookTicket(
                      who: callPerson(widget.id, _name).copyWithAvatar(_avatar),
                      name: _name.isEmpty ? 'Influencer' : _name,
                      sub: [_callText(s), if (_topicLabel(s) != null) _topicLabel(s)!].join(' · '),
                      date: dayLabel(d),
                      time: slotLabel(widget.slot),
                    ),
                    const SizedBox(height: 14),
                    HisaabCard(
                      lines: [
                        ('Rate', '₹${s.ratePerMin}/min'),
                        if (_topicLabel(s) != null) ('About', _topicLabel(s)!),
                        ('Held now (${_holdMinutesOf(s)} min)', paiseText(s.holdPaise)),
                        ('Your wallet', _walletPaise != null ? paiseText(_walletPaise!) : (_walletLoading ? 'Checking…' : (_walletFailed ? "Couldn't load" : '—'))),
                      ],
                      strong: {'Held now (${_holdMinutesOf(s)} min)'},
                    ),
                    // [HF-BOOK-APPROVE] Manual approval: say plainly what happens if nobody accepts.
                    if (s.needsApproval) ...[
                      const SizedBox(height: 14),
                      BookNotice(
                        key: const ValueKey('approval-notice'),
                        text: "Needs $_approver's approval. If it isn't accepted within 24 hours, the full ${paiseText(s.holdPaise)} returns to your wallet.",
                      ),
                    ],
                    const SizedBox(height: 14),
                    // [HF-CALL-MODES-E2] The quote, in words: a 15-minute hold, then 5-minute charging for talk time only.
                    if (_lengthOn) ...[
                      BookNotice(
                        key: const ValueKey('hold-notice'),
                        icon: Icons.info_outline_rounded,
                        teal: true,
                        text: bookingHoldNotice(_holdMinutesOf(s)),
                      ),
                      const SizedBox(height: 14),
                    ],
                    BookNoteField(controller: _note, label: 'A note for ${_name.isEmpty ? 'the influencer' : firstName} (optional)'),
                    const SizedBox(height: 12),
                    Text(
                      _lengthOn
                          ? (s.needsApproval
                              ? 'Once accepted, at ${slotLabel(widget.slot)} India time we ring $firstName first, then your phone. You pay only for the minutes you talk. You can cancel any time while you wait, and free until 1 hour before the call.'
                              : 'At ${slotLabel(widget.slot)} India time we ring $firstName first, then your phone. You pay only for the minutes you talk. You can cancel free until 1 hour before. You get a WhatsApp reminder an hour before.')
                          : s.needsApproval
                          ? 'Once accepted, at ${slotLabel(widget.slot)} India time we ring $firstName first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You can cancel any time while you wait, and free until 1 hour before the call.'
                          : 'At ${slotLabel(widget.slot)} India time we ring $firstName first, then your phone. You pay only for the minutes you talk; the rest of the hold comes back. You can cancel free until 1 hour before. You get a WhatsApp reminder an hour before.',
                      style: t(15, color: C.muted, w: FontWeight.w700, h: 1.45),
                    ),
                    const SizedBox(height: 14),
                    const DesiMogra(),
                  ],
                ),
              ),
            ),
            if (_state is AsyncData<HostSlots>)
              BookBottomButton(
                label: _busy ? 'BOOKING…' : ((_state as AsyncData<HostSlots>).value.needsApproval ? 'SEND REQUEST' : 'CONFIRM BOOKING'),
                plum: true,
                icon: Icons.check_rounded,
                onTap: () => requireAccount(context, () => unawaited(_confirm((_state as AsyncData<HostSlots>).value)), reason: 'to book'),
              ),
          ],
        ),
      ),
    );
  }
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
    final first = name.isEmpty ? '' : name.split(' ').first;
    // [HF-APP-DESI-5] approved "Booked!" layout; an approval booking says "Request sent!"
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            BookedCard(
              title: approval ? 'Request sent!' : 'Booked!',
              line: approval ? (first.isEmpty ? 'Waiting for approval.' : 'Waiting for $first to accept.') : (first.isEmpty ? 'Your call is booked.' : "Your call is in $first's diary."),
              name: name,
              when: '${dayLabel(d)} · ${slotLabel(slot)}',
            ),
            const SizedBox(height: 14),
            approval
                ? BookedActions(
                    noticeKey: const ValueKey('approval-text'),
                    notice: approvalText.isNotEmpty ? approvalText : "Sent for approval. If it isn't accepted within 24 hours, your money returns to your wallet.",
                  )
                : const BookedActions(notice: 'We will WhatsApp you a reminder an hour before and ring your phone at that minute.'),
          ],
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
      // [HF-APP-CACHE-1] The saved list paints at once, then the server's answer replaces it. The "past" list follows the same
      // rule: its saved copy goes with the saved active list, its network read with the fresh one.
      var firstEmission = true;
      await for (final active in _repo.watchMine()) {
        var past = const <AppBooking>[];
        if (Services.instance.bookingApprovalEnabled || active.any((b) => b.statusText != null)) {
          // [HF-BOOK-APPROVE] cancelled / refunded ones stay visible, with the server's own sentence.
          try {
            past = firstEmission ? await _repo.watchMine(status: 'past').first : await _repo.mine(status: 'past');
          } catch (_) {}
        }
        firstEmission = false;
        if (!mounted) return;
        setState(() => _state = AsyncData([...active, ...past]));
        if (_highlightId != null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            final c = _highlightKey.currentContext;
            if (c != null) unawaited(Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300)));
          });
        }
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
    // [HF-APP-DESI-7] approved My bookings layout
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('My bookings'),
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
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                      children: [
                        const ListHero(eyebrow: 'My bookings', title: 'Aapke booked samay', sub: 'Cancel free until 1 hour before a call.', ghost: 'Samay', teal: true),
                        const SizedBox(height: 12),
                        if (current.isNotEmpty) const BookingAgeConfirmation(),
                        for (var i = 0; i < current.length; i++) _tile(current[i], now, i),
                        if (earlier.isNotEmpty) ...[
                          const EarlierDivider(),
                          for (var i = 0; i < earlier.length; i++) _tile(earlier[i], now, current.length + i),
                        ],
                        const SizedBox(height: 4),
                        const DesiMogra(),
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

  static BookingKind _kind(AppBooking b) => switch (b.status) {
        'pending_approval' => BookingKind.waiting,
        'confirmed' || 'starting' || 'active' => BookingKind.confirmed,
        'cancelled' => BookingKind.cancelled,
        'completed' => BookingKind.completed,
        'failed' => BookingKind.failed,
        _ => BookingKind.other,
      };

  Widget _tile(AppBooking b, DateTime now, int index) {
    final rich = b.statusText != null; // the approval feature is on: the extra lines below
    final deadline = b.approvalDeadline;
    final highlighted = _highlightId == b.id;
    final tile = BookingTicketCard(
      key: ValueKey('booking-${b.id}'),
      index: index,
      stub: stubOf(b.date),
      who: callPerson(b.hostSlug, b.hostName),
      name: b.hostName ?? 'Influencer',
      time: slotLabel(b.time),
      topic: b.topic?.label,
      topicKey: ValueKey('topic-${b.id}'),
      held: '${paiseText(b.holdPaise)} ${b.status == 'cancelled' ? 'refunded' : 'held'} · ${_minsText(b.minutes)}',
      kind: rich ? _kind(b) : BookingKind.confirmed,
      chip: rich ? KeyedSubtree(key: ValueKey('chip-${b.id}'), child: BookingStatusChip(_kind(b))) : null,
      extra: [
        if (rich && b.isPending && deadline != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('Auto-cancels in ${countdownLabel(deadline.difference(now))}', key: ValueKey('countdown-${b.id}'), style: t(14, color: C.deep, w: FontWeight.w700)),
          ),
        if (rich && !b.isPending && b.statusText != null && b.statusText!.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 4), child: Text(b.statusText!, style: t(14, color: C.deep, w: FontWeight.w700, h: 1.3))),
      ],
      onCancel: (rich && b.isPast) ? null : () => unawaited(_cancel(b)),
      cancelKey: ValueKey('cancel-${b.id}'),
      cancelEnabled: b.canCancel,
      highlighted: highlighted,
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

  /// [HF-APP-DESI-11] same card as the influencer home.
  @override
  Widget build(BuildContext context) {
    final label = slotLabel(b.time);
    return InfBookingCard(
      index: b.id.hashCode.abs() % 4,
      time: label,
      fan: b.fanHandle ?? 'A fan',
      line: '${showDay ? '${dayLabel(b.date)} · ' : ''}${_minsText(b.minutes)}'
          '${b.topic == null ? '' : ' · ${b.topic!.label}'}'
          '${showStarts && !b.isPast ? ' · ${startsInLabel(b.startAt, DateTime.now())}' : ''}'
          '${b.note.isEmpty ? '' : ' · ${b.note}'}',
      extra: extra,
      icon: b.isPending ? Icons.hourglass_top_rounded : (b.isCancelled || b.status == 'failed') ? Icons.event_busy_rounded : b.isPast ? Icons.task_alt_rounded : Icons.call_rounded,
      iconInk: b.isPending ? C.saffron : (b.isCancelled || b.status == 'failed') ? C.ruby : C.peacock,
      onTap: onTap,
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
          Text('${dayLabel(b.date)} · ${CallFlags.bookingLengths ? '${lengthLabel(b.minutes)} call' : '${b.minutes} minute call'}', style: t(15, w: FontWeight.w700)),
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
      // [HF-APP-CACHE-1] Saved list first, then the server's (see the fan list above). Settings are not cached.
      var firstEmission = true;
      await for (final l in _repo.watchHostBookings()) {
        var past = _past;
        BookingSettings? settings = _settings;
        if (_approvalUi(l)) {
          try {
            past = firstEmission ? await _repo.watchHostBookings(status: 'past').first : await _repo.hostBookings(status: 'past');
          } catch (_) {}
          if (!firstEmission || settings == null) {
            try {
              settings = await _repo.bookingSettings();
            } catch (_) {}
          }
        }
        firstEmission = false;
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
    // [HF-APP-DESI-12] approved "Booked with me" layout
    return Scaffold(
      backgroundColor: C.ivory,
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
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                children: [
                  const BookedWithMeHero(), // [HF-BOOK-APPROVE-QA-1] not 'My bookings' (that is the fan list)
                  const SizedBox(height: 12),
                  if (approval) ..._approvalSections(all) else ..._calendarBlock(all),
                  if (!approval) ...[
                    const SizedBox(height: 18),
                    const InfSectionHead(title: 'All upcoming'),
                    if (all.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Nothing booked yet.', style: t(15, color: C.muted, w: FontWeight.w700))),
                    for (final b in all) _tileOf(b, showDay: true, onTap: () => unawaited(_open(b))),
                  ],
                  const SizedBox(height: 12),
                  const DesiMogra(),
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
      CalendarCard(
        child: BookMonth(
          month: _month,
          selected: _day,
          allowPast: true,
          fill: const {},
          dots: {for (final b in all) dayKey(b.date)},
          onPick: (d) => setState(() => _day = d),
          onMonth: (m) => setState(() => _month = m),
        ),
      ),
      const SizedBox(height: 14),
      Text(dayLabel(_day), style: t(18, color: C.maroon, w: FontWeight.w900)),
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
      const SizedBox(height: 18),
      _sectionTitle('Waiting for you', waiting.length),
      if (waiting.isEmpty) _hint('Nothing is waiting for you.'),
      for (final b in waiting) _waitingCard(b, now),
      const SizedBox(height: 18),
      _sectionTitle('Upcoming', upcoming.length),
      if (upcoming.isEmpty) _hint('No confirmed calls yet.'),
      for (final b in upcoming) _upcomingTile(b, now),
      const SizedBox(height: 18),
      _sectionTitle('Calendar', 0),
      const SizedBox(height: 8),
      ..._calendarBlock([...waiting, ...upcoming]),
      const SizedBox(height: 18),
      _sectionTitle('Past', _past.length),
      if (_past.isEmpty) _hint('Finished and cancelled bookings show here.'),
      for (final b in _past.take(30)) AppBookingTile(b, showDay: true, extra: b.statusText, onTap: () => unawaited(_open(b))),
    ];
  }

  Widget _sectionTitle(String title, int count) => InfSectionHead(title: count > 0 ? '$title ($count)' : title);

  Widget _hint(String text) => Padding(padding: const EdgeInsets.only(top: 8), child: Text(text, style: t(15, color: C.muted, w: FontWeight.w700)));

  Widget _settingsCard() {
    final st = _settings;
    final manual = st?.isManual ?? true;
    return InfSettingsCard(
      key: const ValueKey('booking-settings'),
      rows: [
        InfSwitchRow(
          title: 'I approve each booking',
          titleKey: const ValueKey('approval-title'), // [HF-BOOK-APPROVE-QA-1] the switch says on/off; the title stays put
          line: manual
              ? 'On: each booking waits for you to accept. If you do not accept within 24 hours it is cancelled and the caller is refunded.'
              : 'Off (auto-accept): bookings are confirmed straight away. You can still cancel one later and the caller is refunded.',
          toggle: DesiSwitch(
            key: const ValueKey('approval-switch'),
            value: manual,
            onChanged: st == null || _savingSettings ? null : (v) => unawaited(_saveSettings(approval: v ? 'manual' : 'auto')),
          ),
        ),
        InfSwitchRow(
          title: 'Open-time alerts',
          line: 'A nudge when your open hours begin, so you are ready for calls.',
          toggle: DesiSwitch(
            key: const ValueKey('alerts-switch'),
            value: st?.openAlerts ?? true,
            onChanged: st == null || _savingSettings ? null : (v) => unawaited(_saveSettings(openAlerts: v)),
          ),
        ),
      ],
      footer: st == null
          ? Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Could not load these settings. Pull down to try again.', style: t(14, color: C.ruby, w: FontWeight.w700)),
            )
          : null,
    );
  }

  Widget _waitingCard(AppBooking b, DateTime now) {
    final busy = _busyId == b.id;
    final deadline = b.approvalDeadline;
    final highlighted = _highlightId == b.id;
    final card = WaitingCard(
      key: ValueKey('pending-${b.id}'),
      fan: b.fanHandle ?? 'A fan',
      when: '${dayLabel(b.date)} · ${slotLabel(b.time)} · ${_minsText(b.minutes)}',
      topic: b.topic?.label,
      note: b.note,
      held: '${paiseText(b.holdPaise)} held for this call',
      countdown: deadline == null ? null : 'Auto-cancels in ${countdownLabel(deadline.difference(now))}',
      countdownKey: ValueKey('countdown-${b.id}'),
      highlighted: highlighted,
      accept: CallPill(
        key: ValueKey('accept-${b.id}'),
        label: busy ? 'Please wait…' : 'Accept',
        kind: CallPillKind.plum,
        icon: Icons.check_rounded,
        height: 52,
        onTap: b.canAccept && _busyId == null ? () => unawaited(_accept(b)) : null,
      ),
      decline: OutlinePill(key: ValueKey('decline-${b.id}'), label: 'Decline', onTap: b.canDecline && _busyId == null ? () => unawaited(_decline(b)) : null),
      warning: !b.canAccept && !b.canDecline ? 'This booking is about to be cancelled.' : null,
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
      await for (final l in _repo.watchHostBookings(day: isoDay(DateTime.now()))) {
        if (mounted) setState(() => _state = AsyncData(l)); // [HF-APP-CACHE-1]
      }
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
      await for (final s in _repo.watchSlots(widget.slug)) {
        if (mounted) setState(() => _state = AsyncData(s)); // [HF-APP-CACHE-1]
      }
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
          // [HF-APP-DESI-4] approved teal "Free times" card
          return FreeTimesCard(
            child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: 68,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: days.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (_, i) {
                    final d = parseDay(days[i])!;
                    return CalDayChip(key: ValueKey('cal-day-${days[i]}'), weekday: weekdayShort[d.weekday - 1], day: d.day, on: i == idx, onTap: () => setState(() => _pick = i));
                  },
                ),
              ),
              const SizedBox(height: 14),
              Text(calDayTitle(parseDay(day)!), style: t(15, w: FontWeight.w800)),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final hhmm in s.slotsOn(day))
                    CalSlotChip(
                      key: ValueKey('cal-slot-$hhmm'),
                      label: slotLabel(hhmm),
                      onTap: () => context.push('/book/${widget.slug}?day=$day&slot=${Uri.encodeComponent(hhmm)}'),
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
          ),
          );
        },
      ),
    );
  }
}
