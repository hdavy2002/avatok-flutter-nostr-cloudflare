import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../../core/ui/avatok_dark.dart';
import 'step_widgets.dart';

class Step4Time extends StatefulWidget {
  const Step4Time({
    super.key,
    required this.draft,
    required this.patch,
    required this.slotsSupported,
    required this.onAddSlot,
    required this.onRemoveSlot,
    this.slotBusy = false,
    this.error = _noError,
  });

  final dynamic draft;
  final NativeListingPatch patch;
  final bool? slotsSupported;
  final ValueChanged<NativeListingSlotDraft> onAddSlot;
  final ValueChanged<String> onRemoveSlot;
  final bool slotBusy;
  final NativeListingError error;

  static String? _noError(String field) => null;

  @override
  State<Step4Time> createState() => _Step4TimeState();
}

class _Step4TimeState extends State<Step4Time> {
  static const _timezones = {
    'Asia/Kolkata': 'India (IST, Asia/Kolkata)',
    'Asia/Dubai': 'Dubai (GST, Asia/Dubai)',
    'Asia/Singapore': 'Singapore (SGT, Asia/Singapore)',
    'Europe/London': 'London (GMT/BST, Europe/London)',
    'America/New_York': 'New York (ET, America/New_York)',
    'America/Toronto': 'Toronto (ET, America/Toronto)',
    'Australia/Sydney': 'Sydney (AET, Australia/Sydney)',
  };
  static const _days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  late bool _timezoneOther;
  DateTime? _slotStart;
  final _slotLabel = TextEditingController();
  final _slotDuration = TextEditingController(text: '60');
  final _slotCapacity = TextEditingController();

  @override
  void initState() {
    super.initState();
    _timezoneOther = !_timezones.containsKey('${listingDraftValue(widget.draft, 'timezone', 'timezone', 'Asia/Kolkata')}');
    _slotCapacity.text = '${listingDraftValue(widget.draft, 'kind', 'kind', 'live_event')}' == 'consult' ? '1' : '10';
  }

  @override
  void dispose() {
    _slotLabel.dispose();
    _slotDuration.dispose();
    _slotCapacity.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final kind = '${listingDraftValue(widget.draft, 'kind', 'kind', 'live_event')}';
    final schedule = '${listingDraftValue(widget.draft, 'scheduleMode', 'schedule_mode', 'fixed_date')}';
    final showTime = schedule == 'fixed_date' || schedule == 'recurring';
    final slots = (listingDraftValue(widget.draft, 'slots', 'slots', const []) as Iterable?)?.toList() ?? const [];
    final availabilityMode = '${listingDraftValue(widget.draft, 'availabilityMode', 'availability_mode', 'shared')}';
    return NativeStepLayout(children: [
      _timezoneField(),
      if (kind == 'consult') _availabilityMode(availabilityMode),
      if (schedule == 'fixed_date') ...[
        if (kind != 'consult' || availabilityMode == 'exclusive') _dateTimeField(context),
        nativeNumberField(
          label: 'Length (minutes)',
          value: '${listingDraftValue(widget.draft, 'durationMin', 'duration_min', 60)}',
          onChanged: (v) => widget.patch({'duration_min': int.tryParse(v) ?? 0}),
          error: widget.error('duration_min'), min: 5, max: 480,
        ),
      ],
      if (schedule == 'recurring') ...[
        _recurrenceDays(),
        _timeField(context),
        nativeNumberField(
          label: 'Length (minutes)',
          value: '${listingDraftValue(widget.draft, 'durationMin', 'duration_min', 60)}',
          onChanged: (v) => widget.patch({'duration_min': int.tryParse(v) ?? 0}),
          error: widget.error('duration_min'), min: 5, max: 480,
        ),
      ],
      if (schedule == 'on_request' || schedule == 'always_on')
        NativeStepCard(child: Text(
          schedule == 'on_request'
              ? 'No fixed time — people will request a slot and you confirm it.'
              : 'No fixed time — this listing is joinable any time.',
          style: ADText.preview(c: AD.textSecondary),
        )),
      if (showTime) _slots(context, slots),
      if (kind == 'consult' || kind == 'ai_agent')
        nativeNumberField(
          label: 'Typical reply time (minutes, optional)',
          value: '${listingDraftValue(widget.draft, 'responseTimeMin', 'response_time_min', '')}',
          onChanged: (v) => widget.patch({'response_time_min': v}),
          error: widget.error('response_time_min'),
        ),
      if (kind != 'consult')
        nativeNumberField(
          label: 'Seats (capacity)',
          value: listingDraftValue(widget.draft, 'capacity', 'capacity', 0) == 0 ? '' : '${listingDraftValue(widget.draft, 'capacity', 'capacity', 0)}',
          hint: 'e.g. 60 — blank = unlimited',
          onChanged: (v) => widget.patch({'capacity': int.tryParse(v) ?? 0}),
          error: widget.error('capacity'),
        ),
      nativeNumberField(
        label: 'Max bookings per person',
        value: '${listingDraftValue(widget.draft, 'maxPerBooking', 'max_per_booking', 4)}',
        onChanged: (v) => widget.patch({'max_per_booking': int.tryParse(v) ?? 0}),
        error: widget.error('max_per_booking'),
      ),
    ]);
  }

