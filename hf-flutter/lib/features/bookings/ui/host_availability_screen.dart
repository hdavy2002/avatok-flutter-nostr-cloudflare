import 'package:flutter/material.dart';
import '../../../core/config/flags.dart';
import 'booking_unavailable_screen.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/hf_booking_models.dart';
import '../data/hf_bookings_providers.dart';
import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';

class HostAvailabilityScreen extends ConsumerStatefulWidget {
  const HostAvailabilityScreen({super.key});
  @override
  ConsumerState<HostAvailabilityScreen> createState() => _HostAvailabilityScreenState();
}

class _HostAvailabilityScreenState extends ConsumerState<HostAvailabilityScreen> {
  BookingSchedule? _draft;
  bool _saving = false;
  bool _reloadRequired = false;
  bool _legacyImported = false;
  bool _legacyTimezoneConfirmed = false;
  String? _error;
  static const _days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  Future<void> _editTime(int index, {required bool start}) async {
    final schedule = _draft!;
    final row = schedule.rules[index];
    final currentMin = start ? row.startMin : row.endMin;
    final initial = currentMin == 1440
        ? const TimeOfDay(hour: 23, minute: 59)
        : TimeOfDay(hour: currentMin ~/ 60, minute: currentMin % 60);
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked == null || !mounted) return;
    final minute = !start && picked.hour == 0 && picked.minute == 0
        ? 1440
        : picked.hour * 60 + picked.minute;
    final rows = [...schedule.rules];
    rows[index] = BookingWindow(
      weekday: row.weekday, startMin: start ? minute : row.startMin,
      endMin: start ? row.endMin : minute,
    );
    setState(() => _draft = _copy(schedule, rules: rows));
  }

  BookingSchedule _copy(
    BookingSchedule s, {
    String? timezone,
    List<int>? durationsMinutes,
    int? slotIntervalMinutes,
    int? bufferMinutes,
    int? minNoticeMinutes,
    int? horizonDays,
    List<BookingWindow>? rules,
    List<BookingException>? exceptions,
    LegacyAvailabilityPreview? legacyPreview,
  }) => BookingSchedule(
    timezone: timezone ?? s.timezone, version: s.version,
    durationsMinutes: durationsMinutes ?? s.durationsMinutes,
    slotIntervalMinutes: slotIntervalMinutes ?? s.slotIntervalMinutes,
    bufferMinutes: bufferMinutes ?? s.bufferMinutes,
    minNoticeMinutes: minNoticeMinutes ?? s.minNoticeMinutes,
    horizonDays: horizonDays ?? s.horizonDays,
    rules: rules ?? s.rules, exceptions: exceptions ?? s.exceptions,
    legacyPreview: legacyPreview ?? s.legacyPreview,
  );

  Future<void> _editTimezone() async {
    final controller = TextEditingController(text: _draft!.timezone);
    String? errorText;
    final zone = await showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(builder: (context, setDialogState) => AlertDialog(
        title: const Text('Enter IANA time zone'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(
            labelText: 'Time zone',
            hintText: 'Asia/Kolkata',
            helperText: 'Use an IANA name such as Europe/Paris or America/Chicago.',
            errorText: errorText,
          ),
          textCapitalization: TextCapitalization.none,
          autocorrect: false,
          enableSuggestions: false,
          onChanged: (_) {
            if (errorText != null) setDialogState(() => errorText = null);
          },
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final value = controller.text.trim();
              final validShape = RegExp(r'^[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+.-]+)*$').hasMatch(value) &&
                  !value.contains('..') && value != '.' && value != '..';
              if (!validShape) {
                setDialogState(() => errorText = 'Enter a valid IANA time zone name.');
                return;
              }
              Navigator.pop(context, value);
            },
            child: const Text('Use time zone'),
          ),
        ],
      )),
    );
    controller.dispose();
    if (zone == null || !mounted) return;
    setState(() {
      _draft = _copy(_draft!, timezone: zone);
      _legacyTimezoneConfirmed = false;
      _error = null;
    });
  }

  void _addWindow({required int weekday}) {
    final s = _draft!;
    final day = weekday;
    setState(() => _draft = _copy(s, rules: [...s.rules, BookingWindow(weekday: day, startMin: 540, endMin: 1020)]));
  }

  Future<void> _toggleDay(int weekday) async {
    final s = _draft!;
    final rows = [...s.rules];
    if (rows.any((r) => r.weekday == weekday)) {
      rows.removeWhere((r) => r.weekday == weekday);
    } else {
      rows.add(BookingWindow(weekday: weekday, startMin: 540, endMin: 1020));
    }
    rows.sort((a,b) => a.weekday.compareTo(b.weekday));
    setState(() => _draft = _copy(s, rules: rows));
  }

  Future<void> _toggleException() async {
    final s = _draft!;
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(Duration(days: s.horizonDays)),
      initialDateRange: DateTimeRange(
        start: DateTime.now().add(const Duration(days: 1)),
        end: DateTime.now().add(const Duration(days: 1)),
      ),
    );
    if (picked == null || !mounted) return;
    final mode = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(title: const Text('Block selected dates'), onTap: () => Navigator.pop(context, 'unavailable')),
          ListTile(title: const Text('Add available hours'), onTap: () => Navigator.pop(context, 'available')),
        ],
      )),
    );
    if (mode == null || !mounted) return;

    int? startMin;
    int? endMin;
    if (mode == 'available') {
      final start = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 9, minute: 0));
      if (start == null || !mounted) return;
      final end = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 17, minute: 0));
      if (end == null || !mounted) return;
      startMin = start.hour * 60 + start.minute;
      endMin = end.hour * 60 + end.minute;
      if (endMin == startMin) {
        setState(() => _error = 'The override needs a non-zero time window.');
        return;
      }
    }

    final rows = [...s.exceptions];
    var day = DateTime(picked.start.year, picked.start.month, picked.start.day);
    final last = DateTime(picked.end.year, picked.end.month, picked.end.day);
    while (!day.isAfter(last)) {
      final date = _dateKey(day);
      if (mode == 'unavailable') {
        rows.removeWhere((item) => item.date == date);
        rows.add(BookingException(date: date, status: 'unavailable', startMin: 0, endMin: 1440));
      } else {
        rows.removeWhere((item) => item.date == date && item.status == 'unavailable');
        if (endMin! > startMin!) {
          rows.removeWhere((item) => item.date == date && item.status == 'available' &&
              item.startMin == startMin && item.endMin == endMin);
          rows.add(BookingException(date: date, status: 'available', startMin: startMin, endMin: endMin));
        } else {
          rows.removeWhere((item) => item.date == date && item.status == 'available' &&
              item.startMin == startMin && item.endMin == 1440);
          rows.add(BookingException(date: date, status: 'available', startMin: startMin, endMin: 1440));
          final next = DateTime(day.year, day.month, day.day + 1);
          final nextDate = _dateKey(next);
          rows.removeWhere((item) => item.date == nextDate && item.status == 'unavailable');
          rows.removeWhere((item) => item.date == nextDate && item.status == 'available' &&
              item.startMin == 0 && item.endMin == endMin);
          rows.add(BookingException(date: nextDate, status: 'available', startMin: 0, endMin: endMin));
        }
      }
      day = DateTime(day.year, day.month, day.day + 1);
    }
    setState(() { _draft = _copy(s, exceptions: rows); _error = null; });
  }

  String _dateKey(DateTime day) =>
      '${day.year.toString().padLeft(4, '0')}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';

  String _exceptionLabel(BookingException item) {
    if (item.status == 'unavailable' || item.startMin == null || item.endMin == null) return '${item.date} · blocked';
    String clock(int minute) => '${(minute ~/ 60).toString().padLeft(2, '0')}:${(minute % 60).toString().padLeft(2, '0')}';
    return '${item.date} · ${clock(item.startMin!)}–${clock(item.endMin!)}';
  }

  void _reloadSchedule() {
    setState(() {
      _draft = null;
      _reloadRequired = false;
      _legacyImported = false;
      _legacyTimezoneConfirmed = false;
      _error = null;
    });
    ref.invalidate(hostAvailabilityProvider);
  }

  void _toggleDuration(BookingSchedule schedule, int duration, bool selected) {
    final values = [...schedule.durationsMinutes];
    if (selected && !values.contains(duration)) values.add(duration);
    if (!selected) values.remove(duration);
    if (values.isEmpty) {
      setState(() => _error = 'Keep at least one booking duration available.');
      return;
    }
    values.sort();
    setState(() { _draft = _copy(schedule, durationsMinutes: values); _error = null; });
  }

  void _importLegacyPreview(BookingSchedule schedule) {
    final preview = schedule.legacyPreview;
    if (preview == null || preview.days.isEmpty || preview.startMin == null ||
        preview.endMin == null || preview.startMin! < 0 ||
        preview.startMin! >= 1440 || preview.endMin! < 0 || preview.endMin! > 1440 ||
        preview.startMin == preview.endMin) {
      setState(() => _error = 'The saved hours could not be read. Edit the weekly hours manually before saving.');
      return;
    }
    final touchedDays = <int>{};
    for (final day in preview.days) {
      touchedDays.add(day);
      if (preview.endMin! <= preview.startMin!) touchedDays.add(day == 7 ? 1 : day + 1);
    }
    final rules = schedule.rules.where((row) => !touchedDays.contains(row.weekday)).toList();
    for (final day in preview.days) {
      if (preview.endMin! > preview.startMin!) {
        rules.add(BookingWindow(weekday: day, startMin: preview.startMin!, endMin: preview.endMin!));
      } else {
        rules.add(BookingWindow(weekday: day, startMin: preview.startMin!, endMin: 1440));
        rules.add(BookingWindow(weekday: day == 7 ? 1 : day + 1, startMin: 0, endMin: preview.endMin!));
      }
    }
    rules.sort((a, b) => a.weekday != b.weekday
        ? a.weekday.compareTo(b.weekday)
        : a.startMin.compareTo(b.startMin));
    setState(() {
      _draft = _copy(schedule, rules: rules);
      _legacyImported = true;
      _error = null;
    });
  }

  String _legacyHoursLabel(LegacyAvailabilityPreview preview) {
    String time(int? minute) {
      if (minute == null) return 'unknown';
      return '${(minute ~/ 60).toString().padLeft(2, '0')}:${(minute % 60).toString().padLeft(2, '0')}';
    }
    final days = preview.days.map((day) => _days[day - 1]).join(', ');
    return '${days.isEmpty ? 'No weekdays found' : days}: ${time(preview.startMin)}–${time(preview.endMin)}';
  }

  Future<void> _save() async {
    if (_saving || _draft == null) return;
    final legacyConfirmationRequired = _draft!.legacyPreview?.requiresHostTimezoneConfirmation == true;
    if (legacyConfirmationRequired && (!_legacyImported || !_legacyTimezoneConfirmed)) {
      setState(() => _error = 'Import the preview and confirm its host time zone before saving.');
      return;
    }
    for (final row in _draft!.rules) {
      if (row.weekday < 1 || row.weekday > 7 || row.startMin < 0 ||
          row.endMin > 1440 || row.startMin >= row.endMin) {
        setState(() => _error = 'Each time window must end after it starts and stay within the same day.');
        return;
      }
    }
    for (var weekday = 1; weekday <= 7; weekday++) {
      final windows = _draft!.rules.where((row) => row.weekday == weekday).toList()
        ..sort((a, b) => a.startMin.compareTo(b.startMin));
      for (var i = 1; i < windows.length; i++) {
        if (windows[i].startMin < windows[i - 1].endMin) {
          setState(() => _error = 'Time windows on the same day cannot overlap.');
          return;
        }
      }
    }
    for (final row in _draft!.exceptions) {
      if (row.status == 'available' &&
          (row.startMin == null || row.endMin == null ||
           row.startMin! < 0 || row.endMin! > 1440 || row.startMin! >= row.endMin!)) {
        setState(() => _error = 'Date override windows must be valid same-day times. Overnight windows are split automatically.');
        return;
      }
    }
    final dates = _draft!.exceptions.map((row) => row.date).toSet();
    for (final date in dates) {
      final windows = _draft!.exceptions.where((row) => row.date == date && row.status == 'available').toList()
        ..sort((a, b) => a.startMin!.compareTo(b.startMin!));
      for (var i = 1; i < windows.length; i++) {
        if (windows[i].startMin! < windows[i - 1].endMin!) {
          setState(() => _error = 'Available windows on $date cannot overlap.');
          return;
        }
      }
    }
    setState(() { _saving = true; _reloadRequired = false; _error = null; });
    try {
      final saved = await ref.read(hfBookingsApiProvider).saveAvailability(
        _draft!,
        confirmLegacyPreview: legacyConfirmationRequired && _legacyImported && _legacyTimezoneConfirmed,
      );
      if (!mounted) return;
      setState(() {
        _draft = saved;
        _saving = false;
        _legacyImported = false;
        _legacyTimezoneConfirmed = false;
      });
      ref.invalidate(hostAvailabilityProvider);
      await Analytics.capture('hf_app_booking_availability_saved', {
        'rule_count': saved.rules.length, 'exception_count': saved.exceptions.length,
        'schedule_version': saved.version,
      });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Availability saved')));
    } catch (e) {
      if (!mounted) return;
      final conflict = e is ApiError && e.status == 409;
      final affected = e is ApiError ? (e.extra['affectedBookingIds'] ?? e.extra['bookingIds']) : null;
      setState(() {
        _saving = false;
        _reloadRequired = conflict && (affected is! List || affected.isEmpty);
        _error = conflict
          ? (affected is List && affected.isNotEmpty
            ? 'This schedule overlaps confirmed booking(s): ${affected.join(', ')}. Change the hours or cancel those bookings first.'
            : 'Your schedule changed on another device. Reload it before saving.')
          : e is ApiError && (e.field == 'timezone' || e.code == 'invalid_timezone')
            ? (e.message?.isNotEmpty == true ? e.message! : 'The server rejected this IANA time zone. Check that the zone exists and try again.')
            : 'Could not save your availability. Check your connection and try again.';
      });
      if (conflict) await Analytics.capture('hf_app_booking_conflict', {'stage': 'availability', 'schedule_version': _draft!.version});
    }
  }

  @override
  Widget build(BuildContext context) {
    if (ref.watch(flagsProvider).asData?.value.hfBookingsEnabled != true) {
      return const BookingUnavailableScreen(title: 'Availability');
    }
    final value = ref.watch(hostAvailabilityProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Availability')),
      body: value.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _LoadError(onRetry: () => ref.invalidate(hostAvailabilityProvider)),
        data: (schedule) {
          _draft ??= schedule;
          final s = _draft!;
          final legacyPreview = s.legacyPreview;
          final media = MediaQuery.of(context);
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Text('Set the times customers can book. Confirmed appointments keep their original time.',
                    style: Theme.of(context).textTheme.bodyLarge),
                  const SizedBox(height: 16),
                  Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Time zone', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      DropdownButtonFormField<String>(
                        value: s.timezone,
                        decoration: const InputDecoration(labelText: 'Host time zone'),
                        items: [
                          if (!const {'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'}.contains(s.timezone))
                            DropdownMenuItem(value: s.timezone, child: Text(s.timezone)),
                          const DropdownMenuItem(value: 'Asia/Kolkata', child: Text('India (Asia/Kolkata)')),
                          const DropdownMenuItem(value: 'Europe/London', child: Text('United Kingdom (Europe/London)')),
                          const DropdownMenuItem(value: 'America/New_York', child: Text('US Eastern (America/New_York)')),
                          const DropdownMenuItem(value: 'America/Los_Angeles', child: Text('US Pacific (America/Los_Angeles)')),
                          const DropdownMenuItem(value: 'Australia/Sydney', child: Text('Australia (Australia/Sydney)')),
                        ],
                        onChanged: (zone) {
                          if (zone != null) setState(() {
                            _draft = _copy(s, timezone: zone);
                            _legacyTimezoneConfirmed = false;
                          });
                        },
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: _editTimezone,
                          icon: const Icon(Icons.edit_location_alt_outlined),
                          label: const Text('Enter another IANA time zone'),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text('Weekly hours repeat in this time zone. Choose a date below to block it.',
                        style: Theme.of(context).textTheme.bodySmall),
                    ],
                  ))),
                  if (legacyPreview?.requiresHostTimezoneConfirmation == true) ...[
                    const SizedBox(height: 12),
                    Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Existing availability preview', style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 8),
                        Text('Older schedule: ${_legacyHoursLabel(legacyPreview!)}'),
                        Text('It will use ${s.timezone}. Confirm the time zone before importing.'),
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _legacyTimezoneConfirmed,
                          onChanged: (value) => setState(() {
                            _legacyTimezoneConfirmed = value ?? false;
                          }),
                          title: const Text('I confirm this is the time zone used for my existing hours.'),
                          controlAffinity: ListTileControlAffinity.leading,
                          minTileHeight: 48,
                        ),
                        OutlinedButton.icon(
                          onPressed: _legacyTimezoneConfirmed ? () => _importLegacyPreview(s) : null,
                          icon: const Icon(Icons.download_outlined),
                          label: Text(_legacyImported ? 'Refresh imported draft' : 'Import preview into draft'),
                          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                        ),
                        if (_legacyImported)
                          const Padding(
                            padding: EdgeInsets.only(top: 8),
                            child: Text('Preview imported. Review the weekly hours below before saving.'),
                          ),
                      ],
                    ))),
                  ],
                  const SizedBox(height: 12),
                  Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Booking settings', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      Text('Durations customers can choose', style: Theme.of(context).textTheme.bodyMedium),
                      Wrap(spacing: 8, runSpacing: 4, children: [
                        for (final duration in const [15, 30, 45, 60])
                          FilterChip(
                            label: Text('$duration min'),
                            selected: s.durationsMinutes.contains(duration),
                            onSelected: (selected) => _toggleDuration(s, duration, selected),
                          ),
                      ]),
                      _numberSetting(
                        label: 'Start interval (minutes)',
                        value: s.slotIntervalMinutes,
                        options: const [5, 10, 15, 30],
                        onChanged: (v) => setState(() => _draft = _copy(s, slotIntervalMinutes: v)),
                      ),
                      _numberSetting(
                        label: 'Minimum notice (minutes)',
                        value: s.minNoticeMinutes,
                        options: const [0, 30, 60, 120, 240, 480, 1440],
                        onChanged: (v) => setState(() => _draft = _copy(s, minNoticeMinutes: v)),
                      ),
                      _numberSetting(
                        label: 'Buffer between bookings (minutes)',
                        value: s.bufferMinutes,
                        options: const [0, 5, 10, 15, 30, 60],
                        onChanged: (v) => setState(() => _draft = _copy(s, bufferMinutes: v)),
                      ),
                      _numberSetting(
                        label: 'Booking horizon (days)',
                        value: s.horizonDays,
                        options: const [7, 14, 30, 60],
                        onChanged: (v) => setState(() => _draft = _copy(s, horizonDays: v)),
                      ),
                    ],
                  ))),
                  const SizedBox(height: 12),
                  Text('Weekly hours', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 8),
                  for (var day = 1; day <= 7; day++) _DayAvailability(
                    day: _days[day - 1], enabled: s.rules.any((r) => r.weekday == day),
                    onToggle: () => _toggleDay(day),
                  ),
                  const SizedBox(height: 8),
                  for (var i = 0; i < s.rules.length; i++) _WindowTile(
                    title: '${_days[s.rules[i].weekday - 1]} availability',
                    row: s.rules[i], onStart: () => _editTime(i, start: true),
                    onEnd: () => _editTime(i, start: false),
                    onRemove: () { final rows = [...s.rules]..removeAt(i); setState(() => _draft = _copy(s, rules: rows)); },
                  ),
                  PopupMenuButton<int>(
                    tooltip: 'Add a weekly time window',
                    onSelected: (weekday) => _addWindow(weekday: weekday),
                    itemBuilder: (context) => [for (var day = 1; day <= 7; day++) PopupMenuItem(value: day, child: Text(_days[day - 1]))],
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.add), SizedBox(width: 8), Text('Add another time window')]),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Date exceptions', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 4),
                      const Text('Block a date range or add one or more available windows. Overnight windows are split across civil dates.'),
                      const SizedBox(height: 8),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (var i = 0; i < s.exceptions.length; i++)
                          InputChip(
                            label: Text(_exceptionLabel(s.exceptions[i])),
                            onDeleted: () {
                              final rows = [...s.exceptions]..removeAt(i);
                              setState(() => _draft = _copy(s, exceptions: rows));
                            },
                          ),
                        ActionChip(
                          avatar: const Icon(Icons.event_available_outlined),
                          label: const Text('Add date override'),
                          onPressed: _toggleException,
                        ),
                      ]),
                    ],
                  ))),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Semantics(liveRegion: true, child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
                    if (_reloadRequired)
                      Align(alignment: Alignment.centerLeft, child: TextButton.icon(
                        onPressed: _reloadSchedule,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Discard changes and reload schedule'),
                      )),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    child: Text(_saving ? 'Saving…' : 'Save availability'),
                  ),
                  SizedBox(height: media.disableAnimations ? 0 : 20),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

