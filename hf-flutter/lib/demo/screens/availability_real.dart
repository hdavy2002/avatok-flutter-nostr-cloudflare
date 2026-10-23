import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api_exception.dart';
import '../../data/call_flags.dart';
import '../../data/models/booking.dart';
import '../../data/repos/bookings_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../ui/async_view.dart';
import '../data.dart';
import '../theme.dart';
import '../widgets.dart';
import '../desi.dart';
import '../inf_kit.dart';
import '../money_kit.dart';
import 'call_real.dart' show paiseText;

/// [HF-BOOK-APPROVE-6] The influencer's availability calendar (moved out of bookings_real.dart).
///
/// Two months from today (up to the server's `horizonDays`; dates past it are greyed). Tap a day to select it,
/// or press and hold then drag across days to select a range. The bottom panel sets the same time slots on every
/// selected day; SAVE sends all changed days in one `PUT /api/hf/hosts/me/availability`. Booked times are locked.
class RealAvailabilityScreen extends StatefulWidget {
  const RealAvailabilityScreen({super.key, this.repo});

  final BookingsRepo? repo;

  @override
  State<RealAvailabilityScreen> createState() => _RealAvailabilityScreenState();
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

bool _sameSet(Set<String> a, Set<String> b) => a.length == b.length && a.containsAll(b);

class _RealAvailabilityScreenState extends State<RealAvailabilityScreen> {
  static const double _cellH = 52;

  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;

  AsyncState<HostAvailability> _state = const AsyncLoading();

  /// Selected days (`YYYY-MM-DD`).
  final Set<String> _sel = {};

  /// Unsaved changes: day -> the slots that day should have. A day equal to the server's is dropped from here.
  final Map<String, Set<String>> _edits = {};

  /// Long-press drag: the day where the finger went down and the selection from before the drag.
  String? _anchor;
  Set<String> _base = {};

  final Map<int, GlobalKey> _gridKeys = {};

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
    setState(() {
      _state = const AsyncLoading();
      _sel.clear();
      _edits.clear();
    });
    try {
      await for (final a in _repo.watchAvailability()) {
        if (mounted) setState(() => _state = AsyncData(a)); // [HF-APP-CACHE-1] saved calendar first, then the server's
      }
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  HostAvailability? get _avail {
    final s = _state;
    return s is AsyncData<HostAvailability> ? s.value : null;
  }

  bool _inRange(HostAvailability a, String k) => k.compareTo(a.today) >= 0 && k.compareTo(a.lastDay) <= 0;

  Set<String> _slotsOf(HostAvailability a, String k) => _edits[k] ?? a.slotsOn(k);

  Set<String> _bookedOn(HostAvailability a, String k) => a.booked[k] ?? const <String>{};

  void _setDay(HostAvailability a, String k, Set<String> slots) {
    if (_sameSet(slots, a.slotsOn(k))) {
      _edits.remove(k);
    } else {
      _edits[k] = slots;
    }
  }

  // ------------------------------------------------------------------------------------------ selecting days

  List<DateTime> _monthsOf(HostAvailability a) {
    final start = parseDay(a.today) ?? dayOnly(DateTime.now());
    final end = parseDay(a.lastDay) ?? start;
    final out = <DateTime>[];
    var m = DateTime(start.year, start.month, 1);
    final last = DateTime(end.year, end.month, 1);
    while (!m.isAfter(last) && out.length < 6) {
      out.add(m);
      m = DateTime(m.year, m.month + 1, 1);
    }
    return out;
  }

  GlobalKey _keyOf(DateTime month) => _gridKeys.putIfAbsent(month.year * 12 + month.month, () => GlobalKey());

  /// The calendar day under a finger at [global], or null when it is between cells or outside the grids.
  DateTime? _hit(HostAvailability a, Offset global) {
    for (final m in _monthsOf(a)) {
      final box = _keyOf(m).currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize) continue;
      final local = box.globalToLocal(global);
      if (local.dx < 0 || local.dy < 0 || local.dx >= box.size.width || local.dy >= box.size.height) continue;
      final col = (local.dx / (box.size.width / 7)).floor().clamp(0, 6);
      final row = (local.dy / _cellH).floor();
      final lead = m.weekday - 1;
      final dayNo = row * 7 + col - lead + 1;
      if (dayNo < 1 || dayNo > DateTime(m.year, m.month + 1, 0).day) return null;
      return DateTime(m.year, m.month, dayNo);
    }
    return null;
  }

