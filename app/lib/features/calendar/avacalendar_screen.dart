// Native creator calendar. The view adapts to the available window: phones
// lead with an agenda, while wide windows keep the diary and inspector visible.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/availability_api.dart';
import '../../core/availability_time.dart';
import '../../core/listings_api.dart';
import '../../core/platform_api.dart';
import '../../core/time_sync.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'booking_card.dart';
import 'calendar_data.dart';

TextStyle _title(double size) => ADText.threadName()
    .copyWith(fontSize: size, height: 1.1, letterSpacing: -0.2);
TextStyle _sub(double size, {Color c = AD.textSecondary}) =>
    ADText.preview(c: c).copyWith(fontSize: size, height: 1.42);
TextStyle _value(double size, {FontWeight w = FontWeight.w600}) =>
    ADText.rowName().copyWith(fontSize: size, fontWeight: w);
TextStyle get _link => ADText.rowName(c: Msg.accent).copyWith(fontSize: 13);

Widget _calendarMessageCard(String message, IconData icon, Color color) =>
    ZineCard(
      radius: Msg.rMd,
      boxShadow: Msg.none,
      padding: const EdgeInsets.all(Msg.s3),
      borderColor: color,
      child: Row(children: [
        PhosphorIcon(icon, size: 20, color: color),
        const SizedBox(width: Msg.s2),
        Expanded(child: Text(message, style: _sub(13, c: color))),
      ]),
    );

enum _CalendarView { month, week, agenda }

class AvaCalendarScreen extends StatefulWidget {
  const AvaCalendarScreen({super.key});

  @override
  State<AvaCalendarScreen> createState() => _AvaCalendarScreenState();
}

class _AvaCalendarScreenState extends State<AvaCalendarScreen> {
  DateTime _month = DateTime(DateTime.now().year, DateTime.now().month);
  DateTime _selected = DateTime.now();
  _CalendarView _view = _CalendarView.month;
  List<CalBlock> _blocks = const [];
  List<ListingCard> _listings = const [];
  String? _selectedListingId;
  AvailabilitySchedule? _schedule;
  ListingAvailability? _availability;
  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  bool _stale = false;

  @override
  void initState() {
    super.initState();
    TimeSync.init();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _loadListings();
    await _loadData();
  }

  Future<void> _loadListings() async {
    try {
      final listings = await ListingsApi.mine();
      if (!mounted) return;
      setState(() => _listings = listings);
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    }
  }

