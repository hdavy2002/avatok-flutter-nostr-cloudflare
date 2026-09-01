import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_gate.dart';
import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/commercial_calendar_api.dart';
import '../../core/commercial_checkout_api.dart';
import '../../core/commercial_sessions_api.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../commercial_getstream/commercial_live_screens.dart';
import '../commercial_getstream/commercial_getstream_screens.dart';
import '../commercial_getstream/commercial_live_gateway.dart';
import '../explore/listing_detail.dart';
import '../calendar/avacalendar_screen.dart';

typedef CommercialCalendarAction = Future<void> Function(
  CommercialCheckoutResult result,
);

/// Confirmation after the server creates the account-bound order and
/// entitlement. This screen never fabricates a receipt; settlement may happen
/// after the session finishes.
class BookingSuccessScreen extends StatelessWidget {
  const BookingSuccessScreen(
      {super.key, required this.result, this.onAddToCalendar});
  final CommercialCheckoutResult result;
  final CommercialCalendarAction? onAddToCalendar;

  @override
  Widget build(BuildContext context) {
    final consult = result.kind == 'consult_1to1';
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
          title: 'Booking confirmed',
          markWord: 'confirmed',
          tag: 'account bound'),
      body: ListView(
        padding: const EdgeInsets.all(Msg.s5),
        children: [
          Icon(
            PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
            size: 62,
            color: AD.online,
          ),
          const SizedBox(height: Msg.s4),
          Text(
              consult
                  ? 'Your consultation is booked.'
                  : 'Your ticket is reserved.',
              textAlign: TextAlign.center,
              style: ADText.appTitle()),
          const SizedBox(height: Msg.s2),
          Text(
            'The server tied this ${consult ? 'booking' : 'ticket'} to your AvaTOK account. Public links do not transfer access.',
            textAlign: TextAlign.center,
            style: ADText.preview(),
          ),
          const SizedBox(height: Msg.s5),
          ZineCard(
            radius: Msg.rLg,
            padding: const EdgeInsets.all(Msg.s4),
            boxShadow: const <BoxShadow>[],
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _row('Amount held',
                  '${result.grossAmount ?? 0} ${result.currency ?? 'TOKENS'}'),
              if (result.startsAt != null)
                _row('Starts', _date(result.startsAt!)),
              if (result.bookingId != null) _row('Booking', result.bookingId!),
              if (result.orderId != null) _row('Order', result.orderId!),
              if (result.policySnapshotId != null || result.orderId != null)
                _row('Receipt reference',
                    result.policySnapshotId ?? result.orderId!),
              const SizedBox(height: Msg.s2),
              Text(
                  'Your receipt appears after server settlement. Refund status follows the accepted policy and provider evidence.',
                  style: ADText.sectionLabel(c: AD.textSecondary)),
            ]),
          ),
          const SizedBox(height: Msg.s4),
          if (result.startsAt != null) ...[
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 48)),
              onPressed: () async {
                if (onAddToCalendar != null) {
                  await onAddToCalendar!(result);
                } else {
                  await _addToCalendar(context);
                }
              },
              icon: Icon(PhosphorIcons.calendarPlus(PhosphorIconsStyle.bold)),
              label: const Text('Add to calendar'),
            ),
            const SizedBox(height: Msg.s2),
          ],
          FilledButton.icon(
            style: FilledButton.styleFrom(minimumSize: const Size(0, 48)),
            onPressed: () => Navigator.pushReplacement(
              context,
              MaterialPageRoute(builder: (_) => const MySessionsScreen()),
            ),
            icon: Icon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold)),
            label: const Text('View My Sessions'),
          ),
          const SizedBox(height: Msg.s2),
          OutlinedButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s1),
        child: Row(children: [
          Expanded(child: Text(label, style: ADText.preview())),
          Flexible(
              child: Text(value,
                  textAlign: TextAlign.end, style: ADText.rowName())),
        ]),
      );

  String _date(int millis) {
    final d = DateTime.fromMillisecondsSinceEpoch(millis).toLocal();
    return '${d.day}/${d.month}/${d.year} · ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  Future<void> _addToCalendar(BuildContext context) async {
    final entitlement = result.entitlementId;
    if (entitlement == null || entitlement.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Calendar entry is waiting for the server entitlement.'),
      ));
      return;
    }
    final added = await CommercialCalendarApi.addEntitlement(
      entitlement,
      kind: result.kind ?? '',
      listingId: result.listingId ?? '',
      bookingId: result.bookingId,
    );
    if (!context.mounted) return;
    final message = added.ok || added.alreadyAdded
        ? 'Added to AvaCalendar.'
        : added.conflict
            ? 'Calendar conflict — the session was not added.'
            : added.error == 'network'
                ? 'Calendar could not be reached. Try again.'
                : 'Calendar entry could not be added.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message),
      action: added.ok || added.alreadyAdded
          ? SnackBarAction(
              label: 'Open',
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AvaCalendarScreen())),
            )
          : null,
    ));
  }
}

