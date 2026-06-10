// Phase 5 — the blip→card popup (spec: title, app icon, date/time, counterpart,
// price, status, action buttons) + the reschedule proposal flow (A4) with the
// greyed-conflicts slot picker (occupied slots flagged, never hidden).
import 'package:flutter/material.dart';

import '../../core/platform_api.dart';
import '../consult/prejoin_screen.dart';
import 'calendar_data.dart';

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
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (sheetCtx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              CircleAvatar(backgroundColor: st.color.withOpacity(.15), child: Icon(st.icon, color: st.color)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                  Text(st.label, style: TextStyle(color: st.color, fontWeight: FontWeight.w600, fontSize: 12)),
                ]),
              ),
              if (status != null)
                Chip(
                  label: Text(status, style: const TextStyle(fontSize: 11)),
                  visualDensity: VisualDensity.compact,
                ),
            ]),
            const SizedBox(height: 16),
            _row(Icons.today, fmtDate(startsAt)),
            _row(Icons.schedule, '${fmtRange(startsAt, endsAt)} · ${fmtTimeBoth(startsAt)}'),
            if (counterpart != null && counterpart.isNotEmpty) _row(Icons.person, counterpart),
            if ((priceCoins ?? 0) > 0) _row(Icons.payments, '\$${((priceCoins!) / 100).toStringAsFixed(2)}'),
            const SizedBox(height: 16),
            // Phase 7 — join the delivered session (room opens 10 min early;
            // rejoin within the slot always works — same order, new token).
            if (bookingId != null && status == 'confirmed' &&
                DateTime.now().millisecondsSinceEpoch > startsAt - 10 * 60000 &&
                DateTime.now().millisecondsSinceEpoch < endsAt + 2 * 60000)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    icon: const Icon(Icons.video_call),
                    label: Text(DateTime.now().millisecondsSinceEpoch >= startsAt ? 'Join session' : 'Join (starts soon)'),
                    onPressed: () {
                      Navigator.pop(sheetCtx);
                      Navigator.push(context, MaterialPageRoute(
                          builder: (_) => PrejoinScreen(bookingId: bookingId, title: title)));
                    },
                  ),
                ),
              ),
            if (bookingId != null && status == 'confirmed')
              _PendingProposalBanner(bookingId: bookingId, onChanged: onChanged),
            if (bookingId != null && status == 'confirmed')
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.update),
                    label: const Text('Propose new time'),
                    onPressed: () async {
                      Navigator.pop(sheetCtx);
                      await showReschedulePicker(context, bookingId: bookingId, counterpartCreator: counterpart ?? '', amCreator: amCreator);
                      onChanged?.call();
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.tonalIcon(
                    style: FilledButton.styleFrom(foregroundColor: Colors.red),
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('Cancel'),
                    onPressed: () async {
                      final sure = await showDialog<bool>(
                        context: sheetCtx,
                        builder: (d) => AlertDialog(
                          title: const Text('Cancel this booking?'),
                          content: const Text('Refund follows the rules: ≥24h before — 100%; later — 50%. Creators always refund 100%.'),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Keep')),
                            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Cancel booking')),
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

Widget _row(IconData icon, String text) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Icon(icon, size: 18, color: Colors.grey[700]),
        const SizedBox(width: 10),
        Expanded(child: Text(text)),
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
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: Colors.amber.withOpacity(.15), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('New time proposed: ${fmtDate(ns)} ${fmtTimeBoth(ns)}', style: const TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Row(children: [
          FilledButton(
            onPressed: () => _respond(true),
            child: const Text('Accept'),
          ),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: () => _respond(false),
            child: const Text('Decline'),
          ),
        ]),
      ]),
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
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
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
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Pick a new time — ${widget.dateStr}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 12),
          if (_error != null) Text('Could not load slots: $_error'),
          if (_slots == null && _error == null) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
          if (_slots != null && _slots!.isEmpty)
            const Padding(padding: EdgeInsets.all(8), child: Text('The creator has no offered hours on this day.')),
          if (_slots != null && _slots!.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 380),
              child: SingleChildScrollView(
                child: Wrap(
                  spacing: 8, runSpacing: 8,
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
                      child: ChoiceChip(
                        label: Text(fmtRange(start, end)),
                        selected: false,
                        onSelected: ok ? (_) => _propose(start, end) : null,
                        disabledColor: Colors.grey.withOpacity(.18),
                        labelStyle: TextStyle(color: ok ? null : Colors.grey),
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
