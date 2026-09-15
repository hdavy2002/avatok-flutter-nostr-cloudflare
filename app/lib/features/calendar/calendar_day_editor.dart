// The day editor (audit findings 2, 3, A8).
//
// Before this, one date could only ever hold ONE exception: the editor loaded
// the first row for the day and saving replaced it, so a second break silently
// overwrote the first. Block time also opened in whatever state the stored row
// happened to have, whole-day blocks were rendered as midnight–midnight, and
// there was no way to block a holiday range or to remove an interval.
//
// This sheet lists EVERY interval for the day with its own Edit/Remove, adds
// explicit "I'm busy" / "I'm available" / "Keep this time for a listing" and
// "All day" actions, and reports the whole day-set back to the diary so
// unrelated exceptions are never dropped.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'calendar_data.dart';
import 'calendar_logic.dart';
import 'calendar_ui.dart';

/// What one day edit means, expressed so the diary can apply it to the CORRECT
/// schedule without ever transplanting a whole date between scopes.
///
/// [delta] names only the intervals the creator actually added, edited or
/// removed, and was derived against the scope whose schedule was loaded.
/// [dayExceptions] is the intended full set for the day in that scope, used for
/// the holiday-range preview. [scopeLoaded] is false when the sheet could not
/// prove it was editing the target scope, in which case the diary refuses to
/// save under that scope.
class CalendarDayEditResult {
  final String? scopeListingId;
  final DayEditDelta delta;
  final List<AvailabilityException> dayExceptions;
  final bool scopeLoaded;
  final DateTime? holidayFrom;
  final DateTime? holidayTo;

  const CalendarDayEditResult({
    required this.delta,
    required this.dayExceptions,
    this.scopeListingId,
    this.scopeLoaded = true,
    this.holidayFrom,
    this.holidayTo,
  });

  bool get hasHolidayRange => holidayFrom != null && holidayTo != null;
}

/// Loads the day's intervals from ONE schedule scope. The diary supplies this
/// so switching "All listings" / "Only this listing" inside the sheet shows the
/// target's real saved hours BEFORE anything is edited.
typedef CalendarScopeLoader = Future<List<AvailabilityException>> Function(
    String? listingId);

Future<CalendarDayEditResult?> showCalendarDayEditor(
  BuildContext context, {
  required DateTime day,
  required String? timezone,
  required List<AvailabilityException> exceptions,
  required List<ListingCard> listings,
  required String? selectedListingId,
  int? horizonDays,
  CalendarScopeLoader? loadScope,
  bool startBlocked = false,
}) =>
    showModalBottomSheet<CalendarDayEditResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: Msg.brSheetTop,
        side: BorderSide(color: AD.borderHairline, width: 1),
      ),
      builder: (_) => CalendarDayEditorSheet(
        day: day,
        timezone: timezone,
        exceptions: exceptions,
        listings: listings,
        selectedListingId: selectedListingId,
        horizonDays: horizonDays,
        loadScope: loadScope,
        startBlocked: startBlocked,
      ),
    );

class CalendarDayEditorSheet extends StatefulWidget {
  const CalendarDayEditorSheet({
    super.key,
    required this.day,
    required this.timezone,
    required this.exceptions,
    required this.listings,
    required this.selectedListingId,
    this.horizonDays,
    this.loadScope,
    this.startBlocked = false,
  });

  final DateTime day;
  final String? timezone;
  final List<AvailabilityException> exceptions;
  final List<ListingCard> listings;
  final String? selectedListingId;
  final int? horizonDays;
  final CalendarScopeLoader? loadScope;
  final bool startBlocked;

  @override
  State<CalendarDayEditorSheet> createState() => _CalendarDayEditorSheetState();
}

class _CalendarDayEditorSheetState extends State<CalendarDayEditorSheet> {
  /// The scope whose schedule is currently on screen. It only ever changes
  /// after that scope's schedule has been LOADED (review item 1).
  late String? _scopeListingId = widget.selectedListingId;

  /// The intervals the loaded scope held when it was displayed. The delta is
  /// always computed against this, never against another scope's rows.
  late List<AvailabilityException> _baseExceptions =
      List<AvailabilityException>.from(widget.exceptions);

  late List<AvailabilityException> _exceptions =
      List<AvailabilityException>.from(widget.exceptions);

  bool _scopeLoaded = true;
  bool _loadingScope = false;
  String? _scopeError;
  bool _dirty = false;
  int _localCounter = 0;
  DateTime? _holidayFrom;
  DateTime? _holidayTo;