  Widget _availabilityMode(String mode) {
    const options = <String, String>{
      'shared': 'Shared creator hours',
      'custom': 'Custom hours for this listing',
      'exclusive': 'Exclusive windows',
    };
    final rules = (listingDraftValue(widget.draft, 'availabilityRules', 'availability_rules', const []) as Iterable?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ?? <Map<String, dynamic>>[];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const NativeStepLabel('Consult availability'),
      const SizedBox(height: 8),
      for (final entry in options.entries) Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: NativeStepCard(selected: mode == entry.key, child: InkWell(
          onTap: () => widget.patch({'availability_mode': entry.key}),
        child: Row(children: [Expanded(child: Text(entry.value, style: ADText.preview(c: AD.textPrimary))), if (mode == entry.key) Icon(PhosphorIconsRegular.check)]),
        )),
      ),
      if (mode == 'custom') ...[
        Text('Custom hours use ${listingDraftValue(widget.draft, 'timezone', 'timezone', 'UTC')}.', style: ADText.preview(c: AD.textSecondary)),
        for (var i = 0; i < rules.length; i++) _availabilityRule(rules, i),
        TextButton.icon(
          onPressed: () => widget.patch({'availability_rules': [...rules, {'weekday': 1, 'start_min': 540, 'end_min': 1020}]}),
          icon: Icon(PhosphorIconsRegular.plus), label: const Text('Add weekly window'),
        ),
      ],
    ]);
  }

  Widget _availabilityRule(List<Map<String, dynamic>> rules, int index) {
    final rule = rules[index];
    final weekday = (rule['weekday'] as num?)?.toInt() ?? 1;
    final start = (rule['start_min'] as num?)?.toInt() ?? 540;
    final end = (rule['end_min'] as num?)?.toInt() ?? 1020;
    String clock(int minutes) => '${((minutes ~/ 60) % 24).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(child: nativeSelect<int>(label: 'Day', value: weekday.clamp(0, 6).toInt(), items: [for (var i = 0; i < _days.length; i++) DropdownMenuItem(value: i, child: Text(_days[i]))], onChanged: (v) { if (v == null) return; final next = [...rules]; next[index] = {...rule, 'weekday': v}; widget.patch({'availability_rules': next}); })),
        const SizedBox(width: 8),
        Expanded(child: _PickerField(label: 'Starts', value: clock(start), onTap: () async { final t = await showTimePicker(context: context, initialTime: TimeOfDay(hour: (start ~/ 60) % 24, minute: start % 60)); if (t == null) return; final next = [...rules]; next[index] = {...rule, 'start_min': t.hour * 60 + t.minute}; widget.patch({'availability_rules': next}); })),
        const SizedBox(width: 8),
        Expanded(child: _PickerField(label: 'Ends', value: clock(end), onTap: () async { final t = await showTimePicker(context: context, initialTime: TimeOfDay(hour: (end ~/ 60) % 24, minute: end % 60)); if (t == null) return; final next = [...rules]; next[index] = {...rule, 'end_min': t.hour * 60 + t.minute}; widget.patch({'availability_rules': next}); })),
        IconButton(onPressed: () { final next = [...rules]..removeAt(index); widget.patch({'availability_rules': next}); }, icon: Icon(PhosphorIconsRegular.trash)),
      ]),
    );
  }

  Widget _timezoneField() {
    final current = '${listingDraftValue(widget.draft, 'timezone', 'timezone', 'Asia/Kolkata')}';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      nativeSelect<String>(
        label: 'Timezone',
        value: _timezoneOther ? '__other__' : current,
        items: [
          for (final item in _timezones.entries)
            DropdownMenuItem(value: item.key, child: Text(item.value)),
          const DropdownMenuItem(value: '__other__', child: Text('Other…')),
        ],
        onChanged: (value) {
          if (value == '__other__') {
            setState(() => _timezoneOther = true);
          } else if (value != null) {
            setState(() => _timezoneOther = false);
            widget.patch({'timezone': value});
          }
        },
      ),
      if (_timezoneOther) ...[
        const SizedBox(height: 12),
        AdField(label: 'Timezone ID', hint: 'e.g. Asia/Tokyo', onChanged: (v) => widget.patch({'timezone': v})),
        NativeErrorText(message: widget.error('timezone')),
      ],
    ]);
  }

  Widget _dateTimeField(BuildContext context) => _PickerField(
        label: 'Starts',
        value: '${listingDraftValue(widget.draft, 'startsAt', 'starts_at', '')}',
        onTap: () async {
          final parsed = DateTime.tryParse('${listingDraftValue(widget.draft, 'startsAt', 'starts_at', '')}') ?? DateTime.now();
          final date = await showDatePicker(
            context: context, initialDate: parsed, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 730)),
          );
          if (date == null || !context.mounted) return;
          final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(parsed));
          if (time == null) return;
          final combined = DateTime(date.year, date.month, date.day, time.hour, time.minute);
          widget.patch({'starts_at': _localInput(combined)});
        },
        error: widget.error('starts_at'),
      );

  Widget _timeField(BuildContext context) => _PickerField(
        label: 'Time', value: '${listingDraftValue(widget.draft, 'recurrenceTime', 'recurrence_time', '18:00')}',
        onTap: () async {
          final parts = '${listingDraftValue(widget.draft, 'recurrenceTime', 'recurrence_time', '18:00')}'.split(':');
          final initial = TimeOfDay(hour: int.tryParse(parts.first) ?? 18, minute: int.tryParse(parts.last) ?? 0);
          final picked = await showTimePicker(context: context, initialTime: initial);
          if (picked != null) widget.patch({'recurrence_time': '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}'});
        }, error: widget.error('recurrence_time'),
      );

  Widget _recurrenceDays() {
    final selected = ((listingDraftValue(widget.draft, 'recurrenceDays', 'recurrence_days', const []) as Iterable?)?.map((e) => e as int).toSet()) ?? <int>{};
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const NativeStepLabel('Days'), const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [for (var i = 0; i < _days.length; i++)
        AdChip(label: _days[i], active: selected.contains(i), onTap: () {
          final next = {...selected};
          next.contains(i) ? next.remove(i) : next.add(i);
          widget.patch({'recurrence_days': next.toList()..sort()});
        })]),
      NativeErrorText(message: widget.error('recurrence_days')),
    ]);
  }

  Widget _slots(BuildContext context, List<dynamic> slots) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Specific time slots (optional)', style: ADText.sectionLabel(c: AD.textSecondary)),
      const SizedBox(height: 4),
      Text('Offer several named time options instead of one fixed start.', style: ADText.preview(c: AD.textSecondary)),
      if (widget.slotsSupported == false)
        Padding(padding: const EdgeInsets.only(top: 10), child: Text('Slot booking is coming soon — for now, use the single start time above.', style: ADText.preview(c: AD.textSecondary)))
      else ...[
        for (final slot in slots) _slotRow(slot),
        const SizedBox(height: 10),
        NativeStepCard(child: Column(children: [
          _PickerField(label: 'Slot start', value: _slotStart == null ? 'Choose date and time' : _localInput(_slotStart!), onTap: () async {
            final date = await showDatePicker(context: context, initialDate: _slotStart ?? DateTime.now(), firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 730)));
            if (date == null || !context.mounted) return;
            final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_slotStart ?? DateTime.now()));
            if (time != null) setState(() => _slotStart = DateTime(date.year, date.month, date.day, time.hour, time.minute));
          }),
          const SizedBox(height: 12),
          LayoutBuilder(builder: (context, constraints) {
            final wide = constraints.maxWidth >= 500;
            final fields = [
              AdField(label: 'Label (optional)', hint: 'e.g. Morning batch', controller: _slotLabel),
              AdField(label: 'Duration (min)', controller: _slotDuration, keyboardType: TextInputType.number),
              AdField(label: 'Seats', controller: _slotCapacity, keyboardType: TextInputType.number),
            ];
            return wide ? Row(children: [for (var i = 0; i < fields.length; i++) ...[Expanded(child: fields[i]), if (i < fields.length - 1) const SizedBox(width: 10)]]) : Column(children: [for (final field in fields) Padding(padding: const EdgeInsets.only(bottom: 10), child: field)]);
          }),
          AdButton(label: 'Add slot', onPressed: _slotStart == null || widget.slotBusy ? null : () {
            widget.onAddSlot(NativeListingSlotDraft(startsAt: _slotStart!.millisecondsSinceEpoch, durationMin: int.tryParse(_slotDuration.text) ?? 60, label: _slotLabel.text, capacity: int.tryParse(_slotCapacity.text) ?? 10));
            setState(() { _slotStart = null; _slotLabel.clear(); _slotDuration.text = '60'; });
          }, loading: widget.slotBusy, fullWidth: true),
        ])),
      ],
    ]);
  }

  Widget _slotRow(dynamic slot) {
    final id = '${slot.id}';
    final start = DateTime.fromMillisecondsSinceEpoch((slot.startsAt as num).toInt());
    return Padding(padding: const EdgeInsets.only(top: 8), child: NativeStepCard(child: Row(children: [
      Expanded(child: Text('${slot.label == null || '${slot.label}'.isEmpty ? 'Slot' : slot.label} · ${start.toLocal()} · ${slot.durationMin}min · cap ${slot.capacity}', style: ADText.preview(c: AD.textPrimary))),
      if (id.isNotEmpty && id != 'null') TextButton(onPressed: () => widget.onRemoveSlot(id), child: const Text('Remove')),
    ])));
  }
}

String _localInput(DateTime date) => '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}T${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';

class _PickerField extends StatelessWidget {
  const _PickerField({required this.label, required this.value, required this.onTap, this.error});
  final String label;
  final String value;
  final VoidCallback onTap;
  final String? error;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        NativeStepLabel(label), const SizedBox(height: 8),
        InkWell(onTap: onTap, borderRadius: BorderRadius.circular(AD.rInput), child: Container(padding: const EdgeInsets.all(16), decoration: BoxDecoration(color: AD.inputField, borderRadius: BorderRadius.circular(AD.rInput), border: Border.all(color: AD.borderControl, width: AD.wBorder)), child: Row(children: [Expanded(child: Text(value, style: ADText.preview(c: AD.textPrimary))), Icon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular))]))),
        NativeErrorText(message: error),
      ]);
}
