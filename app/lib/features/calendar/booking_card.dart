// Phase 5 — the blip→card popup (spec: title, app icon, date/time, counterpart,
// price, status, action buttons) + the reschedule proposal flow (A4) with the
// greyed-conflicts slot picker (occupied slots flagged, never hidden).
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/platform_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../consult/prejoin_screen.dart';
import 'calendar_data.dart';

/// Zine accent for a calendar source app (event dots, icon badges).
Color zineSourceColor(String? sourceApp) => switch (sourceApp) {
      'avacalendar' => Zine.lime,
      'avabooking' => Zine.coral,
      'avalive' => Zine.lilac,
      'avaconsult' => Zine.blue,
      'gcal' => Zine.mint,
      'manual' => Zine.inkMute,
      _ => Zine.inkMute,
    };

/// Phosphor (bold) icon for a calendar source app.
IconData zineSourceIcon(String? sourceApp) => switch (sourceApp) {
      'avacalendar' => PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
      'avabooking' => PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold),
      'avalive' => PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
      'avaconsult' => PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
      'gcal' => PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
      'manual' => PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
      _ => PhosphorIcons.calendarX(PhosphorIconsStyle.bold),
    };

/// Status sticker per the zine system: confirmed = ok, pending = hint,
/// cancelled = coral.
ZineSticker zineStatusSticker(String status) => ZineSticker(
      status,
      kind: switch (status) {
        'confirmed' || 'completed' => ZineStickerKind.ok,
        'pending' => ZineStickerKind.hint,
        'cancelled' => ZineStickerKind.no,
        _ => ZineStickerKind.plain,
      },
    );

/// Opens the detail card for a booking/event/block. Pass whatever ids exist:
/// [bookingId] enables cancel/reschedule; gcal/manual blocks are read-only.
Future<void> showBookingCard(
  BuildContext context, {
  required String sourceApp,
  required String title,
  required int startsAt,
  required int endsAt,
  String? bookingId,
  String? counterpart,
  int? priceCoins,
  String? status,
  bool amCreator = false,
  VoidCallback? onChanged,
}) async {
  final st = styleFor(sourceApp);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      side: BorderSide(color: Zine.ink, width: Zine.bw),
    ),
    builder: (sheetCtx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(22, 18, 22, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              ZineIconBadge(icon: zineSourceIcon(sourceApp), color: zineSourceColor(sourceApp), size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: ZineText.cardTitle()),
                  const SizedBox(height: 2),
                  Text(st.label.toUpperCase(), style: ZineText.kicker(size: 10.5)),
                ]),
              ),
              if (status != null) zineStatusSticker(status),
            ]),
            const SizedBox(height: 16),
            _row(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), fmtDate(startsAt)),
            _row(PhosphorIcons.clock(PhosphorIconsStyle.bold), '${fmtRange(startsAt, endsAt)} · ${fmtTimeBoth(startsAt)}'),
            if (counterpart != null && counterpart.isNotEmpty)
              _row(PhosphorIcons.user(PhosphorIconsStyle.bold), counterpart),
            if ((priceCoins ?? 0) > 0)
              _row(PhosphorIcons.coins(PhosphorIconsStyle.bold),
                  '\$${((priceCoins!) / 100).toStringAsFixed(2)}', money: true),
            const SizedBox(height: 16),
            // Phase 7 — join the delivered session (room opens 10 min early;
            // rejoin within the slot always works — same order, new token).
            if (bookingId != null && status == 'confirmed' &&
                DateTime.now().millisecondsSinceEpoch > startsAt - 10 * 60000 &&
                DateTime.now().millisecondsSinceEpoch < endsAt + 2 * 60000)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: ZineButton(
                  label: DateTime.now().millisecondsSinceEpoch >= startsAt ? 'Join session' : 'Join (starts soon)',
                  fullWidth: true,
                  icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                  trailingIcon: false,
                  onPressed: () {
                    Navigator.pop(sheetCtx);
                    Navigator.push(context, MaterialPageRoute(
                        builder: (_) => PrejoinScreen(bookingId: bookingId, title: title)));
                  },
                ),
              ),
            if (bookingId != null && status == 'confirmed')
              _PendingProposalBanner(bookingId: bookingId, onChanged: onChanged),
            if (bookingId != null && status == 'confirmed')
              Row(children: [
                Expanded(
                  child: ZineButton(
                    label: 'New time',
                    variant: ZineButtonVariant.ghost,
                    fontSize: 16,
                    icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                    trailingIcon: false,
                    onPressed: () async {
                      Navigator.pop(sheetCtx);
                      await showReschedulePicker(context, bookingId: bookingId, counterpartCreator: counterpart ?? '', amCreator: amCreator);
                      onChanged?.call();
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ZineButton(
                    label: 'Cancel',
                    variant: ZineButtonVariant.coral,
                    fontSize: 16,
                    icon: PhosphorIcons.xCircle(PhosphorIconsStyle.bold),
                    trailingIcon: false,
                    onPressed: () async {
                      final sure = await showDialog<bool>(
                        context: sheetCtx,
                        builder: (d) => AlertDialog(
                          backgroundColor: Zine.card,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(Zine.r),
                            side: const BorderSide(color: Zine.ink, width: Zine.bw),
                          ),
                          title: Text('Cancel this booking?', style: ZineText.cardTitle()),
                          content: Text(
                            'Refund follows the rules: ≥24h before — 100%; later — 50%. Creators always refund 100%.',
                            style: ZineText.sub(size: 14),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(d, false),
                              child: Text('Keep it', style: ZineText.link()),
                            ),
                            ZineButton(
                              label: 'Cancel booking',
                              variant: ZineButtonVariant.coral,
                              fontSize: 15,
                              onPressed: () => Navigator.pop(d, true),
                            ),
                          ],
                        ),
                      );
                      if (sure != true) return;
                      final r = await PlatformApi.cancelBooking(bookingId);
                      if (sheetCtx.mounted) {
                        Navigator.pop(sheetCtx);
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                          content: Text(r['ok'] == true ? (r['refund'] as String? ?? 'Booking cancelled') : 'Failed: ${r['error'] ?? 'unknown'}'),
                        ));
                      }
                      onChanged?.call();
                    },
                  ),
                ),
              ]),
          ],
        ),
      ),
    ),
  );
}

