// Native creator calendar — the diary.
//
// Audit fixes covered here (15 September 2026):
//  * 3 / A8 — every interval on a selected day is listed and can be edited or
//    removed on its own; "Block time" starts in a blocked state and states its
//    scope explicitly.
//  * 4 — a partial load says WHICH sources failed instead of marking the page
//    ready, and unknown availability is never rendered as zero.
//  * 5 / 6 — Google readiness is surfaced with its last successful sync, and an
//    unverifiable status is never shown as healthy.
//  * 7 / A1 — one card per booking, with a route to the commercial appointment
//    or session screen that actually owns it.
//  * 8 — one explicit schedule timezone for every card, heading and slot.
//  * 12 / A6 — refresh on foreground + a visible "Updated at", and a reload
//    with a confirmation after settings close.
//  * A4 / A5 — Agenda renders once and is the phone default; the arrows move
//    the active view (month, week or day) and the selected date with it.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/availability_api.dart';
import '../../core/listings_api.dart';
import '../../core/platform_api.dart';
import '../../core/time_sync.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'booking_card.dart';
import 'calendar_data.dart';
import 'calendar_day_editor.dart';
import 'calendar_logic.dart';
import 'calendar_settings_screen.dart';
import 'calendar_signals.dart';
import 'calendar_ui.dart';

export 'calendar_settings_screen.dart';

class AvaCalendarScreen extends StatefulWidget {
  const AvaCalendarScreen({super.key});

  @override
  State<AvaCalendarScreen> createState() => _AvaCalendarScreenState();
}

