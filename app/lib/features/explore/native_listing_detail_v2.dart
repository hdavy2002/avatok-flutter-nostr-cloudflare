import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';
import 'creator_channel.dart';
import 'native_listing_booking_flow.dart';

String _when(int? epochMs) {
  if (epochMs == null || epochMs <= 0) return 'ON REQUEST';
  final date = DateTime.fromMillisecondsSinceEpoch(epochMs).toLocal();
  return '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')} · ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
}

/// The second-generation native listing surface. This is a deliberate replacement
/// for both the old monolithic detail widget and the embedded website: every
/// section is a Flutter widget and every CTA stays inside the app.
class NativeListingDetailV2 extends StatefulWidget {
  const NativeListingDetailV2(
      {super.key, required this.listingId, this.source = 'unknown'});
  final String listingId;
  final String source;

  @override
  State<NativeListingDetailV2> createState() => _NativeListingDetailV2State();
}

class _NativeListingDetailV2State extends State<NativeListingDetailV2> {
  ListingDetail? detail;
  CreatorChannel? creator;
  List<ListingCard> related = const [];
  bool loading = true;
  bool favouriteBusy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    Analytics.capture('listing_detail_opened', {
      'listing_id': widget.listingId,
      'source': widget.source,
      'render_mode': 'native_v2'
    });
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await ListingsApi.detail(widget.listingId);
      if (d == null) throw StateError('Listing not found');
      CreatorChannel? c;
      try {
        c = await ListingsApi.creator(d.listing.creator.uid);
      } catch (_) {}
      List<ListingCard> r = const [];
      try {
        r = await ListingsApi.explore(
            category: d.listing.category, cache: true);
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        detail = d;
        creator = c;
        related = r.where((x) => x.id != d.listing.id).take(8).toList();
        loading = false;
      });
    } catch (e) {
      if (mounted)
        setState(() {
          loading = false;
          error =
              'Could not load this listing. Check your connection and try again.';
        });
    }
  }

  Future<void> _toggleFavourite() async {
    final d = detail;
    if (d == null || favouriteBusy) return;
    setState(() {
      favouriteBusy = true;
      d.listing.favorited = !d.listing.favorited;
    });
    final ok = d.listing.favorited
        ? await ListingsApi.favorite(d.listing.id)
        : await ListingsApi.unfavorite(d.listing.id);
    if (!ok && mounted)
      setState(() => d.listing.favorited = !d.listing.favorited);
    if (mounted) setState(() => favouriteBusy = false);
  }

  void _openBooking() {
    final d = detail;
    if (d == null) return;
    Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => NativeListingBookingFlow(
                listing: d.listing)));
  }

  @override
  Widget build(BuildContext context) {
    if (loading)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (error != null || detail == null) {
      return Scaffold(
          appBar: AppBar(),
          body: Center(
              child:
                  FilledButton(onPressed: _load, child: const Text('Retry'))));
    }
    final d = detail!;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.bg,
        foregroundColor: AD.textPrimary,
        title: Text('BAZAAR', style: ADText.rowName()),
        actions: [
          IconButton(
              onPressed: () => Share.share(
                  'See ${d.listing.title} on AvaTOK — https://avatok.ai/l/${d.listing.id}'),
              icon: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold))),
          IconButton(
              onPressed: _toggleFavourite,
              icon: Icon(
                  d.listing.favorited ? PhosphorIcons.heart(PhosphorIconsStyle.fill) : PhosphorIcons.heart(PhosphorIconsStyle.regular),
                  color: d.listing.favorited ? AD.danger : AD.textPrimary)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: LayoutBuilder(builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          final content = _content(d, wide);
          return ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 48),
              children: [content]);
        }),
      ),
      bottomNavigationBar: SafeArea(
          child: Padding(
              padding: const EdgeInsets.all(12),
              child: FilledButton.icon(
                  onPressed: _openBooking,
            icon: PhosphorIcon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold)),
                  label: Text(d.booked ? 'OPEN BOOKING' : _cta(d.listing))))),
    );
  }

  String _cta(ListingCard l) => l.status == 'live'
      ? 'BOOK & JOIN NOW'
      : (l.freeEntry || l.effectivePrice == 0
          ? 'RESERVE YOUR SEAT'
          : 'BOOK A SEAT · ${l.priceLabel}');

  Widget _content(ListingDetail d, bool wide) {
    final l = d.listing;
    final hero = _hero(l);
    final summary = _summary(d);
    final booking = _bookingCard(l);
    final body =
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _ticker(l),
      hero,
      if (l.coverMedia.length > 1) _gallery(l),
      _shareCard(l),
      summary,
      if (wide)
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: _sections(d)),
          const SizedBox(width: 16),
          SizedBox(width: 340, child: booking)
        ])
      else ...[_sections(d), booking],
      if (related.isNotEmpty) _related(),
    ]);
    return Center(
        child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1180), child: body));
  }

  Widget _shareCard(ListingCard l) {
    final link = 'https://avatok.ai/l/${l.id}';
    return Card(
        color: AD.headerFooter,
        elevation: 0,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rListCard),
            side: const BorderSide(color: AD.textPrimary, width: 2)),
        child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              QrImageView(data: link, size: 78, backgroundColor: AD.card),
              const SizedBox(width: 14),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const Text('SHARE THIS SHOW',
                        style: TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    const Text('Copy the link or scan it on another phone.',
                        style: TextStyle(color: AD.card)),
                    const SizedBox(height: 8),
                    Wrap(spacing: 8, children: [
                      OutlinedButton(
                          onPressed: () {
                            Clipboard.setData(ClipboardData(text: link));
                            showAdToast(context, message: 'Listing link copied');
                          },
                          child: const Text('COPY LINK')),
                      OutlinedButton(
                          onPressed: () => Share.share('$link\n${l.title}'),
                          child: const Text('SHARE'))
                    ])
                  ]))
            ])));
  }

  Widget _ticker(ListingCard l) => Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
          color: l.status == 'live'
              ? AD.danger
              : AD.headerFooter,
          borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Row(children: [
        Container(width: 10, height: 10,
            decoration: BoxDecoration(shape: BoxShape.circle,
                color: l.status == 'live' ? AD.card : AD.bg)),
        const SizedBox(width: 8),
        Expanded(
            child: Text(
                l.status == 'live'
                    ? 'LIVE NOW · ${l.title.toUpperCase()}'
                    : 'NEXT SHOW · ${_when(l.startsAt)}',
            style: ADText.rowName(c: Colors.white))),
        Text(l.status == 'live' ? 'JOIN NOW' : 'BOOK AHEAD',
            style: ADText.rowName(c: Colors.white))
      ]));

  Widget _hero(ListingCard l) {
    final url = l.coverUrl;
    return Container(
        height: 250,
        decoration: BoxDecoration(
            color: AD.headerFooter,
            border: Border.all(color: AD.textPrimary, width: 3),
            borderRadius: BorderRadius.circular(AD.rHero),
            boxShadow: const [
              BoxShadow(color: AD.textPrimary, offset: Offset(5, 6))
            ]),
        clipBehavior: Clip.antiAlias,
        child: Stack(fit: StackFit.expand, children: [
          if (url != null)
            Image.network(url,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox())
          else
            Center(
                child: Text(l.title.toUpperCase(),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                        fontFamily: ADText.display,
                        fontSize: 28,
                        fontWeight: FontWeight.w700,
                        color: Colors.white))),
          DecoratedBox(
              decoration: BoxDecoration(
                  gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                AD.card.withOpacity(0),
                AD.scrim,
              ]))),
          Positioned(
              left: 16,
              right: 16,
              bottom: 14,
              child: Text(l.title,
                  style: const TextStyle(
                      fontFamily: ADText.display,
                      color: Colors.white,
                      fontSize: 26,
                      fontWeight: FontWeight.w700))),
          Positioned(
              top: 12,
              left: 12,
              child: _pill(l.status == 'live' ? '● LIVE' : 'NEXT SHOW',
                      AD.danger)),
        ]));
  }

  Widget _gallery(ListingCard l) {
    final urls = l.coverMedia
        .map((m) => (m is Map ? m['url'] : null)?.toString())
        .whereType<String>()
        .where((u) => u.startsWith('http'))
        .take(8)
        .toList();
    return SizedBox(
        height: 88,
        child: ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 10),
            scrollDirection: Axis.horizontal,
            itemCount: urls.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (_, i) => ClipRRect(
                borderRadius: BorderRadius.circular(AD.rImage),
                child: Image.network(urls[i], width: 110, fit: BoxFit.cover))));
  }

  Widget _summary(ListingDetail d) {
    final l = d.listing;
    final badges = <String>[
      if (l.ratingAvg != null)
        '★ ${l.ratingAvg!.toStringAsFixed(1)} · ${l.ratingCount} RATINGS',
      if (l.durationMin != null) '${l.durationMin} MIN',
      if (l.mediaMode == 'audio_only') '🎧 AUDIO ONLY' else '🎥 AUDIO + VIDEO',
      l.kind == 'agent' ? '⚙ AI VOICE AGENT' : '✓ REAL HUMAN'
    ];
    return Padding(
        padding: const EdgeInsets.fromLTRB(2, 20, 2, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(l.category.toUpperCase(),
              style: ADText.sectionLabel(c: AD.textTertiary)),
          const SizedBox(height: 6),
          Text(l.title,
              style: const TextStyle(
                  fontFamily: ADText.display,
                  fontSize: 34,
                  height: 1,
                  fontWeight: FontWeight.w700,
                  color: AD.textPrimary)),
          const SizedBox(height: 10),
          Wrap(
              spacing: 7,
              runSpacing: 7,
              children: badges
                  .map((x) => _pill(x, AD.cardHover, dark: true))
                  .toList()),
          if ((l.description ?? l.blurb ?? l.oneLiner).isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Text(l.description ?? l.blurb ?? l.oneLiner,
                    style: const TextStyle(
                        fontSize: 16, height: 1.45, color: AD.textPrimary))),
          const SizedBox(height: 12),
          Row(children: [
            Image.network('https://avatok.ai/assets/desi-swag.png',
                width: 62,
                height: 62,
                errorBuilder: (_, __, ___) => const SizedBox()),
            const Expanded(
                child: Text('“Jo jeeta wahi asli scene.” — a regular',
                    style: TextStyle(
                        fontStyle: FontStyle.italic,
                        color: AD.textTertiary))),
            Image.network('https://avatok.ai/assets/luv-it-sticker.png',
                width: 58,
                height: 58,
                errorBuilder: (_, __, ___) => const SizedBox()),
          ]),
          const SizedBox(height: 16),
          _stats(d)
        ]));
  }

  Widget _stats(ListingDetail d) {
    final l = d.listing;
    return Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: const BoxDecoration(
            border: Border.symmetric(
                horizontal: BorderSide(color: AD.textTertiary, width: 1))),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          _stat('${l.joinedCount}', 'BOOKED'),
          _stat('${l.favorited ? '♥' : l.ratingCount}', 'FAVOURITES'),
          _stat('${creator?.listings.length ?? 1}', 'SHOWS LISTED'),
          _stat('${d.creatorRating?.toStringAsFixed(1) ?? '—'}', 'HOST RATING')
        ]));
  }

  Widget _stat(String value, String label) => Column(children: [
        Text(value,
            style: const TextStyle(fontFamily: ADText.display, fontSize: 22, fontWeight: FontWeight.w700)),
        Text(label, style: ADText.sectionLabel(c: AD.textTertiary))
      ]);
  Widget _pill(String text, Color color, {bool dark = false}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration:
          BoxDecoration(color: color, borderRadius: BorderRadius.circular(99)),
      child: Text(text,
          style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: .3,
              color: dark ? AD.textPrimary : Colors.white)));

  Widget _bookingCard(ListingCard l) => Card(
      color: AD.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rSheet),
          side: const BorderSide(color: AD.textPrimary, width: 2.5)),
      child: Padding(
          padding: const EdgeInsets.all(18),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('BOOK A SEAT', style: ADText.appTitle()),
            const SizedBox(height: 4),
            Text(
                l.freeEntry || l.effectivePrice == 0
                    ? 'FREE'
                    : '${l.priceLabel} / SEAT',
                style:
                    const TextStyle(fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 14),
            Text(
                l.status == 'live'
                    ? 'Book and join instantly.'
                    : 'Choose your slot and confirm the exact price before payment.',
                style: ADText.preview()),
            const SizedBox(height: 16),
            FilledButton(
                onPressed: _openBooking,
                child: Text(l.status == 'live'
                    ? 'BOOK & JOIN NOW'
                    : 'CHOOSE DATE & TIME')),
            const SizedBox(height: 8),
            Text('No hidden fees · policy shown before payment',
                textAlign: TextAlign.center,
                style: ADText.sectionLabel(c: AD.textTertiary))
          ])));

  Widget _sections(ListingDetail d) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _section('HOW THE SHOW WORKS.', _howItWorks(d.listing)),
        _host(d),
        _rules(d.listing),
        _reviews(d),
        _trust()
      ]);
  Widget _section(String title, Widget child) => Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: const TextStyle(fontFamily: ADText.display, fontSize: 22, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        child
      ]));
  Widget _howItWorks(ListingCard l) {
    final raw = l.attrs['content_how_it_works'];
    final steps = raw is List ? raw : const [];
    return steps.isEmpty
        ? _infoCard(
            'Pick a time, review the host rules, then join from your booking confirmation.')
        : Column(children: [
            for (var i = 0; i < steps.length; i++)
              _infoCard(
                  'STEP ${i + 1} · ${(steps[i] is Map ? steps[i]['label'] : 'YOUR SESSION')}',
                  body: steps[i] is Map
                      ? '${steps[i]['body'] ?? ''}'
                      : '$steps[i]')
          ]);
  }

  Widget _infoCard(String title, {String? body}) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: AD.card,
          border: Border.all(color: AD.textPrimary, width: 1.5),
          borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: ADText.rowName()),
        if (body != null)
          Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(body, style: ADText.preview()))
      ]));

  Widget _host(ListingDetail d) {
    final c = creator;
    final l = d.listing;
    final name = c?.name ?? l.creator.name ?? l.creator.handle ?? 'Host';
    return _section(
        'MEET THE HOST.',
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _infoCard('', body: null),
          Row(children: [
            Avatar(
                seed: l.creator.uid,
                name: name,
                avatarUrl: c?.avatarUrl ?? l.creator.avatarUrl,
                size: 64),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text(name,
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, fontSize: 18)),
                  Text(
                      '${d.creatorRating?.toStringAsFixed(1) ?? '—'} host rating · ${d.followerCount} followers',
                      style: ADText.preview()),
                  if (l.creator.kycVerified)
                    const Text('✓ ID VERIFIED',
                        style: TextStyle(
                            color: AD.headerFooter,
                            fontWeight: FontWeight.w700))
                ]))
          ]),
          if ((c?.bio ?? '').isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(c!.bio!, style: ADText.preview())),
          TextButton.icon(
              onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) =>
                          CreatorChannelScreen(creatorUid: l.creator.uid))),
              icon: PhosphorIcon(PhosphorIcons.envelope(PhosphorIconsStyle.bold)),
              label: Text('Message ${name.split(' ').first}')),
          if (c != null && c.listings.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text('ALSO LISTED BY ${name.toUpperCase()}',
                    style: ADText.sectionLabel()))
        ]));
  }

  Widget _rules(ListingCard l) {
    final raw = l.attrs['rules'];
    final rules = raw is List ? raw : const [];
    if (rules.isEmpty)
      return _section(
          'HOUSE RULES.',
          _infoCard(
              'Respect the host and other attendees. No harassment, hate, or recording without consent.'));
    return _section(
        'HOUSE RULES.',
        Column(children: [
          for (var i = 0; i < rules.length; i++)
            _infoCard('${i + 1}. ${rules[i]}')
        ]));
  }

  Widget _reviews(ListingDetail d) => _section(
      'PUBLIC KI RAI.',
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _infoCard(
            '${d.creatorRating?.toStringAsFixed(1) ?? '—'} / 5 · ${d.reviews.length} VERIFIED REVIEWS'),
        for (final r in d.reviews.take(5)) _review(r)
      ]));

  Widget _trust() => _section(
      'SEEDHI BAAT, NO CHAKKAR.',
      GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 2,
          childAspectRatio: 1.45,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
          children: const [
            _TrustTile(
                'FULL PRICE UPFRONT', 'Fees and GST are shown before booking.'),
            _TrustTile('CANCEL = REFUND',
                'Cancellation follows the policy shown before payment.'),
            _TrustTile('REAL SEATS', 'Availability comes from live inventory.'),
            _TrustTile('HUMAN OR AI', 'The host type is clearly labelled.'),
            _TrustTile(
                'RECORDING OFF', 'Recording is off unless people consent.'),
            _TrustTile(
                'MODERATED ROOM', 'Report bad behaviour from every session.'),
          ]));
  Widget _review(ListingReview r) => Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: AD.borderHairline))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('★' * r.rating, style: TextStyle(color: AD.danger)),
        const SizedBox(width: 8),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(r.body.isEmpty ? 'Verified booking' : r.body,
              style: ADText.preview()),
          Text(r.authorName ?? 'AvaTOK member',
              style: ADText.sectionLabel(c: AD.textTertiary))
        ]))
      ]));
  Widget _related() => _section(
        'BROWSE MORE EVENTS.',
        SizedBox(
          height: 160,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: related.length,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (_, i) {
              final l = related[i];
              return SizedBox(
                width: 190,
                child: InkWell(
                  onTap: () => Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                        builder: (_) => NativeListingDetailV2(listingId: l.id)),
                  ),
                  child: Card(
                    color: AD.card,
                    child: Padding(
                      padding: const EdgeInsets.all(10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: l.coverUrl == null
                                ? ColoredBox(color: AD.headerFooter)
                                : ClipRRect(
                                    borderRadius: BorderRadius.circular(AD.rImage),
                                    child: Image.network(l.coverUrl!,
                                        width: double.infinity, fit: BoxFit.cover),
                                  ),
                          ),
                          const SizedBox(height: 7),
                          Text(l.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: ADText.rowName()),
                          Text(l.displayPrice, style: ADText.sectionLabel()),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
}

class _TrustTile extends StatelessWidget {
  const _TrustTile(this.title, this.body);
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
          color: AD.cardHover,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.textPrimary)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(body, style: const TextStyle(fontSize: 11, height: 1.2))
      ]));
}

/// Kept as a small, native preview adapter for the listing editor. It is not
/// the details page and shares no implementation with the removed legacy view.
class NativeListingPreview extends StatelessWidget {
  const NativeListingPreview({super.key, required this.card});
  final ListingCard card;
  @override
  Widget build(BuildContext context) => Card(
      child: ListTile(
          leading: SizedBox(
              width: 64,
              child: card.coverUrl == null
                  ? ColoredBox(color: AD.headerFooter)
                  : ClipRRect(
                      borderRadius: BorderRadius.circular(AD.rImage),
                      child: Image.network(card.coverUrl!, fit: BoxFit.cover))),
          title: Text(card.title),
          subtitle: Text(card.displayPrice)));
}
