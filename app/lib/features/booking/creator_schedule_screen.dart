import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/commercial_sessions_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../commercial_getstream/commercial_getstream_screens.dart';
import '../commercial_getstream/commercial_live_screens.dart';

enum CreatorScheduleKind { liveEvents, appointments }

class CreatorLiveEventsScreen extends StatelessWidget {
  const CreatorLiveEventsScreen({super.key});

  @override
  Widget build(BuildContext context) => const CreatorScheduleScreen(
        kind: CreatorScheduleKind.liveEvents,
      );
}

class CreatorAppointmentsScreen extends StatelessWidget {
  const CreatorAppointmentsScreen({super.key, this.focusListingId});

  final String? focusListingId;

  @override
  Widget build(BuildContext context) => CreatorScheduleScreen(
        kind: CreatorScheduleKind.appointments,
        focusListingId: focusListingId,
      );
}

/// Creator-owned commercial sessions. The server projection includes live
/// listings before host admission creates an entitlement and every confirmed
/// customer booking. Cards always carry the exact listing/booking IDs through
/// to the existing server-authorized readiness/prejoin screens.
class CreatorScheduleScreen extends StatefulWidget {
  const CreatorScheduleScreen({
    super.key,
    required this.kind,
    this.focusListingId,
  });

  final CreatorScheduleKind kind;
  final String? focusListingId;

  @override
  State<CreatorScheduleScreen> createState() => _CreatorScheduleScreenState();
}

