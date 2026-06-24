// AvaCalendar — Phase 5. Month view with BLIPS (one colored dot per
// source_app), agenda for the selected day, blip→card popup, and settings:
// Google Calendar connect/disconnect, availability rules editor (weekday
// ranges, slot length, timezone — DST-safe server-side), booking policies +
// vacation mode. Local-first: cached blocks render instantly (per-account
// DiskCache), then a network refresh repaints.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/platform_api.dart';
import '../../core/time_sync.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'AvaCalendar',
        markWord: 'Calendar',
        tag: 'Every app, one grid',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            onTap: _refresh,
          ),
          const SizedBox(width: 10),
          ZineBackButton(
            icon: PhosphorIcons.gearSix(PhosphorIconsStyle.bold),
            onTap: () => _openSettings(context),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: Zine.blueInk,
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            _monthHeader(),
            const SizedBox(height: 6),
            _weekdayRow(),
            _monthGrid(),
            const SizedBox(height: 16),
            Text(
              '${_selected.day}.${_selected.month}.${_selected.year}',
              style: ZineText.cardTitle(),
            ),
            const SizedBox(height: 10),
            if (_loading && _blocks.isEmpty)
              const Center(child: Padding(padding: EdgeInsets.all(24),
                  child: CircularProgressIndicator(color: Zine.blueInk))),
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
          ZineBackButton(
            icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.bold),
            onTap: () => setState(() { _month = DateTime(_month.year, _month.month - 1); _refresh(); }),
          ),
          Text(
            '${const ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_month.month - 1]} ${_month.year}',
            style: ZineText.cardTitle(size: 20),
          ),
          ZineBackButton(
            icon: PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
            onTap: () => setState(() { _month = DateTime(_month.year, _month.month + 1); _refresh(); }),
          ),
        ],
      );

  Widget _weekdayRow() => Row(
        children: const ['M', 'T', 'W', 'T', 'F', 'S', 'S']
            .map((d) => Expanded(child: Center(child: Text(d, style: ZineText.kicker(size: 10.5)))))
            .toList(),
      );

  Widget _monthGrid() {
    final first = DateTime(_month.year, _month.month, 1);
    final lead = (first.weekday + 6) % 7; // Monday-first
    final days = DateTime(_month.year, _month.month + 1, 0).day;
    final cells = <Widget>[];
    for (var i = 0; i < lead; i++) {
      cells.add(const SizedBox());
    }
    final today = TimeSync.now();
    for (var d = 1; d <= days; d++) {
      final day = DateTime(_month.year, _month.month, d);
      final blips = _onDay(day);
      final isSel = day.year == _selected.year && day.month == _selected.month && day.day == _selected.day;
      final isToday = day.year == today.year && day.month == today.month && day.day == today.day;
      cells.add(GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _selected = day),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Selected = lime circle w/ ink border; today = ink-bordered circle.
            Container(
              width: 32, height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isSel ? Zine.lime : null,
                border: (isSel || isToday) ? Border.all(color: Zine.ink, width: 2) : null,
              ),
              child: Text('$d',
                  style: ZineText.value(size: 14,
                      weight: isSel || isToday ? FontWeight.w900 : FontWeight.w700)),
            ),
            const SizedBox(height: 2),
            SizedBox(
              height: 8,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (final b in blips.take(3))
                    Container(
                      width: 6, height: 6, margin: const EdgeInsets.symmetric(horizontal: 1),
                      decoration: BoxDecoration(
                          color: zineSourceColor(b.sourceApp), shape: BoxShape.circle),
                    ),
                  if (blips.length > 3)
                    Text('+', style: ZineText.tag(size: 8, color: Zine.inkSoft)),
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
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: ZineEmptyState(
            icon: PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold),
            text: 'All clear — nothing scheduled.',
          ),
        ),
      ];
    }
    return items.map((b) {
      final st = styleFor(b.sourceApp);
      final isBooking = b.sourceApp == 'avabooking';
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
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
          child: Row(children: [
            ZineIconBadge(icon: zineSourceIcon(b.sourceApp), color: zineSourceColor(b.sourceApp)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${fmtRange(b.startsAt, b.endsAt)} · ${st.label}'.toUpperCase(),
                    style: ZineText.kicker(size: 10)),
                const SizedBox(height: 3),
                Text(b.title ?? st.label,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 15)),
              ]),
            ),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
          ]),
        ),
      );
    }).toList();
  }

  Widget _legend() => Wrap(
        spacing: 14, runSpacing: 8,
        children: kSourceStyles.entries
            .map((e) => Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 10, height: 10,
                    decoration: BoxDecoration(
                      color: zineSourceColor(e.key),
                      shape: BoxShape.circle,
                      border: Border.all(color: Zine.ink, width: 1.5),
                    ),
                  ),
                  const SizedBox(width: 5),
                  Text(e.value.label.toUpperCase(), style: ZineText.tag(size: 10, color: Zine.inkSoft)),
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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'Settings',
        markWord: 'Settings',
        tag: 'AvaCalendar',
      ),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          // --- Google Calendar -------------------------------------------------
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.bold), color: Zine.blue),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Google Calendar', style: ZineText.cardTitle(size: 16)),
                  const SizedBox(height: 2),
                  Text(
                    _gcalConnected == null
                        ? 'Checking…'
                        : _gcalConnected!
                            ? 'Connected — two-way sync active'
                            : 'Not connected',
                    style: ZineText.sub(size: 13),
                  ),
                ]),
              ),
              const SizedBox(width: 10),
              if (_gcalConnected == true)
                ZineLink('DISCONNECT', underline: Zine.coral, fontSize: 11, onTap: _disconnectGcal)
              else
                ZineButton(
                  label: 'Connect',
                  variant: ZineButtonVariant.blue,
                  fontSize: 15,
                  onPressed: _connectGcal,
                ),
            ]),
          ),
          const SizedBox(height: 20),

          // --- Availability rules ----------------------------------------------
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('Offered hours', style: ZineText.cardTitle(size: 17)),
            ZineButton(
              label: 'Add',
              fontSize: 15,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _addRule,
            ),
          ]),
          const SizedBox(height: 10),
          if (_rules.isEmpty)
            Text('No offered hours yet — add weekday ranges buyers can book.',
                style: ZineText.sub(size: 13.5)),
          ..._rules.map((r) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: ZineCard(
                  radius: Zine.rSm,
                  padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(
                          '${_days[(r['weekday'] as num).toInt()]}  ${_hm((r['start_min'] as num).toInt())}–${_hm((r['end_min'] as num).toInt())}',
                          style: ZineText.value(size: 15),
                        ),
                        const SizedBox(height: 2),
                        Text('${r['slot_min']} MIN SLOTS · ${r['tz']}'.toUpperCase(),
                            style: ZineText.kicker(size: 10)),
                      ]),
                    ),
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () async {
                        setState(() => _rules.remove(r));
                        await _saveRules();
                      },
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                            size: 20, color: Zine.coral),
                      ),
                    ),
                  ]),
                ),
              )),
          const SizedBox(height: 20),

          // --- Booking policies -------------------------------------------------
          Text('Booking policies', style: ZineText.cardTitle(size: 17)),
          const SizedBox(height: 10),
          _policyTile('Buffer between sessions', 'buffer_min', 'min'),
          _policyTile('Minimum notice', 'min_notice_min', 'min'),
          _policyTile('Max bookings per day', 'max_per_day', ''),
          const SizedBox(height: 4),
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Vacation mode', style: ZineText.value(size: 15)),
                  const SizedBox(height: 2),
                  Text(
                    onVacation
                        ? 'Bookings paused until ${fmtDate(vac)} — existing bookings unaffected'
                        : 'Pause new bookings until a date',
                    style: ZineText.sub(size: 13),
                  ),
                ]),
              ),
              const SizedBox(width: 10),
              ZineToggle(
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
            ]),
          ),
          const SizedBox(height: 30),
        ],
      ),
    );
  }

  String _hm(int minutes) => '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';

  Widget _policyTile(String label, String key, String unit) {
    final v = (_policy[key] as num?)?.toInt() ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
        child: Row(children: [
          Expanded(child: Text(label, style: ZineText.sub(size: 14.5))),
          Text('$v $unit'.trim(), style: ZineText.value(size: 15, weight: FontWeight.w900)),
          const SizedBox(width: 6),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () async {
              final c = TextEditingController(text: '$v');
              final nv = await showDialog<int>(
                context: context,
                builder: (d) => AlertDialog(
                  backgroundColor: Zine.card,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(Zine.r),
                    side: const BorderSide(color: Zine.ink, width: Zine.bw),
                  ),
                  title: Text(label, style: ZineText.cardTitle(size: 17)),
                  content: ZineField(controller: c, keyboardType: TextInputType.number, autofocus: true),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(d), child: Text('Cancel', style: ZineText.link())),
                    ZineButton(
                      label: 'Save',
                      variant: ZineButtonVariant.blue,
                      fontSize: 15,
                      onPressed: () => Navigator.pop(d, int.tryParse(c.text)),
                    ),
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
            child: Padding(
              padding: const EdgeInsets.all(6),
              child: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
                  size: 18, color: Zine.inkSoft),
            ),
          ),
        ]),
      ),
    );
  }

  /// Connect Google Calendar via an IN-APP auth sheet (iOS ASWebAuthenticationSession
  /// / Android Custom Tabs) that AUTO-CLOSES on the avatokauth:// callback — the
  /// user stays inside AvaCalendar instead of being bounced to the external
  /// browser. gcalConnect() requests ?return=app so the Worker redirects to the
  /// callback scheme. Same pattern as AvaStorage / Backup & sync.
  Future<void> _connectGcal() async {
    final sw = Stopwatch()..start();
    Analytics.capture('gcal_connect_started', const {});
    final r = await PlatformApi.gcalConnect();
    final url = r['url'] as String?;
    if (url == null) {
      Analytics.error(
          domain: 'calendar', code: 'connect_url_null', screen: 'avacalendar', action: 'connect');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r['error'] as String? ?? 'Google sync not configured yet')));
      }
      return;
    }
    Analytics.capture('gcal_connect_opened', const {'mode': 'web_auth'});
    try {
      await FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: 'avatokauth');
      Analytics.capture('gcal_connect_returned', const {'mode': 'web_auth'});
      await _load();
      final connected = _gcalConnected == true;
      Analytics.capture(connected ? 'gcal_connected' : 'gcal_connect_unverified',
          {'via': 'web_auth', 'connect_ms': sw.elapsedMilliseconds});
    } on PlatformException catch (e) {
      if (e.code == 'CANCELED' || e.code == 'CANCELLED') {
        Analytics.capture('gcal_connect_cancelled', {'code': e.code});
      } else {
        AvaLog.I.log('gcal', 'web auth failed (${e.code}); falling back to tab');
        Analytics.error(
            domain: 'calendar', code: 'web_auth_failed', message: e.code,
            screen: 'avacalendar', action: 'connect');
        try {
          final opened = await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
          Analytics.capture('gcal_connect_fallback_opened', {'mode': 'in_app_tab', 'opened': opened});
          if (opened && mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Finish in Google, then pull to refresh.')));
          }
        } catch (e2) {
          Analytics.error(
              domain: 'calendar', code: 'fallback_launch_failed', message: e2.toString(),
              screen: 'avacalendar', action: 'connect');
        }
      }
    } catch (e) {
      AvaLog.I.log('gcal', 'web auth error: $e');
      Analytics.error(
          domain: 'calendar', code: 'web_auth_error', message: e.toString(),
          screen: 'avacalendar', action: 'connect');
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
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Offered hours', style: ZineText.cardTitle(size: 17)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineDropdown<int>(
              value: weekday,
              items: List.generate(7, (i) => DropdownMenuItem(value: i, child: Text(_days[i]))),
              onChanged: (v) => setS(() => weekday = v ?? 1),
            ),
            const SizedBox(height: 10),
            ZineCard(
              radius: Zine.rSm,
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: start); if (t != null) setS(() => start = t); },
              child: Row(children: [
                Expanded(child: Text('From ${start.format(d2)}', style: ZineText.value(size: 14.5))),
                PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
              ]),
            ),
            const SizedBox(height: 10),
            ZineCard(
              radius: Zine.rSm,
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: end); if (t != null) setS(() => end = t); },
              child: Row(children: [
                Expanded(child: Text('To ${end.format(d2)}', style: ZineText.value(size: 14.5))),
                PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
              ]),
            ),
            const SizedBox(height: 12),
            ZineField(controller: slotC, label: 'Slot length (min)', keyboardType: TextInputType.number),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: Text('Cancel', style: ZineText.link())),
            ZineButton(
              label: 'Add it',
              variant: ZineButtonVariant.blue,
              fontSize: 15,
              onPressed: () => Navigator.pop(d, true),
            ),
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
