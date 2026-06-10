// AvaBooking — Phase 5. Creator-facing list of all bookings (upcoming/past)
// over the SAME data as AvaCalendar; blip→card interaction; per-booking
// earnings shown after settlement (net = price × 0.80; the full escrow/settle
// engine lands in Phase 7). The buyer's own bookings appear here too (and in
// their AvaCalendar).
import 'package:flutter/material.dart';

import '../../core/platform_api.dart';
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
      appBar: AppBar(
        title: const Text('AvaBooking'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh)],
        bottom: TabBar(controller: _tab, tabs: const [Tab(text: 'Upcoming'), Tab(text: 'Past')]),
      ),
      body: TabBarView(controller: _tab, children: [
        _list(_upcoming, upcoming: true),
        _list(_past, upcoming: false),
      ]),
    );
  }

  Widget _list(List<Map<String, dynamic>>? items, {required bool upcoming}) {
    if (_error != null) return Center(child: Text('Could not load bookings.\n$_error', textAlign: TextAlign.center));
    if (items == null) return const Center(child: CircularProgressIndicator());
    if (items.isEmpty) {
      return Center(child: Text(upcoming ? 'No upcoming bookings.' : 'No past bookings yet.', style: TextStyle(color: Colors.grey[600])));
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: items.length,
        itemBuilder: (ctx, i) => _card(items[i], upcoming: upcoming),
      ),
    );
  }

  Widget _card(Map<String, dynamic> b, {required bool upcoming}) {
    final myUid = AccountScope.id; // Clerk uid — bookings are uid-keyed (Phase 5)
    final amCreator = myUid != null && b['creator_id'] == myUid;
    final st = styleFor(b['kind'] == 'live_event' ? 'avalive' : 'avabooking');
    final price = (b['price'] as num?)?.toInt() ?? 0;
    final status = b['status'] as String? ?? 'confirmed';
    final startsAt = (b['starts_at'] as num?)?.toInt() ?? 0;
    final endsAt = (b['ends_at'] as num?)?.toInt() ?? 0;
    final title = b['title'] as String? ?? 'Booking';
    final settled = !upcoming && (status == 'completed' || (status == 'confirmed' && endsAt < DateTime.now().millisecondsSinceEpoch));
    final net = (price * 0.8 / 100).toStringAsFixed(2);

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: CircleAvatar(backgroundColor: st.color.withOpacity(.15), child: Icon(st.icon, color: st.color, size: 20)),
        title: Text(title),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${fmtDate(startsAt)} · ${fmtRange(startsAt, endsAt)}'),
          Text(
            [
              status,
              if (price > 0) '\$${(price / 100).toStringAsFixed(2)}',
              if (amCreator && settled && price > 0) 'earned ~\$$net',
            ].join(' · '),
            style: TextStyle(color: Colors.grey[600], fontSize: 12),
          ),
        ]),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => showBookingCard(
          context,
          sourceApp: b['kind'] == 'live_event' ? 'avalive' : 'avabooking',
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
      ),
    );
  }
}
