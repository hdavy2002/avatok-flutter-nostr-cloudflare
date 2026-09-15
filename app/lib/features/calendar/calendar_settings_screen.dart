// Availability settings: working hours, booking policy and the Google
// connection (audit findings 5, 6, 8, 10 and A3/A6).
//
// Google readiness is derived from additive `ready`/`reason`/`last_success_at`
// fields. When a deployed backend does not send them the screen says "Status
// unavailable" and keeps the "customers cannot book yet" warning — it never
// reports a healthy sync it could not verify.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/availability_api.dart';
import '../../core/platform_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../identity/identity.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'calendar_data.dart';
import 'calendar_day_editor.dart';
import 'calendar_logic.dart';
import 'calendar_signals.dart';
import 'calendar_ui.dart';

class CalendarSettingsScreen extends StatefulWidget {
  const CalendarSettingsScreen({super.key});

  @override
  State<CalendarSettingsScreen> createState() => _CalendarSettingsScreenState();
}

class _CalendarSettingsScreenState extends State<CalendarSettingsScreen> {
  AvailabilitySchedule? _schedule;
  GcalReadiness? _gcal;
  bool _loading = true;
  bool _saving = false;
  bool _gcalBusy = false;
  String? _error;
  String? _gcalMessage;
  static const _days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /// The account this screen's data belongs to. An async load or save that
  /// started under another account must not render, or write, under this one
  /// (review item 5).
  String? _accountScope = AccountScope.id;

  bool _scopeIsCurrent(String? captured) =>
      captured != null && captured == _accountScope && captured == AccountScope.id;

  @override
  void initState() {
    super.initState();
    _accountScope = AccountScope.id;
    _load();
  }

