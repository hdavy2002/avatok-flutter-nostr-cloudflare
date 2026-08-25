import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import '../calendar/avacalendar_screen.dart';
import '../marketplace/create_service_choice_sheet.dart';
import 'create_listing_flow.dart';
import 'commercial_service_policy_screen.dart';
import 'creator_insights_screen.dart';
import 'creator_receipt_summary_screen.dart';
import 'share_live_event_sheet.dart';
import '../commercial_getstream/commercial_live_screens.dart';
import '../commercial_getstream/commercial_getstream_screens.dart';

/// "My listings" — the creator's pipeline home: drafts, published, live.
/// Overflow per listing: publish, go live / end, duplicate (A6), cancel.
class MyListingsScreen extends StatefulWidget {
  const MyListingsScreen({super.key});
  @override
  State<MyListingsScreen> createState() => _MyListingsScreenState();
}

class _MyListingsScreenState extends State<MyListingsScreen> {
  List<ListingCard> _items = [];
  bool _loading = true;
  String _studioKind = 'all';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await ListingsApi.mine();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  Future<void> _create() async {
    final commercial = RemoteConfig.commercialLiveListingsEnabled ||
        RemoteConfig.commercialConsultListingsEnabled;
    final created = commercial
        ? await openCreateServiceChoice(context)
        : await Navigator.push<bool>(context,
            MaterialPageRoute(builder: (_) => const CreateListingFlow()));
    if (created == true) _load();
  }

  Future<void> _act(ListingCard l, String action) async {
    String? msg;
    switch (action) {
      case 'publish':
        final r = await ListingsApi.publish(l.id);
        msg = r['ok'] == true
            ? 'Published'
            : (r['detail']?.toString() ?? r['error']?.toString() ?? 'Failed');
        if (r['ok'] == true && _commercialLive(l) && mounted) {
          await showShareLiveEventSheet(
            context,
            listingId: l.id,
            title: l.title,
            startsAt: l.startsAt,
            ticketCount: l.joinedCount,
          );
        }
      case 'live':
        final r = await ListingsApi.setStatus(l.id, 'live');
        msg = r['ok'] == true ? 'You are LIVE — followers notified' : 'Failed';
      case 'complete':
        final r = await ListingsApi.setStatus(l.id, 'completed');
        msg = r['ok'] == true ? 'Marked completed' : 'Failed';
      case 'duplicate':
        final id = await ListingsApi.duplicate(l.id);
        msg =
            id != null ? 'Duplicated as a draft — set the new date' : 'Failed';
      case 'cancel':
        msg = await ListingsApi.cancel(l.id) ? 'Cancelled' : 'Failed';
    }
    if (!mounted) return;
    if (msg != null)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    _load();
  }

  bool _commercialLive(ListingCard l) =>
      l.kind == 'live_event' && RemoteConfig.commercialLiveListingsEnabled;

  bool _commercialConsult(ListingCard l) =>
      l.kind == 'consult' && RemoteConfig.commercialConsultListingsEnabled;