  void _tapDay(String k) {
    final a = _avail;
    if (a == null) return;
    if (!_inRange(a, k)) {
      toast(context, 'You can open dates from today up to ${a.horizonDays} days ahead.');
      return;
    }
    setState(() {
      if (!_sel.remove(k)) _sel.add(k);
    });
  }

  void _tapAt(Offset global) {
    final a = _avail;
    if (a == null) return;
    final d = _hit(a, global);
    if (d != null) _tapDay(isoDay(d));
  }

  void _dragStart(Offset global) {
    final a = _avail;
    if (a == null) return;
    final d = _hit(a, global);
    if (d == null) return;
    final k = isoDay(d);
    if (!_inRange(a, k)) return;
    setState(() {
      _anchor = k;
      _base = {..._sel};
      _sel.add(k);
    });
  }

  void _dragMove(Offset global) {
    final a = _avail;
    final anchor = _anchor;
    if (a == null || anchor == null) return;
    final d = _hit(a, global);
    if (d == null) return;
    final from = parseDay(anchor)!;
    var lo = from;
    var hi = d;
    if (hi.isBefore(lo)) {
      lo = d;
      hi = from;
    }
    final next = <String>{..._base};
    for (var x = lo, n = 0; !x.isAfter(hi) && n < 400; x = DateTime(x.year, x.month, x.day + 1), n++) {
      final k = isoDay(x);
      if (_inRange(a, k)) next.add(k);
    }
    setState(() {
      _sel
        ..clear()
        ..addAll(next);
    });
  }

  void _dragEnd() {
    if (_anchor != null) setState(() => _anchor = null);
  }

  // ------------------------------------------------------------------------------------------ editing slots

  /// Tap on a time chip: if every selected day already has it, take it off them all, otherwise put it on them all.
  void _applyChip(HostAvailability a, String slot) {
    final days = _sel.toList()..sort();
    if (days.isEmpty) return;
    final allHave = days.every((k) => _slotsOf(a, k).contains(slot));
    var skipped = 0;
    setState(() {
      for (final k in days) {
        final cur = {..._slotsOf(a, k)};
        if (allHave) {
          if (_bookedOn(a, k).contains(slot)) {
            skipped++;
            continue;
          }
          cur.remove(slot);
        } else {
          cur.add(slot);
        }
        _setDay(a, k, cur);
      }
    });
    if (skipped > 0) toast(context, 'A booked time stays open until you cancel that booking.');
  }

  /// Closes every selected day (booked times stay).
  void _closeSelected(HostAvailability a) {
    var kept = 0;
    setState(() {
      for (final k in _sel) {
        final booked = _bookedOn(a, k);
        final cur = _slotsOf(a, k).where(booked.contains).toSet();
        if (booked.isNotEmpty) kept++;
        _setDay(a, k, cur);
      }
    });
    if (kept > 0) toast(context, 'Booked times stay open until you cancel those bookings.');
  }