Widget _row(IconData icon, String text, {bool money = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        PhosphorIcon(icon, size: 18, color: Zine.inkSoft),
        const SizedBox(width: 10),
        Expanded(
          child: Text(text,
              style: money
                  ? ZineText.value(size: 15, color: Zine.mintInk, weight: FontWeight.w900)
                  : ZineText.value(size: 14.5, weight: FontWeight.w700)),
        ),
      ]),
    );

/// Banner shown when the OTHER side proposed a new time → Accept / Decline.
class _PendingProposalBanner extends StatefulWidget {
  final String bookingId;
  final VoidCallback? onChanged;
  const _PendingProposalBanner({required this.bookingId, this.onChanged});
  @override
  State<_PendingProposalBanner> createState() => _PendingProposalBannerState();
}

class _PendingProposalBannerState extends State<_PendingProposalBanner> {
  Map<String, dynamic>? _pending;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    PlatformApi.reschedules(widget.bookingId).then((list) {
      if (!mounted) return;
      setState(() {
        _loaded = true;
        _pending = list.where((r) => r['status'] == 'pending').cast<Map<String, dynamic>?>().firstWhere((_) => true, orElse: () => null);
      });
    }).catchError((_) {
      if (mounted) setState(() => _loaded = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded || _pending == null) return const SizedBox.shrink();
    final p = _pending!;
    final ns = (p['new_start'] as num).toInt();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const ZineSticker('New time proposed', kind: ZineStickerKind.hint),
          const SizedBox(height: 8),
          Text('${fmtDate(ns)} ${fmtTimeBoth(ns)}',
              style: ZineText.value(size: 14.5, weight: FontWeight.w800)),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: ZineButton(
                label: 'Accept',
                variant: ZineButtonVariant.blue,
                fontSize: 15,
                onPressed: () => _respond(true),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ZineButton(
                label: 'Decline',
                variant: ZineButtonVariant.ghost,
                fontSize: 15,
                onPressed: () => _respond(false),
              ),
            ),
          ]),
        ]),
      ),
    );
  }

  Future<void> _respond(bool accept) async {
    final r = await PlatformApi.respondReschedule(_pending!['id'] as String, accept: accept);
    if (!mounted) return;
    setState(() => _pending = null);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(r['ok'] == true ? (accept ? 'Rescheduled ✅' : 'Declined — original time stands') : 'Failed: ${r['error'] ?? r['conflictWith'] ?? 'unknown'}'),
    ));
    widget.onChanged?.call();
  }
}