class _AvaCalendarScreenState extends State<AvaCalendarScreen>
    with WidgetsBindingObserver {
  DateTime _month = DateTime(TimeSync.now().year, TimeSync.now().month);
  DateTime _selected = TimeSync.now();

  /// null → adaptive default: Agenda on a phone, Month on a wide window.
  CalendarView? _viewOverride;
  bool _monthOverview = false;

  List<CalBlock> _blocks = const [];
  List<ListingCard> _listings = const [];
  String? _selectedListingId;
  AvailabilitySchedule? _schedule;
  ListingAvailability? _availability;
  GcalReadiness? _gcal;

  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  bool _stale = false;
  DateTime? _updatedAt;
  int _loadGeneration = 0;
  int _settingsRevision = 0;
  DateTime? _lastForegroundRefresh;

  @override
  void initState() {
    super.initState();
    TimeSync.init();
    WidgetsBinding.instance.addObserver(this);
    CalendarSignals.availabilityRevision.addListener(_onAvailabilitySaved);
    _bootstrap();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    CalendarSignals.availabilityRevision.removeListener(_onAvailabilitySaved);
    super.dispose();
  }

  void _onAvailabilitySaved() => _settingsRevision++;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // 12 — an already-open diary must not keep showing yesterday's answer.
    final now = TimeSync.now();
    if (_lastForegroundRefresh != null &&
        now.difference(_lastForegroundRefresh!) < const Duration(seconds: 20)) {
      return;
    }
    _lastForegroundRefresh = now;
    _refresh();
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
    final generation = ++_loadGeneration;
    bool current() => mounted && generation == _loadGeneration;
    final listingId = _selectedListingId;
    final range = _monthRange;
    final from = dateKey(range.$1);
    final to = dateKey(range.$2);
    if (showBusy && current()) {
      setState(() {
        _loading = true;
        _error = null;
        _availability = null;
        _stale = true;
      });
    }

    final failed = <String>[];

    final cachedBlocks = await CalendarStore.cached();
    if (current() && cachedBlocks.isNotEmpty) {
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
      if (current()) {
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
        if (current()) {
          setState(() {
            _loading = false;
            _refreshing = false;
            _error = _friendlyError(e);
          });
        }
        return;
      }
    }
    if (current() && (cachedSchedule != null || cachedAvailability != null)) {
      setState(() {
        if (cachedSchedule != null) _schedule = cachedSchedule.value;
        if (cachedAvailability != null) _availability = cachedAvailability!.value;
        _stale = (cachedSchedule?.isStale() ?? false) ||
            (cachedAvailability?.isStale(maxAge: const Duration(minutes: 30)) ??
                false);
        _loading = false;
      });
    }

    try {
      final blocks = await CalendarStore.refresh(
        from: range.$1.subtract(const Duration(days: 7)).millisecondsSinceEpoch,
        to: range.$2.add(const Duration(days: 7)).millisecondsSinceEpoch,
      );
      if (current()) setState(() => _blocks = blocks);
    } catch (e) {
      failed.add('busy blocks');
    }

    AvailabilitySchedule? fetchedSchedule;
    try {
      fetchedSchedule = await AvailabilityApi.fetchSchedule(listingId: listingId);
      if (current()) {
        setState(() {
          _schedule = fetchedSchedule;
          if (listingId == null) _stale = false;
        });
      }
    } catch (e) {
      failed.add(listingId == null ? 'working hours' : 'this listing’s schedule');
      fetchedSchedule = cachedSchedule?.value;
    }

    if (listingId != null) {
      if (fetchedSchedule == null) {
        failed.add('bookable slots');
      } else {
        try {
          final availability = await AvailabilityApi.fetchListingAvailability(
            listingId: listingId,
            from: from,
            to: to,
            timezone: fetchedSchedule.timezone,
          );
          if (current())
            setState(() {
              _availability = availability;
              _stale = false;
            });
        } catch (e) {
          failed.add('bookable slots');
        }
      }
    }

    try {
      final result = await PlatformApi.gcalStatusResult();
      if (current()) {
        setState(() => _gcal = result.ok
            ? gcalReadinessFromStatus(result.json)
            : gcalUnknown(result.error ??
                'Google Calendar status could not be read, so it cannot be verified.'));
      }
    } catch (e) {
      if (current()) setState(() => _gcal = null);
      failed.add('Google Calendar');
    }

    if (!current()) return;
    setState(() {
      _loading = false;
      _refreshing = false;
      _failedSources = failed;
      _updatedAt = TimeSync.now();
      if (failed.isEmpty) {
        _error = null;
        _stale = false;
      } else {
        _error = _partialMessage(failed);
      }
    });
  }

  String _partialMessage(List<String> failed) =>
      'Some calendar data could not be refreshed (${failed.join(', ')}). '
      'Time you cannot see here is NOT confirmed free — pull to refresh before relying on this day.';

  String _friendlyError(Object error) => error is AvailabilityApiException
      ? error.message
      : 'Calendar data could not be refreshed. Your last saved view is still shown.';

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    await _loadData(showBusy: false);
  }

  Future<void> _openSettings() async {
    final before = _settingsRevision;
    await Navigator.push<void>(
        context, MaterialPageRoute(builder: (_) => const CalendarSettingsScreen()));
    if (!mounted) return;
    await _loadData(showBusy: false);
    if (!mounted) return;
    if (_settingsRevision != before) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Working hours updated')));
    }
  }

  (DateTime, DateTime) get _monthRange => (
        DateTime(_month.year, _month.month, 1),
        DateTime(_month.year, _month.month + 1, 1),
      );

  CalendarView _viewFor(bool wide) =>
      _viewOverride ?? defaultCalendarView(wide: wide);

  String get _timezone => _schedule?.timezone ?? _availability?.timezone ?? 'UTC';

  List<CalBlock> _onDay(DateTime day) {
    final bounds = dayBoundsUtcMs(day, _timezone);
    final from = bounds?.from ?? DateTime.utc(day.year, day.month, day.day).millisecondsSinceEpoch;
    final to = bounds?.to ??
        DateTime.utc(day.year, day.month, day.day + 1).millisecondsSinceEpoch;
    final rows = _blocks
        .where((b) => b.startsAt < to && b.endsAt > from)
        .toList(growable: false);
    return dedupeBookingBlocks(rows);
  }

  List<AvailabilitySlot> _slotsOnDay(DateTime day) {
    final key = dateKey(day);
    final timezone = _timezone;
    final rows = (_availability?.slots ?? const <AvailabilitySlot>[])
        .where((slot) => dateKey(calendarTime(slot.startAt, timezone)) == key)
        .toList();
    rows.sort((a, b) => a.startAt.compareTo(b.startAt));
    return rows;
  }

  List<AvailabilityException> _exceptionsFor(DateTime day) =>
      exceptionsOnDate(_schedule?.exceptions ?? const [], dateKey(day));

  int? _availableCount(DateTime day) {
    final key = dateKey(day);
    for (final row in _availability?.days ?? const <AvailabilityDay>[]) {
      if (row.date == key) return row.availableCount;
    }
    return null;
  }

  DateTime _scheduleTime(DateTime instant) => calendarTime(instant, _timezone);

  bool _sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  String _listingTitle(String? id) {
    if (id == null) return 'this listing';
    for (final listing in _listings) {
      if (listing.id == id) return listing.title;
    }
    return 'this listing';
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
              onTap: _openSettings),
        ],
      ),
      body: RefreshIndicator(
        color: Msg.accent,
        backgroundColor: AD.card,
        onRefresh: _refresh,
        child: LayoutBuilder(builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          final view = _viewFor(wide);
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(Msg.s4),
            children: [
              _topControls(wide, view),
              ..._banners(),
              const SizedBox(height: Msg.s3),
              if (view == CalendarView.agenda) ...[
                if (!wide) ...[
                  _agendaNavBar(view),
                  if (_monthOverview) ...[
                    const SizedBox(height: Msg.s3),
                    _monthCard(),
                  ],
                ],
                _agendaPanel(),
              ] else if (wide)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(flex: 6, child: _calendarPanel(view)),
                  const SizedBox(width: Msg.s4),
                  Expanded(flex: 4, child: _agendaPanel()),
                ])
              else
                _calendarPanel(view),
              const SizedBox(height: Msg.s6),
            ],
          );
        }),
      ),
    );
  }

  Widget _topControls(bool wide, CalendarView view) {
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
        Text('Showing your creator schedule', style: calSub(14)),
      const SizedBox(height: Msg.s1),
      Text(
        editingScopeLabel(
            selectedListingId: _selectedListingId, listings: _listings),
        style: ADText.statCaption(c: AD.textSecondary),
      ),
      const SizedBox(height: Msg.s2),
      Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
        ZineChip(
            label: 'Month',
            active: view == CalendarView.month,
            onTap: () => setState(() => _viewOverride = CalendarView.month)),
        ZineChip(
            label: 'Week',
            active: view == CalendarView.week,
            onTap: () => setState(() => _viewOverride = CalendarView.week)),
        ZineChip(
            label: 'Agenda',
            active: view == CalendarView.agenda,
            onTap: () => setState(() => _viewOverride = CalendarView.agenda)),
        ZineButton(
            label: 'Block time',
            variant: ZineButtonVariant.ghost,
            fontSize: 13,
            icon: PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
            trailingIcon: false,
            onPressed: () => _openDayEditor(_selected, startBlocked: true)),
        ZineButton(
            label: 'Refresh',
            variant: ZineButtonVariant.ghost,
            fontSize: 13,
            loading: _refreshing,
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
            trailingIcon: false,
            onPressed: _refresh),
      ]),
      const SizedBox(height: Msg.s2),
      Row(children: [
        ZineLink('Working hours', onTap: _openSettings),
        const SizedBox(width: Msg.s3),
        ZineLink('Connected calendars', onTap: _openSettings),
        const Spacer(),
        Text(updatedAtLabel(_updatedAt),
            style: ADText.statCaption(c: AD.textSecondary)),
      ]),
    ]);
  }

  List<Widget> _banners() {
    final widgets = <Widget>[];
    if (_error != null) {
      widgets.add(calendarMessageCard(
          _error!,
          PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
          AD.danger));
    }
    if (_stale) {
      widgets.add(calendarMessageCard(
          'Showing a saved snapshot until the refresh completes.',
          PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.regular),
          AD.textSecondary));
    }
    final gcal = _gcal;
    if (gcal != null && gcal.pausesBookings) {
      widgets.add(calendarMessageCard(
          'Google Calendar: ${gcal.detail}',
          PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
          AD.haldi));
    }
    if (_failedSources.isNotEmpty) {
      // A partial failure must name its sources; "no error" used to mean "ready"
      // even when blocks or events had failed to load (finding 4).
      widgets.add(Text('Not refreshed: ${_failedSources.join(', ')}',
          style: ADText.statCaption(c: AD.textSecondary)));
    }
    if (widgets.isEmpty) return const [];
    return [
      for (final widget in widgets) ...[
        const SizedBox(height: Msg.s3),
        widget,
      ]
    ];
  }

  // ── Navigation (A4, A5) ──────────────────────────────────────────────────
  void _shift(CalendarView view, int direction) {
    final nav = calendarNavigate(
        view: view, direction: direction, selected: _selected, month: _month);
    setState(() {
      _month = nav.month;
      _selected = nav.selected;
      _availability = null;
    });
    _loadData();
  }

  void _goToday() {
    final now = TimeSync.now();
    setState(() {
      _selected = now;
      _month = DateTime(now.year, now.month, 1);
      _availability = null;
    });
    _loadData();
  }

  Widget _navArrows(CalendarView view) => Row(mainAxisSize: MainAxisSize.min, children: [
        ZineBackButton(
            icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.regular),
            onTap: () => _shift(view, -1)),
        const SizedBox(width: Msg.s2),
        ZineBackButton(
            icon: PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
            onTap: () => _shift(view, 1)),
      ]);

  Widget _agendaNavBar(CalendarView view) => Row(children: [
        _navArrows(view),
        const SizedBox(width: Msg.s2),
        Expanded(
            child: Text(
                calendarRangeLabel(
                    view: view, month: _month, selected: _selected),
                style: calTitle(17))),
        ZineChip(
            label: _monthOverview ? 'Hide month' : 'Month overview',
            active: _monthOverview,
            onTap: () => setState(() => _monthOverview = !_monthOverview)),
        const SizedBox(width: Msg.s2),
        ZineLink('Today', onTap: _goToday),
      ]);

  // ── Month ────────────────────────────────────────────────────────────────
  Widget _calendarPanel(CalendarView view) => ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.all(Msg.s4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (view == CalendarView.month) _monthHeader(),
          if (view == CalendarView.week) _weekHeader(),
          const SizedBox(height: Msg.s3),
          if (view == CalendarView.month) _monthGrid(),
          if (view == CalendarView.week) _weekView(),
          const SizedBox(height: Msg.s3),
          _legend(),
        ]),
      );

  Widget _monthCard() => ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.all(Msg.s4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _monthHeader(),
          const SizedBox(height: Msg.s3),
          _monthGrid(),
          const SizedBox(height: Msg.s3),
          _legend(),
        ]),
      );

  Widget _monthHeader() => Row(children: [
        _navArrows(CalendarView.month),
        const SizedBox(width: Msg.s2),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(calendarRangeLabel(view: CalendarView.month, month: _month, selected: _selected),
              style: calTitle(20)),
          const SizedBox(height: 2),
          Text(
              _schedule == null
                  ? timezoneLabel(null)
                  : '${_schedule!.timezone} · ${_schedule!.durationMin} min slots',
              style: calSub(12)),
        ])),
        ZineLink('Today', onTap: _goToday),
      ]);

  Widget _weekHeader() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _navArrows(CalendarView.week),
          const SizedBox(width: Msg.s2),
          Expanded(
              child: Text(
                  calendarRangeLabel(
                      view: CalendarView.week, month: _month, selected: _selected),
                  style: calTitle(20))),
          ZineLink('Today', onTap: _goToday),
        ]),
        const SizedBox(height: Msg.s1),
        calendarTimezoneNote(_timezone),
      ]);

  Widget _monthGrid() {
    final first = DateTime(_month.year, _month.month, 1);
    final lead = (first.weekday + 6) % 7;
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final cells = <Widget>[
      ...const ['M', 'T', 'W', 'T', 'F', 'S', 'S']
          .map((label) => Center(child: Text(label, style: ADText.sectionLabel())))
    ];
    for (var i = 0; i < lead; i++) {
      cells.add(const SizedBox());
    }
    final today = TimeSync.now();
    for (var dayNo = 1; dayNo <= days; dayNo++) {
      final day = DateTime(_month.year, _month.month, dayNo);
      final blocks = _onDay(day);
      final selected = _sameDay(day, _selected);
      final isToday = _sameDay(day, today);
      final count = _availableCount(day);
      final exceptions = _exceptionsFor(day);
      cells.add(GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _selected = day),
        onLongPress: () => _openDayEditor(day),
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
                        if (exceptions.isNotEmpty)
                          _dot(_exceptionColor(exceptions.first.status)),
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

  // ── Week (A7: real commitments, honest open counts) ──────────────────────
  Widget _weekView() {
    final start = startOfWeek(_selected);
    final days =
        List.generate(7, (i) => DateTime(start.year, start.month, start.day + i));
    final listingSelected = _selectedListingId != null;
    return Column(children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final day in days)
          Expanded(
              child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => _selected = day),
            onLongPress: () => _openDayEditor(day),
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
                      Text(weekdayShort(day), style: ADText.sectionLabel()),
                      const SizedBox(height: Msg.s1),
                      Text('${day.day}', style: calValue(16)),
                      const SizedBox(height: Msg.s2),
                      Text(
                          weekAvailabilityLabel(
                              availableCount: _availableCount(day),
                              listingSelected: listingSelected),
                          style: ADText.statCaption(c: AD.textSecondary)),
                      const SizedBox(height: Msg.s2),
                      ..._onDay(day).take(3).map((block) => Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text(
                              '${_hm(_scheduleTime(DateTime.fromMillisecondsSinceEpoch(block.startsAt)))} ${styleFor(block.sourceApp).label}',
                              textAlign: TextAlign.center,
                              style: ADText.statCaption(c: AD.textSecondary)))),
                      if (_onDay(day).isEmpty)
                        Text('No commitments',
                            textAlign: TextAlign.center,
                            style: ADText.statCaption(c: AD.textFaint)),
                    ]))),
          ))
      ]),
      const SizedBox(height: Msg.s3),
      Text(
          'Tap a day to inspect it, long press to change its hours. '
          '${availabilityHint(listingSelected: listingSelected)}',
          style: calSub(12)),
    ]);
  }

  // ── Agenda (A4: rendered exactly once) ───────────────────────────────────
  Widget _agendaPanel() {
    final blocks = _onDay(_selected);
    final slots = _slotsOnDay(_selected);
    final exceptions = _exceptionsFor(_selected);
    final listingSelected = _selectedListingId != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
            child: Text(
                calendarRangeLabel(
                    view: CalendarView.agenda, month: _month, selected: _selected),
                style: calTitle(19))),
        ZineLink('Edit day', onTap: () => _openDayEditor(_selected)),
      ]),
      const SizedBox(height: Msg.s1),
      calendarTimezoneNote(_timezone,
          deviceNote: 'your device is ${DateTime.now().timeZoneName}'),
      const SizedBox(height: Msg.s3),
      Text('Hours for this day', style: calTitle(15)),
      const SizedBox(height: Msg.s2),
      if (exceptions.isEmpty)
        Text('Your usual working hours apply.', style: calSub(13))
      else
        ...exceptions.map(_exceptionRow),
      const SizedBox(height: Msg.s2),
      Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
        ZineLink("Add another time", onTap: () => _openDayEditor(_selected)),
        if (exceptions.isNotEmpty)
          ZineLink('Use normal hours',
              underline: AD.textSecondary,
              onTap: () => _saveDayExceptions(
                  day: _selected, dayExceptions: const [], scopeListingId: _schedule?.listingId)),
      ]),
      const SizedBox(height: Msg.s3),
      if (blocks.isNotEmpty) ...[
        Text('Commitments', style: calTitle(15)),
        const SizedBox(height: Msg.s2),
        ...blocks.map(_blockCard),
      ],
      if (slots.isNotEmpty) ...[
        Text('Bookable slots', style: calTitle(15)),
        const SizedBox(height: Msg.s2),
        ...slots.map(_slotCard),
      ],
      if (blocks.isEmpty && slots.isEmpty)
        _emptyAgenda(listingSelected: listingSelected),
      if (!listingSelected) ...[
        const SizedBox(height: Msg.s2),
        Text(availabilityHint(listingSelected: false), style: calSub(12)),
      ],
    ]);
  }

  Widget _exceptionRow(AvailabilityException exception) {
    final range = exception.isAllDay || exception.looksLikeMidnightToMidnight
        ? 'All day'
        : minutesRangeLabel(exception.startMin, exception.endMin);
    final label = switch (exception.status) {
      AvailabilityExceptionStatus.available => "I'm available",
      AvailabilityExceptionStatus.unavailable => "I'm busy",
      AvailabilityExceptionStatus.reserved =>
        'Kept for ${_listingTitle(exception.listingId)}',
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: ZineCard(
        radius: Msg.rMd,
        boxShadow: Msg.none,
        padding:
            const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
        child: Row(children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text('$label · $range', style: calValue(14)),
              ])),
          ZineLink('Edit', onTap: () => _editSingleException(exception)),
          const SizedBox(width: Msg.s2),
          calendarIconAction(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.regular),
            color: AD.danger,
            tooltip: 'Remove this interval',
            onTap: () => _saveDayExceptions(
                day: _selected,
                dayExceptions:
                    removeException(_exceptionsFor(_selected), exception.id),
                scopeListingId: _schedule?.listingId),
          ),
        ]),
      ),
    );
  }

  Widget _emptyAgenda({required bool listingSelected}) {
    if (_loading) {
      return const Padding(
          padding: EdgeInsets.all(Msg.s5),
          child: Center(child: CircularProgressIndicator(color: Msg.accent)));
    }
    if (_schedule == null) {
      return calendarMessageCard(
          'Working hours are not configured yet. Add them in Availability settings to show bookable slots.',
          PhosphorIcons.clock(PhosphorIconsStyle.regular),
          AD.textSecondary);
    }
    return calendarMessageCard(
        listingSelected
            ? 'No bookings, blocks or exceptions are shown for this day.'
            : 'No bookings or blocks are shown for this day. Availability is unknown until a listing is selected.',
        PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular),
        AD.textSecondary);
  }

  Widget _blockCard(CalBlock block) {
    final style = styleFor(block.sourceApp);
    final statusLabel = blockStatusLabel(block);
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
          // Legacy AvaBooking rows keep their booking id; modern unified
          // reservations use the canonical booking_id the server resolved.
          bookingId: block.bookingId ??
              (block.sourceApp == 'avabooking' ? block.sourceRef : null),
          status: block.bookingStatus ??
              (block.sourceApp == 'avabooking' ? 'confirmed' : null),
          statusLabel: statusLabel,
          listingId: block.listingId,
          bookingKind: block.bookingKind,
          timezone: _timezone,
          ownedListingIds: {for (final listing in _listings) listing.id},
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
                    '${blockTimeLabel(startMs: block.startsAt, endMs: block.endsAt, timezone: _timezone)} · ${style.label}',
                    style: ADText.sectionLabel()),
                const SizedBox(height: 2),
                Text(block.title ?? style.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: calValue(14)),
                const SizedBox(height: 2),
                Text(statusLabel, style: ADText.statCaption(c: AD.textSecondary)),
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
                  style: calValue(14))),
          Text(free ? 'Open' : (slot.reason ?? 'Unavailable'),
              style: ADText.statCaption(c: free ? AD.online : AD.textTertiary)),
        ]),
      ),
    );
  }

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

  String _hm(DateTime date) => hm(date);

  // ── Day editing (findings 2, 3, A8) ──────────────────────────────────────
  Future<void> _openDayEditor(DateTime day, {bool startBlocked = false}) async {
    final result = await showCalendarDayEditor(
      context,
      day: day,
      timezone: _schedule?.timezone ?? _availability?.timezone,
      exceptions: _exceptionsFor(day),
      listings: _listings
          .where((listing) =>
              _selectedListingId == null || listing.id == _selectedListingId)
          .toList(),
      selectedListingId: _selectedListingId,
      startBlocked: startBlocked,
    );
    if (result == null || !mounted) return;
    await _applyDayEdit(day, result);
  }

  Future<void> _editSingleException(AvailabilityException exception) async {
    final day = _selected;
    final updated = await showCalendarExceptionDialog(
      context,
      day: day,
      initial: exception,
      defaultStatus: exception.status,
      listings: _listings,
      defaultListingId: exception.listingId ?? _selectedListingId,
      timezone: _timezone,
    );
    if (updated == null || !mounted) return;
    await _saveDayExceptions(
      day: day,
      dayExceptions: upsertException(_exceptionsFor(day), updated,
          replacingId: exception.id),
      scopeListingId: _schedule?.listingId,
    );
  }

  Future<void> _applyDayEdit(DateTime day, CalendarDayEditResult result) async {
    var schedule = _schedule;
    if (schedule == null) return;
    final scopeListingId = result.scopeListingId;
    if (schedule.listingId != scopeListingId) {
      // Scope and filter are separate (finding 9): blocking "All listings"
      // while a listing is filtered must write the creator-wide schedule.
      try {
        final shared = await AvailabilityApi.fetchSchedule();
        if (shared.listingId != scopeListingId) {
          if (mounted) {
            setState(() => _error =
                'That schedule scope could not be loaded. Pull to refresh and try again.');
          }
          return;
        }
        schedule = shared;
      } catch (e) {
        if (mounted) setState(() => _error = _friendlyError(e));
        return;
      }
    }

    var exceptions = replaceDateExceptions(
        schedule.exceptions, dateKey(day), result.exceptions);
    if (result.hasHolidayRange) {
      final confirmed = await _confirmHolidayRange(result);
      if (confirmed != true || !mounted) return;
      final additions = holidayRangeExceptions(
        from: result.holidayFrom!,
        to: result.holidayTo!,
      ).where((row) => row.date != dateKey(day)).toList(growable: false);
      exceptions = mergeExceptions(exceptions, additions);
    }
    final tooMany = validateExceptionCount(exceptions.length);
    if (tooMany != null) {
      if (mounted) setState(() => _error = tooMany);
      return;
    }
    await _persistExceptions(schedule, exceptions, day);
  }

  /// Adding a range can touch days that already hold confirmed appointments:
  /// list them and make it explicit that AvaTOK will not cancel anything.
  Future<bool?> _confirmHolidayRange(CalendarDayEditResult result) {
    final from = dayBoundsUtcMs(result.holidayFrom!, _timezone)?.from ??
        DateTime.utc(result.holidayFrom!.year, result.holidayFrom!.month,
                result.holidayFrom!.day)
            .millisecondsSinceEpoch;
    final to = dayBoundsUtcMs(result.holidayTo!, _timezone)?.to ??
        DateTime.utc(result.holidayTo!.year, result.holidayTo!.month,
                result.holidayTo!.day + 1)
            .millisecondsSinceEpoch;
    final affected = _blocks
        .where((block) => block.startsAt < to && block.endsAt > from)
        .toList(growable: false);
    return showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl)),
        title: Text('Block this range?', style: calTitle(17)),
        content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                  '${result.holidayFrom!.day} ${monthShort(result.holidayFrom!)} – '
                  '${result.holidayTo!.day} ${monthShort(result.holidayTo!)} will be blocked across '
                  '${result.scopeListingId == null ? 'all your listings' : _listingTitle(result.scopeListingId)}.',
                  style: calSub(13)),
              if (affected.isEmpty) ...[
                const SizedBox(height: Msg.s3),
                Text('No existing commitments fall inside this range.',
                    style: calSub(13)),
              ] else ...[
                const SizedBox(height: Msg.s3),
                Text(
                    '${affected.length} existing commitment(s) fall inside this range:',
                    style: calValue(13)),
                const SizedBox(height: Msg.s2),
                ...affected.take(6).map((block) => Text(
                    '· ${fmtDate(block.startsAt)} ${blockTimeLabel(startMs: block.startsAt, endMs: block.endsAt, timezone: _timezone)} ${styleFor(block.sourceApp).label}',
                    style: calSub(12))),
                const SizedBox(height: Msg.s2),
                Text(
                    'AvaTOK never cancels a confirmed booking automatically. Reschedule or cancel each one individually.',
                    style: calSub(12, c: AD.danger)),
              ],
            ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text('Back', style: calLinkStyle)),
          ZineButton(
              label: 'Block range',
              variant: ZineButtonVariant.blue,
              fontSize: 14,
              onPressed: () => Navigator.pop(dialogContext, true)),
        ],
      ),
    );
  }

  Future<void> _saveDayExceptions({
    required DateTime day,
    required List<AvailabilityException> dayExceptions,
    String? scopeListingId,
  }) async {
    final schedule = _schedule;
    if (schedule == null) return;
    if (schedule.listingId != scopeListingId) {
      await _applyDayEdit(
        day,
        CalendarDayEditResult(
            exceptions: dayExceptions, scopeListingId: scopeListingId),
      );
      return;
    }
    final exceptions =
        replaceDateExceptions(schedule.exceptions, dateKey(day), dayExceptions);
    final tooMany = validateExceptionCount(exceptions.length);
    if (tooMany != null) {
      if (mounted) setState(() => _error = tooMany);
      return;
    }
    await _persistExceptions(schedule, exceptions, day);
  }

  Future<void> _persistExceptions(AvailabilitySchedule schedule,
      List<AvailabilityException> exceptions, DateTime day) async {
    try {
      final saved =
          await AvailabilityApi.saveSchedule(schedule.copyWith(exceptions: exceptions));
      if (!mounted) return;
      if (saved.listingId == _selectedListingId) {
        setState(() {
          _schedule = saved;
          _error = null;
        });
      } else {
        setState(() => _error = null);
      }
      await _loadData(showBusy: false);
      if (!mounted) return;
      final scope = saved.listingId == null
          ? 'all your listings'
          : _listingTitle(saved.listingId);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'Saved — ${day.day} ${monthShort(day)} now follows these hours for $scope.')));
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    }
  }
}