Widget _numberSetting({
  required String label,
  required int value,
  required List<int> options,
  required ValueChanged<int> onChanged,
}) => Padding(
  padding: const EdgeInsets.only(top: 8),
  child: DropdownButtonFormField<int>(
    value: value,
    decoration: InputDecoration(labelText: label),
    items: [
      if (!options.contains(value))
        DropdownMenuItem(value: value, child: Text('$value (current)')),
      for (final option in options)
        DropdownMenuItem(value: option, child: Text('$option')),
    ],
    onChanged: (next) { if (next != null) onChanged(next); },
  ),
);

class _DayAvailability extends StatelessWidget {
  const _DayAvailability({required this.day, required this.enabled, required this.onToggle});
  final String day;
  final bool enabled;
  final VoidCallback onToggle;
  @override
  Widget build(BuildContext context) => Semantics(
    label: '$day availability', toggled: enabled, button: true,
    child: SwitchListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 12),
      title: Text(day), value: enabled, onChanged: (_) => onToggle(),
    ),
  );
}

class _WindowTile extends StatelessWidget {
  const _WindowTile({required this.title, required this.row, required this.onStart, required this.onEnd, required this.onRemove});
  final String title;
  final BookingWindow row;
  final VoidCallback onStart, onEnd, onRemove;
  String _clock(int n) => '${(n ~/ 60).toString().padLeft(2,'0')}:${(n % 60).toString().padLeft(2,'0')}';
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(padding: const EdgeInsets.all(12), child: Column(
      crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Expanded(child: Text(title, style: Theme.of(context).textTheme.titleSmall)),
          IconButton(tooltip: 'Remove this time window', onPressed: onRemove, icon: const Icon(Icons.delete_outline))]),
        Wrap(spacing: 8, children: [
          OutlinedButton(onPressed: onStart, child: Text(_clock(row.startMin))),
          const Padding(padding: EdgeInsets.only(top: 12), child: Text('to')),
          OutlinedButton(onPressed: onEnd, child: Text(_clock(row.endMin))),
        ]),
      ],
    )),
  );
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.onRetry});
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(child: Padding(
    padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [
      const Text('Availability could not be loaded.'),
      const SizedBox(height: 12), OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
    ]),
  ));
}