  @override
  void initState() {
    super.initState();
    if (widget.startBlocked && _exceptions.isEmpty) {
      // A8 — "Block time" must land in a blocked state, not in whatever state a
      // stored interval happened to have.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _addInterval(AvailabilityExceptionStatus.unavailable);
      });
    }
  }

  String get _key => dateKey(widget.day);

  String _listingTitle(String? id) {
    for (final listing in widget.listings) {
      if (listing.id == id) return listing.title;
    }
    return 'this listing';
  }

  @override
  Widget build(BuildContext context) {
    final timezone = widget.timezone;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s4),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                            '${weekdayShort(widget.day)} ${widget.day.day} ${monthShort(widget.day)}',
                            style: calTitle(19)),
                        const SizedBox(height: 2),
                        calendarTimezoneNote(timezone),
                      ]),
                ),
                ZineBackButton(
                    icon: PhosphorIcons.x(PhosphorIconsStyle.regular),
                    onTap: () => Navigator.pop(context)),
              ]),
              const SizedBox(height: Msg.s3),
              Text(
                  'Blocking applies to every listing by default. Choose "Only this '
                  'listing" to change just one listing’s schedule. Switching scope '
                  'loads that schedule before you edit it, so nothing is copied '
                  'between them.',
                  style: calSub(13)),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
                ZineChip(
                    label: 'All listings',
                    active: _scopeListingId == null,
                    onTap: _loadingScope
                        ? null
                        : () => _switchScope(null, 'All listings')),
                if (widget.selectedListingId != null)
                  ZineChip(
                      label: 'Only this listing',
                      active: _scopeListingId != null,
                      onTap: _loadingScope
                          ? null
                          : () => _switchScope(
                              widget.selectedListingId, _listingTitle(widget.selectedListingId))),
              ]),
              if (_loadingScope) ...[
                const SizedBox(height: Msg.s2),
                Text('Loading that schedule…', style: calSub(12)),
              ],
              if (_scopeError != null) ...[
                const SizedBox(height: Msg.s2),
                Text(_scopeError!, style: calSub(12, c: AD.danger)),
              ],
              const SizedBox(height: Msg.s4),
              Text('This day', style: calTitle(16)),
              const SizedBox(height: Msg.s2),
              Text(
                  _scopeListingId == null
                      ? 'Showing your shared calendar hours.'
                      : 'Showing the saved hours for ${_listingTitle(_scopeListingId)} only.',
                  style: ADText.statCaption(c: AD.textSecondary)),
              const SizedBox(height: Msg.s2),
              if (_exceptions.isEmpty)
                Text('Your usual working hours apply.', style: calSub(13))
              else
                ..._exceptions.map(_exceptionRow),
              const SizedBox(height: Msg.s3),
              Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
                ZineButton(
                    label: "I'm busy",
                    variant: ZineButtonVariant.blue,
                    fontSize: 14,
                    icon: PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
                    trailingIcon: false,
                    onPressed: () =>
                        _addInterval(AvailabilityExceptionStatus.unavailable)),
                ZineButton(
                    label: "I'm available",
                    variant: ZineButtonVariant.ghost,
                    fontSize: 14,
                    icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.regular),
                    trailingIcon: false,
                    onPressed: () =>
                        _addInterval(AvailabilityExceptionStatus.available)),
                if (widget.listings.isNotEmpty)
                  ZineButton(
                      label: 'Keep time for a listing',
                      variant: ZineButtonVariant.ghost,
                      fontSize: 14,
                      icon: PhosphorIcons.tag(PhosphorIconsStyle.regular),
                      trailingIcon: false,
                      onPressed: () =>
                          _addInterval(AvailabilityExceptionStatus.reserved)),
              ]),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
                ZineButton(
                    label: 'Block the whole day',
                    variant: ZineButtonVariant.ghost,
                    fontSize: 13,
                    icon: PhosphorIcons.calendarX(PhosphorIconsStyle.regular),
                    trailingIcon: false,
                    onPressed: _blockWholeDay),
                ZineButton(
                    label: 'Block a date range',
                    variant: ZineButtonVariant.ghost,
                    fontSize: 13,
                    icon: PhosphorIcons.calendarPlus(PhosphorIconsStyle.regular),
                    trailingIcon: false,
                    onPressed: _pickHolidayRange),
                if (_exceptions.isNotEmpty)
                  ZineButton(
                      label: 'Use normal hours',
                      variant: ZineButtonVariant.ghost,
                      fontSize: 13,
                      icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
                      trailingIcon: false,
                      onPressed: () => setState(() {
                            _exceptions = <AvailabilityException>[];
                            _dirty = true;
                          })),
              ]),
              if (_holidayFrom != null && _holidayTo != null) ...[
                const SizedBox(height: Msg.s3),
                calendarMessageCard(
                  'Holiday: ${_holidayFrom!.day} ${monthShort(_holidayFrom!)} – '
                  '${_holidayTo!.day} ${monthShort(_holidayTo!)} · whole days blocked. '
                  'Existing appointments are never cancelled automatically.',
                  PhosphorIcons.calendarPlus(PhosphorIconsStyle.regular),
                  AD.haldi,
                ),
                const SizedBox(height: Msg.s2),
                ZineLink('Remove range',
                    onTap: () => setState(() {
                          _holidayFrom = null;
                          _holidayTo = null;
                          _dirty = true;
                        })),
              ],
              const SizedBox(height: Msg.s4),
              ZineButton(
                  label: 'Save changes',
                  variant: ZineButtonVariant.blue,
                  fontSize: 16,
                  fullWidth: true,
                  // A fetch failure or an unloaded scope can never save: that is
                  // exactly how a listing's rows used to end up in the shared
                  // calendar (review item 1).
                  onPressed: _scopeLoaded && !_loadingScope
                      ? () => Navigator.pop(
                            context,
                            CalendarDayEditResult(
                              delta: dayEditDelta(
                                  date: _key,
                                  before: _baseExceptions,
                                  after: _exceptions),
                              dayExceptions: _exceptions,
                              scopeListingId: _scopeListingId,
                              scopeLoaded: _scopeLoaded,
                              holidayFrom: _holidayFrom,
                              holidayTo: _holidayTo,
                            ),
                          )
                      : null),
            ],
          ),
        ),
      ),
    );
  }

  Widget _exceptionRow(AvailabilityException exception) {
    final statusLabel = switch (exception.status) {
      AvailabilityExceptionStatus.available => "I'm available",
      AvailabilityExceptionStatus.unavailable => "I'm busy",
      AvailabilityExceptionStatus.reserved =>
        'Kept for ${_listingTitle(exception.listingId)}',
    };
    final range = exception.isAllDay || exception.looksLikeMidnightToMidnight
        ? 'All day'
        : minutesRangeLabel(exception.startMin, exception.endMin);
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
                  Text(statusLabel, style: calValue(14)),
                  const SizedBox(height: 2),
                  Text(range, style: ADText.statCaption(c: AD.textSecondary)),
                ]),
          ),
          ZineLink('Edit', onTap: () => _editInterval(exception)),
          const SizedBox(width: Msg.s2),
          calendarIconAction(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.regular),
            color: AD.danger,
            tooltip: 'Remove this interval',
            onTap: () => setState(() {
              _exceptions = removeException(_exceptions, exception.id);
              _dirty = true;
            }),
          ),
        ]),
      ),
    );
  }

  /// Switches the editing scope by LOADING that scope's saved intervals for the
  /// day first. The delta is then derived against the target's own rows.
  Future<void> _switchScope(String? listingId, String label) async {
    if (listingId == _scopeListingId) return;
    final loader = widget.loadScope;
    if (loader == null) {
      setState(() => _scopeError =
          'That schedule could not be loaded, so this sheet stays on the scope it already has.');
      return;
    }
    if (_dirty) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          backgroundColor: AD.card,
          shape: RoundedRectangleBorder(
              borderRadius: Msg.brLg,
              side: const BorderSide(color: AD.borderControl)),
          title: Text('Switch to $label?', style: calTitle(17)),
          content: Text(
              'Your unsaved changes here belong to the current schedule. Switching '
              'loads $label’s own hours, so those changes will be discarded rather '
              'than copied across.',
              style: calSub(13)),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text('Keep editing', style: calLinkStyle)),
            ZineButton(
                label: 'Switch scope',
                variant: ZineButtonVariant.blue,
                fontSize: 14,
                onPressed: () => Navigator.pop(dialogContext, true)),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }
    setState(() {
      _loadingScope = true;
      _scopeError = null;
    });
    try {
      final loaded = await loader(listingId);
      if (!mounted) return;
      setState(() {
        _scopeListingId = listingId;
        _baseExceptions = List<AvailabilityException>.from(loaded);
        _exceptions = List<AvailabilityException>.from(loaded);
        _scopeLoaded = true;
        _loadingScope = false;
        _dirty = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingScope = false;
        _scopeLoaded = false;
        _scopeError =
            'Could not load that schedule. Nothing was switched, and saving is paused so '
            'these changes cannot land in the wrong schedule.';
      });
    }
  }

  Future<void> _addInterval(AvailabilityExceptionStatus status) async {
    final created = await showCalendarExceptionDialog(
      context,
      day: widget.day,
      defaultStatus: status,
      listings: widget.listings,
      defaultListingId: widget.selectedListingId,
      timezone: widget.timezone,
    );
    if (created == null || !mounted) return;
    setState(() {
      _localCounter++;
      _exceptions = upsertException(_exceptions,
          created.copyWith(id: 'local:$_localCounter'));
      _dirty = true;
    });
  }

  Future<void> _editInterval(AvailabilityException exception) async {
    final updated = await showCalendarExceptionDialog(
      context,
      day: widget.day,
      initial: exception,
      defaultStatus: exception.status,
      listings: widget.listings,
      defaultListingId: widget.selectedListingId,
      timezone: widget.timezone,
    );
    if (updated == null || !mounted) return;
    setState(() {
      // A row added in this sheet keeps its provisional id so it stays
      // addressable; the server assigns the real id on save.
      final id = exception.id.isEmpty
          ? 'local:${++_localCounter}'
          : exception.id;
      _exceptions = upsertException(_exceptions, updated.copyWith(id: id),
          replacingId: exception.id.isEmpty ? id : exception.id);
      _dirty = true;
    });
  }

  void _blockWholeDay() {
    setState(() {
      _localCounter++;
      _exceptions = upsertException(
        _exceptions,
        AvailabilityException(
          id: 'local:$_localCounter',
          date: _key,
          startMin: AvailabilityException.allDayStartMin,
          endMin: AvailabilityException.allDayEndMin,
          status: AvailabilityExceptionStatus.unavailable,
        ),
      );
      _dirty = true;
    });
  }

  Future<void> _pickHolidayRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 3),
      initialDateRange: DateTimeRange(
          start: widget.day, end: widget.day.add(const Duration(days: 6))),
      helpText: 'Block every day in this range',
      saveText: 'Use range',
    );
    if (picked == null || !mounted) return;
    final days = picked.end.difference(picked.start).inDays + 1;
    if (days > kMaxHorizonDays) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'Choose a shorter range — at most $kMaxHorizonDays days at a time.')));
      return;
    }
    final horizon = widget.horizonDays;
    if (horizon != null &&
        horizon >= 1 &&
        horizon <= kMaxHorizonDays &&
        days > horizon) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'This schedule can be booked $horizon day(s) ahead, so a $days-day '
              'holiday goes past it. Shorten the range or raise the booking horizon.')));
      return;
    }
    setState(() {
      _holidayFrom = picked.start;
      _holidayTo = picked.end;
      _dirty = true;
    });
  }
}

