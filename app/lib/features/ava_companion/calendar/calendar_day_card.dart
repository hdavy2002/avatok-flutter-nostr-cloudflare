import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import 'ava_calendar_service.dart';
import 'calendar_action_sheets.dart';
import 'calendar_models.dart';

/// In-chat AVA calendar cards (the lilac "AVA · PRIVATE" bubbles).
///
/// [AvaCalendarCard] renders one day's result: the open-day hero + per-calendar
/// CLEAR list, or the busy-day event list, plus the action footer. It is fully
/// self-driving — button taps open the action sheets ([calendar_action_sheets])
/// and, on success, push a follow-up [AvaResultCard] back into the thread via
/// [onPostCard]. [onOpenUrl] is used for OAuth connect + "Join" video links
/// (the thread owns url_launcher).
library;

/// Shared lilac shell used by every AVA card so they all match the mockups.
class AvaCalendarShell extends StatelessWidget {
  final String lead;
  final Widget? pill;
  final Widget child;
  final String stamp;
  const AvaCalendarShell({
    super.key,
    required this.lead,
    required this.child,
    this.pill,
    this.stamp = '',
  });

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.92),
        child: Container(
          margin: const EdgeInsets.only(top: 4, bottom: 6),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.r),
            border: Border.all(color: Zine.ink, width: Zine.bw),
            boxShadow: Zine.shadowSm,
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 14, color: Zine.ink),
              const SizedBox(width: 6),
              Text('AVA · PRIVATE', style: ZineText.tag(size: 10, color: Zine.inkSoft)),
            ]),
            const SizedBox(height: 9),
            Text(lead, style: ZineText.cardTitle(size: 18)),
            if (pill != null) ...[const SizedBox(height: 11), pill!],
            const SizedBox(height: 12),
            child,
            if (stamp.isNotEmpty) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: Text(stamp, style: ZineText.tag(size: 10, color: Zine.inkSoft)),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// The dark context pill (calendar icon + summary), white text.
class _ContextPill extends StatelessWidget {
  final IconData icon;
  final String text;
  const _ContextPill({required this.icon, required this.text});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
      decoration: BoxDecoration(
        color: Zine.ink,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(icon, size: 14, color: Colors.white),
        const SizedBox(width: 8),
        Text(text, style: ZineText.tag(size: 11, color: Colors.white)),
      ]),
    );
  }
}

class AvaCalendarCard extends StatelessWidget {
  final CalDayOutcome outcome;
  final AvaCalendarService service;
  final void Function(Widget card) onPostCard;
  final void Function(String url) onOpenUrl;
  final String stamp;

  const AvaCalendarCard({
    super.key,
    required this.outcome,
    required this.service,
    required this.onPostCard,
    required this.onOpenUrl,
    this.stamp = '',
  });