  void _notice(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _salesSummary(ListingCard l) async {
    final sessionIds = l.kind == 'consult'
        ? await ListingsApi.commercialConsultSessionIds(l.id)
        : [ListingsApi.liveCommercialSessionId(l.id)];
    if (!mounted) return;
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => CreatorReceiptSummaryScreen(
          serviceTitle: l.title,
          reservedTickets: l.kind == 'live_event' ? l.joinedCount : null,
          sessionIds: sessionIds,
        ),
      ),
    );
  }

  Future<void> _openCommercialConsultCreator(ListingCard l) async {
    final ids = await ListingsApi.commercialConsultSessionIds(l.id);
    final sessionId =
        ids.firstWhere((id) => id.startsWith('consult_'), orElse: () => '');
    if (!mounted) return;
    if (sessionId.isEmpty) {
      _notice('No booked consultation session is ready yet.');
      return;
    }
    final bookingId = sessionId.substring('consult_'.length);
    Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CommercialConsultationPrejoinScreen(
            listingId: l.id,
            bookingId: bookingId,
            title: l.title,
            isCreator: true,
          ),
        ));
  }

  void _menu(ListingCard l) {
    final commercialLive = _commercialLive(l);
    final commercialConsult = _commercialConsult(l);
    Widget item(IconData icon, String label, VoidCallback onTap,
            {Color color = AD.textPrimary}) =>
        ListTile(
          leading: PhosphorIcon(icon, color: color),
          title: Text(label,
              style: ADText.rowName(c: color)
                  .copyWith(fontWeight: FontWeight.w700)),
          onTap: onTap,
        );
    showModalBottomSheet(
        context: context,
        backgroundColor: AD.bg,
        shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
        builder: (s) => SafeArea(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (l.status == 'draft')
                item(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
                    'Publish', () {
                  Navigator.pop(s);
                  _act(l, 'publish');
                }),
              if (commercialLive || commercialConsult)
                item(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
                    'Edit booking policy', () async {
                  Navigator.pop(s);
                  final changed = await Navigator.push<bool>(
                      context,
                      MaterialPageRoute(
                          builder: (_) =>
                              CommercialServicePolicyScreen(listingId: l.id)));
                  if (changed == true) _load();
                }),
              if (commercialLive && l.status != 'draft') ...[
                item(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                    'Share event', () {
                  Navigator.pop(s);
                  showShareLiveEventSheet(
                    context,
                    listingId: l.id,
                    title: l.title,
                    startsAt: l.startsAt,
                    ticketCount: l.joinedCount,
                  );
                }),
                item(PhosphorIcons.ticket(PhosphorIconsStyle.bold),
                    'View ticket sales & receipts', () {
                  Navigator.pop(s);
                  _salesSummary(l);
                }),
                item(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                    'Test camera & microphone', () {
                  Navigator.pop(s);
                  Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => LiveReadinessScreen(
                            listingId: l.id, title: l.title),
                      ));
                }),
                if (l.status == 'published')
                  item(PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                      'Start backstage', () {
                    Navigator.pop(s);
                    Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => LiveReadinessScreen(
                              listingId: l.id, title: l.title),
                        ));
                  }, color: AD.danger),
              ],
              if (commercialConsult && l.status != 'draft') ...[
                item(PhosphorIcons.eye(PhosphorIconsStyle.bold),
                    'Preview service', () {
                  Navigator.pop(s);
                  Navigator.push(
                      context,
                      MaterialPageRoute(
                          builder: (_) =>
                              ListingDetailScreen(listingId: l.id)));
                }),
                item(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold),
                    'Manage availability', () {
                  Navigator.pop(s);
                  Navigator.push(
                      context,
                      MaterialPageRoute(
                          builder: (_) => const AvaCalendarScreen()));
                }),
                item(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                    'Open creator session', () {
                  Navigator.pop(s);
                  _openCommercialConsultCreator(l);
                }),
                item(PhosphorIcons.pauseCircle(PhosphorIconsStyle.bold),
                    'Pause bookings', () {
                  Navigator.pop(s);
                  _notice(
                      'Pause/resume will use the commercial service-status endpoint before launch.');
                }),
                item(PhosphorIcons.coins(PhosphorIconsStyle.bold),
                    'View earnings & receipts', () {
                  Navigator.pop(s);
                  _salesSummary(l);
                }),
              ],
              if (!commercialLive &&
                  l.status == 'published' &&
                  l.kind == 'live_event')
                item(PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                    'Go live now', () {
                  Navigator.pop(s);
                  _act(l, 'live');
                }, color: AD.danger),
              if (!commercialLive && l.status == 'live')
                item(PhosphorIcons.stopCircle(PhosphorIconsStyle.bold),
                    'End & mark completed', () {
                  Navigator.pop(s);
                  _act(l, 'complete');
                }),
              item(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                  'Duplicate listing', () {
                Navigator.pop(s);
                _act(l, 'duplicate');
              }),
              if (l.status != 'cancelled' && l.status != 'completed')
                item(PhosphorIcons.xCircle(PhosphorIconsStyle.bold),
                    'Cancel listing', () {
                  Navigator.pop(s);
                  _act(l, 'cancel');
                }, color: AD.danger),
            ])));
  }

  // Status stickers: draft = hint (ghost), live = ok (lime), the rest plain.
  ZineStickerKind _stickerKind(String s) => switch (s) {
        'live' => ZineStickerKind.ok,
        'published' => ZineStickerKind.ok,
        'draft' => ZineStickerKind.hint,
        _ => ZineStickerKind.plain,
      };

  Widget _listingList(List<ListingCard> items) {
    if (items.isEmpty) {
      return ListView(children: [
        const SizedBox(height: 88),
        Center(
            child: Text(
          _studioKind == 'live_event'
              ? 'No live events in this view.'
              : 'No 1:1 consultation services in this view.',
          style: ADText.preview(),
        )),
      ]);
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: AD.primaryBadge,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, 96),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: Msg.s3),
        itemBuilder: (_, i) {
          final l = items[i];
          final countLabel = l.joinedCount <= 0
              ? ''
              : _commercialLive(l)
                  ? ' · ${l.joinedCount} tickets'
                  : _commercialConsult(l)
                      ? ''
                      : ' · ${l.joinedCount} joined';
          return ZineCard(
            radius: Msg.rLg,
            padding: const EdgeInsets.all(Msg.s3),
            boxShadow: const <BoxShadow>[],
            onTap: l.status == 'draft'
                ? () => _menu(l)
                : () => Navigator.push(
                    context,
                    MaterialPageRoute(
                        builder: (_) => ListingDetailScreen(listingId: l.id))),
            child: Row(children: [
              CoverImage(
                url: l.coverUrl,
                seed: l.id.hashCode,
                width: 56,
                height: 56,
                radius: BorderRadius.circular(Msg.rMd),
              ),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(l.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.rowName()
                            .copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: Msg.s1),
                    Row(children: [
                      ZineSticker(l.status, kind: _stickerKind(l.status)),
                      const SizedBox(width: Msg.s2),
                      Flexible(
                        child: Text(
                          '${l.priceLabel}${l.startsAt != null ? ' · ${fmtWhen(l.startsAt)}' : ''}$countLabel',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.preview(),
                        ),
                      ),
                    ]),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () => _menu(l),
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.all(Msg.s2),
                  child: PhosphorIcon(
                    PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                    size: 20,
                    color: AD.textPrimary,
                  ),
                ),
              ),
            ]),
          );
        },
      ),
    );
  }

  Widget _studioFilters() => SizedBox(
        height: 52,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s1),
          children: [
            for (final filter in <(String, String)>[
              ('all', 'All'),
              if (RemoteConfig.commercialLiveListingsEnabled)
                ('live_event', 'Live events'),
              if (RemoteConfig.commercialConsultListingsEnabled)
                ('consult', '1:1 consultations'),
            ]) ...[
              ChoiceChip(
                label: Text(filter.$2),
                selected: _studioKind == filter.$1,
                showCheckmark: false,
                onSelected: (_) => setState(() => _studioKind = filter.$1),
              ),
              const SizedBox(width: Msg.s2),
            ],
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final commercialStudio = RemoteConfig.commercialLiveListingsEnabled ||
        RemoteConfig.commercialConsultListingsEnabled;
    final visibleItems = _studioKind == 'all'
        ? _items
        : _items.where((item) => item.kind == _studioKind).toList();
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: commercialStudio ? 'Creator Studio' : 'My listings',
        markWord: commercialStudio ? 'Creator' : 'listings',
        tag: 'creator',
        actions: [
          // Creator Insights — views, audience countries/ages, conversion.
          ZineBackButton(
            icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
            onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                    builder: (_) => const CreatorInsightsScreen())),
          ),
        ],
      ),
      floatingActionButton: ZineButton(
        label: commercialStudio ? 'New service' : 'New listing',
        icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _create,
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AD.primaryBadge))
          : _items.isEmpty
              ? Center(
                  child: Padding(
                      padding: const EdgeInsets.all(Msg.s5),
                      child: ZineEmptyState(
                          icon:
                              PhosphorIcons.storefront(PhosphorIconsStyle.bold),
                          text: commercialStudio
                              ? 'No services yet — create a live event or 1:1 consultation and publish it to Marketplace.'
                              : 'No listings yet — create a live event or consultation and it shows up in AvaExplore the moment you publish.')))
              : commercialStudio
                  ? Column(children: [
                      _studioFilters(),
                      Divider(height: 1, color: AD.borderHairline),
                      Expanded(child: _listingList(visibleItems)),
                    ])
                  : _listingList(_items),
    );
  }
}