  Future<void> _loadData({bool showBusy = true}) async {
    final listingId = _selectedListingId;
    final range = _monthRange;
    final from = _dateKey(range.$1);
    final to = _dateKey(range.$2);
    if (showBusy && mounted)
      setState(() {
        _loading = true;
        _error = null;
      });

    final cachedBlocks = await CalendarStore.cached();
    if (mounted && cachedBlocks.isNotEmpty) {
      setState(() {
        _blocks = cachedBlocks;
        _loading = false;
      });
    }
    AvailabilityCache<AvailabilitySchedule>? cachedSchedule;
    try {
      cachedSchedule =
          await AvailabilityApi.cachedSchedule(listingId: listingId);
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _refreshing = false;
          _error = _friendlyError(e);
        });
      }
      return;
    }
    AvailabilityCache<ListingAvailability>? cachedAvailability;
    if (listingId != null) {
      final cacheTimezone =
          cachedSchedule?.value.timezone ?? _schedule?.timezone ?? 'UTC';
      try {
        cachedAvailability = await AvailabilityApi.cachedListingAvailability(
          listingId: listingId,
          from: from,
          to: to,
          timezone: cacheTimezone,
        );
      } catch (e) {
        if (mounted) {
          setState(() {
            _loading = false;
            _refreshing = false;
            _error = _friendlyError(e);
          });
        }
        return;
      }
    }
    if (mounted && (cachedSchedule != null || cachedAvailability != null)) {
      setState(() {
        if (cachedSchedule != null) _schedule = cachedSchedule.value;
        if (cachedAvailability != null)
          _availability = cachedAvailability!.value;
        _stale = (cachedSchedule?.isStale() ?? false) ||
            (cachedAvailability?.isStale(maxAge: const Duration(minutes: 30)) ??
                false);
        _loading = false;
      });
    }

    final errors = <String>[];
    try {
      final blocks = await CalendarStore.refresh(
        from: range.$1.subtract(const Duration(days: 7)).millisecondsSinceEpoch,
        to: range.$2.add(const Duration(days: 7)).millisecondsSinceEpoch,
      );
      if (mounted) setState(() => _blocks = blocks);
    } catch (e) {
      errors.add(_friendlyError(e));
    }
    try {
      final schedule =
          await AvailabilityApi.fetchSchedule(listingId: listingId);
      if (mounted)
        setState(() {
          _schedule = schedule;
          if (listingId == null) _stale = false;
        });
      if (listingId != null) {
        try {
          final availability = await AvailabilityApi.fetchListingAvailability(
            listingId: listingId,
            from: from,
            to: to,
            timezone: schedule.timezone,
          );
          if (mounted)
            setState(() {
              _availability = availability;
              _stale = false;
            });
        } catch (e) {
          errors.add(_friendlyError(e));
        }
      }
    } catch (e) {
      errors.add(_friendlyError(e));
    }
    if (mounted) {
      setState(() {
        _loading = false;
        _refreshing = false;
        if (errors.isNotEmpty) _error = errors.first;
      });
    }
  }

  String _friendlyError(Object error) => error is AvailabilityApiException
      ? error.message
      : 'Calendar data could not be refreshed. Your last saved view is still shown.';

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    await _loadData(showBusy: false);
  }

  (DateTime, DateTime) get _monthRange => (
        DateTime(_month.year, _month.month, 1),
        DateTime(_month.year, _month.month + 1, 1),
      );

  String _dateKey(DateTime date) =>
      '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

  List<CalBlock> _onDay(DateTime day) {
    final start = DateTime(day.year, day.month, day.day).millisecondsSinceEpoch;
    final end = start + const Duration(days: 1).inMilliseconds;
    return (_blocks.where((b) => b.startsAt < end && b.endsAt > start).toList()
      ..sort((a, b) => a.startsAt.compareTo(b.startsAt)));
  }

  List<AvailabilitySlot> _slotsOnDay(DateTime day) {
    final key = _dateKey(day);
    final timezone = _schedule?.timezone ?? _availability?.timezone ?? 'UTC';
    return (_availability?.slots ?? const <AvailabilitySlot>[])
        .where((slot) =>
            _dateKey(AvailabilityTime.inTimezone(slot.startAt, timezone)) ==
            key)
        .toList()
      ..sort((a, b) => a.startAt.compareTo(b.startAt));
  }

  AvailabilityException? _exceptionOnDay(DateTime day) {
    final key = _dateKey(day);
    for (final item
        in _schedule?.exceptions ?? const <AvailabilityException>[]) {
      if (item.date == key) return item;
    }
    return null;
  }

  int? _availableCount(DateTime day) {
    final key = _dateKey(day);
    for (final row in _availability?.days ?? const <AvailabilityDay>[]) {
      if (row.date == key) return row.availableCount;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'Calendar & availability',
        markWord: 'availability',
        tag: 'One creator, every commitment',
        actions: [
          ZineBackButton(
              icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
              onTap: _refresh),
          const SizedBox(width: Msg.s2),
          ZineBackButton(
              icon: PhosphorIcons.gearSix(PhosphorIconsStyle.regular),
              onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) => const CalendarSettingsScreen()))),
        ],
      ),
      body: RefreshIndicator(
        color: Msg.accent,
        backgroundColor: AD.card,
        onRefresh: _refresh,
        child: LayoutBuilder(builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          final diary = _calendarPanel();
          final inspector = _agendaPanel();
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(Msg.s4),
            children: [
              _topControls(wide),
              if (_error != null) ...[
                const SizedBox(height: Msg.s3),
                _messageCard(
                    _error!,
                    PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
                    AD.danger),
              ],
              if (_stale) ...[
                const SizedBox(height: Msg.s3),
                _messageCard(
                    'Showing a saved snapshot. Pull to refresh for current availability.',
                    PhosphorIcons.clockCounterClockwise(
                        PhosphorIconsStyle.regular),
                    AD.textSecondary),
              ],
              const SizedBox(height: Msg.s3),
              if (wide)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(flex: 6, child: diary),
                  const SizedBox(width: Msg.s4),
                  Expanded(flex: 4, child: inspector),
                ])
              else ...[diary, const SizedBox(height: Msg.s4), inspector],
              const SizedBox(height: Msg.s6),
            ],
          );
        }),
      ),
    );
  }

  Widget _topControls(bool wide) {
    final items = <DropdownMenuItem<String>>[
      const DropdownMenuItem(value: '', child: Text('All listings')),
      ..._listings.map((listing) =>
          DropdownMenuItem(value: listing.id, child: Text(listing.title))),
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (_listings.isNotEmpty)
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: wide ? 420 : double.infinity),
          child: ZineDropdown<String>(
            label: 'Showing availability for',
            value: _selectedListingId ?? '',
            items: items,
            onChanged: (value) async {
              setState(() {
                _selectedListingId =
                    value == null || value.isEmpty ? null : value;
                _schedule = null;
                _availability = null;
              });
              await _loadData();
            },
          ),
        )
      else
        Text('Showing your creator schedule', style: _sub(14)),
      const SizedBox(height: Msg.s3),
      Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
        ZineChip(
            label: 'Month',
            active: _view == _CalendarView.month,
            onTap: () => setState(() => _view = _CalendarView.month)),
        ZineChip(
            label: 'Week',
            active: _view == _CalendarView.week,
            onTap: () => setState(() => _view = _CalendarView.week)),
        ZineChip(
            label: 'Agenda',
            active: _view == _CalendarView.agenda,
            onTap: () => setState(() => _view = _CalendarView.agenda)),
        ZineButton(
            label: 'Block time',
            variant: ZineButtonVariant.ghost,
            fontSize: 13,
            icon: PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
            onPressed: () => _editException(_selected)),
      ]),
    ]);
  }

  Widget _calendarPanel() => ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.all(Msg.s4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _monthHeader(),
          const SizedBox(height: Msg.s3),
          if (_view == _CalendarView.month) _monthGrid(),
          if (_view == _CalendarView.week) _weekView(),
          if (_view == _CalendarView.agenda) _agendaPanel(compact: true),
          const SizedBox(height: Msg.s3),
          _legend(),
        ]),
      );

  Widget _monthHeader() {
    final name = const [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ][_month.month - 1];
    return Row(children: [
      ZineBackButton(
          icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.regular),
          onTap: () {
            setState(() {
              _month = DateTime(_month.year, _month.month - 1);
              _availability = null;
            });
            _loadData();
          }),
      const SizedBox(width: Msg.s2),
      Expanded(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$name ${_month.year}', style: _title(20)),
        const SizedBox(height: 2),
        Text(
            _schedule == null
                ? 'Schedule'
                : '${_schedule!.timezone} · ${_schedule!.durationMin} min slots',
            style: _sub(12)),
      ])),
      ZineLink('Today', onTap: () {
        final now = TimeSync.now();
        setState(() {
          _selected = now;
          _month = DateTime(now.year, now.month);
          _availability = null;
        });
        _loadData();
      }),
      const SizedBox(width: Msg.s3),
      ZineBackButton(
          icon: PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
          onTap: () {
            setState(() {
              _month = DateTime(_month.year, _month.month + 1);
              _availability = null;
            });
            _loadData();
          }),
    ]);
  }

  Widget _monthGrid() {
    final first = DateTime(_month.year, _month.month, 1);
    final lead = (first.weekday + 6) % 7;
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final cells = <Widget>[
      ...const [
        'M',
        'T',
        'W',
        'T',
        'F',
        'S',
        'S'
      ].map((label) => Center(child: Text(label, style: ADText.sectionLabel())))
    ];
    for (var i = 0; i < lead; i++) cells.add(const SizedBox());
    final today = TimeSync.now();
    for (var dayNo = 1; dayNo <= days; dayNo++) {
      final day = DateTime(_month.year, _month.month, dayNo);
      final blocks = _onDay(day);
      final selected = _sameDay(day, _selected);
      final isToday = _sameDay(day, today);
      final count = _availableCount(day);
      final exception = _exceptionOnDay(day);
      cells.add(GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _selected = day),
        onLongPress: () => _editException(day),
        child: Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s1),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                  width: 34,
                  height: 34,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: selected ? Msg.accent : null,
                      border: selected || isToday
                          ? Border.all(
                              color: selected ? Msg.accent : AD.borderControl)
                          : null),
                  child: Text('$dayNo',
                      style:
                          ADText.rowName(c: selected ? AD.bg : AD.textPrimary)
                              .copyWith(
                                  fontWeight: selected || isToday
                                      ? FontWeight.w700
                                      : FontWeight.w500))),
              const SizedBox(height: 2),
              SizedBox(
                  height: 14,
                  child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (exception != null)
                          _dot(_exceptionColor(exception.status)),
                        for (final block in blocks.take(2))
                          _dot(zineSourceColor(block.sourceApp)),
                        if (count != null)
                          Text('$count',
                              style: ADText.statCaption(c: AD.textSecondary)
                                  .copyWith(fontSize: 9)),
                      ])),
            ])),
      ));
    }
    return GridView.count(
        crossAxisCount: 7,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        childAspectRatio: 0.95,
        children: cells);
  }

  Widget _weekView() {
    final start =
        _selected.subtract(Duration(days: (_selected.weekday + 6) % 7));
    final days = List.generate(
        7, (i) => DateTime(start.year, start.month, start.day + i));
    return Column(children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final day in days)
          Expanded(
              child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => _selected = day),
            child: Padding(
                padding: const EdgeInsets.only(right: Msg.s1),
                child: ZineCard(
                    radius: Msg.rMd,
                    boxShadow: Msg.none,
                    padding: const EdgeInsets.symmetric(
                        horizontal: Msg.s1, vertical: Msg.s2),
                    borderColor: _sameDay(day, _selected)
                        ? Msg.accent
                        : AD.borderControl,
                    child: Column(children: [
                      Text(
                          const [
                            'Mon',
                            'Tue',
                            'Wed',
                            'Thu',
                            'Fri',
                            'Sat',
                            'Sun'
                          ][day.weekday - 1],
                          style: ADText.sectionLabel()),
                      const SizedBox(height: Msg.s1),
                      Text('${day.day}', style: _value(16)),
                      const SizedBox(height: Msg.s2),
                      Text('${_availableCount(day) ?? 0} open',
                          style: ADText.statCaption(c: AD.textSecondary)),
                      const SizedBox(height: Msg.s2),
                      ..._slotsOnDay(day).take(4).map((slot) => Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text(_hm(_scheduleTime(slot.startAt)),
                              style: ADText.statCaption(
                                  c: slot.available
                                      ? AD.online
                                      : AD.textTertiary)))),
                      if (_slotsOnDay(day).isEmpty)
                        Text('—', style: ADText.statCaption(c: AD.textFaint)),
                    ]))),
          ))
      ]),
      const SizedBox(height: Msg.s3),
      Text(
          'Tap a day to inspect its bookings and exceptions. Long press in Month view to edit a date.',
          style: _sub(12)),
    ]);
  }

  String _hm(DateTime date) =>
      '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';

  DateTime _scheduleTime(DateTime instant) => AvailabilityTime.inTimezone(
      instant, _schedule?.timezone ?? _availability?.timezone ?? 'UTC');

  Widget _agendaPanel({bool compact = false}) {
    final blocks = _onDay(_selected);
    final slots = _slotsOnDay(_selected);
    final exception = _exceptionOnDay(_selected);
    final monthName = const [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ][_selected.month - 1];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (!compact) ...[
        Row(children: [
          Expanded(child: Text('Agenda', style: _title(19))),
          ZineLink('Edit date', onTap: () => _editException(_selected))
        ]),
        const SizedBox(height: Msg.s1),
      ],
      Text('${_selected.day} $monthName ${_selected.year}',
          style: ADText.sectionLabel()),
      if (exception != null) ...[
        const SizedBox(height: Msg.s2),
        _exceptionBadge(exception)
      ],
      const SizedBox(height: Msg.s3),
      if (blocks.isNotEmpty) ...[
        Text('Bookings & blocks', style: _title(15)),
        const SizedBox(height: Msg.s2),
        ...blocks.map(_blockCard),
      ],
      if (slots.isNotEmpty) ...[
        const SizedBox(height: Msg.s2),
        Text('Bookable slots', style: _title(15)),
        const SizedBox(height: Msg.s2),
        ...slots.map(_slotCard),
      ],
      if (blocks.isEmpty && slots.isEmpty) _emptyAgenda(),
    ]);
  }

  Widget _blockCard(CalBlock block) {
    final style = styleFor(block.sourceApp);
    final isBooking = block.sourceApp == 'avabooking';
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: ZineCard(
        radius: Msg.rMd,
        padding: const EdgeInsets.all(Msg.s3),
        onTap: () => showBookingCard(
          context,
          sourceApp: block.sourceApp,
          title: block.title ?? style.label,
          startsAt: block.startsAt,
          endsAt: block.endsAt,
          bookingId: isBooking ? block.sourceRef : null,
          status: isBooking ? 'confirmed' : null,
          onChanged: _refresh,
        ),
        child: Row(children: [
          ZineIconBadge(
              icon: zineSourceIcon(block.sourceApp),
              color: zineSourceColor(block.sourceApp)),
          const SizedBox(width: Msg.s2),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(
                    '${fmtRange(block.startsAt, block.endsAt)} · ${style.label}',
                    style: ADText.sectionLabel()),
                const SizedBox(height: 2),
                Text(block.title ?? style.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _value(14)),
              ])),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
              size: 16, color: AD.textSecondary),
        ]),
      ),
    );
  }

  Widget _slotCard(AvailabilitySlot slot) {
    final free = slot.available;
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: ZineCard(
        radius: Msg.rMd,
        boxShadow: Msg.none,
        padding:
            const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
        borderColor: free ? AD.borderControl : AD.borderHairline,
        child: Row(children: [
          PhosphorIcon(
              free
                  ? PhosphorIcons.checkCircle(PhosphorIconsStyle.regular)
                  : PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
              size: 18,
              color: free ? AD.online : AD.textTertiary),
          const SizedBox(width: Msg.s2),
          Expanded(
              child: Text(
                  '${_hm(_scheduleTime(slot.startAt))}–${_hm(_scheduleTime(slot.endAt))}',
                  style: _value(14))),
          Text(free ? 'Open' : (slot.reason ?? 'Unavailable'),
              style: ADText.statCaption(c: free ? AD.online : AD.textTertiary)),
        ]),
      ),
    );
  }

  Widget _emptyAgenda() {
    if (_loading)
      return const Padding(
          padding: EdgeInsets.all(Msg.s5),
          child: Center(child: CircularProgressIndicator(color: Msg.accent)));
    if (_schedule == null)
      return _messageCard(
          'Working hours are not configured yet. Add them in Settings to show bookable slots.',
          PhosphorIcons.clock(PhosphorIconsStyle.regular),
          AD.textSecondary);
    return _messageCard(
        'Nothing is scheduled for this day.',
        PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular),
        AD.textSecondary);
  }

  Widget _exceptionBadge(AvailabilityException exception) {
    final label = switch (exception.status) {
      AvailabilityExceptionStatus.available => 'Date opened manually',
      AvailabilityExceptionStatus.unavailable => 'Blocked for this date',
      AvailabilityExceptionStatus.reserved =>
        'Reserved for ${_listingTitle(exception.listingId)}',
    };
    return ZineSticker(label,
        kind: exception.status == AvailabilityExceptionStatus.available
            ? ZineStickerKind.ok
            : ZineStickerKind.no);
  }

  Widget _messageCard(String message, IconData icon, Color color) => ZineCard(
        radius: Msg.rMd,
        boxShadow: Msg.none,
        padding: const EdgeInsets.all(Msg.s3),
        borderColor: color,
        child: Row(children: [
          PhosphorIcon(icon, size: 20, color: color),
          const SizedBox(width: Msg.s2),
          Expanded(child: Text(message, style: _sub(13, c: color)))
        ]),
      );

  Widget _legend() => Wrap(spacing: Msg.s3, runSpacing: Msg.s2, children: [
        _legendItem(AD.online, 'Open'),
        _legendItem(AD.danger, 'Unavailable'),
        _legendItem(AD.textSecondary, 'Bookings & blocks'),
        _legendItem(Msg.accent, 'Reserved'),
      ]);

  Widget _legendItem(Color color, String label) =>
      Row(mainAxisSize: MainAxisSize.min, children: [
        _dot(color),
        const SizedBox(width: Msg.s1),
        Text(label, style: ADText.statCaption(c: AD.textSecondary))
      ]);
  Widget _dot(Color color) => Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle));

  Color _exceptionColor(AvailabilityExceptionStatus status) => switch (status) {
        AvailabilityExceptionStatus.available => AD.online,
        AvailabilityExceptionStatus.unavailable => AD.danger,
        AvailabilityExceptionStatus.reserved => Msg.accent,
      };

  String _listingTitle(String? id) {
    if (id == null) return 'this listing';
    for (final listing in _listings) {
      if (listing.id == id) return listing.title;
    }
    return 'this listing';
  }

  bool _sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  Future<void> _editException(DateTime day) async {
    final result = await showDialog<AvailabilityException>(
        context: context,
        builder: (_) => _ExceptionDialog(
            day: day, initial: _exceptionOnDay(day), listings: _listings));
    if (result == null || _schedule == null) return;
    final exceptions = [..._schedule!.exceptions]
      ..removeWhere((e) => e.date == _dateKey(day));
    exceptions.add(result);
    try {
      final saved = await AvailabilityApi.saveSchedule(
          _schedule!.copyWith(exceptions: exceptions));
      if (!mounted) return;
      setState(() {
        _schedule = saved;
        _error = null;
      });
      await _loadData(showBusy: false);
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    }
  }
}