  @override
  Widget build(BuildContext context) {
    switch (outcome.state) {
      case CalState.needsConnect:
        return _stateCard(
          context,
          lead: 'Connect Google Calendar and I\'ll pull your schedule right here.',
          icon: PhosphorIcons.plugs(PhosphorIconsStyle.bold),
          ctaLabel: 'Connect Calendar',
          onCta: outcome.authUrl == null ? null : () => onOpenUrl(outcome.authUrl!),
        );
      case CalState.unavailable:
        return _stateCard(
          context,
          lead: 'My app connections are still being set up — check back soon.',
          icon: PhosphorIcons.clock(PhosphorIconsStyle.bold),
        );
      case CalState.error:
        return _stateCard(
          context,
          lead: outcome.message ?? 'Couldn\'t reach your calendar — try again.',
          icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.bold),
        );
      case CalState.ok:
        final day = outcome.day!;
        return day.isOpen ? _openDay(context, day) : _busyDay(context, day);
    }
  }

  // ── connect / unavailable / error ──────────────────────────────────────────
  Widget _stateCard(BuildContext context,
      {required String lead, required IconData icon, String? ctaLabel, VoidCallback? onCta}) {
    return AvaCalendarShell(
      lead: lead,
      stamp: stamp,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: Row(children: [
            PhosphorIcon(icon, size: 22, color: Zine.ink),
            const SizedBox(width: 12),
            Expanded(child: Text(outcome.message ?? '', style: ZineText.sub(size: 13.5))),
          ]),
        ),
        if (ctaLabel != null) ...[
          const SizedBox(height: 12),
          ZineButton(
            label: ctaLabel,
            fullWidth: true,
            icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
            onPressed: onCta,
          ),
        ],
      ]),
    );
  }

  // ── open day ─────────────────────────────────────────────────────────────
  Widget _openDay(BuildContext context, CalDay day) {
    return AvaCalendarShell(
      lead: 'Good news — you have a completely open schedule ${_CalFmt.relDay(day.date)}.',
      stamp: stamp,
      pill: _ContextPill(
        icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
        text: '${_CalFmt.dayPill(day.date)} · 0 EVENTS',
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Hero
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Zine.mint,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Border.all(color: Zine.ink, width: Zine.bw),
            boxShadow: Zine.shadowXs,
          ),
          child: Row(children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Zine.ink, width: Zine.bw),
              ),
              child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 28, color: Zine.ink),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Open day', style: ZineText.cardTitle(size: 20)),
                const SizedBox(height: 2),
                Text('No scheduled events — you\'re free.',
                    style: ZineText.sub(size: 13, color: Zine.ink)),
              ]),
            ),
          ]),
        ),
        if (day.sources.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text('CHECKED ACROSS ${day.sources.length} CALENDAR${day.sources.length == 1 ? '' : 'S'}',
              style: ZineText.tag(size: 10, color: Zine.inkSoft)),
          const SizedBox(height: 8),
          for (final s in day.sources) ...[
            _SourceRow(source: s),
            const SizedBox(height: 8),
          ],
        ],
        const SizedBox(height: 4),
        ZineButton(
          label: 'Schedule a meeting',
          fullWidth: true,
          trailingIcon: false,
          icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
          onPressed: () => _schedule(context, day),
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: _ghost(context, 'Block focus', PhosphorIcons.timer(PhosphorIconsStyle.bold),
              () => _blockFocus(context, day))),
          const SizedBox(width: 10),
          Expanded(child: _ghost(context, 'Reminder', PhosphorIcons.bell(PhosphorIconsStyle.bold),
              () => _reminder(context, day))),
        ]),
      ]),
    );
  }

  // ── busy day ───────────────────────────────────────────────────────────────
  Widget _busyDay(BuildContext context, CalDay day) {
    final n = day.eventCount;
    final pm = day.events.where((e) => (e.start?.hour ?? 0) >= 12).length;
    final mostlyPm = pm > n / 2 && n > 1;
    final rel = _CalFmt.relDay(day.date); // today / tomorrow / on <day>
    final noun = n == 1 ? 'thing' : 'meetings';
    final head = rel == 'today'
        ? 'You\'ve got $n $noun today'
        : '${_CalFmt.relDayCap(day.date)}${rel == 'tomorrow' ? '\'s' : ' is'} busier — you\'ve got $n $noun';
    return AvaCalendarShell(
      lead: '$head${mostlyPm ? ', mostly in the afternoon' : ''}.',
      stamp: stamp,
      pill: _ContextPill(
        icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
        text: '${_CalFmt.dayPill(day.date)} · $n EVENT${n == 1 ? '' : 'S'}',
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final e in day.events) ...[
          _EventItem(event: e, accent: _accentFor(day, e), onJoin: () => onOpenUrl(e.videoLink!)),
          const SizedBox(height: 10),
        ],
        ZineButton(
          label: 'Add another',
          fullWidth: true,
          trailingIcon: false,
          icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
          onPressed: () => _schedule(context, day),
        ),
      ]),
    );
  }

  Color _accentFor(CalDay day, CalEvent e) {
    for (final s in day.sources) {
      if (s.id == e.calendarId) return s.color;
    }
    return Zine.blue;
  }

  Widget _ghost(BuildContext context, String label, IconData icon, VoidCallback onTap) {
    return ZinePressable(
      onTap: onTap,
      color: Zine.card,
      radius: BorderRadius.circular(100),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
      child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
        PhosphorIcon(icon, size: 16, color: Zine.ink),
        const SizedBox(width: 8),
        Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.button(size: 14))),
      ]),
    );
  }

  // ── button handlers → sheets → result chip ───────────────────────────────
  Future<void> _schedule(BuildContext context, CalDay day) async {
    final res = await showNewMeetingSheet(context, service: service, day: day);
    if (res != null) _postResult(res);
  }

  Future<void> _blockFocus(BuildContext context, CalDay day) async {
    final res = await showBlockFocusSheet(context, service: service, day: day);
    if (res != null) _postResult(res);
  }

  Future<void> _reminder(BuildContext context, CalDay day) async {
    final res = await showReminderSheet(context, service: service, day: day);
    if (res != null) _postResult(res);
  }

  void _postResult(CreatedResult r) {
    onPostCard(AvaResultCard(
      result: r,
      service: service,
      onOpenUrl: onOpenUrl,
      stamp: _CalFmt.now(),
    ));
  }
}

