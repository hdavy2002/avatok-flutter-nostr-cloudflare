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
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'booking_card.dart';
import 'calendar_data.dart';

/// Card / dialog title — the dark-system stand-in for the old
/// `ZineText.cardTitle(...)`.
TextStyle _title(double size) =>
    ADText.threadName().copyWith(fontSize: size, height: 1.1, letterSpacing: -0.2);

/// Body copy — the dark-system stand-in for the old `ZineText.sub(...)`.
TextStyle _sub(double size, {Color c = AD.textSecondary}) =>
    ADText.preview(c: c).copyWith(fontSize: size, height: 1.42);

/// Emphasised value line — the stand-in for `ZineText.value(...)`.
TextStyle _value(double size, {FontWeight w = FontWeight.w600}) =>
    ADText.rowName().copyWith(fontSize: size, fontWeight: w);

/// Inline text link — the stand-in for `ZineText.link()`.
TextStyle get _link => ADText.rowName(c: Msg.accent).copyWith(fontSize: 13);

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
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'AvaCalendar',
        markWord: 'Calendar',
        tag: 'Every app, one grid',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
            onTap: _refresh,
          ),
          const SizedBox(width: Msg.s3),
          ZineBackButton(
            icon: PhosphorIcons.gearSix(PhosphorIconsStyle.regular),
            onTap: () => _openSettings(context),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: Msg.accent,
        backgroundColor: AD.card,
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(Msg.s4),
          children: [
            _monthHeader(),
            const SizedBox(height: Msg.s1),
            _weekdayRow(),
            _monthGrid(),
            const SizedBox(height: Msg.s4),
            Text(
              '${_selected.day}.${_selected.month}.${_selected.year}',
              style: _title(19),
            ),
            const SizedBox(height: Msg.s3),
            if (_loading && _blocks.isEmpty)
              const Center(child: Padding(padding: EdgeInsets.all(Msg.s5),
                  child: CircularProgressIndicator(color: Msg.accent))),
            ..._agenda(),
            const SizedBox(height: Msg.s5),
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
            icon: PhosphorIcons.caretLeft(PhosphorIconsStyle.regular),
            onTap: () => setState(() { _month = DateTime(_month.year, _month.month - 1); _refresh(); }),
          ),
          Text(
            '${const ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_month.month - 1]} ${_month.year}',
            style: _title(20),
          ),
          ZineBackButton(
            icon: PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
            onTap: () => setState(() { _month = DateTime(_month.year, _month.month + 1); _refresh(); }),
          ),
        ],
      );

  Widget _weekdayRow() => Row(
        children: const ['M', 'T', 'W', 'T', 'F', 'S', 'S']
            .map((d) => Expanded(child: Center(child: Text(d, style: ADText.sectionLabel()))))
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
          padding: const EdgeInsets.symmetric(vertical: Msg.s1),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Selected = accent disc carrying WHITE ink; today = hairline ring
            // with the normal white numeral. The old version painted dark ink
            // on a pale lime disc — inverted literally that would have been
            // white-on-orange at ~2.5:1 for the selected day, and an invisible
            // near-black ring for today.
            Container(
              width: 32, height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isSel ? Msg.accent : null,
                border: (isSel || isToday)
                    ? Border.all(
                        color: isSel ? Msg.accent : AD.borderControl, width: 1)
                    : null,
              ),
              child: Text('$d',
                  style: ADText.rowName(
                          c: isSel
                              ? Colors.white
                              : isToday
                                  ? AD.textPrimary
                                  : AD.textSecondary)
                      .copyWith(
                          fontSize: 14,
                          fontWeight:
                              isSel || isToday ? FontWeight.w700 : FontWeight.w500)),
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
                    Text('+', style: ADText.statCaption(c: AD.textSecondary).copyWith(fontSize: 9)),
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
          padding: const EdgeInsets.symmetric(vertical: Msg.s5),
          child: ZineEmptyState(
            icon: PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular),
            text: 'All clear — nothing scheduled.',
          ),
        ),
      ];
    }
    return items.map((b) {
      final st = styleFor(b.sourceApp);
      final isBooking = b.sourceApp == 'avabooking';
      return Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: ZineCard(
          radius: Msg.rLg,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
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
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${fmtRange(b.startsAt, b.endsAt)} · ${st.label}',
                    style: ADText.sectionLabel()),
                const SizedBox(height: Msg.rowTextGap),
                Text(b.title ?? st.label,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: _value(15)),
              ]),
            ),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.regular),
                size: 16, color: AD.textSecondary),
          ]),
        ),
      );
    }).toList();
  }

  Widget _legend() => Wrap(
        spacing: Msg.s4, runSpacing: Msg.s2,
        children: kSourceStyles.entries
            .map((e) => Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 10, height: 10,
                    decoration: BoxDecoration(
                      color: zineSourceColor(e.key),
                      shape: BoxShape.circle,
                      // The old 1.5px near-BLACK ring is dropped: on the
                      // near-black canvas it only ate the dot.
                    ),
                  ),
                  const SizedBox(width: Msg.s1),
                  Text(e.value.label, style: ADText.statCaption(c: AD.textSecondary)),
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
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(
        title: 'Settings',
        markWord: 'Settings',
        tag: 'AvaCalendar',
      ),
      body: ListView(
        padding: const EdgeInsets.all(Msg.s4),
        children: [
          // --- Google Calendar -------------------------------------------------
          ZineCard(
            radius: Msg.rLg,
            padding: const EdgeInsets.all(Msg.s4),
            child: Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
                  color: AD.familyByName('sky').solid),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Google Calendar', style: _title(16)),
                  const SizedBox(height: 2),
                  Text(
                    _gcalConnected == null
                        ? 'Checking…'
                        : _gcalConnected!
                            ? 'Connected — two-way sync active'
                            : 'Not connected',
                    style: _sub(13),
                  ),
                ]),
              ),
              const SizedBox(width: Msg.s3),
              if (_gcalConnected == true)
                ZineLink('Disconnect', underline: AD.danger, fontSize: 12, onTap: _disconnectGcal)
              else
                ZineButton(
                  label: 'Connect',
                  variant: ZineButtonVariant.blue,
                  fontSize: 15,
                  onPressed: _connectGcal,
                ),
            ]),
          ),
          const SizedBox(height: Msg.s5),

          // --- Availability rules ----------------------------------------------
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('Offered hours', style: _title(17)),
            ZineButton(
              label: 'Add',
              fontSize: 15,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _addRule,
            ),
          ]),
          const SizedBox(height: Msg.s3),
          if (_rules.isEmpty)
            Text('No offered hours yet — add weekday ranges buyers can book.',
                style: _sub(14)),
          ..._rules.map((r) => Padding(
                padding: const EdgeInsets.only(bottom: Msg.s3),
                child: ZineCard(
                  radius: Msg.rLg,
                  padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s3, Msg.s3),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(
                          '${_days[(r['weekday'] as num).toInt()]}  ${_hm((r['start_min'] as num).toInt())}–${_hm((r['end_min'] as num).toInt())}',
                          style: _value(15),
                        ),
                        const SizedBox(height: 2),
                        Text('${r['slot_min']} min slots · ${r['tz']}',
                            style: ADText.sectionLabel()),
                      ]),
                    ),
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () async {
                        setState(() => _rules.remove(r));
                        await _saveRules();
                      },
                      child: Padding(
                        padding: const EdgeInsets.all(Msg.s2),
                        child: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.regular),
                            size: 20, color: AD.danger),
                      ),
                    ),
                  ]),
                ),
              )),
          const SizedBox(height: Msg.s5),

          // --- Booking policies -------------------------------------------------
          Text('Booking policies', style: _title(17)),
          const SizedBox(height: Msg.s3),
          _policyTile('Buffer between sessions', 'buffer_min', 'min'),
          _policyTile('Minimum notice', 'min_notice_min', 'min'),
          _policyTile('Max bookings per day', 'max_per_day', ''),
          const SizedBox(height: Msg.s1),
          ZineCard(
            radius: Msg.rLg,
            padding: const EdgeInsets.all(Msg.s4),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Vacation mode', style: _value(15)),
                  const SizedBox(height: 2),
                  Text(
                    onVacation
                        ? 'Bookings paused until ${fmtDate(vac)} — existing bookings unaffected'
                        : 'Pause new bookings until a date',
                    style: _sub(13),
                  ),
                ]),
              ),
              const SizedBox(width: Msg.s3),
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
          const SizedBox(height: Msg.s6),
        ],
      ),
    );
  }

  String _hm(int minutes) => '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';

  Widget _policyTile(String label, String key, String unit) {
    final v = (_policy[key] as num?)?.toInt() ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s3, Msg.s3),
        child: Row(children: [
          Expanded(child: Text(label, style: _sub(15))),
          Text('$v $unit'.trim(), style: _value(15, w: FontWeight.w700)),
          const SizedBox(width: Msg.s1),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () async {
              final c = TextEditingController(text: '$v');
              final nv = await showDialog<int>(
                context: context,
                builder: (d) => AlertDialog(
                  backgroundColor: AD.card,
                  shape: RoundedRectangleBorder(
                    borderRadius: Msg.brLg,
                    side: const BorderSide(color: AD.borderControl, width: 1),
                  ),
                  title: Text(label, style: _title(17)),
                  content: ZineField(controller: c, keyboardType: TextInputType.number, autofocus: true),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(d), child: Text('Cancel', style: _link)),
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
              padding: const EdgeInsets.all(Msg.s1),
              child: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.regular),
                  size: 18, color: AD.textSecondary),
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
          backgroundColor: AD.card,
          shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl, width: 1),
          ),
          title: Text('Offered hours', style: _title(17)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineDropdown<int>(
              value: weekday,
              items: List.generate(7, (i) => DropdownMenuItem(value: i, child: Text(_days[i]))),
              onChanged: (v) => setS(() => weekday = v ?? 1),
            ),
            const SizedBox(height: Msg.s3),
            ZineCard(
              radius: Msg.rLg,
              boxShadow: Msg.none,
              padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: start); if (t != null) setS(() => start = t); },
              child: Row(children: [
                Expanded(child: Text('From ${start.format(d2)}', style: _value(15))),
                PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.regular),
                    size: 16, color: AD.textSecondary),
              ]),
            ),
            const SizedBox(height: Msg.s3),
            ZineCard(
              radius: Msg.rLg,
              boxShadow: Msg.none,
              padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
              onTap: () async { final t = await showTimePicker(context: d2, initialTime: end); if (t != null) setS(() => end = t); },
              child: Row(children: [
                Expanded(child: Text('To ${end.format(d2)}', style: _value(15))),
                PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.regular),
                    size: 16, color: AD.textSecondary),
              ]),
            ),
            const SizedBox(height: Msg.s3),
            ZineField(controller: slotC, label: 'Slot length (min)', keyboardType: TextInputType.number),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: Text('Cancel', style: _link)),
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