  Future<void> _load() async {
    final scope = AccountScope.id;
    if (scope == null) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Choose an account before changing calendar settings.';
        });
      }
      return;
    }
    try {
      final cached = await AvailabilityApi.cachedSchedule();
      if (!mounted || !_scopeIsCurrent(scope)) return;
      if (cached != null) {
        setState(() {
          _schedule = cached.value;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _loading = false;
          _error =
              'Saved calendar settings could not be read. Refreshing from the server…';
        });
      }
    }
    final failed = <String>[];
    try {
      final schedule = await AvailabilityApi.fetchSchedule();
      if (!mounted || !_scopeIsCurrent(scope)) return;
      setState(() {
        _schedule = schedule;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      failed.add('working hours');
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _loading = false;
          _error =
              'Working hours could not be refreshed. The values below may be out of date.';
        });
      }
    }
    if (!await _loadGcal(scope) && mounted && _scopeIsCurrent(scope)) {
      failed.add('Google Calendar');
    }
    if (mounted && _scopeIsCurrent(scope) && failed.isNotEmpty && _error == null) {
      setState(() => _error =
          'Some settings could not be refreshed: ${failed.join(', ')}.');
    }
  }

  Future<bool> _loadGcal(String? scope) async {
    if (scope == null) return false;
    try {
      final result = await PlatformApi.gcalStatusResult();
      if (!mounted || !_scopeIsCurrent(scope)) return true;
      setState(() {
        _gcal = result.ok
            ? gcalReadinessFromStatus(result.json)
            : gcalUnknown(result.error ??
                'Google Calendar status could not be read, so it cannot be verified.');
      });
      return result.ok;
    } catch (_) {
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() => _gcal = gcalUnknown(
            'Google Calendar status could not be read. Treat Google busy times as unverified.'));
      }
      return false;
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
                            style: calSub(14)),
                        if (_error != null) ...[
                          const SizedBox(height: Msg.s3),
                          calendarMessageCard(
                              _error!,
                              PhosphorIcons.warningCircle(
                                  PhosphorIconsStyle.regular),
                              AD.danger)
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
                        const SizedBox(height: Msg.s4),
                        Text(
                            'Listings can keep their own policy. Where a listing overrides the calendar, the listing’s value applies to that listing only.',
                            style: calSub(12)),
                      ])))
        ]);
      }),
    );
  }

  // ── Google Calendar ──────────────────────────────────────────────────────
  Widget _googleCard() {
    final readiness = _gcal;
    final calendars = readiness?.calendars ?? const <GcalCalendarStatus>[];
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
              color: AD.familyByName('sky').solid),
          const SizedBox(width: Msg.s3),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text('Google Calendar', style: calTitle(16)),
                const SizedBox(height: 2),
                Text('Busy times that must block your bookable time',
                    style: calSub(13)),
              ])),
          if (readiness != null) calendarReadinessSticker(readiness),
        ]),
        const SizedBox(height: Msg.s3),
        Text(readiness?.detail ?? 'Reading Google Calendar status…',
            style: calSub(13)),
        if (readiness?.lastSuccessAt != null) ...[
          const SizedBox(height: Msg.s2),
          Text(
              'Last successful sync ${_lastSync(readiness!.lastSuccessAt)} (oldest selected calendar).',
              style: calSub(12)),
        ],
        if (readiness != null && readiness.pausesBookings) ...[
          const SizedBox(height: Msg.s3),
          calendarMessageCard(
              'Customers cannot book listing time until Google readiness is confirmed.',
              PhosphorIcons.prohibit(PhosphorIconsStyle.regular),
              AD.haldi),
        ],
        if (_gcalMessage != null) ...[
          const SizedBox(height: Msg.s3),
          Text(_gcalMessage!, style: calSub(13)),
        ],
        const SizedBox(height: Msg.s3),
        Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
          if (readiness?.state == GcalState.notConnected || readiness == null)
            ZineButton(
                label: 'Connect Google Calendar',
                variant: ZineButtonVariant.blue,
                fontSize: 14,
                icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.regular),
                trailingIcon: false,
                onPressed: _connectGcal)
          else ...[
            ZineButton(
                label: 'Sync busy times now',
                variant: ZineButtonVariant.blue,
                fontSize: 14,
                loading: _gcalBusy,
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
                trailingIcon: false,
                onPressed: _gcalBusy ? null : _syncNow),
            ZineButton(
                label: 'Refresh calendar list',
                variant: ZineButtonVariant.ghost,
                fontSize: 14,
                icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular),
                trailingIcon: false,
                onPressed: _gcalBusy ? null : _refreshCalendarList),
            ZineButton(
                label: 'Choose calendars',
                variant: ZineButtonVariant.ghost,
                fontSize: 14,
                icon: PhosphorIcons.listChecks(PhosphorIconsStyle.regular),
                trailingIcon: false,
                onPressed: _gcalBusy || calendars.isEmpty
                    ? null
                    : () => _chooseCalendars(calendars)),
            ZineButton(
                label: 'Disconnect',
                variant: ZineButtonVariant.ghost,
                fontSize: 14,
                icon: PhosphorIcons.xCircle(PhosphorIconsStyle.regular),
                trailingIcon: false,
                onPressed: _gcalBusy ? null : _disconnectGcal),
          ],
        ]),
        if (calendars.isNotEmpty) ...[
          const SizedBox(height: Msg.s3),
          Text('Calendars', style: ADText.sectionLabel()),
          const SizedBox(height: Msg.s2),
          ...calendars.map(_calendarRow),
        ] else if (readiness?.state != GcalState.notConnected &&
            readiness != null) ...[
          const SizedBox(height: Msg.s2),
          Text('No Google calendar list has been loaded yet.',
              style: calSub(12)),
        ],
      ]),
    );
  }

  String _lastSync(int? epochMs) {
    if (epochMs == null || epochMs <= 0) return 'never';
    return hm(DateTime.fromMillisecondsSinceEpoch(epochMs));
  }

  Widget _calendarRow(GcalCalendarStatus calendar) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s2),
        child: ZineCard(
          radius: Msg.rMd,
          boxShadow: Msg.none,
          padding:
              const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PhosphorIcon(
                  calendar.selected
                      ? PhosphorIcons.checkCircle(PhosphorIconsStyle.regular)
                      : PhosphorIcons.circle(PhosphorIconsStyle.regular),
                  size: 18,
                  color: calendar.selected ? AD.online : AD.textTertiary),
              const SizedBox(width: Msg.s2),
              Expanded(
                  child: Text(calendar.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: calValue(14))),
              if (calendar.destination)
                const ZineSticker('Receives bookings',
                    kind: ZineStickerKind.hint),
            ]),
            const SizedBox(height: 2),
            Text(
                '${calendar.timezone} · ${calendar.selected ? 'blocks your time' : 'not blocking time'} · last synced ${_lastSync(calendar.lastSuccessAt)}',
                style: ADText.statCaption(c: AD.textSecondary)),
            if (calendar.failed) ...[
              const SizedBox(height: 2),
              Text(calendar.lastError!, style: calSub(12, c: AD.danger)),
            ],
          ]),
        ),
      );

  Future<void> _syncNow() async {
    final scope = AccountScope.id;
    if (scope == null) {
      setState(() => _gcalMessage =
          'Choose an account before syncing Google Calendar.');
      return;
    }
    setState(() {
      _gcalBusy = true;
      _gcalMessage = null;
    });
    try {
      final result = await PlatformApi.gcalSyncResult();
      if (!mounted || !_scopeIsCurrent(scope)) return;
      // The orchestration (what may be claimed, and whether the status must be
      // re-read) lives in a pure helper so CI covers it without a live account.
      final outcome = gcalSyncOutcome(
        ok: result.ok,
        routeUnavailable: result.routeUnavailable,
        json: result.json,
        error: result.error,
      );
      if (outcome.readiness != null) {
        setState(() {
          _gcalBusy = false;
          _gcal = outcome.readiness;
          _gcalMessage = outcome.message;
        });
        return;
      }
      if (outcome.reloadStatus) {
        final ok = await _loadGcal(scope);
        if (!mounted || !_scopeIsCurrent(scope)) return;
        setState(() {
          _gcalBusy = false;
          _gcalMessage = ok ? outcome.message : outcome.messageIfReloadFails;
        });
        return;
      }
      setState(() {
        _gcalBusy = false;
        _gcalMessage = outcome.message;
      });
    } catch (_) {
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = 'Google sync could not run. Nothing was reported as synced.';
        });
      }
    }
  }

  Future<void> _refreshCalendarList() async {
    setState(() {
      _gcalBusy = true;
      _gcalMessage = null;
    });
    try {
      final result = await PlatformApi.gcalCalendarsResult();
      if (!mounted) return;
      if (!result.ok) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = result.error ??
              'The Google calendar list could not be refreshed. This does not import busy times.';
        });
        return;
      }
      final rows = ((result.json['calendars'] as List?) ?? const [])
          .whereType<Map>()
          .map((row) => GcalCalendarStatus.fromJson(row.cast<String, dynamic>()))
          .toList(growable: false);
      final previous = _gcal;
      setState(() {
        _gcalBusy = false;
        _gcal = GcalReadiness(
          state: previous?.state ?? GcalState.unknown,
          label: previous?.label ?? 'Status unavailable',
          detail: previous?.detail ??
              'Readiness could not be verified from the calendar list.',
          lastSuccessAt: previous?.lastSuccessAt,
          calendars: rows,
          destinationCalendarId:
              (result.json['destination_calendar_id'] as String?) ??
                  previous?.destinationCalendarId,
        );
        _gcalMessage =
            'Calendar list refreshed (${rows.length}). This does not import busy times — use Sync busy times now.';
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = 'The Google calendar list could not be refreshed.';
        });
      }
    }
  }

  Future<void> _chooseCalendars(List<GcalCalendarStatus> calendars) async {
    final scope = AccountScope.id;
    if (scope == null) {
      setState(() => _gcalMessage =
          'Choose an account before changing Google calendars.');
      return;
    }
    final selected = <String>{
      for (final calendar in calendars)
        if (calendar.selected) calendar.id
    };
    var destination = _gcal?.destinationCalendarId ??
        (calendars.firstWhere((c) => c.destination,
                orElse: () => calendars.first)
            .id);
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          final valid = selected.isNotEmpty && selected.contains(destination);
          return AlertDialog(
            backgroundColor: AD.card,
            shape: RoundedRectangleBorder(
                borderRadius: Msg.brLg,
                side: const BorderSide(color: AD.borderControl)),
            title: Text('Which calendars count?', style: calTitle(17)),
            content: SingleChildScrollView(
              child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                        'Selected calendars block your bookable time. The destination calendar receives AvaTOK bookings.',
                        style: calSub(13)),
                    const SizedBox(height: Msg.s3),
                    ...calendars.map((calendar) => CheckboxListTile(
                          value: selected.contains(calendar.id),
                          onChanged: (value) => setDialogState(() {
                            if (value == true) {
                              selected.add(calendar.id);
                              destination = destination.isEmpty
                                  ? calendar.id
                                  : destination;
                            } else {
                              selected.remove(calendar.id);
                            }
                          }),
                          contentPadding: EdgeInsets.zero,
                          title: Text(calendar.summary, style: calValue(14)),
                          subtitle: Text(
                              calendar.destination
                                  ? 'Receives bookings'
                                  : calendar.timezone,
                              style: ADText.statCaption(c: AD.textSecondary)),
                        )),
                    const SizedBox(height: Msg.s2),
                    Text('Send AvaTOK bookings to', style: ADText.sectionLabel()),
                    const SizedBox(height: Msg.s2),
                    ...calendars
                        .where((calendar) => selected.contains(calendar.id))
                        .map((calendar) => RadioListTile<String>(
                              value: calendar.id,
                              groupValue: destination,
                              onChanged: (value) => setDialogState(
                                  () => destination = value ?? destination),
                              contentPadding: EdgeInsets.zero,
                              title:
                                  Text(calendar.summary, style: calValue(14)),
                            )),
                    if (!valid) ...[
                      const SizedBox(height: Msg.s2),
                      Text(
                          'Choose at least one calendar to block time, and send bookings to one of the selected calendars.',
                          style: calSub(12, c: AD.danger)),
                    ],
                  ]),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(dialogContext, false),
                  child: Text('Cancel', style: calLinkStyle)),
              ZineButton(
                  label: 'Save',
                  variant: ZineButtonVariant.blue,
                  fontSize: 14,
                  onPressed: valid
                      ? () => Navigator.pop(dialogContext, true)
                      : null),
            ],
          );
        },
      ),
    );
    if (saved != true || !mounted || !_scopeIsCurrent(scope)) return;
    setState(() {
      _gcalBusy = true;
      _gcalMessage = null;
    });
    try {
      final result = await PlatformApi.gcalSaveCalendarsResult(
          readCalendarIds: selected.toList(), destinationCalendarId: destination);
      if (!mounted || !_scopeIsCurrent(scope)) return;
      setState(() {
        _gcalBusy = false;
        _gcalMessage = result.ok
            ? 'Calendar selection saved.'
            : (result.error ?? 'Calendar selection could not be saved.');
      });
      if (result.ok) await _loadGcal(scope);
    } catch (_) {
      if (mounted) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = 'Calendar selection could not be saved.';
        });
      }
    }
  }

  // ── Working hours ────────────────────────────────────────────────────────
  Widget _hoursCard(AvailabilitySchedule schedule) => ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text('Working hours', style: calTitle(17)),
                const SizedBox(height: 2),
                Text('${schedule.timezone} · ${_modeLabel(schedule.mode)}',
                    style: calSub(13))
              ])),
          ZineButton(
              label: 'Add hours',
              variant: ZineButtonVariant.ghost,
              fontSize: 13,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              onPressed: _addRule)
        ]),
        const SizedBox(height: Msg.s2),
        calendarTimezoneNote(schedule.timezone,
            deviceNote: 'your device is ${DateTime.now().timeZoneName}'),
        const SizedBox(height: Msg.s3),
        if (schedule.rules.isEmpty)
          Text(
              'No working hours yet. Add a weekday range to make the schedule bookable.',
              style: calSub(13))
        else
          ...schedule.rules
              .asMap()
              .entries
              .map((entry) => _ruleRow(entry.key, entry.value)),
        const SizedBox(height: Msg.s3),
        _settingLine(
            'Timezone',
            schedule.timezone,
            () => _editTimezone(schedule)),
        _settingLine(
            'Slot duration',
            '${schedule.durationMin} min',
            () => showCalendarNumberDialog(
                  context,
                  title: 'Slot duration',
                  helper: 'How long one appointment lasts, in minutes.',
                  initialValue: schedule.durationMin,
                  min: 5,
                  max: 480,
                  validate: validateDurationMinutes,
                  onSave: (value) =>
                      _save(schedule.copyWith(durationMin: value)),
                )),
        _settingLine(
            'Slot interval',
            '${schedule.slotIntervalMin} min',
            () => showCalendarNumberDialog(
                  context,
                  title: 'Slot interval',
                  helper: 'How far apart the offered start times are.',
                  initialValue: schedule.slotIntervalMin,
                  min: 5,
                  max: 240,
                  validate: validateSlotIntervalMinutes,
                  onSave: (value) =>
                      _save(schedule.copyWith(slotIntervalMin: value)),
                )),
      ]));

  // ── Booking policy ───────────────────────────────────────────────────────
  Widget _policyCard(AvailabilitySchedule schedule) => ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Booking policy', style: calTitle(17)),
        const SizedBox(height: Msg.s2),
        Text('These limits are shared by every listing owned by this creator.',
            style: calSub(13)),
        const SizedBox(height: Msg.s3),
        _settingLine(
            'Buffer between sessions',
            '${schedule.bufferMin} min',
            () => showCalendarNumberDialog(
                  context,
                  title: 'Buffer between sessions',
                  helper:
                      'Applied BEFORE and AFTER every session, so a 30 min buffer reserves an extra 30 min on both sides.',
                  initialValue: schedule.bufferMin,
                  min: 0,
                  max: 240,
                  validate: validateBufferMinutes,
                  onSave: (value) => _save(schedule.copyWith(bufferMin: value)),
                )),
        _settingLine(
            'Minimum notice',
            '${schedule.minNoticeMin} min',
            () => showCalendarNumberDialog(
                  context,
                  title: 'Minimum notice',
                  helper:
                      'How far ahead a booking must be made. A listing can require longer notice; the larger value applies.',
                  initialValue: schedule.minNoticeMin,
                  min: 0,
                  max: 43200,
                  validate: validateNoticeMinutes,
                  onSave: (value) =>
                      _save(schedule.copyWith(minNoticeMin: value)),
                )),
        _settingLine(
            'Maximum per day',
            maxPerDayLabel(schedule.maxPerDay),
            () => showCalendarNumberDialog(
                  context,
                  title: 'Maximum per day',
                  helper:
                      'How many appointments each day can hold. The supported range is 1–100; unlimited (0) is not accepted by the server.',
                  initialValue: schedule.maxPerDay >= 1 && schedule.maxPerDay <= 100
                      ? schedule.maxPerDay
                      : null,
                  min: 1,
                  max: 100,
                  validate: validateMaxPerDay,
                  onSave: (value) => _save(schedule.copyWith(maxPerDay: value)),
                )),
        _settingLine(
            'Booking horizon',
            storedHorizonDays(schedule) == null
                ? 'Not stored'
                : '${schedule.horizonDays} days',
            () => showCalendarNumberDialog(
                  context,
                  title: 'Booking horizon',
                  helper:
                      'How far ahead customers can book. Up to $kMaxHorizonDays days; the value you choose is kept.',
                  initialValue: storedHorizonDays(schedule),
                  min: 1,
                  max: kMaxHorizonDays,
                  validate: validateHorizonDays,
                  onSave: (value) =>
                      _save(schedule.copyWith(horizonDays: value)),
                )),
        if (horizonPersistenceNotice(schedule) != null) ...[
          const SizedBox(height: Msg.s2),
          calendarMessageCard(
              horizonPersistenceNotice(schedule)!,
              PhosphorIcons.warningCircle(PhosphorIconsStyle.regular),
              AD.haldi),
        ],
        const SizedBox(height: Msg.s3),
        Text('Schedule mode', style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s2, children: [
          for (final mode in AvailabilityMode.values)
            ZineChip(
                label: _modeLabel(mode),
                active: schedule.mode == mode,
                onTap: () => _save(schedule.copyWith(mode: mode)))
        ]),
        const SizedBox(height: Msg.s3),
        Text(_effectiveRules(schedule), style: calSub(12)),
        const SizedBox(height: Msg.s2),
        Text(
            noticePolicyLine(noticePolicySummary(
              calendarNoticeMin: schedule.minNoticeMin,
              authoritativeEffectiveMinNoticeMin: schedule.effectiveMinNoticeMin,
            )),
            style: calSub(12)),
      ]));

  String _effectiveRules(AvailabilitySchedule schedule) {
    final parts = <String>[];
    parts.add(switch (schedule.mode) {
      AvailabilityMode.shared => 'offers your usual working hours',
      AvailabilityMode.custom => 'offers only the hours set here',
      AvailabilityMode.exclusive =>
        'offers only the dates and times you reserve',
    });
    parts.add(schedule.minNoticeMin > 0
        ? 'needs ${schedule.minNoticeMin} min notice'
        : 'has no minimum notice');
    parts.add(schedule.maxPerDay >= 1 && schedule.maxPerDay <= 100
        ? 'holds at most ${schedule.maxPerDay} appointment(s) per day'
        : 'has no daily limit stored (set one before publishing)');
    parts.add('reserves a ${schedule.bufferMin} min buffer around each session');
    final horizon = storedHorizonDays(schedule);
    parts.add(horizon == null
        ? 'has no stored booking horizon, so the server default applies'
        : 'is bookable up to $horizon days ahead');
    return 'Effective rules: this schedule ${parts.join(', ')}.';
  }

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
                    '${_days[(rule.weekday + 7) % 7]}  ${minutesRangeLabel(rule.startMin, rule.endMin)}',
                    style: calValue(14))),
            calendarIconAction(
                icon: PhosphorIcons.trash(PhosphorIconsStyle.regular),
                color: AD.danger,
                tooltip: 'Remove these hours',
                onTap: () {
                  final next = [...?_schedule?.rules]..removeAt(index);
                  _save(_schedule!.copyWith(rules: next));
                }),
          ])));

  Widget _settingLine(String label, String value, VoidCallback onTap) =>
      ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(label, style: calSub(14)),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(value, style: calValue(14)),
            const SizedBox(width: Msg.s2),
            PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.regular),
                size: 17, color: AD.textSecondary)
          ]),
          onTap: onTap);

  String _modeLabel(AvailabilityMode mode) => switch (mode) {
        AvailabilityMode.shared => 'Shared',
        AvailabilityMode.custom => 'Custom',
        AvailabilityMode.exclusive => 'Exclusive'
      };

  Future<void> _save(AvailabilitySchedule value) async {
    final scope = AccountScope.id;
    if (scope == null) {
      setState(() => _error =
          'Choose an account before saving calendar settings.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await AvailabilityApi.saveSchedule(value);
      if (!mounted || !_scopeIsCurrent(scope)) return;
      setState(() {
        _schedule = saved;
        _saving = false;
      });
      // [A6] The diary listens for this so returning from settings shows the
      // new hours immediately instead of a stale schedule.
      CalendarSignals.availabilitySaved();
      // A horizon outside 1..62 is omitted from the wire payload (the server
      // refuses it), so say that plainly instead of implying it was saved.
      final omitted = horizonPersistenceNotice(saved);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(omitted == null
              ? 'Availability updated'
              : 'Availability updated. $omitted')));
    } catch (e) {
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _saving = false;
          _error = e is AvailabilityApiException
              ? e.message
              : 'Could not save availability.';
        });
      }
    }
  }

  Future<void> _addRule() async {
    final scope = AccountScope.id;
    if (scope == null) {
      setState(() => _error =
          'Choose an account before changing calendar settings.');
      return;
    }
    final result = await showDialog<AvailabilityRule>(
        context: context, builder: (_) => const CalendarRuleDialog());
    if (result == null || !mounted || !_scopeIsCurrent(scope)) return;
    if (_schedule != null) {
      await _save(_schedule!.copyWith(rules: [..._schedule!.rules, result]));
    }
  }

  Future<void> _editTimezone(AvailabilitySchedule schedule) async {
    final value = await _editText('Timezone', schedule.timezone,
        helper: 'An IANA name such as Asia/Kolkata. Every listing shares it.');
    if (value == null) return;
    final error = validateTimezone(value);
    if (error != null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    await _save(schedule.copyWith(timezone: value));
  }

  Future<String?> _editText(String label, String value, {String? helper}) async {
    final controller = TextEditingController(text: value);
    final result = await showDialog<String>(
        context: context,
        builder: (_) => AlertDialog(
                backgroundColor: AD.card,
                shape: RoundedRectangleBorder(
                    borderRadius: Msg.brLg,
                    side: const BorderSide(color: AD.borderControl)),
                title: Text(label, style: calTitle(17)),
                content: Column(mainAxisSize: MainAxisSize.min, children: [
                  if (helper != null) ...[
                    Text(helper, style: calSub(13)),
                    const SizedBox(height: Msg.s3),
                  ],
                  ZineField(controller: controller, autofocus: true),
                ]),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text('Cancel', style: calLinkStyle)),
                  ZineButton(
                      label: 'Save',
                      variant: ZineButtonVariant.blue,
                      fontSize: 14,
                      onPressed: () =>
                          Navigator.pop(context, controller.text.trim()))
                ]));
    if (result == null || result.isEmpty) return null;
    return result;
  }

  Future<void> _connectGcal() async {
    final result = await PlatformApi.gcalConnect();
    final url = result['url'] as String?;
    if (url == null || url.isEmpty) {
      if (mounted) {
        setState(() => _gcalMessage =
            (result['error'] as String?) ?? 'Google sync is not configured yet.');
      }
      return;
    }
    final scope = AccountScope.id;
    if (scope == null) {
      if (mounted) {
        setState(() => _gcalMessage =
            'Choose an account before connecting Google Calendar.');
      }
      return;
    }
    try {
      await FlutterWebAuth2.authenticate(
          url: url, callbackUrlScheme: 'avatokauth');
      await _loadGcal(scope);
    } on PlatformException catch (error) {
      if (error.code == 'CANCELED' || error.code == 'CANCELLED') return;
      AvaLog.I
          .log('gcal', 'web auth failed (${error.code}); falling back to tab');
      try {
        final opened =
            await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
        if (opened && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Finish in Google, then tap Sync busy times now.')));
        }
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
    final scope = AccountScope.id;
    if (scope == null) {
      setState(() => _gcalMessage =
          'Choose an account before disconnecting Google Calendar.');
      return;
    }
    setState(() {
      _gcalBusy = true;
      _gcalMessage = null;
    });
    try {
      await PlatformApi.gcalDisconnect();
      await _loadGcal(scope);
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = 'Google Calendar disconnected.';
        });
      }
    } catch (_) {
      if (mounted && _scopeIsCurrent(scope)) {
        setState(() {
          _gcalBusy = false;
          _gcalMessage = 'Google Calendar could not be disconnected.';
        });
      }
    }
  }
}