class MySessionsScreen extends StatefulWidget {
  const MySessionsScreen({super.key, this.focusListingId, this.focusBookingId});

  final String? focusListingId;
  final String? focusBookingId;

  @override
  State<MySessionsScreen> createState() => _MySessionsScreenState();
}

class _MySessionsScreenState extends State<MySessionsScreen>
    with SingleTickerProviderStateMixin {
  // [COMMERCIAL-TEST-GREEN-1] `_tabs` used to be `late final TabController
  // _tabs = TabController(length: 4, vsync: this);` — a lazily-initialized
  // field. When both commercial flags are off, `build()` never renders the
  // TabBar/TabBarView and `initState()` never calls `_load()`, so nothing
  // ever touched `_tabs` while the widget was live. The first access ended
  // up being `_tabs.dispose()` inside `dispose()`, which ran the lazy
  // initializer at that point: constructing a new `TabController(vsync:
  // this)` calls `TickerMode.getValuesNotifier(context)`, which looks up an
  // inherited widget via this element's `context` — unsafe once the element
  // is deactivating. That is the "Looking up a deactivated widget's
  // ancestor is unsafe" assertion. Fixed by constructing `_tabs`
  // unconditionally and eagerly in `initState()`, while the element is
  // still active, so `dispose()` only ever disposes an already-built
  // controller and never triggers construction.
  late final TabController _tabs;
  CommercialSessionsResponse? _response;
  bool _loading = true;
  String? _error;
  String? _focusMessage;

  bool get _enabled =>
      RemoteConfig.commercialLiveListingsEnabled ||
      RemoteConfig.commercialConsultListingsEnabled;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 4, vsync: this);
    if (_enabled) {
      _load();
    } else {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!_enabled) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await CommercialSessionsApi.mine();
    if (!mounted) return;
    final matching = result?.sessions.where((session) =>
        (widget.focusBookingId == null ||
            session.bookingId == widget.focusBookingId) &&
        (widget.focusListingId == null ||
            session.listingId == widget.focusListingId));
    final focus = matching == null || matching.isEmpty ? null : matching.first;
    if (focus != null) {
      _tabs.index = switch (focus.bucket) {
        CommercialSessionBucket.upcoming => 0,
        CommercialSessionBucket.liveNow => 1,
        CommercialSessionBucket.completed => 2,
        CommercialSessionBucket.cancelledRefunded => 3,
      };
    }
    setState(() {
      _response = result;
      _loading = false;
      _error = result == null ? 'Could not load your sessions.' : null;
      _focusMessage = focus == null &&
              (widget.focusBookingId != null || widget.focusListingId != null)
          ? 'This update is not in the latest server session list yet. Pull to refresh.'
          : focus == null
              ? null
              : 'Showing the session linked from your notification.';
    });
  }

  List<CommercialSessionRecord> _for(CommercialSessionBucket bucket) =>
      (_response?.sessions ?? const <CommercialSessionRecord>[])
          .where((session) => session.bucket == bucket)
          .toList();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'My Sessions',
        markWord: 'sessions',
        tag: 'account bound',
        actions: [
          if (_enabled)
            ZineBackButton(
              icon: PhosphorIcons.wrench(PhosphorIconsStyle.bold),
              onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) =>
                          const CommercialSupportDiagnosticsScreen())),
            ),
          ZineBackButton(
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            onTap: _load,
          ),
        ],
      ),
      body: !_enabled
          ? _message(
              'Commercial sessions are unavailable while services are off.')
          : _loading
              ? const Center(
                  child: CircularProgressIndicator(color: AD.primaryBadge))
              : _error != null
                  ? _retry()
                  : Column(children: [
                      TabBar(
                        controller: _tabs,
                        isScrollable: true,
                        labelColor: AD.textPrimary,
                        unselectedLabelColor: AD.textTertiary,
                        indicatorColor: AD.primaryBadge,
                        tabs: const [
                          Tab(text: 'Upcoming'),
                          Tab(text: 'Live now'),
                          Tab(text: 'Completed'),
                          Tab(text: 'Cancelled/refunded'),
                        ],
                      ),
                      if (_focusMessage != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(
                              Msg.s4, Msg.s2, Msg.s4, 0),
                          child: Semantics(
                            liveRegion: true,
                            label: _focusMessage,
                            child: Text(_focusMessage!,
                                style: ADText.preview(c: AD.textSecondary)),
                          ),
                        ),
                      Expanded(
                          child: TabBarView(controller: _tabs, children: [
                        _list(CommercialSessionBucket.upcoming),
                        _list(CommercialSessionBucket.liveNow),
                        _list(CommercialSessionBucket.completed),
                        _list(CommercialSessionBucket.cancelledRefunded),
                      ])),
                    ]),
    );
  }

  Widget _list(CommercialSessionBucket bucket) {
    final sessions = _for(bucket);
    if (sessions.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          const SizedBox(height: 100),
          ZineEmptyState(
            icon: bucket == CommercialSessionBucket.cancelledRefunded
                ? PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold)
                : PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
            text: bucket == CommercialSessionBucket.cancelledRefunded
                ? 'No cancelled or refunded sessions.'
                : 'No sessions in this view yet.',
          ),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: AD.primaryBadge,
      child: ListView.separated(
        padding: const EdgeInsets.all(Msg.s4),
        itemCount: sessions.length,
        separatorBuilder: (_, __) => const SizedBox(height: Msg.s3),
        itemBuilder: (_, index) => _card(sessions[index]),
      ),
    );
  }

  Widget _card(CommercialSessionRecord session) {
    final joinEnabled = session.isJoinWindowOpen &&
        (session.isLiveEvent
            ? RemoteConfig.commercialLiveJoinEnabled
            : RemoteConfig.commercialConsultJoinEnabled);
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      boxShadow: const <BoxShadow>[],
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(
            session.isLiveEvent
                ? PhosphorIcons.broadcast(PhosphorIconsStyle.bold)
                : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
            color: session.isLiveEvent ? AD.danger : AD.tabCalls,
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
              child: Text(session.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
          Text('${session.price} ${session.currency ?? ''}',
              style: ADText.sectionLabel()),
        ]),
        const SizedBox(height: Msg.s2),
        Text(_dateRange(session.startsAt, session.endsAt),
            style: ADText.preview()),
        const SizedBox(height: Msg.s3),
        Row(children: [
          Expanded(
              child: Text(
            session.isRefunded
                ? 'Refunded / cancelled'
                : session.isCompleted
                    ? 'Completed'
                    : session.joinLabel,
            style: ADText.sectionLabel(
                c: session.isRefunded ? AD.danger : AD.textSecondary),
          )),
          if (!session.isRefunded && !session.isCompleted)
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(0, 48)),
              onPressed: joinEnabled
                  ? () => _join(session)
                  : () => _joinNotice(session, joinEnabled),
              child: Text(session.joinLabel),
            ),
        ]),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s2, children: [
          TextButton.icon(
            onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(
                    builder: (_) =>
                        ListingDetailScreen(listingId: session.listingId))),
            icon: Icon(PhosphorIcons.eye(PhosphorIconsStyle.bold), size: 16),
            label: const Text('View event'),
          ),
          if (session.sessionId != null && session.sessionId!.isNotEmpty)
            TextButton.icon(
              onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) =>
                          CommercialReceiptScreen(session: session))),
              icon: Icon(PhosphorIcons.receipt(PhosphorIconsStyle.bold),
                  size: 16),
              label: const Text('View receipt'),
            ),
          if (session.isRefunded)
            TextButton.icon(
              onPressed: () => _refundDetails(session),
              icon: Icon(PhosphorIcons.info(PhosphorIconsStyle.bold), size: 16),
              label: const Text('Refund details'),
            ),
          if (!session.isRefunded && !session.isCompleted)
            TextButton.icon(
              onPressed: () => _addToCalendar(session),
              icon: Icon(PhosphorIcons.calendarPlus(PhosphorIconsStyle.bold),
                  size: 16),
              label: const Text('Add to calendar'),
            ),
        ]),
      ]),
    );
  }

  Future<void> _join(CommercialSessionRecord session) async {
    if (!session.isJoinWindowOpen) {
      _joinNotice(session, false);
      return;
    }
    // [APP-JOIN-ROUTE-1] A session listed here is normally a bought
    // entitlement (viewer/buyer), but a creator who booked into their own
    // listing (self-test, or a creator following their own calendar entry)
    // holds one too — and MUST land backstage, not in their own audience.
    // `ListingDetail.isOwner` is the server's own creator/viewer verdict for
    // this account (worker/src/routes/listings.ts), the same signal
    // ListingDetailScreen already uses — never inferred client-side.
    final isCreator = await _isCreatorOf(session.listingId);
    if (!mounted) return;
    Analytics.capture('commercial_session_join_tapped', {
      'kind': session.kind,
      'role': isCreator ? 'creator' : 'buyer',
    });
    if (session.isLiveEvent) {
      if (isCreator) {
        await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => LiveReadinessScreen(
                listingId: session.listingId,
                title: session.title,
              ),
            ));
        return;
      }
      final entitlement = session.entitlementId;
      if (entitlement.isEmpty) {
        _notice('The server has not returned a valid ticket entitlement.');
        return;
      }
      await Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => LiveViewerScreen(
              listingId: session.listingId,
              title: session.title,
            ),
          ));
    } else if (session.bookingId != null && session.bookingId!.isNotEmpty) {
      await Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => CommercialConsultationPrejoinScreen(
              listingId: session.listingId,
              bookingId: session.bookingId!,
              title: session.title,
              isCreator: isCreator,
              gateway: AuthenticatedCommercialConsultGateway(),
            ),
          ));
    }
  }

  /// Best-effort creator check for [listingId]. A failure here must never
  /// silently pretend the viewer is the creator — it falls back to `false`
  /// (viewer screens), which is exactly today's behaviour, and reports the
  /// failure instead of swallowing it.
  Future<bool> _isCreatorOf(String listingId) async {
    try {
      final detail = await ListingsApi.detail(listingId);
      return detail?.isOwner ?? false;
    } catch (e, st) {
      Analytics.captureException(e, st,
          screen: 'my_sessions_join',
          handled: true,
          extra: {'listing_id': listingId});
      return false;
    }
  }

  void _joinNotice(CommercialSessionRecord session, bool enabled) {
    _notice(!enabled
        ? 'Joining is not available yet.'
        : '${session.joinLabel}. The server controls the join window.');
  }

  void _refundDetails(CommercialSessionRecord session) {
    final refundStatus = session.refundSettlementState;
    final receiptStatus = session.receiptSettlementState;
    final status = refundStatus?.isNotEmpty == true
        ? refundStatus!
        : receiptStatus?.isNotEmpty == true
            ? receiptStatus!
            : session.orderStatus.isNotEmpty
                ? session.orderStatus
                : 'pending server status';
    _notice('Refund status: $status.');
  }

  Future<void> _addToCalendar(CommercialSessionRecord session) async {
    final result = await CommercialCalendarApi.addEntitlement(
      session.entitlementId,
      kind: session.kind,
      listingId: session.listingId,
      bookingId: session.bookingId,
    );
    if (!mounted) return;
    final message = result.ok || result.alreadyAdded
        ? 'Added to AvaCalendar.'
        : result.conflict
            ? 'Calendar conflict — the session was not added.'
            : result.error == 'network'
                ? 'Calendar could not be reached. Try again.'
                : 'Calendar entry could not be added.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message),
      action: result.ok || result.alreadyAdded
          ? SnackBarAction(
              label: 'Open',
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AvaCalendarScreen())),
            )
          : null,
    ));
  }

  void _notice(String value) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(value)));

  Widget _retry() => Center(
      child: ZineEmptyState(
          icon: PhosphorIcons.cloudSlash(PhosphorIconsStyle.bold),
          text: 'Could not load your sessions — pull to retry.'));

  Widget _message(String value) => Center(
      child: ZineEmptyState(
          icon: PhosphorIcons.lock(PhosphorIconsStyle.bold), text: value));

  String _dateRange(int start, int end) {
    final a = DateTime.fromMillisecondsSinceEpoch(start).toLocal();
    final b = DateTime.fromMillisecondsSinceEpoch(end).toLocal();
    return '${a.day}/${a.month}/${a.year} · ${a.hour.toString().padLeft(2, '0')}:${a.minute.toString().padLeft(2, '0')}–${b.hour.toString().padLeft(2, '0')}:${b.minute.toString().padLeft(2, '0')}';
  }
}