/// A4 UI: date picker + the creator's slot grid. Conflicting/policy-blocked
/// slots render GREYED with the reason ("occupied by AvaLive: <title>" etc).
Future<void> showReschedulePicker(BuildContext context, {required String bookingId, required String counterpartCreator, required bool amCreator}) async {
  final date = await showDatePicker(
    context: context,
    firstDate: DateTime.now(),
    lastDate: DateTime.now().add(const Duration(days: 90)),
    initialDate: DateTime.now().add(const Duration(days: 1)),
  );
  if (date == null || !context.mounted) return;
  final dateStr = '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      side: BorderSide(color: Zine.ink, width: Zine.bw),
    ),
    builder: (sheetCtx) => _SlotPickerSheet(bookingId: bookingId, dateStr: dateStr, amCreator: amCreator),
  );
}

class _SlotPickerSheet extends StatefulWidget {
  final String bookingId;
  final String dateStr;
  final bool amCreator;
  const _SlotPickerSheet({required this.bookingId, required this.dateStr, required this.amCreator});
  @override
  State<_SlotPickerSheet> createState() => _SlotPickerSheetState();
}

class _SlotPickerSheetState extends State<_SlotPickerSheet> {
  List<Map<String, dynamic>>? _slots;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      // The creator's availability grid; the server flags occupied/policy slots.
      final bks = await PlatformApi.bookings(role: 'all', when: 'upcoming');
      final bk = bks.where((b) => b['id'] == widget.bookingId).cast<Map<String, dynamic>?>().firstWhere((_) => true, orElse: () => null);
      final creator = bk?['creator_id'] as String? ?? '';
      final slots = await PlatformApi.freeSlots(creator: creator, date: widget.dateStr);
      if (mounted) setState(() => _slots = slots);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Pick a new time', style: ZineText.cardTitle()),
          const SizedBox(height: 4),
          Text(widget.dateStr, style: ZineText.kicker()),
          const SizedBox(height: 14),
          if (_error != null) ZineErrorMsg('Could not load slots: $_error'),
          if (_slots == null && _error == null)
            const Center(child: Padding(padding: EdgeInsets.all(24),
                child: CircularProgressIndicator(color: Zine.blueInk))),
          if (_slots != null && _slots!.isEmpty)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text('The creator has no offered hours on this day.', style: ZineText.sub(size: 14)),
            ),
          if (_slots != null && _slots!.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 380),
              child: SingleChildScrollView(
                child: Wrap(
                  spacing: 9, runSpacing: 9,
                  children: _slots!.map((s) {
                    final ok = s['available'] == true;
                    final start = (s['start'] as num).toInt();
                    final end = (s['end'] as num).toInt();
                    final occ = s['occupied_by'] as Map?;
                    final reason = ok
                        ? null
                        : occ != null
                            ? 'Occupied by ${styleFor(occ['source_app'] as String?).label}${occ['title'] != null ? ': ${occ['title']}' : ''}'
                            : 'Unavailable: ${s['reason']}';
                    return Tooltip(
                      message: reason ?? 'Available',
                      child: ok
                          ? ZinePressable(
                              onTap: () => _propose(start, end),
                              radius: BorderRadius.circular(100),
                              boxShadow: Zine.shadowXs,
                              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
                              child: Text(fmtRange(start, end), style: ZineText.tag(size: 12)),
                            )
                          // Occupied: ghost pill — muted border, paper fill, no shadow.
                          : Container(
                              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
                              decoration: BoxDecoration(
                                color: Zine.paper2,
                                borderRadius: BorderRadius.circular(100),
                                border: Border.all(color: Zine.inkMute, width: 2),
                              ),
                              child: Text(fmtRange(start, end), style: ZineText.tag(size: 12, color: Zine.inkMute)),
                            ),
                    );
                  }).toList(),
                ),
              ),
            ),
        ]),
      ),
    );
  }

  Future<void> _propose(int start, int end) async {
    final r = await PlatformApi.proposeReschedule(widget.bookingId, newStart: start, newEnd: end);
    if (!mounted) return;
    Navigator.pop(context);
    final msg = r['ok'] == true
        ? 'Proposal sent — waiting for the other side to accept.'
        : r['error'] == 'max_reschedules'
            ? 'Max 2 reschedules per booking.'
            : 'Failed: ${r['reason'] ?? r['error'] ?? 'conflict'}';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}