class _ExceptionDialog extends StatefulWidget {
  final DateTime day;
  final AvailabilityException? initial;
  final List<ListingCard> listings;
  const _ExceptionDialog(
      {required this.day, required this.initial, required this.listings});
  @override
  State<_ExceptionDialog> createState() => _ExceptionDialogState();
}

class _ExceptionDialogState extends State<_ExceptionDialog> {
  late AvailabilityExceptionStatus _status;
  late TimeOfDay _start;
  late TimeOfDay _end;
  String? _listingId;

  @override
  void initState() {
    super.initState();
    final initial = widget.initial;
    _status = initial?.status ?? AvailabilityExceptionStatus.unavailable;
    _start = TimeOfDay(
        hour: (initial?.startMin ?? 0) ~/ 60,
        minute: (initial?.startMin ?? 0) % 60);
    _end = TimeOfDay(
        hour: (initial?.endMin ?? 1440) ~/ 60,
        minute: (initial?.endMin ?? 1440) % 60);
    _listingId = initial?.listingId;
  }

  @override
  Widget build(BuildContext context) {
    final title = '${widget.day.day} ${const [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ][widget.day.month - 1]}';
    return AlertDialog(
      backgroundColor: AD.card,
      shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderControl, width: 1)),
      title: Text('Date exception · $title', style: _title(17)),
      content: SingleChildScrollView(
          child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
            Text('Choose what this date means for the shared creator resource.',
                style: _sub(13)),
            const SizedBox(height: Msg.s3),
            Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
              ZineChip(
                  label: 'Available',
                  active: _status == AvailabilityExceptionStatus.available,
                  onTap: () => setState(
                      () => _status = AvailabilityExceptionStatus.available)),
              ZineChip(
                  label: 'Unavailable',
                  active: _status == AvailabilityExceptionStatus.unavailable,
                  onTap: () => setState(
                      () => _status = AvailabilityExceptionStatus.unavailable)),
              ZineChip(
                  label: 'Reserved',
                  active: _status == AvailabilityExceptionStatus.reserved,
                  onTap: () => setState(
                      () => _status = AvailabilityExceptionStatus.reserved)),
            ]),
            const SizedBox(height: Msg.s3),
            Row(children: [
              Expanded(
                  child: _timeTile('From', _start,
                      (value) => setState(() => _start = value))),
              const SizedBox(width: Msg.s2),
              Expanded(
                  child: _timeTile(
                      'To', _end, (value) => setState(() => _end = value)))
            ]),
            if (_status == AvailabilityExceptionStatus.reserved &&
                widget.listings.isNotEmpty) ...[
              const SizedBox(height: Msg.s3),
              ZineDropdown<String>(
                  label: 'Reserved listing',
                  value: _listingId,
                  hint: 'Choose a listing',
                  items: widget.listings
                      .map((listing) => DropdownMenuItem(
                          value: listing.id, child: Text(listing.title)))
                      .toList(),
                  onChanged: (value) => setState(() => _listingId = value)),
            ],
          ])),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text('Cancel', style: _link)),
        ZineButton(
            label: 'Save exception',
            variant: ZineButtonVariant.blue,
            fontSize: 14,
            onPressed: () {
              Navigator.pop(
                  context,
                  AvailabilityException(
                      id: widget.initial?.id ?? '',
                      date:
                          '${widget.day.year.toString().padLeft(4, '0')}-${widget.day.month.toString().padLeft(2, '0')}-${widget.day.day.toString().padLeft(2, '0')}',
                      startMin: _start.hour * 60 + _start.minute,
                      endMin: _end.hour * 60 + _end.minute,
                      status: _status,
                      listingId: _status == AvailabilityExceptionStatus.reserved
                          ? _listingId
                          : null));
            }),
      ],
    );
  }

  Widget _timeTile(
          String label, TimeOfDay value, ValueChanged<TimeOfDay> onChanged) =>
      ZineCard(
          radius: Msg.rMd,
          boxShadow: Msg.none,
          padding:
              const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
          onTap: () async {
            final next =
                await showTimePicker(context: context, initialTime: value);
            if (next != null) onChanged(next);
          },
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: ADText.sectionLabel()),
            const SizedBox(height: 2),
            Text(value.format(context), style: _value(15))
          ]));
}