/// Adds one weekly working-hours window. "Ends at midnight" is an explicit,
/// independent choice so a late window (18:00→24:00) keeps the server's 1440
/// end-of-day value instead of collapsing to minute 0 (audit finding 2).
class CalendarRuleDialog extends StatefulWidget {
  const CalendarRuleDialog({super.key});

  @override
  State<CalendarRuleDialog> createState() => _RuleDialogState();
}

class _RuleDialogState extends State<CalendarRuleDialog> {
  int _weekday = 1;
  TimeOfDay _start = const TimeOfDay(hour: 9, minute: 0);
  TimeOfDay _end = const TimeOfDay(hour: 17, minute: 0);
  bool _endOfDay = false;
  String? _error;

  @override
  Widget build(BuildContext context) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl)),
        title: Text('Add working hours', style: calTitle(17)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineDropdown<int>(
              label: 'Day',
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
              onChanged: (value) => setState(() {
                    _weekday = value ?? 1;
                    _error = null;
                  })),
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
                            })))
          ]),
          const SizedBox(height: Msg.s2),
          ZineButton(
              label: _endOfDay ? 'Ends at midnight: on' : 'Ends at midnight',
              variant: _endOfDay
                  ? ZineButtonVariant.blue
                  : ZineButtonVariant.ghost,
              fontSize: 13,
              trailingIcon: false,
              fullWidth: true,
              onPressed: () => setState(() {
                    _endOfDay = !_endOfDay;
                    _error = null;
                  })),
          if (_error != null) ...[
            const SizedBox(height: Msg.s3),
            Align(
                alignment: Alignment.centerLeft,
                child: Text(_error!, style: calSub(13, c: AD.danger))),
          ],
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text('Cancel', style: calLinkStyle)),
          ZineButton(
              label: 'Add hours',
              variant: ZineButtonVariant.blue,
              fontSize: 14,
              onPressed: () {
                final startMin = pickedMinutes(
                    endOfDay: false, hour: _start.hour, minute: _start.minute);
                final endMin = pickedMinutes(
                    endOfDay: _endOfDay, hour: _end.hour, minute: _end.minute);
                final error = pickedRangeError(startMin, endMin);
                if (error != null) {
                  setState(() => _error = error);
                  return;
                }
                Navigator.pop(
                    context,
                    AvailabilityRule(
                        weekday: _weekday,
                        startMin: startMin,
                        endMin: endMin));
              })
        ],
      );

  Widget _readOnlyTile(String label, String text) => ZineCard(
      radius: Msg.rMd,
      boxShadow: Msg.none,
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: ADText.sectionLabel()),
        const SizedBox(height: 2),
        Text(text, style: calValue(14))
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
            Text(value.format(context), style: calValue(14))
          ]));
}
