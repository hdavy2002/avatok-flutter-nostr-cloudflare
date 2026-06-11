// AvaBooking — Phase 5. Creator-facing list of all bookings (upcoming/past)
// over the SAME data as AvaCalendar; blip→card interaction; per-booking
// earnings shown after settlement (net = price × 0.80; the full escrow/settle
// engine lands in Phase 7). The buyer's own bookings appear here too (and in
// their AvaCalendar).
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/platform_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart' show AccountScope;
import '../calendar/booking_card.dart';
import '../calendar/calendar_data.dart';

class AvaBookingScreen extends StatefulWidget {
  const AvaBookingScreen({super.key});
  @override
  State<AvaBookingScreen> createState() => _AvaBookingScreenState();
}

class _AvaBookingScreenState extends State<AvaBookingScreen> with SingleTickerProviderStateMixin {
  late final TabController _tab = TabController(length: 2, vsync: this);
  List<Map<String, dynamic>>? _upcoming;
  List<Map<String, dynamic>>? _past;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final up = await PlatformApi.bookings(role: 'all', when: 'upcoming');
      final past = await PlatformApi.bookings(role: 'all', when: 'past');
      if (mounted) setState(() { _upcoming = up; _past = past; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        foregroundColor: Zine.ink,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        leading: const Padding(
          padding: EdgeInsets.only(left: 10),
          child: Center(child: ZineBackButton()),
        ),
        leadingWidth: 60,
        title: Text('AvaBooking', style: ZineText.appbar().copyWith(fontSize: 21)),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 14),
            child: Center(
              child: ZineBackButton(
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                onTap: _refresh,
              ),
            ),
          ),
        ],
        bottom: TabBar(
          controller: _tab,
          labelColor: Zine.ink,
          unselectedLabelColor: Zine.inkMute,
          indicatorColor: Zine.ink,
          indicatorWeight: 3,
          dividerColor: Colors.transparent,
          labelStyle: ZineText.tag(size: 11.5),
          unselectedLabelStyle: ZineText.tag(size: 11.5, color: Zine.inkMute),
          tabs: const [Tab(text: 'UPCOMING'), Tab(text: 'PAST')],
        ),
      ),
      body: TabBarView(controller: _tab, children: [
        _list(_upcoming, upcoming: true),
        _list(_past, upcoming: false),
      ]),
    );
  }

  Widget _list(List<Map<String, dynamic>>? items, {required bool upcoming}) {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineEmptyState(
              icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
              text: 'Could not load bookings — pull to retry.',
            ),
            const SizedBox(height: 10),
            ZineErrorMsg('$_error'),
          ]),
        ),
      );
    }
    if (items == null) return const Center(child: CircularProgressIndicator(color: Zine.blueInk));
    if (items.isEmpty) {
      return Center(
        child: ZineEmptyState(
          icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
          text: upcoming
              ? 'No upcoming bookings — your next session lands here.'
              : 'No past bookings yet.',
        ),
      );
    }
    return RefreshIndicator(
      color: Zine.blueInk,
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: items.length,
        itemBuilder: (ctx, i) => _card(items[i], upcoming: upcoming),
      ),
    );
  }

  Widget _card(Map<String, dynamic> b, {required bool upcoming}) {
    final myUid = AccountScope.id; // Clerk uid — bookings are uid-keyed (Phase 5)
    final amCreator = myUid != null && b['creator_id'] == myUid;
    final sourceApp = b['kind'] == 'live_event' ? 'avalive' : 'avabooking';
    final price = (b['price'] as num?)?.toInt() ?? 0;
    final status = b['status'] as String? ?? 'confirmed';
    final startsAt = (b['starts_at'] as num?)?.toInt() ?? 0;
    final endsAt = (b['ends_at'] as num?)?.toInt() ?? 0;
    final title = b['title'] as String? ?? 'Booking';
    final settled = !upcoming && (status == 'completed' || (status == 'confirmed' && endsAt < DateTime.now().millisecondsSinceEpoch));
    final net = (price * 0.8 / 100).toStringAsFixed(2);

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
        onTap: () => showBookingCard(
          context,
          sourceApp: sourceApp,
          title: title,
          startsAt: startsAt,
          endsAt: endsAt,
          bookingId: b['id'] as String?,
          counterpart: amCreator ? b['buyer_id'] as String? : b['creator_id'] as String?,
          priceCoins: price,
          status: status,
          amCreator: amCreator,
          onChanged: _refresh,
        ),
        child: Row(children: [
          ZineIconBadge(icon: zineSourceIcon(sourceApp), color: zineSourceColor(sourceApp)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${fmtDate(startsAt)} · ${fmtRange(startsAt, endsAt)}'.toUpperCase(),
                  style: ZineText.kicker(size: 10)),
              const SizedBox(height: 3),
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 15)),
              const SizedBox(height: 6),
              Row(children: [
                zineStatusSticker(status),
                if (price > 0) ...[
                  const SizedBox(width: 8),
                  Text('\$${(price / 100).toStringAsFixed(2)}',
                      style: ZineText.value(size: 13.5, color: Zine.mintInk, weight: FontWeight.w900)),
                ],
                if (amCreator && settled && price > 0) ...[
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text('EARNED ~\$$net',
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ZineText.tag(size: 10.5, color: Zine.mintInk)),
                  ),
                ],
              ]),
            ]),
          ),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
        ]),
      ),
    );
  }
}