  Future<void> _saveAll() async {
    final a = _avail;
    if (a == null || _saving || _edits.isEmpty) return;
    final changes = <String, DayPlan>{
      for (final e in _edits.entries) e.key: DayPlan(open: e.value.isNotEmpty, slots: {...e.value}),
    };
    final slotCount = changes.values.fold<int>(0, (n, p) => n + p.slots.length);
    setState(() => _saving = true);
    try {
      final saved = await _repo.saveAvailability(changes, expectedVersion: a.version);
      Telemetry.event('hf_availability_saved', {'days': changes.length, 'slots': slotCount});
      if (!mounted) return;
      setState(() {
        _state = AsyncData(saved);
        _edits.clear();
        _sel.clear();
      });
      toast(context, changes.length == 1 ? 'Saved. 1 day updated.' : 'Saved. ${changes.length} days updated.');
    } catch (e) {
      if (!mounted) return;
      if (e is ApiException && e.status == 409 && e.code == 'schedule_changed') {
        // Changed on another phone: load the latest and let her redo her edits on top of it.
        toast(context, '${_why(e)} Your changes were not saved.');
        unawaited(_load());
      } else {
        toast(context, _why(e));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ------------------------------------------------------------------------------------------ rate (unchanged)

  void _bumpRate(int delta) {
    final a = _avail;
    if (a == null || !a.rate.editable) return;
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
        // Reload only the rate; keep her unsaved calendar edits.
        try {
          final fresh = await _repo.availability();
          if (mounted) setState(() => _state = AsyncData(fresh));
        } catch (_) {}
      }
    } catch (e) {
      if (mounted) toast(context, _why(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ------------------------------------------------------------------------------------------ build

  @override
  Widget build(BuildContext context) {
    // [HF-APP-DESI-12] approved "Availability" layout
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: AsyncView<HostAvailability>(
          state: _state,
          onRetry: () => unawaited(_load()),
          isEmpty: (a) => false,
          builder: (context, a) => Column(
            children: [
              Expanded(child: _content(a)),
              _panel(a),
            ],
          ),
        ),
      ),
    );
  }

  Widget _content(HostAvailability a) {
    final rate = _rate ?? a.rate.ratePerMin;
    final gets = _rate == null ? a.rate.hostGetsPerMinPaise : (_rateGetsPaise ?? a.rate.hostGetsPerMinPaise);
    // Booked / pending times count as open: a day with only those still has fans on it.
    final anyOpen = a.days.values.any((d) => d.open || d.slots.isNotEmpty) ||
        a.booked.values.any((s) => s.isNotEmpty) ||
        _edits.values.any((s) => s.isNotEmpty);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        const DesiHero(eyebrow: 'Availability', title: 'When can fans book?', sub: 'Open days and times, India time.', ghost: 'Kab', tone: DesiTone.lav, minHeight: 120),
        const SizedBox(height: 8),
        Text(
          'Tap a day to pick it. Press and hold a day, then slide across to pick many days. Then choose the times (India time).',
          style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4),
        ),
        const SizedBox(height: 4),
        Text(
          'A dot means that day has times open. Greyed days are more than ${a.horizonDays} days away.',
          style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4),
        ),
        if (!anyOpen) ...[
          const SizedBox(height: 8),
          Text('No days are open yet, so fans cannot book you. Pick some days below.', style: t(14, color: C.rani, w: FontWeight.w800, h: 1.4)),
        ],
        const SizedBox(height: 14),
        _calendar(a),
        const SizedBox(height: 14),
        RateCard(
          rate: '₹$rate/min',
          line: a.rate.editable ? 'You get about ${paiseText(gets)} a minute' : (a.rate.fixedMessage ?? 'Your rate is set for everyone, so you can not change it.'),
          onLower: a.rate.editable ? () => _bumpRate(-1) : null,
          onRaise: a.rate.editable ? () => _bumpRate(1) : null,
          child: _rate != null && _rate != a.rate.ratePerMin ? MoneyPill(label: 'SAVE RATE', gold: true, height: 52, onTap: _saving ? null : _saveRate) : null,
        ),
        const SizedBox(height: 14),
        Text('Going online for instant calls is the round button in the middle of your bar.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
      ],
    );
  }

