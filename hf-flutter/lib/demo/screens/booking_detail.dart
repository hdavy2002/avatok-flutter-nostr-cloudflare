// [HF-APP-PARITY-BOOKINGS] One booking, in full. Replaces the small pop-up the influencer's list used to open, and gives the
// fan's My bookings a page too. Route: /bookings/:id (pass the booking as `extra` to paint it at once).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/call_flags.dart';
import '../../data/models/booking.dart';
import '../../data/repos/bookings_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../ui/async_view.dart';
import '../booking_kit.dart';
import '../call_kit.dart';
import '../desi.dart';
import '../inf_kit.dart' show FanAvatar; // [HF-MOD-APP-PHOTOS]
import '../list_kit.dart';
import '../settings_kit.dart';
import '../theme.dart';
import '../widgets.dart';
import 'call_real.dart' show paiseText;

String _msg(Object e, [String fallback = 'That did not work. Please try again.']) {
  if (e is ApiException) {
    if (e.isOffline) return ApiException.offlineText;
    final m = e.message;
    if (m != null && m.isNotEmpty) return m;
  }
  return fallback;
}

String _length(int m) => CallFlags.bookingLengths ? lengthLabel(m) : '$m min';

BookingKind _kindOf(AppBooking b) => switch (b.status) {
      'pending_approval' => BookingKind.waiting,
      'confirmed' || 'starting' || 'active' => BookingKind.confirmed,
      'cancelled' => BookingKind.cancelled,
      'completed' => BookingKind.completed,
      'failed' => BookingKind.failed,
      _ => BookingKind.other,
    };

/// What the page says about cancelling when the server sent no sentence of its own (the older detail answer has none).
String cancelRuleOf(AppBooking b) {
  if (b.cancelRule.isNotEmpty) return b.cancelRule;
  if (b.viewerIsHost) return "If you cancel, the fan's hold is refunded in full.";
  if (b.isPending) return 'You can cancel any time while you wait. Your full hold comes back.';
  return 'You can cancel for free until 1 hour before the call. After that the hold is kept.';
}

/// The Hisaab lines for [b], in the viewer's words. Empty when there is no money to show.
List<(String, String)> hisaabLinesOf(AppBooking b) {
  final out = <(String, String)>[];
  if (b.holdPaise > 0) {
    if (b.viewerIsHost) {
      out.add((b.isCancelled ? "Fan's hold (refunded)" : "Fan's hold", paiseText(b.holdPaise)));
    } else {
      out.add((b.isCancelled ? 'Refunded to your wallet' : 'Held from your wallet', paiseText(b.holdPaise)));
    }
  }
  if (b.viewerIsHost && b.expectedNetPaise > 0 && !b.isPast) out.add(('You will get about', paiseText(b.expectedNetPaise)));
  return out;
}

class RealBookingDetailScreen extends StatefulWidget {
  const RealBookingDetailScreen({super.key, required this.id, this.initial, this.repo});

  final String id;

  /// The booking the list already holds. Without it the page asks the server.
  final AppBooking? initial;
  final BookingsRepo? repo;

  @override
  State<RealBookingDetailScreen> createState() => _RealBookingDetailScreenState();
}