/// [APP-JOIN-ROUTE-1] Resolves a booking join link — `https://avatok.ai/j/<token>`
/// or `avatok://j/<token>` — into the correct screen. Every confirmation
/// email, reminder email and calendar `.ics` `URL:` field points at this
/// path shape (worker/src/cal/ics.ts `joinUrlFor`); before this screen
/// existed the link opened the app to whatever was already showing and
/// silently dropped the token.
///
/// The token itself only carries a signed, expiring booking id
/// (`GET /api/join-info/:token`, worker/src/routes/booking.ts `joinInfo`,
/// PUBLIC — no auth, display data only). Resolving the booking's `kind`,
/// `listing_id` and the caller's role (creator vs buyer) needs the
/// authenticated `GET /api/booking/list`, so a signed-out tap is sent
/// through the sign-in gate first and this same method simply continues
/// once it returns — nothing about the original link is dropped or
/// re-parsed.
class JoinLinkResolverScreen extends StatefulWidget {
  const JoinLinkResolverScreen({
    super.key,
    required this.token,
    required this.scheme,
  });

  final String token;
  final String scheme;

  @override
  State<JoinLinkResolverScreen> createState() =>
      _JoinLinkResolverScreenState();
}

class _JoinLinkResolverScreenState extends State<JoinLinkResolverScreen> {
  String? _error;
  bool _offerMySessions = false;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  Future<void> _resolve() async {
    try {
      final infoResp = await ApiAuth.getSigned(
        '$kApiBase/join-info/${Uri.encodeComponent(widget.token)}',
      );
      if (infoResp.statusCode == 404) {
        _fail('This link has expired or is no longer valid.',
            reason: 'invalid_or_expired');
        return;
      }
      if (infoResp.statusCode != 200) {
        _fail('Could not open this session link. Please try again.',
            reason: 'http_${infoResp.statusCode}');
        return;
      }
      final decoded = jsonDecode(infoResp.body);
      if (decoded is! Map) {
        _fail('Could not open this session link. Please try again.',
            reason: 'bad_response');
        return;
      }
      final data = decoded.cast<String, dynamic>();
      final status = (data['status'] ?? '').toString();
      final startsAt = (data['starts_at'] as num?)?.toInt() ?? 0;
      final endsAt = (data['ends_at'] as num?)?.toInt() ?? 0;
      final title = (data['title'] ?? 'AvaTOK session').toString();
      final deeplink = (data['deeplink'] ?? '').toString();
      final segments = deeplink.split('/');
      final bookingId = segments.isNotEmpty ? segments.last.trim() : '';
      if (bookingId.isEmpty) {
        _fail('Could not open this session link. Please try again.',
            reason: 'no_booking_id');
        return;
      }
      if (status == 'cancelled' || status == 'canceled') {
        _fail('This booking was cancelled.',
            reason: 'cancelled', offerMySessions: true);
        return;
      }
      if (endsAt > 0 && DateTime.now().millisecondsSinceEpoch >= endsAt) {
        _fail('This session has ended.',
            reason: 'ended', offerMySessions: true);
        return;
      }

      if (!AccountGate.isMember) {
        if (!mounted) return;
        final signedIn =
            await AccountGate.ensureMember(context, reason: 'join this session');
        if (!mounted) return;
        if (!signedIn) {
          Analytics.capture('join_link_signin_declined', {
            'path_shape': '/j/<token>',
          });
          Navigator.of(context).maybePop();
          return;
        }
      }

      final uid = ApiAuth.identity?.uid ?? '';
      var row = await _findBooking(bookingId, when: 'upcoming');
      row ??= await _findBooking(bookingId, when: 'past');

      final kind = (row?['kind'] ?? '').toString();
      final listingId = (row?['listing_id'] ?? '').toString();
      final creatorId = (row?['creator_id'] ?? '').toString();
      final isCreator =
          uid.isNotEmpty && creatorId.isNotEmpty && uid == creatorId;

      if (!mounted) return;
      Analytics.capture('join_link_resolved', {
        'path_shape': '/j/<token>',
        'scheme': widget.scheme,
        'kind': kind.isEmpty ? 'unknown' : kind,
        'role': row == null ? 'unknown' : (isCreator ? 'creator' : 'buyer'),
        'starts_at': startsAt,
      });

      if (row == null || listingId.isEmpty) {
        // Couldn't confirm role/kind/listing from the booking list (network
        // hiccup, or the booking sits outside the 100-row window). Not a
        // silent no-op: land on My Sessions with the booking focused — the
        // same screen the buyer already reaches from a notification, and it
        // resolves this exact booking id server-side on its own.
        _goto(MySessionsScreen(focusBookingId: bookingId));
        return;
      }

      if (isCreator && kind == 'live_event') {
        _goto(LiveReadinessScreen(listingId: listingId, title: title));
      } else if (isCreator && kind == 'consult_1to1') {
        _goto(CommercialConsultationPrejoinScreen(
          listingId: listingId,
          bookingId: bookingId,
          title: title,
          isCreator: true,
        ));
      } else if (kind == 'live_event') {
        _goto(LiveViewerScreen(listingId: listingId, title: title));
      } else if (kind == 'consult_1to1') {
        _goto(CommercialConsultationPrejoinScreen(
          listingId: listingId,
          bookingId: bookingId,
          title: title,
        ));
      } else {
        // consult_group or any other legacy kind — not part of this
        // workstream's routing; My Sessions is the honest landing spot.
        _goto(MySessionsScreen(focusBookingId: bookingId, focusListingId: listingId));
      }
    } catch (e, st) {
      Analytics.captureException(e, st,
          screen: 'join_link_resolver',
          handled: true,
          extra: {'path_shape': '/j/<token>'});
      _fail(
          'Could not open this session link. Check your connection and try again.',
          reason: 'exception');
    }
  }