/// One calendar source row (dot + title + badge + CLEAR/count).
class _SourceRow extends StatelessWidget {
  final CalSource source;
  const _SourceRow({required this.source});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: Zine.card,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: source.primary ? Zine.shadowXs : null,
      ),
      child: Row(children: [
        Container(
          width: 14, height: 14,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: source.color,
            border: Border.all(color: Zine.ink, width: 1.5),
          ),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Text(source.title, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.value(size: 14, weight: FontWeight.w700)),
        ),
        if (source.primary || source.shared) ...[
          ZineSticker(source.primary ? 'PRIMARY' : 'SHARED', kind: ZineStickerKind.hint),
          const SizedBox(width: 10),
        ],
        if (source.clear)
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 14, color: Zine.mintInk),
            const SizedBox(width: 4),
            Text('CLEAR', style: ZineText.tag(size: 11, color: Zine.mintInk)),
          ])
        else
          Text('${source.eventCount}', style: ZineText.value(size: 14, color: Zine.inkSoft)),
      ]),
    );
  }
}

/// One event-item card on a busy day.
class _EventItem extends StatelessWidget {
  final CalEvent event;
  final Color accent;
  final VoidCallback onJoin;
  const _EventItem({required this.event, required this.accent, required this.onJoin});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Zine.card,
        borderRadius: BorderRadius.circular(Zine.rSm),
        border: Border.all(color: Zine.ink, width: Zine.bw),
        boxShadow: Zine.shadowXs,
      ),
      clipBehavior: Clip.antiAlias,
      child: IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // time rail
          Container(
            width: 66,
            color: accent,
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(event.allDay ? 'ALL' : _CalFmt.time(event.start),
                  style: ZineText.value(size: 16, weight: FontWeight.w800)),
              if (!event.allDay && event.end != null)
                Text(_CalFmt.time(event.end),
                    style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
            ]),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Row(children: [
                  Expanded(child: Text(event.title, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: ZineText.cardTitle(size: 16))),
                  if (event.attendeeCount > 0) ...[
                    const SizedBox(width: 8),
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), size: 16, color: Zine.inkSoft),
                      const SizedBox(width: 4),
                      Text('${event.attendeeCount}', style: ZineText.value(size: 13, color: Zine.inkSoft)),
                    ]),
                  ],
                ]),
                const SizedBox(height: 6),
                if (event.hasVideo)
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), size: 15, color: Zine.blueInk),
                    const SizedBox(width: 6),
                    Text('Video call', style: ZineText.link(size: 13)),
                  ])
                else if (event.location != null)
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    PhosphorIcon(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), size: 15, color: Zine.inkSoft),
                    const SizedBox(width: 6),
                    Flexible(child: Text(event.location!, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ZineText.sub(size: 13, color: Zine.inkSoft))),
                  ]),
                if (event.hasVideo) ...[
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: ZinePressable(
                      onTap: onJoin,
                      color: Zine.lime,
                      radius: BorderRadius.circular(100),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), size: 15, color: Zine.ink),
                        const SizedBox(width: 7),
                        Text('JOIN', style: ZineText.tag(size: 12.5)),
                      ]),
                    ),
                  ),
                ],
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

/// The "Done — X is on your calendar" confirmation card (post-create chip).
class AvaResultCard extends StatelessWidget {
  final CreatedResult result;
  final AvaCalendarService service;
  final void Function(String url) onOpenUrl;
  final String stamp;
  const AvaResultCard({
    super.key,
    required this.result,
    required this.service,
    required this.onOpenUrl,
    this.stamp = '',
  });