class _RealBookingDetailScreenState extends State<RealBookingDetailScreen> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;
  late AsyncState<AppBooking> _state = widget.initial != null ? AsyncData(widget.initial!) : const AsyncLoading();
  bool _busy = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    if (widget.initial == null) unawaited(_load());
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {}); // keeps "Auto-cancels in 17 h" honest
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final b = await _repo.booking(widget.id);
      if (mounted) setState(() => _state = AsyncData(b));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  void _done(String message) {
    toast(context, message);
    if (context.canPop()) context.pop(true); // the list behind reloads on `true`
  }

  Future<void> _cancel(AppBooking b) async {
    if (_busy) return;
    final host = b.viewerIsHost;
    final ok = await hfConfirm(
      context,
      title: b.isPending && !host ? 'Withdraw this request?' : 'Cancel this booking?',
      body: host
          ? "The fan's hold of ${paiseText(b.holdPaise)} is refunded in full."
          : b.isPending
              ? 'Nothing is lost: the full ${paiseText(b.holdPaise)} comes back to your wallet.'
              : 'The ${paiseText(b.holdPaise)} hold comes back to your wallet. ${cancelRuleOf(b)}',
      confirmLabel: b.isPending && !host ? 'Withdraw' : 'Cancel booking',
      cancelLabel: 'Keep it',
      destructive: true,
      confirmKey: const ValueKey('detail-cancel-confirm'),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final r = await _repo.cancel(b.id);
      if (mounted) _done(r.message);
    } catch (e) {
      if (mounted) toast(context, _msg(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept(AppBooking b) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await _repo.accept(b.id);
      Telemetry.event('hf_app_booking_accept_tapped', {'booking_id': b.id, 'outcome': 'ok', 'source': 'detail'});
      if (mounted) _done('Accepted. ${b.fanHandle ?? 'The caller'} will call you at ${slotLabel(b.time)}.');
    } catch (e) {
      Telemetry.event('hf_app_booking_accept_tapped', {'booking_id': b.id, 'outcome': 'failed', 'reason': e is ApiException ? e.code : 'error', 'source': 'detail'});
      if (mounted) toast(context, _msg(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decline(AppBooking b) async {
    if (_busy) return;
    final ok = await hfConfirm(
      context,
      title: 'Decline this booking?',
      body: 'The caller gets a full refund of ${paiseText(b.holdPaise)} to their wallet.',
      confirmLabel: 'Decline',
      cancelLabel: 'Keep it',
      destructive: true,
      confirmKey: const ValueKey('decline-confirm'),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await _repo.decline(b.id);
      Telemetry.event('hf_app_booking_decline_tapped', {'booking_id': b.id, 'outcome': 'ok', 'source': 'detail'});
      if (mounted) _done('Declined. The caller was refunded in full.');
    } catch (e) {
      Telemetry.event('hf_app_booking_decline_tapped', {'booking_id': b.id, 'outcome': 'failed', 'reason': e is ApiException ? e.code : 'error', 'source': 'detail'});
      if (mounted) toast(context, _msg(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    final b = s is AsyncData<AppBooking> ? s.value : null;
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Booking'),
            Expanded(
              child: AsyncView<AppBooking>(
                state: s,
                onRetry: () => unawaited(_load()),
                isEmpty: (_) => false,
                builder: (context, v) => ListView(
                  key: const ValueKey('detail-list'),
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  children: _body(v),
                ),
              ),
            ),
            if (b != null) _actions(b),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(AppBooking b) {
    final host = b.viewerIsHost;
    final name = host ? (b.fanHandle ?? 'A fan') : (b.hostName ?? 'Influencer');
    final handle = !host && b.hostSlug != null ? '@${b.hostSlug}' : null;
    final deadline = b.approvalDeadline;
    final status = b.statusText;
    final hisaab = hisaabLinesOf(b);
    final blocked = !host && b.cancelBlockedText != null && !b.isPast;
    return [
      DesiHero(
        eyebrow: 'Booking',
        title: name,
        sub: indianWhen(b.day, b.time),
        ghost: 'Mulaqat',
        minHeight: 150,
        art: const _HeroArt(),
      ),
      const SizedBox(height: 12),
      Row(children: [
        Flexible(child: KeyedSubtree(key: const ValueKey('detail-chip'), child: BookingStatusChip(_kindOf(b)))),
      ]),
      if (b.isPending && deadline != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text('Auto-cancels in ${countdownLabel(deadline.difference(DateTime.now()))}', key: const ValueKey('detail-countdown'), style: t(15, color: C.deep, w: FontWeight.w700)),
        ),
      if (status != null && status.isNotEmpty && !(b.isPending && deadline != null))
        Padding(padding: const EdgeInsets.only(top: 6), child: Text(status, key: const ValueKey('detail-status-text'), style: t(15, color: C.deep, w: FontWeight.w700, h: 1.3))),
      const SizedBox(height: 14),
      DesiCard(
        title: 'Details',
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (host) // [HF-MOD-APP-PHOTOS] the fan's checked photo (first letter when none)
            Padding(padding: const EdgeInsets.only(bottom: 10), child: FanAvatar(name: name, url: b.customerPhotoUrl, size: 56)),
          _row(host ? 'Caller' : 'With', handle == null ? name : '$name  $handle', key: const ValueKey('detail-who')),
          _row('Date and time', indianWhen(b.day, b.time), key: const ValueKey('detail-when')),
          _row('Length', _length(b.minutes), key: const ValueKey('detail-length')),
          if (b.topic != null) _row('About', b.topic!.label, key: const ValueKey('detail-topic')),
          if (b.note.isNotEmpty) _row('Note', b.note, key: const ValueKey('detail-note')),
        ]),
      ),
      if (hisaab.isNotEmpty) ...[
        const SizedBox(height: 14),
        KeyedSubtree(key: const ValueKey('detail-hisaab'), child: HisaabCard(lines: hisaab)),
      ],
      if (!b.isPast || blocked) ...[
        const SizedBox(height: 14),
        BookNotice(
          textKey: const ValueKey('detail-cancel-rule'),
          text: blocked ? b.cancelBlockedText! : cancelRuleOf(b),
          icon: Icons.info_outline_rounded,
        ),
      ],
      const SizedBox(height: 8),
      const DesiMogra(),
    ];
  }

  Widget _row(String label, String value, {Key? key}) => Padding(
        key: key,
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: t(14, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(value, style: t(16, w: FontWeight.w800, h: 1.3)),
        ]),
      );

  Widget _actions(AppBooking b) {
    final host = b.viewerIsHost;
    final Widget? primary;
    Widget? secondary;
    if (host && b.isPending && (b.canAccept || b.canDecline)) {
      primary = CallPill(
        key: const ValueKey('detail-accept'),
        label: _busy ? 'Please wait…' : 'Accept',
        kind: CallPillKind.plum,
        icon: Icons.check_rounded,
        height: 56,
        onTap: b.canAccept && !_busy ? () => unawaited(_accept(b)) : null,
      );
      secondary = OutlinePill(key: const ValueKey('detail-decline'), label: 'Decline', onTap: b.canDecline && !_busy ? () => unawaited(_decline(b)) : null);
    } else if (!b.isPast && b.canCancel) {
      primary = CallPill(
        key: host ? const ValueKey('host-cancel') : (b.isPending ? const ValueKey('detail-withdraw') : const ValueKey('detail-cancel')),
        label: _busy ? 'Please wait…' : (b.isPending && !host ? 'Withdraw request' : 'Cancel booking'),
        kind: CallPillKind.red,
        height: 56,
        onTap: _busy ? null : () => unawaited(_cancel(b)),
      );
    } else {
      primary = null;
    }
    if (primary == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        primary,
        if (secondary != null) ...[const SizedBox(height: 10), secondary],
      ]),
    );
  }
}

/// Hero art slot. The picture is optional: when the file is not in the app yet the slot stays empty.
class _HeroArt extends StatelessWidget {
  const _HeroArt();
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: SizedBox(
          width: 96,
          height: 96,
          child: Image.asset(
            'assets/images/bazaar/booking/detail-mulaqat.webp',
            fit: BoxFit.contain,
            errorBuilder: (_, __, ___) => const SizedBox.shrink(),
          ),
        ),
      );
}