/// Add/edit ONE interval on one date. All-day is explicit; the end of day is
/// minute 1440 and is never rewritten to minute 0.
Future<AvailabilityException?> showCalendarExceptionDialog(
  BuildContext context, {
  required DateTime day,
  required AvailabilityExceptionStatus defaultStatus,
  required List<ListingCard> listings,
  String? defaultListingId,
  String? timezone,
  AvailabilityException? initial,
}) =>
    showDialog<AvailabilityException>(
      context: context,
      builder: (_) => CalendarIntervalDialog(
        day: day,
        initial: initial,
        defaultStatus: defaultStatus,
        listings: listings,
        defaultListingId: defaultListingId,
        timezone: timezone,
      ),
    );

class CalendarIntervalDialog extends StatefulWidget {
  const CalendarIntervalDialog({
    super.key,
    required this.day,
    required this.defaultStatus,
    required this.listings,
    this.initial,
    this.defaultListingId,
    this.timezone,
  });

  final DateTime day;
  final AvailabilityException? initial;
  final AvailabilityExceptionStatus defaultStatus;
  final List<ListingCard> listings;
  final String? defaultListingId;
  final String? timezone;

  @override
  State<CalendarIntervalDialog> createState() => _CalendarIntervalDialogState();
}

class _CalendarIntervalDialogState extends State<CalendarIntervalDialog> {
  late AvailabilityExceptionStatus _status;
  late bool _allDay;