  @override
  Widget build(BuildContext context) {
    final e = result.event;
    return AvaCalendarShell(
      lead: result.lead,
      stamp: stamp,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rSm),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(result.calendarLabel.toUpperCase(),
              style: ZineText.tag(size: 10, color: Zine.inkSoft)),
          const SizedBox(height: 6),
          Text(e.title, style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 8),
          Row(children: [
            PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 15, color: Zine.inkSoft),
            const SizedBox(width: 7),
            Flexible(child: Text(_CalFmt.eventWhen(e), style: ZineText.value(size: 13.5, weight: FontWeight.w700))),
          ]),
          if (result.guestCount > 0) ...[
            const SizedBox(height: 6),
            Row(children: [
              PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), size: 15, color: Zine.inkSoft),
              const SizedBox(width: 7),
              Text('${result.guestCount} guest${result.guestCount == 1 ? '' : 's'}'
                  '${result.invited ? ' · invited' : ''}',
                  style: ZineText.sub(size: 13, color: Zine.inkSoft)),
            ]),
          ],
          if (e.hasVideo && (e.videoLink ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            GestureDetector(
              onTap: () => onOpenUrl(e.videoLink!),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), size: 15, color: Zine.blueInk),
                const SizedBox(width: 6),
                Flexible(child: Text(_displayLink(e.videoLink!),
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.link(size: 13))),
              ]),
            ),
          ],
          const SizedBox(height: 14),
          Row(children: [
            if (e.hasVideo && (e.videoLink ?? '').isNotEmpty) ...[
              _chip('JOIN', PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), Zine.lime,
                  () => onOpenUrl(e.videoLink!)),
              const SizedBox(width: 8),
            ],
            if (result.canEmailInvite) ...[
              _chip('EMAIL INVITE', PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill), Zine.blue,
                  () => showEmailInviteSheet(context, service: service, result: result)),
              const SizedBox(width: 8),
            ],
          ]),
        ]),
      ),
    );
  }

  Widget _chip(String label, IconData icon, Color color, VoidCallback onTap) {
    return ZinePressable(
      onTap: onTap,
      color: color,
      radius: BorderRadius.circular(100),
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(icon, size: 14, color: Zine.ink),
        const SizedBox(width: 7),
        Text(label, style: ZineText.tag(size: 12)),
      ]),
    );
  }

  static String _displayLink(String url) =>
      url.replaceFirst(RegExp(r'^https?://'), '');
}

/// Date/time formatting (no `intl` dependency in this app).
class _CalFmt {
  static const _wd = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  static const _mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /// "SUN · JUN 21"
  static String dayPill(DateTime d) =>
      '${_wd[d.weekday - 1]} · ${_mo[d.month - 1]} ${d.day}';

  /// "today" / "tomorrow" / "on Sun, Jun 21"
  static String relDay(DateTime d) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final diff = DateTime(d.year, d.month, d.day).difference(today).inDays;
    if (diff == 0) return 'today';
    if (diff == 1) return 'tomorrow';
    return 'on ${_wd[d.weekday - 1].toLowerCase()}';
  }

  static String relDayCap(DateTime d) {
    final r = relDay(d);
    return r[0].toUpperCase() + r.substring(1);
  }

  /// "9:30" / "1:00" (12h, no leading zero on hour).
  static String time(DateTime? dt) {
    if (dt == null) return '';
    var h = dt.hour % 12;
    if (h == 0) h = 12;
    return '$h:${dt.minute.toString().padLeft(2, '0')}';
  }

  /// "9:30 AM" with meridiem.
  static String time12(DateTime? dt) {
    if (dt == null) return '';
    final ap = dt.hour < 12 ? 'AM' : 'PM';
    return '${time(dt)} $ap';
  }

  /// "Sun, Jun 21 · 3:00 PM – 3:30 PM"
  static String eventWhen(CalEvent e) {
    final s = e.start;
    if (s == null) return '';
    final cap = '${_wd[s.weekday - 1][0]}${_wd[s.weekday - 1].substring(1).toLowerCase()}';
    final mon = '${_mo[s.month - 1][0]}${_mo[s.month - 1].substring(1).toLowerCase()}';
    final date = '$cap, $mon ${s.day}';
    if (e.allDay) return '$date · All day';
    final end = e.end == null ? '' : ' – ${time12(e.end)}';
    return '$date · ${time12(s)}$end';
  }

  static String now() => 'now';
}