  Future<Map<String, dynamic>?> _findBooking(String bookingId,
      {required String when}) async {
    try {
      final resp =
          await ApiAuth.getSigned('$kBookingBase/list?role=all&when=$when');
      if (resp.statusCode != 200) return null;
      final decoded = jsonDecode(resp.body);
      if (decoded is! Map) return null;
      final list = (decoded['bookings'] as List?) ?? const [];
      for (final row in list) {
        if (row is Map && row['id']?.toString() == bookingId) {
          return row.cast<String, dynamic>();
        }
      }
      return null;
    } catch (e, st) {
      Analytics.captureException(e, st,
          screen: 'join_link_resolver',
          handled: true,
          extra: {'stage': 'booking_list', 'when': when});
      return null;
    }
  }

  void _goto(Widget target) {
    if (!mounted) return;
    Navigator.of(context)
        .pushReplacement(MaterialPageRoute(builder: (_) => target));
  }

  void _fail(String message, {required String reason, bool offerMySessions = false}) {
    Analytics.capture('join_link_resolve_failed', {
      'path_shape': '/j/<token>',
      'scheme': widget.scheme,
      'reason': reason,
    });
    if (!mounted) return;
    setState(() {
      _error = message;
      _offerMySessions = offerMySessions;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Center(
          child: _error == null
              ? const CircularProgressIndicator(color: AD.primaryBadge)
              : Padding(
                  padding: const EdgeInsets.all(Msg.s5),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        PhosphorIcons.warningCircle(PhosphorIconsStyle.bold),
                        size: 48,
                        color: AD.danger,
                      ),
                      const SizedBox(height: Msg.s3),
                      Text(_error!,
                          textAlign: TextAlign.center, style: ADText.appTitle()),
                      const SizedBox(height: Msg.s4),
                      if (_offerMySessions)
                        FilledButton.icon(
                          style: FilledButton.styleFrom(
                              minimumSize: const Size(0, 48)),
                          onPressed: () => _goto(const MySessionsScreen()),
                          icon: Icon(
                              PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold)),
                          label: const Text('View My Sessions'),
                        )
                      else
                        OutlinedButton(
                          onPressed: () => Navigator.of(context).maybePop(),
                          child: const Text('Close'),
                        ),
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

/// A support-safe export surface. It contains only account-owned identifiers
/// and lifecycle states; provider credentials, tokens and call ids are never
/// included or copied.
class CommercialSupportDiagnosticsScreen extends StatefulWidget {
  const CommercialSupportDiagnosticsScreen({super.key});

  @override
  State<CommercialSupportDiagnosticsScreen> createState() =>
      _CommercialSupportDiagnosticsScreenState();
}

class _CommercialSupportDiagnosticsScreenState
    extends State<CommercialSupportDiagnosticsScreen> {
  CommercialSessionsResponse? _response;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final result = await CommercialSessionsApi.mine();
    if (mounted)
      setState(() {
        _response = result;
        _loading = false;
      });
  }

  String _exportText() {
    final sessions = (_response?.sessions ?? const <CommercialSessionRecord>[])
        .map((session) => {
              'entitlement_id': session.entitlementId,
              'listing_id': session.listingId,
              if (session.bookingId != null) 'booking_id': session.bookingId,
              'kind': session.kind,
              'bucket': session.bucket.name,
              'entitlement_state': session.entitlementState,
              'booking_status': session.bookingStatus,
              'order_status': session.orderStatus,
              if (session.sessionState != null)
                'session_state': session.sessionState,
              if (session.receiptSettlementState != null)
                'receipt_settlement_state': session.receiptSettlementState,
            })
        .toList();
    return jsonEncode({
      'server_now': _response?.serverNow ?? 0,
      'sessions': sessions,
      'provider_credentials': 'omitted',
    });
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: _exportText()));
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Safe session diagnostics copied.')));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: AD.bg,
        appBar: ZineAppBar(
            title: 'Session support', markWord: 'support', tag: 'safe export'),
        body: _loading
            ? const Center(
                child: CircularProgressIndicator(color: AD.primaryBadge))
            : ListView(
                padding: const EdgeInsets.all(Msg.s5),
                children: [
                  Text(
                      'Share these IDs and states with AvaTOK support. Provider credentials are never included.',
                      style: ADText.preview(c: AD.textSecondary)),
                  const SizedBox(height: Msg.s4),
                  Semantics(
                    button: true,
                    label: 'Copy safe session diagnostics',
                    child: SizedBox(
                      height: 48,
                      child: FilledButton.icon(
                        onPressed: _copy,
                        icon: Icon(PhosphorIcons.copy(PhosphorIconsStyle.bold)),
                        label: const Text('Copy diagnostics'),
                      ),
                    ),
                  ),
                  const SizedBox(height: Msg.s4),
                  if (_response == null) ...[
                    const _SupportLine(
                        text:
                            'Could not load session diagnostics. Check your connection and try again.'),
                    const SizedBox(height: Msg.s2),
                    SizedBox(
                      height: 48,
                      child: OutlinedButton(
                        onPressed: () {
                          setState(() => _loading = true);
                          _load();
                        },
                        child: const Text('Retry'),
                      ),
                    ),
                  ] else if (_response!.sessions.isEmpty)
                    const _SupportLine(
                        text:
                            'No account-bound commercial sessions were returned.')
                  else
                    for (final session in _response!.sessions)
                      _SupportLine(
                          text:
                              '${session.kind} · ${session.bucket.name} · ${session.entitlementId}'),
                ],
              ),
      );
}

class _SupportLine extends StatelessWidget {
  const _SupportLine({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s1),
        child: Text(text, style: ADText.preview(c: AD.textSecondary)),
      );
}

class CommercialReceiptScreen extends StatefulWidget {
  const CommercialReceiptScreen({super.key, required this.session});
  final CommercialSessionRecord session;

