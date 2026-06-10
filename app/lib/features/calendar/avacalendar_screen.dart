// AvaCalendar — Phase 5. Month view with BLIPS (one colored dot per
// source_app), agenda for the selected day, blip→card popup, and settings:
// Google Calendar connect/disconnect, availability rules editor (weekday
// ranges, slot length, timezone — DST-safe server-side), booking policies +
// vacation mode. Local-first: cached blocks render instantly (per-account
// DiskCache), then a network refresh repaints.
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/platform_api.dart';
import '../../core/time_sync.dart';
import 'booking_card.dart';
import 'calendar_data.dart';

class AvaCalendarScreen extends StatefulWidget {
  const AvaCalendarScreen({super.key});
  @override
  State<AvaCalendarScreen> createState() => _AvaCalendarScreenState();
}

class _AvaCalendarScreenState extends State<AvaCalendarScreen> {
  DateTime _month = DateTime(DateTime.now().year, DateTime.now().month);
  DateTime _selected = DateTime.now();
  List<CalBlock> _blocks = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    TimeSync.init(); // A2 — refresh clock skew whenever the calendar opens
    CalendarStore.cached().then((c) {
      if (mounted && c.isNotEmpty) setState(() => _blocks = c);
    });
    _refresh();
  }

  Future<void> _refresh() async {
    final from = _month.subtract(const Duration(days: 7)).millisecondsSinceEpoch;
    final to = DateTime(_month.year, _month.month + 1, 8).millisecondsSinceEpoch;
    try {
      final b = await CalendarStore.refresh(from: from, to: to);
      if (mounted) setState(() { _blocks = b; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<CalBlock> _onDay(DateTime day) {
    final s = DateTime(day.year, day.month, day.day).millisecondsSinceEpoch;
    final e = s + 86400000;
    final list = _blocks.where((b) => b.startsAt < e && b.endsAt > s).toList()
      ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    return list;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AvaCalendar'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh),
          IconButton(icon: const Icon(Icons.settings), onPressed: () => _openSettings(context)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _monthHeader(),
            _weekdayRow(),
            _monthGrid(),
            const SizedBox(height: 16),
            Text(
              '${_selected.day}.${_selected.month}.${_selected.year}',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            if (_loading && _blocks.isEmpty)
              const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
            ..._agenda(),
            const SizedBox(height: 24),
            _legend(),
          ],
        ),
      ),
    );
  }

  Widget _monthHeader() => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          IconButton(
            icon: const Icon(Icons.chevron_left),
            onPressed: () => setState(() { _month = DateTime(_month.year, _month.month - 1); _refresh(); }),
          ),
          Text(
            '${const ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_month.month - 1]} ${_month.year}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
          ),
          IconButton(
            icon: const Icon(Icons.chevron_right),
            onPressed: () => setState(() { _month = DateTime(_month.year, _month.month + 1); _refresh(); }),
          ),
        ],
      );

  Widget _weekdayRow() => Row(
        children: const ['M', 'T', 'W', 'T', 'F', 'S', 'S']
            .map((d) => Expanded(child: Center(child: Text(d, style: TextStyle(color: Colors.grey[600], fontSize: 12, fontWeight: FontWeight.w600)))))
            .toList(),
      );

  Widget _monthGrid() {
    final first = DateTime(_month.year, _month.month, 1);
    final lead = (first.weekday + 6) % 7; // Monday-first
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final cells = <Widget>[];
    for (var i = 0; i < lead; i++) cells.add(const SizedBox());
    final today = TimeSync.now();
    for (var d = 1; d <= days; d++) {
      final day = DateTime(_month.year, _month.month, d);
      final blips = _onDay(day);
      final isSel = day.year == _selected.year && day.month == _selected.month && day.day == _selected.day;
      final isToday = day.year == today.year && day.month == today.month && day.day == today.day;
      cells.add(InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => setState(() => _selected = day),
        child: Container(
          decoration: BoxDecoration(
            color: isSel ? Theme.of(context).colorScheme.primary.withOpacity(.12) : null,
            border: isToday ? Border.all(color: Theme.of(context).colorScheme.primary) : null,
            borderRadius: BorderRadius.circular(10),
          ),
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('$d', style: TextStyle(fontWeight: isSel ? FontWeight.w800 : FontWeight.w500)),
            const SizedBox(height: 2),
            SizedBox(
              height: 8,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (final b in blips.take(3))
                    Container(
                      width: 6, height: 6, margin: const EdgeInsets.symmetric(horizontal: 1),
                      decoration: BoxDecoration(color: styleFor(b.sourceApp).color, shape: BoxShape.circle),
                    ),
                  if (blips.length > 3) Text('+', style: TextStyle(fontSize: 8, color: Colors.grey[600])),
                ],
              ),
            ),
          ]),
        ),
      ));
    }
    return GridView.count(
      crossAxisCount: 7,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 1.05,
      children: cells,
    );
  }

  List<Widget> _agenda() {
    final items = _onDay(_selected);
    if (items.isEmpty && !_loading) {
      return [Padding(padding: const EdgeInsets.all(8), child: Text('Nothing scheduled.', style: TextStyle(color: Colors.grey[600])))];
    }
    return items.map((b) {
      final st = styleFor(b.sourceApp);
      final isBooking = b.sourceApp == 'avabooking';
      return Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: ListTile(
          leading: CircleAvatar(backgroundColor: st.color.withOpacity(.15), child: Icon(st.icon, color: st.color, size: 20)),
          title: Text(b.title ?? st.label),
          subtitle: Text('${fmtRange(b.startsAt, b.endsAt)} · ${st.label}'),
          onTap: () => showBookingCard(
            context,
            sourceApp: b.sourceApp,
            title: b.title ?? st.label,
            startsAt: b.startsAt,
            endsAt: b.endsAt,
            bookingId: isBooking ? b.sourceRef : null,
            status: isBooking ? 'confirmed' : null,
            onChanged: _refresh,
          ),
        ),
      );
    }).toList();
  }

  Widget _legend() => Wrap(
        spacing: 12, runSpacing: 6,
        children: kSourceStyles.entries
            .map((e) => Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(width: 8, height: 8, decoration: BoxDecoration(color: e.value.color, shape: BoxShape.circle)),
                  const SizedBox(width: 4),
                  Text(e.value.label, style: TextStyle(fontSize: 12, color: Colors.grey[700])),
                ]))
            .toList(),
      );

  void _openSettings(BuildContext context) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => const CalendarSettingsScreen()));
  }
}