class CalendarSettingsScreen extends StatefulWidget {
  const CalendarSettingsScreen({super.key});
  @override
  State<CalendarSettingsScreen> createState() => _CalendarSettingsScreenState();
}

class _CalendarSettingsScreenState extends State<CalendarSettingsScreen> {
  AvailabilitySchedule? _schedule;
  bool? _gcalConnected;
  bool _loading = true;
  bool _saving = false;
  String? _error;
  static const _days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final cached = await AvailabilityApi.cachedSchedule();
    if (mounted && cached != null)
      setState(() {
        _schedule = cached.value;
        _loading = false;
      });
    try {
      final results = await Future.wait<dynamic>(
          [AvailabilityApi.fetchSchedule(), PlatformApi.gcalStatus()]);
      if (!mounted) return;
      setState(() {
        _schedule = results[0] as AvailabilitySchedule;
        _gcalConnected =
            (results[1] as Map<String, dynamic>)['connected'] == true;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (mounted)
        setState(() {
          _loading = false;
          _error = e is AvailabilityApiException
              ? e.message
              : 'Settings could not be refreshed.';
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final schedule = _schedule;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(
          title: 'Availability settings',
          markWord: 'settings',
          tag: 'Calendar & availability'),
      body: LayoutBuilder(builder: (context, constraints) {
        final max = constraints.maxWidth >= 760 ? 820.0 : double.infinity;
        return ListView(padding: const EdgeInsets.all(Msg.s4), children: [
          Center(
              child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: max),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                            'Set the hours buyers can request. AvaTOK remains the authority for conflicts, holds and confirmed bookings.',
                            style: _sub(14)),
                        if (_error != null) ...[
                          const SizedBox(height: Msg.s3),
                          _settingsMessage(_error!)
                        ],
                        const SizedBox(height: Msg.s4),
                        _googleCard(),
                        const SizedBox(height: Msg.s4),
                        if (_loading && schedule == null)
                          const Center(
                              child: Padding(
                                  padding: EdgeInsets.all(Msg.s5),
                                  child: CircularProgressIndicator(
                                      color: Msg.accent)))
                        else if (schedule != null) ...[
                          _hoursCard(schedule),
                          const SizedBox(height: Msg.s4),
                          _policyCard(schedule)
                        ],
                      ])))
        ]);
      }),
    );
  }

  Widget _googleCard() => ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Row(children: [
        ZineIconBadge(
            icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
            color: AD.familyByName('sky').solid),
        const SizedBox(width: Msg.s3),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Google Calendar', style: _title(16)),
          const SizedBox(height: 2),
          Text(
              _gcalConnected == null
                  ? 'Checking…'
                  : _gcalConnected!
                      ? 'Connected — busy events are imported'
                      : 'Not connected',
              style: _sub(13))
        ])),
        if (_gcalConnected == true)
          ZineLink('Disconnect',
              underline: AD.danger, fontSize: 12, onTap: _disconnectGcal)
        else
          ZineButton(
              label: 'Connect',
              variant: ZineButtonVariant.blue,
              fontSize: 14,
              onPressed: _connectGcal),
      ]));

  Widget _hoursCard(AvailabilitySchedule schedule) => ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text('Working hours', style: _title(17)),
                const SizedBox(height: 2),
                Text('${schedule.timezone} · ${_modeLabel(schedule.mode)}',
                    style: _sub(13))
              ])),
          ZineButton(
              label: 'Add hours',
              variant: ZineButtonVariant.ghost,
              fontSize: 13,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              onPressed: _addRule)
        ]),
        const SizedBox(height: Msg.s3),
        if (schedule.rules.isEmpty)
          Text(
              'No working hours yet. Add a weekday range to make the schedule bookable.',
              style: _sub(13))
        else
          ...schedule.rules
              .asMap()
              .entries
              .map((entry) => _ruleRow(entry.key, entry.value)),
        const SizedBox(height: Msg.s3),
        _settingLine(
            'Timezone',
            schedule.timezone,
            () => _editText('Timezone', schedule.timezone,
                (value) => _save(schedule.copyWith(timezone: value)))),
        _settingLine(
            'Slot duration',
            '${schedule.durationMin} min',
            () => _editNumber('Slot duration', schedule.durationMin,
                (value) => _save(schedule.copyWith(durationMin: value)))),
        _settingLine(
            'Slot interval',
            '${schedule.slotIntervalMin} min',
            () => _editNumber('Slot interval', schedule.slotIntervalMin,
                (value) => _save(schedule.copyWith(slotIntervalMin: value)))),
      ]));

  Widget _policyCard(AvailabilitySchedule schedule) => ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Booking policy', style: _title(17)),
        const SizedBox(height: Msg.s2),
        Text('These limits are shared by every listing owned by this creator.',
            style: _sub(13)),
        const SizedBox(height: Msg.s3),
        _settingLine(
            'Buffer between sessions',
            '${schedule.bufferMin} min',
            () => _editNumber('Buffer between sessions', schedule.bufferMin,
                (value) => _save(schedule.copyWith(bufferMin: value)))),
        _settingLine(
            'Minimum notice',
            '${schedule.minNoticeMin} min',
            () => _editNumber('Minimum notice', schedule.minNoticeMin,
                (value) => _save(schedule.copyWith(minNoticeMin: value)))),
        _settingLine(
            'Maximum per day',
            schedule.maxPerDay == 0 ? 'No limit' : '${schedule.maxPerDay}',
            () => _editNumber(
                'Maximum per day (0 = no limit)',
                schedule.maxPerDay,
                (value) => _save(schedule.copyWith(maxPerDay: value)))),
        _settingLine(
            'Booking horizon',
            '${schedule.horizonDays} days',
            () => _editNumber('Booking horizon', schedule.horizonDays,
                (value) => _save(schedule.copyWith(horizonDays: value)))),
        const SizedBox(height: Msg.s2),
        Text('Schedule mode', style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s2, children: [
          for (final mode in AvailabilityMode.values)
            ZineChip(
                label: _modeLabel(mode),
                active: schedule.mode == mode,
                onTap: () => _save(schedule.copyWith(mode: mode)))
        ]),
      ]));

  Widget _ruleRow(int index, AvailabilityRule rule) => Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: ZineCard(
          radius: Msg.rMd,
          boxShadow: Msg.none,
          padding:
              const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
          child: Row(children: [
            Expanded(
                child: Text(
                    '${_days[(rule.weekday + 7) % 7]}  ${_hmMinutes(rule.startMin)}–${_hmMinutes(rule.endMin)}',
                    style: _value(14))),
            GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () {
                  final next = [...?_schedule?.rules]..removeAt(index);
                  _save(_schedule!.copyWith(rules: next));
                },
                child: Padding(
                    padding: const EdgeInsets.all(Msg.s1),
                    child: PhosphorIcon(
                        PhosphorIcons.trash(PhosphorIconsStyle.regular),
                        size: 18,
                        color: AD.danger))),
          ])));

  Widget _settingLine(String label, String value, VoidCallback onTap) =>
      ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(label, style: _sub(14)),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(value, style: _value(14)),
            const SizedBox(width: Msg.s2),
            PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.regular),
                size: 17, color: AD.textSecondary)
          ]),
          onTap: onTap);
  Widget _settingsMessage(String text) => _calendarMessageCard(
      text, PhosphorIcons.warningCircle(PhosphorIconsStyle.regular), AD.danger);

  Future<void> _save(AvailabilitySchedule value) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await AvailabilityApi.saveSchedule(value);
      if (mounted)
        setState(() {
          _schedule = saved;
          _saving = false;
        });
    } catch (e) {
      if (mounted)
        setState(() {
          _saving = false;
          _error = e is AvailabilityApiException
              ? e.message
              : 'Could not save availability.';
        });
    }
  }

  Future<void> _addRule() async {
    final result = await showDialog<AvailabilityRule>(
        context: context, builder: (_) => const _RuleDialog());
    if (result != null && _schedule != null)
      await _save(_schedule!.copyWith(rules: [..._schedule!.rules, result]));
  }

  Future<void> _editNumber(
      String label, int value, ValueChanged<int> onSave) async {
    final controller = TextEditingController(text: '$value');
    final result = await showDialog<int>(
        context: context,
        builder: (_) => AlertDialog(
                backgroundColor: AD.card,
                shape: RoundedRectangleBorder(
                    borderRadius: Msg.brLg,
                    side: const BorderSide(color: AD.borderControl)),
                title: Text(label, style: _title(17)),
                content: ZineField(
                    controller: controller,
                    keyboardType: TextInputType.number,
                    autofocus: true),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text('Cancel', style: _link)),
                  ZineButton(
                      label: 'Save',
                      variant: ZineButtonVariant.blue,
                      fontSize: 14,
                      onPressed: () =>
                          Navigator.pop(context, int.tryParse(controller.text)))
                ]));
    if (result != null && result >= 0) onSave(result);
  }

  Future<void> _editText(
      String label, String value, ValueChanged<String> onSave) async {
    final controller = TextEditingController(text: value);
    final result = await showDialog<String>(
        context: context,
        builder: (_) => AlertDialog(
                backgroundColor: AD.card,
                shape: RoundedRectangleBorder(
                    borderRadius: Msg.brLg,
                    side: const BorderSide(color: AD.borderControl)),
                title: Text(label, style: _title(17)),
                content: ZineField(controller: controller, autofocus: true),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text('Cancel', style: _link)),
                  ZineButton(
                      label: 'Save',
                      variant: ZineButtonVariant.blue,
                      fontSize: 14,
                      onPressed: () =>
                          Navigator.pop(context, controller.text.trim()))
                ]));
    if (result != null && result.isNotEmpty) onSave(result);
  }

  String _hmMinutes(int minutes) =>
      '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';
  String _modeLabel(AvailabilityMode mode) => switch (mode) {
        AvailabilityMode.shared => 'Shared',
        AvailabilityMode.custom => 'Custom',
        AvailabilityMode.exclusive => 'Exclusive'
      };

  Future<void> _connectGcal() async {
    final result = await PlatformApi.gcalConnect();
    final url = result['url'] as String?;
    if (url == null) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(result['error']?.toString() ??
                'Google sync is not configured yet.')));
      return;
    }
    try {
      await FlutterWebAuth2.authenticate(
          url: url, callbackUrlScheme: 'avatokauth');
      await _load();
    } on PlatformException catch (error) {
      if (error.code == 'CANCELED' || error.code == 'CANCELLED') return;
      AvaLog.I
          .log('gcal', 'web auth failed (${error.code}); falling back to tab');
      try {
        final opened =
            await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
        if (opened && mounted)
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Finish in Google, then refresh this page.')));
      } catch (_) {}
    } catch (error) {
      Analytics.error(
          domain: 'calendar',
          code: 'gcal_connect_failed',
          message: error.toString(),
          screen: 'calendar_settings',
          action: 'connect');
    }
  }

  Future<void> _disconnectGcal() async {
    try {
      await PlatformApi.gcalDisconnect();
      await _load();
    } catch (_) {
      if (mounted)
        setState(() => _error = 'Google Calendar could not be disconnected.');
    }
  }
}