  Widget _calendar(HostAvailability a) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 10, 8, 10),
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: const Color(0xFFF3DFB3), width: 2)),
      child: GestureDetector(
        key: const ValueKey('avail-calendar'),
        behavior: HitTestBehavior.opaque,
        onTapUp: (d) => _tapAt(d.globalPosition),
        onLongPressStart: (d) => _dragStart(d.globalPosition),
        onLongPressMoveUpdate: (d) => _dragMove(d.globalPosition),
        onLongPressEnd: (_) => _dragEnd(),
        onLongPressCancel: _dragEnd,
        child: Column(
          children: [
            Row(
              children: [
                for (final w in weekdayShort) Expanded(child: Center(child: Text(w.substring(0, 1), style: t(14, color: C.amber, w: FontWeight.w800)))),
              ],
            ),
            for (final m in _monthsOf(a)) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 10, 4, 4),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('${monthLong[m.month - 1]} ${m.year}', style: t(17, color: C.maroon, w: FontWeight.w900)),
                ),
              ),
              _monthGrid(a, m),
            ],
          ],
        ),
      ),
    );
  }

  Widget _monthGrid(HostAvailability a, DateTime m) {
    final lead = m.weekday - 1; // Monday first
    final count = DateTime(m.year, m.month + 1, 0).day;
    final rows = ((lead + count) / 7).ceil();
    return Column(
      key: _keyOf(m),
      children: [
        for (var r = 0; r < rows; r++)
          Row(
            children: [
              for (var c = 0; c < 7; c++)
                Expanded(
                  child: SizedBox(
                    height: _cellH,
                    child: () {
                      final dayNo = r * 7 + c - lead + 1;
                      if (dayNo < 1 || dayNo > count) return const SizedBox.shrink();
                      return _cell(a, DateTime(m.year, m.month, dayNo));
                    }(),
                  ),
                ),
            ],
          ),
      ],
    );
  }

  Widget _cell(HostAvailability a, DateTime d) {
    final k = isoDay(d);
    final inRange = _inRange(a, k);
    final selected = _sel.contains(k);
    final slots = _slotsOf(a, k);
    final has = slots.isNotEmpty;
    final edited = _edits.containsKey(k);
    final isToday = k == a.today;
    final Color bg = selected ? C.maroon : (has ? C.goldtint : C.clear);
    final Color fg = selected ? C.white : (inRange ? C.deep : C.muted.withValues(alpha: 0.4));
    final label = '${dayLabel(d)}. ${has ? '${slots.length} ${slots.length == 1 ? 'time' : 'times'} open' : 'Closed'}'
        '${edited ? '. Not saved yet' : ''}${inRange ? '' : '. Too far ahead to open'}';
    return Semantics(
      key: ValueKey('day-$k'),
      button: inRange,
      enabled: inRange,
      selected: selected,
      label: label,
      excludeSemantics: true,
      onTap: inRange ? () => _tapDay(k) : null,
      child: Padding(
        padding: const EdgeInsets.all(2),
        child: Container(
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(12),
            border: isToday && !selected
                ? Border.all(color: C.peacock, width: 2)
                : Border.all(color: selected ? C.maroon : (has ? const Color(0xFFF3DFB3) : C.clear), width: 2),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: FittedBox(fit: BoxFit.scaleDown, child: Text('${d.day}', style: t(15, color: fg, w: FontWeight.w800))),
              ),
              if (has)
                Positioned(
                  bottom: 4,
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: selected ? C.lemon : (edited ? C.saffron : C.rani)),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------------------------------ bottom panel

  Widget _panel(HostAvailability a) {
    final days = _sel.toList()..sort();
    if (days.isEmpty && _edits.isEmpty) return const SizedBox.shrink();
    final maxH = MediaQuery.sizeOf(context).height * 0.5;
    return Container(
      decoration: const BoxDecoration(
        color: C.ivory,
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        border: Border(top: BorderSide(color: Color(0xFFF3DFB3), width: 1.5)),
        boxShadow: [BoxShadow(color: Color(0x994A1747), offset: Offset(0, -16), blurRadius: 30, spreadRadius: -18)],
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (days.isNotEmpty) ..._slotPicker(a, days),
              // [HF-BOOK-APPROVE-QA-1] The save row is shown as soon as days are picked (disabled until something changes), so the
              // panel does not grow under her finger while she taps times.
              if (_edits.isNotEmpty || days.isNotEmpty) ...[
                if (days.isNotEmpty) const SizedBox(height: 12),
                Text(
                  _edits.isEmpty
                      ? 'Tap the times you want, then save.'
                      : (_edits.length == 1 ? '1 day changed. Not saved yet.' : '${_edits.length} days changed. Not saved yet.'),
                  style: t(14, color: _edits.isEmpty ? C.muted : C.maroon, w: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                Opacity(
                  opacity: _saving || _edits.isEmpty ? .5 : 1,
                  child: MoneyPill(
                    label: _saving ? 'SAVING…' : (_edits.isEmpty ? 'SAVE' : (_edits.length == 1 ? 'SAVE 1 DAY' : 'SAVE ${_edits.length} DAYS')),
                    rani: true,
                    height: 54,
                    onTap: _saving || _edits.isEmpty ? null : () => unawaited(_saveAll()),
                  ),
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    key: const ValueKey('avail-discard'),
                    style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                    onPressed: _saving || _edits.isEmpty ? null : () => setState(_edits.clear),
                    child: Text('Discard changes', style: t(15, color: C.muted)),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _slotPicker(HostAvailability a, List<String> days) {
    final single = days.length == 1;
    final mixed = !single && days.map((k) => _slotsOf(a, k)).toList().any((s) => !_sameSet(s, _slotsOf(a, days.first)));
    return [
      Row(
        children: [
          Expanded(
            child: Text(
              single ? 'Time slots for ${dayLabel(parseDay(days.first)!)}' : 'Time slots for ${days.length} days',
              style: t(18, color: C.maroon, w: FontWeight.w900),
            ),
          ),
        ],
      ),
      const SizedBox(height: 4),
      if (mixed)
        Text('These days have different times. A time you tap goes on all of them.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4))
      else if (!single)
        Text('A time you tap goes on all ${days.length} days.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
      if (CallFlags.bookingLengths && a.chipMinutes >= 60) ...[
        const SizedBox(height: 4),
        Text(
          'Each tick opens that whole hour, so people can book 15 minutes up to 5 hours inside it. Tick two hours in a row for longer calls.',
          key: const ValueKey('avail-chip-hint'),
          style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4),
        ),
      ],
      const SizedBox(height: 8),
      if (a.slotChoices.isEmpty)
        Text('No times can be set right now. Please try again later.', style: t(14, color: C.muted, w: FontWeight.w700))
      else
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final s in a.slotChoices) _chip(a, days, s),
          ],
        ),
      const SizedBox(height: 6),
      if (days.any((k) => _bookedOn(a, k).isNotEmpty))
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text('A booked time (lock) can only be closed after you cancel that booking.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
        ),
      Wrap(
        spacing: 8,
        children: [
          OutlinedButton.icon(
            key: const ValueKey('avail-close-days'),
            onPressed: _saving ? null : () => _closeSelected(a),
            icon: const Icon(Icons.event_busy_rounded, color: C.maroon),
            label: Text(single ? 'Close this day' : 'Close these days', style: t(15, color: C.maroon, w: FontWeight.w800)),
            style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48), side: const BorderSide(color: C.maroon, width: 2), shape: const StadiumBorder()),
          ),
          TextButton(
            key: const ValueKey('avail-clear-selection'),
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => setState(_sel.clear),
            child: Text('Clear selection', style: t(15, color: C.muted)),
          ),
        ],
      ),
    ];
  }

  Widget _chip(HostAvailability a, List<String> days, String s) {
    final have = days.where((k) => _slotsOf(a, k).contains(s)).length;
    final all = have == days.length;
    final partial = have > 0 && !all;
    final bookedDays = days.where((k) => _bookedOn(a, k).contains(s)).length;
    final lockedAll = bookedDays == days.length;
    final text = '${slotLabel(s)}${lockedAll ? ' · booked' : ''}';
    return availabilityChip(
      key: ValueKey('chip-$s'),
      label: partial ? '$text · some' : text,
      selected: all,
      partial: partial,
      locked: bookedDays > 0,
      onSelected: _saving || lockedAll ? null : (_) => _applyChip(a, s),
    );
  }
}