// ---------------------------------------------------------------------------
// Settings: gcal connect, availability rules editor, policies + vacation mode.
// ---------------------------------------------------------------------------
class CalendarSettingsScreen extends StatefulWidget {
  const CalendarSettingsScreen({super.key});
  @override
  State<CalendarSettingsScreen> createState() => _CalendarSettingsScreenState();
}

class _CalendarSettingsScreenState extends State<CalendarSettingsScreen> {
  bool? _gcalConnected;
  List<Map<String, dynamic>> _rules = [];
  Map<String, dynamic> _policy = {};

  static const _days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final g = await PlatformApi.gcalStatus();
      final r = await PlatformApi.availabilityRules();
      final p = await PlatformApi.bookingPolicies();
      if (mounted) {
        setState(() {
          _gcalConnected = g['connected'] == true;
          _rules = r;
          _policy = (p['policy'] as Map?)?.cast<String, dynamic>() ?? {};
        });
      }
    } catch (_) {/* render what we have */}
  }

  @override
  Widget build(BuildContext context) {
    final vac = (_policy['vacation_until'] as num?)?.toInt();
    final onVacation = vac != null && vac > TimeSync.nowMs();
    return Scaffold(
      appBar: AppBar(title: const Text('Calendar settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // --- Google Calendar -------------------------------------------------
          Card(
            child: ListTile(
              leading: const Icon(Icons.event, color: Color(0xFF4285F4)),
              title: const Text('Google Calendar'),
              subtitle: Text(_gcalConnected == null
                  ? 'Checking…'
                  : _gcalConnected!
                      ? 'Connected — two-way sync active'
                      : 'Not connected'),
              trailing: _gcalConnected == true
                  ? TextButton(onPressed: _disconnectGcal, child: const Text('Disconnect'))
                  : FilledButton(onPressed: _connectGcal, child: const Text('Connect')),
            ),
          ),
          const SizedBox(height: 16),

          // --- Availability rules ----------------------------------------------
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            const Text('Offered hours', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
            TextButton.icon(icon: const Icon(Icons.add), label: const Text('Add'), onPressed: _addRule),
          ]),
          if (_rules.isEmpty) Text('No offered hours yet — add weekday ranges buyers can book.', style: TextStyle(color: Colors.grey[600])),
          ..._rules.map((r) => Card(
                child: ListTile(
                  title: Text('${_days[(r['weekday'] as num).toInt()]}  ${_hm((r['start_min'] as num).toInt())}–${_hm((r['end_min'] as num).toInt())}'),
                  subtitle: Text('${r['slot_min']} min slots · ${r['tz']}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      setState(() => _rules.remove(r));
                      await _saveRules();
                    },
                  ),
                ),
              )),
          const SizedBox(height: 16),

          // --- Booking policies -------------------------------------------------
          const Text('Booking policies', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          _policyTile('Buffer between sessions', 'buffer_min', 'min'),
          _policyTile('Minimum notice', 'min_notice_min', 'min'),
          _policyTile('Max bookings per day', 'max_per_day', ''),
          SwitchListTile(
            title: const Text('Vacation mode'),
            subtitle: Text(onVacation
                ? 'Bookings paused until ${fmtDate(vac)} — existing bookings unaffected'
                : 'Pause new bookings until a date'),
            value: onVacation,
            onChanged: (v) async {
              if (!v) {
                await PlatformApi.saveBookingPolicies(vacationUntil: 0);
                _load();
                return;
              }
              final d = await showDatePicker(
                context: context,
                firstDate: DateTime.now().add(const Duration(days: 1)),
                lastDate: DateTime.now().add(const Duration(days: 365)),
                initialDate: DateTime.now().add(const Duration(days: 7)),
                helpText: 'Pause bookings until…',
              );
              if (d == null) return;
              await PlatformApi.saveBookingPolicies(vacationUntil: d.millisecondsSinceEpoch);
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Vacation mode on. Existing bookings are unaffected — cancel them individually if needed.')));
              }
              _load();
            },
          ),
        ],
      ),
    );
  }

  String _hm(int minutes) => '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';

  Widget _policyTile(String label, String key, String unit) {
    final v = (_policy[key] as num?)?.toInt() ?? 0;
    return ListTile(
      dense: true,
      title: Text(label),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Text('$v $unit'),
        IconButton(
          icon: const Icon(Icons.edit, size: 18),
          onPressed: () async {
            final c = TextEditingController(text: '$v');
            final nv = await showDialog<int>(
              context: context,
              builder: (d) => AlertDialog(
                title: Text(label),
                content: TextField(controller: c, keyboardType: TextInputType.number, autofocus: true),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
                  FilledButton(onPressed: () => Navigator.pop(d, int.tryParse(c.text)), child: const Text('Save')),
                ],
              ),
            );
            if (nv == null) return;
            await PlatformApi.saveBookingPolicies(
              bufferMin: key == 'buffer_min' ? nv : null,
              minNoticeMin: key == 'min_notice_min' ? nv : null,
              maxPerDay: key == 'max_per_day' ? nv : null,
              vacationUntil: (_policy['vacation_until'] as num?)?.toInt(),
            );
            _load();
          },
        ),
      ]),
    );
  }

  Future<void> _connectGcal() async {
    final r = await PlatformApi.gcalConnect();
    final url = r['url'] as String?;
    if (url == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r['error'] as String? ?? 'Google sync not configured yet')));
      }
      return;
    }
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Finish in the browser, then pull to refresh.')));
    }
  }

  Future<void> _disconnectGcal() async {
    await PlatformApi.gcalDisconnect();
    _load();
  }

  Future<void> _addRule() async {
    var weekday = 1;
    var start = const TimeOfDay(hour: 9, minute: 0);
    var end = const TimeOfDay(hour: 17, minute: 0);
    final slotC = TextEditingController(text: '60');
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d2, setS) => AlertDialog(
          title: const Text('Offered hours'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButton<int>(
              value: weekday,
              isExpanded: true,
              items: List.generate(7, (i) => DropdownMenuItem(value: i, child: Text(_days[i]))),
              onChanged: (v) => setS(() => weekday = v ?? 1),
            ),
            ListTile(
              dense: true, title: Text('From ${start.format(d2)}'),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: start); if (t != null) setS(() => start = t); },
            ),
            ListTile(
              dense: true, title: Text('To ${end.format(d2)}'),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: end); if (t != null) setS(() => end = t); },
            ),
            TextField(controller: slotC, decoration: const InputDecoration(labelText: 'Slot length (min)'), keyboardType: TextInputType.number),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Add')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final tz = DateTime.now().timeZoneName; // best-effort IANA via platform; server validates
    _rules.add({
      'weekday': weekday,
      'start_min': start.hour * 60 + start.minute,
      'end_min': end.hour * 60 + end.minute,
      'tz': _ianaGuess(tz),
      'slot_min': int.tryParse(slotC.text) ?? 60,
    });
    await _saveRules();
  }

  /// DateTime.timeZoneName gives an abbreviation on some platforms; the server
  /// validates with Intl and rejects bad zones, so fall back to UTC offset zone.
  String _ianaGuess(String name) {
    if (name.contains('/')) return name;
    final off = DateTime.now().timeZoneOffset;
    if (off == Duration.zero) return 'UTC';
    final h = off.inHours;
    // Etc/GMT zones are POSIX-inverted (Etc/GMT-5 == UTC+5) and DST-free —
    // a safe fallback when the platform won't name the IANA zone.
    return 'Etc/GMT${h <= 0 ? '+${-h}' : '-$h'}';
  }

  Future<void> _saveRules() async {
    final r = await PlatformApi.saveAvailabilityRules(
      _rules.map((e) => {
        'weekday': e['weekday'], 'start_min': e['start_min'], 'end_min': e['end_min'],
        'tz': e['tz'], 'slot_min': e['slot_min'],
      }).toList(),
    );
    if (r['ok'] != true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Save failed: ${r['error'] ?? 'unknown'}')));
    }
    _load();
  }
}