  @override
  State<CommercialReceiptScreen> createState() =>
      _CommercialReceiptScreenState();
}

class _CommercialReceiptScreenState extends State<CommercialReceiptScreen> {
  CommercialReceiptResponse? _response;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final id = widget.session.sessionId;
    if (id == null || id.isEmpty) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    final response = await ListingsApi.commercialReceipt(id);
    if (mounted)
      setState(() {
        _response = response;
        _loading = false;
      });
  }

  @override
  Widget build(BuildContext context) {
    final receipt = _response?.receipts.isNotEmpty == true
        ? _response!.receipts.first
        : null;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
          title: 'Session receipt',
          markWord: 'receipt',
          tag: widget.session.title),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AD.primaryBadge))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(Msg.s5),
                children: [
                  if (receipt == null)
                    ZineEmptyState(
                      icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold),
                      text: _response == null
                          ? 'Receipt unavailable — pull to retry.'
                          : 'Receipt is still being finalized by the server.',
                    )
                  else
                    ZineCard(
                      radius: Msg.rLg,
                      padding: const EdgeInsets.all(Msg.s4),
                      boxShadow: const <BoxShadow>[],
                      child: Column(children: [
                        _row('Amount',
                            '${receipt.grossAmount} ${receipt.currency}'),
                        _row('Status', receipt.settlementState),
                        _row('Connected',
                            '${(receipt.connectedMs / 60000).ceil()} min'),
                        _row('Receipt', receipt.receiptId),
                      ]),
                    ),
                  const SizedBox(height: Msg.s4),
                  Text(
                      'This receipt is read-only. Refunds and settlement are determined by server policy and signed session evidence.',
                      style: ADText.preview()),
                ],
              ),
            ),
    );
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s1),
        child: Row(children: [
          Expanded(child: Text(label, style: ADText.preview())),
          Flexible(
              child: Text(value,
                  textAlign: TextAlign.end, style: ADText.rowName())),
        ]),
      );
}