class _RuleDialog extends StatefulWidget {
  const _RuleDialog();
  @override
  State<_RuleDialog> createState() => _RuleDialogState();
}

class _RuleDialogState extends State<_RuleDialog> {
  int _weekday = 1;
  TimeOfDay _start = const TimeOfDay(hour: 9, minute: 0);
  TimeOfDay _end = const TimeOfDay(hour: 17, minute: 0);

  @override
  Widget build(BuildContext context) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl)),
        title: Text('Add working hours', style: _title(17)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineDropdown<int>(
              value: _weekday,
              items: List.generate(
                  7,
                  (index) => DropdownMenuItem(
                      value: index,
                      child: Text(const [
                        'Sun',
                        'Mon',
                        'Tue',
                        'Wed',
                        'Thu',
                        'Fri',
                        'Sat'
                      ][index]))),
              onChanged: (value) => setState(() => _weekday = value ?? 1)),
          const SizedBox(height: Msg.s3),
          Row(children: [
            Expanded(
                child: _timeTile(
                    'From', _start, (value) => setState(() => _start = value))),
            const SizedBox(width: Msg.s2),
            Expanded(
                child: _timeTile(
                    'To', _end, (value) => setState(() => _end = value)))
          ]),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text('Cancel', style: _link)),
          ZineButton(
              label: 'Add hours',
              variant: ZineButtonVariant.blue,
              fontSize: 14,
              onPressed: () => Navigator.pop(
                  context,
                  AvailabilityRule(
                      weekday: _weekday,
                      startMin: _start.hour * 60 + _start.minute,
                      endMin: _end.hour * 60 + _end.minute)))
        ],
      );

  Widget _timeTile(
          String label, TimeOfDay value, ValueChanged<TimeOfDay> onChanged) =>
      ZineCard(
          radius: Msg.rMd,
          boxShadow: Msg.none,
          padding:
              const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
          onTap: () async {
            final next =
                await showTimePicker(context: context, initialTime: value);
            if (next != null) onChanged(next);
          },
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: ADText.sectionLabel()),
            const SizedBox(height: 2),
            Text(value.format(context), style: _value(14))
          ]));
}