  /// Explicit, INDEPENDENT of [_allDay]: a partial 18:00→24:00 interval must
  /// keep the server's 1440 end-of-day value. Stored as 1440 and read back as
  /// "end of day" instead of collapsing to midnight-of-the-next-day (00:00),
  /// which the server rejects as an end before the start.
  late bool _endOfDay;
  late TimeOfDay _start;
  late TimeOfDay _end;
  String? _listingId;
  String? _error;

  @override
  void initState() {
    super.initState();
    final initial = widget.initial;
    _status = initial?.status ?? widget.defaultStatus;
    _allDay = initial?.isAllDay ?? initial?.looksLikeMidnightToMidnight ?? false;
    final startMin = initial?.startMin ?? 9 * 60;
    final endMin = (initial == null || initial.endMin <= initial.startMin)
        ? 17 * 60
        : initial.endMin;
    _endOfDay = endMin >= AvailabilityException.allDayEndMin;
    _start = TimeOfDay(hour: startMin ~/ 60, minute: startMin % 60);
    _end = TimeOfDay(
        hour: _endOfDay ? 17 : (endMin ~/ 60) % 24,
        minute: _endOfDay ? 0 : endMin % 60);
    _listingId = initial?.listingId ?? widget.defaultListingId;
  }

  @override
  Widget build(BuildContext context) {
    final reserved = _status == AvailabilityExceptionStatus.reserved;
    return AlertDialog(
      backgroundColor: AD.card,
      shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderControl, width: 1)),
      title: Text(
          '${weekdayShort(widget.day)} ${widget.day.day} ${monthShort(widget.day)}',
          style: calTitle(17)),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
              ZineChip(
                  label: "I'm busy",
                  active: _status == AvailabilityExceptionStatus.unavailable,
                  onTap: () => setState(() {
                        _status = AvailabilityExceptionStatus.unavailable;
                        _error = null;
                      })),
              ZineChip(
                  label: "I'm available",
                  active: _status == AvailabilityExceptionStatus.available,
                  onTap: () => setState(() {
                        _status = AvailabilityExceptionStatus.available;
                        _error = null;
                      })),
              if (widget.listings.isNotEmpty)
                ZineChip(
                    label: 'Keep for a listing',
                    active: reserved,
                    onTap: () => setState(() {
                          _status = AvailabilityExceptionStatus.reserved;
                          _listingId = _listingId ?? widget.defaultListingId;
                          _error = null;
                        })),
            ]),
            const SizedBox(height: Msg.s3),
            ZineCard(
              radius: Msg.rMd,
              boxShadow: Msg.none,
              padding: const EdgeInsets.symmetric(
                  horizontal: Msg.s3, vertical: Msg.s2),
              onTap: () => setState(() {
                _allDay = !_allDay;
                _error = null;
              }),
              child: Row(children: [
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text('All day', style: calValue(15)),
                      const SizedBox(height: 2),
                      Text('Blocks minute 0 through end of day (1440).',
                          style: ADText.statCaption(c: AD.textSecondary)),
                    ])),
                ZineToggle(
                    value: _allDay,
                    onChanged: (value) => setState(() {
                          _allDay = value;
                          _error = null;
                        })),
              ]),
            ),
            if (!_allDay) ...[
              const SizedBox(height: Msg.s3),
              Row(children: [
                Expanded(
                    child: _timeTile('From', _start,
                        (value) => setState(() {
                              _start = value;
                              _error = null;
                            }))),
                const SizedBox(width: Msg.s2),
                Expanded(
                    child: _endOfDay
                        ? _readOnlyTile('To', '24:00 · end of day')
                        : _timeTile('To', _end,
                            (value) => setState(() {
                                  _end = value;
                                  _error = null;
                                }))),
              ]),
              const SizedBox(height: Msg.s2),
              ZineCard(
                radius: Msg.rMd,
                boxShadow: Msg.none,
                padding: const EdgeInsets.symmetric(
                    horizontal: Msg.s3, vertical: Msg.s2),
                onTap: () => setState(() {
                  _endOfDay = !_endOfDay;
                  _error = null;
                }),
                child: Row(children: [
                  Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text('Ends at midnight', style: calValue(15)),
                        const SizedBox(height: 2),
                        Text(
                            'Keeps the end-of-day value (1440) for a partial interval, '
                            'so an evening block or late working hours save correctly.',
                            style: ADText.statCaption(c: AD.textSecondary)),
                      ])),
                  ZineToggle(
                      value: _endOfDay,
                      onChanged: (value) => setState(() {
                            _endOfDay = value;
                            _error = null;
                          })),
                ]),
              ),
            ],
            if (reserved) ...[
              const SizedBox(height: Msg.s3),
              ZineDropdown<String>(
                  label: 'Kept for',
                  // A stored listing that is not in the current filter would
                  // crash a DropdownButton with a value outside its items.
                  value: _listingId != null &&
                          widget.listings.any((l) => l.id == _listingId)
                      ? _listingId
                      : null,
                  hint: 'Choose a listing',
                  items: widget.listings
                      .map((listing) => DropdownMenuItem(
                          value: listing.id, child: Text(listing.title)))
                      .toList(),
                  onChanged: (value) => setState(() {
                        _listingId = value;
                        _error = null;
                      })),
            ],
            if (_error != null) ...[
              const SizedBox(height: Msg.s3),
              Text(_error!, style: calSub(13, c: AD.danger)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text('Cancel', style: calLinkStyle)),
        ZineButton(
          label: 'Save',
          variant: ZineButtonVariant.blue,
          fontSize: 14,
          onPressed: _save,
        ),
      ],
    );
  }

  void _save() {
    final startMin = _allDay
        ? AvailabilityException.allDayStartMin
        : pickedMinutes(endOfDay: false, hour: _start.hour, minute: _start.minute);
    final endMin = _allDay
        ? AvailabilityException.allDayEndMin
        : pickedMinutes(endOfDay: _endOfDay, hour: _end.hour, minute: _end.minute);
    final rangeError = pickedRangeError(startMin, endMin);
    if (rangeError != null) {
      setState(() => _error = rangeError);
      return;
    }
    if (_status == AvailabilityExceptionStatus.reserved &&
        (_listingId == null || _listingId!.isEmpty)) {
      setState(() => _error = 'Choose which listing keeps this time.');
      return;
    }
    Navigator.pop(
      context,
      AvailabilityException(
        id: widget.initial?.id ?? '',
        date: dateKey(widget.day),
        startMin: startMin,
        endMin: endMin,
        status: _status,
        listingId: _status == AvailabilityExceptionStatus.reserved
            ? _listingId
            : null,
      ),
    );
  }

  Widget _readOnlyTile(String label, String value) => ZineCard(
      radius: Msg.rMd,
      boxShadow: Msg.none,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: ADText.sectionLabel()),
        const SizedBox(height: 2),
        Text(value, style: calValue(15)),
      ]));

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
            Text(value.format(context), style: calValue(15)),
          ]));
}

