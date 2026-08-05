// AvaBooking — Phase 5. Creator-facing list of all bookings (upcoming/past)
// over the SAME data as AvaCalendar; blip→card interaction; per-booking
// earnings shown after settlement (net = price × 0.80; the full escrow/settle
// engine lands in Phase 7). The buyer's own bookings appear here too (and in
// their AvaCalendar).
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/platform_api.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.card,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        foregroundColor: AD.textPrimary,
        shape: const Border(bottom: BorderSide(color: AD.borderCard, width: 1)),
        leading: const Padding(
          padding: EdgeInsets.only(left: Msg.s3),
          child: Center(child: ZineBackButton()),
        ),
        leadingWidth: 60,
        title: Text('AvaBooking', style: ADText.appTitle().copyWith(fontSize: 21)),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: Msg.s4),
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
          labelColor: AD.textPrimary,
          unselectedLabelColor: AD.textTertiary,
          indicatorColor: AD.textPrimary,
          indicatorWeight: 3,
          dividerColor: Colors.transparent,
          labelStyle: ADText.sectionLabel(),
          unselectedLabelStyle: ADText.sectionLabel(c: AD.textTertiary),
          tabs: const [Tab(text: 'Upcoming'), Tab(text: 'Past')],
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
          padding: const EdgeInsets.all(Msg.s5),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineEmptyState(
              icon: PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
              text: 'Could not load bookings — pull to retry.',
            ),
            const SizedBox(height: Msg.s3),
            ZineErrorMsg('$_error'),
          ]),
        ),
      );
    }
    if (items == null) return const Center(child: CircularProgressIndicator(color: AD.primaryBadge));
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
      color: AD.primaryBadge,
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(Msg.s4),
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
    final net = (price * 0.8).round();

    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s3, Msg.s3),
        onTap: () => showBookingCard(
          context,
          sourceApp: sourceApp,
          title: title,
          startsAt: startsAt,
          endsAt: endsAt,
          bookingId: b['id'] as String?,
          counterpart: amCreator ? b['buyer_id'] as String? : b['creator_id'] as String?,
          priceTokens: price,
          status: status,
          amCreator: amCreator,
          onChanged: _refresh,
        ),
        child: Row(children: [
          ZineIconBadge(icon: zineSourceIcon(sourceApp), color: zineSourceColor(sourceApp)),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${fmtDate(startsAt)} · ${fmtRange(startsAt, endsAt)}',
                  style: ADText.sectionLabel()),
              const SizedBox(height: Msg.s1),
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName()),
              const SizedBox(height: Msg.s2),
              Row(children: [
                zineStatusSticker(status),
                if (price > 0) ...[
                  const SizedBox(width: Msg.s2),
                  Text('\u20b9$price',
                      style: ADText.rowName(c: AD.online).copyWith(fontWeight: FontWeight.w700)),
                ],
                if (amCreator && settled && price > 0) ...[
                  const SizedBox(width: Msg.s2),
                  Flexible(
                    child: Text('Earned ~\u20b9$net',
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ADText.sectionLabel(c: AD.online)),
                  ),
                ],
              ]),
            ]),
          ),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
        ]),
      ),
    );
  }
}