class _CreatorScheduleScreenState extends State<CreatorScheduleScreen>
    with WidgetsBindingObserver {
  CommercialSessionsResponse? _response;
  bool _loading = true;
  bool _refreshing = false;
  Timer? _clock;
  Timer? _serverRefresh;

  bool get _isLiveEvents => widget.kind == CreatorScheduleKind.liveEvents;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _clock = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
    _serverRefresh = Timer.periodic(const Duration(minutes: 2), (_) {
      if (mounted) _load();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _clock?.cancel();
    _serverRefresh?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _load();
  }

  Future<void> _load() async {
    if (_refreshing) return;
    _refreshing = true;
    final requestUid = ApiAuth.identity?.uid ?? '';
    if (mounted) setState(() => _loading = _response == null);
    final response = await CommercialSessionsApi.mineAll(role: 'creator');
    if (!mounted || requestUid != (ApiAuth.identity?.uid ?? '')) {
      _refreshing = false;
      return;
    }
    setState(() {
      _response = response;
      _loading = false;
    });
    _refreshing = false;
  }

  List<CommercialSessionRecord> _sessions(CommercialSessionBucket bucket) {
    final all = (_response?.sessions ?? const <CommercialSessionRecord>[])
        .where((session) =>
            _isLiveEvents ? session.isLiveEvent : session.isConsultation)
        .where((session) => session.bucket == bucket)
        .where((session) =>
            widget.focusListingId == null ||
            session.listingId == widget.focusListingId)
        .toList();
    all.sort((a, b) => a.startsAt.compareTo(b.startsAt));
    return all;
  }

  @override
  Widget build(BuildContext context) {
    final title = _isLiveEvents ? 'My Live Events' : 'Customer Appointments';
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: title,
        markWord: _isLiveEvents ? 'events' : 'appointments',
        tag: 'creator schedule',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            onTap: _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AD.primaryBadge))
          : _response == null
              ? _error()
              : LayoutBuilder(
                  builder: (context, constraints) => Center(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth > 900 ? 860 : 700),
                      child: RefreshIndicator(
                        onRefresh: _load,
                        color: AD.primaryBadge,
                        child: ListView(
                          padding: const EdgeInsets.all(Msg.s4),
                          children: [
                            if (widget.focusListingId != null) _focusNotice(),
                            _section(
                                'Live now', CommercialSessionBucket.liveNow),
                            _section(
                                'Upcoming', CommercialSessionBucket.upcoming),
                            _section('Past', CommercialSessionBucket.completed),
                            _section('Cancelled / refunded',
                                CommercialSessionBucket.cancelledRefunded),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
    );
  }

  Widget _section(String label, CommercialSessionBucket bucket) {
    final sessions = _sessions(bucket);
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(label, style: ADText.sectionLabel())),
          if (sessions.isNotEmpty)
            Semantics(
              label: '$label, ${sessions.length} sessions',
              child: AdSticker('${sessions.length}', kind: AdStickerKind.hint),
            ),
        ]),
        const SizedBox(height: Msg.s2),
        if (sessions.isEmpty)
          ZineEmptyState(
            icon: bucket == CommercialSessionBucket.cancelledRefunded
                ? PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold)
                : _isLiveEvents
                    ? PhosphorIcons.broadcast(PhosphorIconsStyle.bold)
                    : PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
            text:
                'No ${label.toLowerCase()} ${_isLiveEvents ? 'events' : 'appointments'}.',
          )
        else
          for (final session in sessions) ...[
            _card(session),
            const SizedBox(height: Msg.s3),
          ],
      ]),
    );
  }

  Widget _card(CommercialSessionRecord session) {
    final cancelled = session.isRefunded || session.isCancelled;
    final completed = session.isCompleted;
    final isLive = session.bucket == CommercialSessionBucket.liveNow;
    final joinEnabled = _isLiveEvents
        ? !cancelled &&
            !completed &&
            RemoteConfig.commercialLiveJoinEnabled &&
            session.isJoinWindowOpen &&
            (session.allowedActions.isEmpty ||
                session.allowedActions.contains('start') ||
                session.allowedActions.contains('join'))
        : !cancelled &&
            !completed &&
            session.isJoinWindowOpen &&
            RemoteConfig.commercialConsultJoinEnabled;
    final actionLabel = cancelled
        ? session.isRefunded
            ? 'Refunded'
            : 'Cancelled'
        : completed
            ? 'Ended'
            : _isLiveEvents
                ? isLive
                    ? 'Rejoin controls'
                    : 'Start live'
                : session.isJoinWindowOpen
                    ? 'Join appointment'
                    : session.joinLabel;
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      boxShadow: const <BoxShadow>[],
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          PhosphorIcon(
            _isLiveEvents
                ? PhosphorIcons.broadcast(PhosphorIconsStyle.bold)
                : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
            color: _isLiveEvents ? AD.danger : AD.tabCalls,
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Text(session.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: ADText.rowName()),
          ),
        ]),
        const SizedBox(height: Msg.s2),
        Text(_dateRange(session.startsAt, session.endsAt),
            style: ADText.preview()),
        if (session.counterpartyName?.isNotEmpty == true) ...[
          const SizedBox(height: Msg.s1),
          Text('Customer: ${session.counterpartyName}',
              style: ADText.preview(c: AD.textSecondary)),
        ],
        const SizedBox(height: Msg.s3),
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(
              child: Text(
                  cancelled
                      ? session.isRefunded
                          ? 'Refunded'
                          : 'Cancelled'
                      : completed
                          ? 'Completed'
                          : session.joinLabel,
                  style: ADText.sectionLabel(
                      c: cancelled ? AD.danger : AD.textSecondary))),
          if (!completed && !cancelled)
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(0, 48)),
              onPressed: joinEnabled
                  ? () => _open(session)
                  : () => _notice(_isLiveEvents
                      ? 'Live controls are unavailable right now.'
                      : '${session.joinLabel}. The server controls the appointment window.'),
              child: Text(actionLabel),
            ),
        ]),
      ]),
    );
  }

  Future<void> _open(CommercialSessionRecord session) async {
    Analytics.capture('creator_schedule_action_tapped', {
      'kind': session.kind,
      'listing_id': session.listingId,
      if (session.bookingId != null) 'booking_id': session.bookingId!,
      'action': _isLiveEvents ? 'host' : 'join',
    });
    if (_isLiveEvents) {
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (_) => LiveReadinessScreen(
            listingId: session.listingId,
            title: session.title,
          ),
        ),
      );
      return;
    }
    final bookingId = session.bookingId;
    if (bookingId == null || bookingId.isEmpty) {
      _notice(
          'This appointment has no booking reference yet. Refresh to retry.');
      return;
    }
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => CommercialConsultationPrejoinScreen(
          listingId: session.listingId,
          bookingId: bookingId,
          title: session.title,
          isCreator: true,
        ),
      ),
    );
  }

  Widget _focusNotice() => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: Text('Showing appointments for the selected listing.',
            style: ADText.preview(c: AD.textSecondary)),
      );

  Widget _error() => Center(
        child: ZineEmptyState(
          icon: PhosphorIcons.cloudSlash(PhosphorIconsStyle.bold),
          text: 'Could not load your schedule. Pull to retry.',
        ),
      );

  void _notice(String message) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(message)));

  String _dateRange(int start, int end) {
    final a = DateTime.fromMillisecondsSinceEpoch(start).toLocal();
    final b = DateTime.fromMillisecondsSinceEpoch(end).toLocal();
    String date(DateTime d) =>
        '${d.day}/${d.month}/${d.year} · ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return '${date(a)}–${b.hour.toString().padLeft(2, '0')}:${b.minute.toString().padLeft(2, '0')}';
  }
}