/// Numeric policy editor with INLINE validation (A3): Save stays disabled and
/// the allowed range is explained before the dialog closes, so an invalid value
/// never reaches the server.
Future<void> showCalendarNumberDialog(
  BuildContext context, {
  required String title,
  required String helper,
  required int? initialValue,
  required String? Function(int? value) validate,
  required int min,
  required int max,
  required ValueChanged<int> onSave,
}) async {
  final controller = TextEditingController(
      text: initialValue == null ? '' : '$initialValue');
  final result = await showDialog<int>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (context, setState) {
        final parsed =
            controller.text.trim().isEmpty ? null : int.tryParse(controller.text.trim());
        final error = validate(parsed);
        return AlertDialog(
          backgroundColor: AD.card,
          shape: RoundedRectangleBorder(
              borderRadius: Msg.brLg,
              side: const BorderSide(color: AD.borderControl)),
          title: Text(title, style: calTitle(17)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(helper, style: calSub(13)),
            const SizedBox(height: Msg.s3),
            ZineField(
              controller: controller,
              keyboardType: TextInputType.number,
              autofocus: true,
              error: error != null,
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: Msg.s2),
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                error ?? 'Allowed: $min–$max.',
                style: calSub(12, c: error == null ? AD.textSecondary : AD.danger),
              ),
            ),
          ]),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: Text('Cancel', style: calLinkStyle)),
            ZineButton(
                label: 'Save',
                variant: ZineButtonVariant.blue,
                fontSize: 14,
                onPressed: error == null
                    ? () => Navigator.pop(dialogContext, parsed)
                    : null),
          ],
        );
      },
    ),
  );
  if (result != null) onSave(result);
}
