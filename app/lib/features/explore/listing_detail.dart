import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import 'dart:convert';

import '../marketplace/call_agent_sheet.dart';
import '../../core/marketplace_api.dart';
import '../../core/chat_state.dart';
import '../../sync/sync_hub.dart';
import '../avatok/contacts.dart';
import '../../core/session_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verse_api.dart';
import '../avalive/live_viewer_screen.dart';
import '../avatok/chat_thread.dart';
import '../avatok/data.dart';
import '../translation/translation_api.dart';
import '../translation/translation_langs.dart';
import 'creator_channel.dart';
import 'widgets.dart';

/// Listing details page (Phase 6): media carousel, title, description, icon
/// row, Book/Join CTA, reviews, creator mini-card → channel.
class ListingDetailScreen extends StatefulWidget {
  final String listingId;
  const ListingDetailScreen({super.key, required this.listingId});
  @override
  State<ListingDetailScreen> createState() => _ListingDetailScreenState();
}

class _ListingDetailScreenState extends State<ListingDetailScreen> {
  ListingDetail? _d;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    Analytics.capture('listing_detail_viewed', {'listing_id': widget.listingId});
  }

  Future<void> _load() async {
    final d = await ListingsApi.detail(widget.listingId);
    if (!mounted) return;
    setState(() { _d = d; _loading = false; });
    // Talk-once: grey the Call Agent button if this buyer already negotiated this
    // listing version (one agent↔agent conversation per buyer per listing).
    if (d != null && const ['sell', 'buy', 'social'].contains(d.listing.kind) && !d.isOwner) {
      final talked = await MarketplaceApi.alreadyTalked(d.listing.id, 0);
      if (mounted && talked) setState(() => _alreadyTalked = true);
    }
  }

  // AvaMarketplace P5 — Call Agent. Greyed once this buyer has already
  // negotiated the current version of the listing (talk-once-per-version).
  bool _agentBusy = false;
  bool _alreadyTalked = false;

  void _alreadyTalkedNotice() {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content: Text('Your agent has already talked to this listing. Use Message to reach the seller.'),
    ));
  }

  Future<void> _callAgent() async {
    final d = _d;
    if (d == null || _agentBusy) return;
    final started = await showCallAgentSheet(
      context,
      listingId: d.listing.id,
      contentVersion: 0, // server keys talk-once on (buyer, listing, version)
      currency: d.listing.currency,
    );
    if (started && mounted) {
      setState(() => _alreadyTalked = true);
      // Materialise the seller as a contact NOW so the deal thread has somewhere to
      // land. The negotiation result arrives ~30s later (often when this screen or
      // the chat list isn't the active listener), so relying on the chat-list
      // listener alone is racy — pre-creating the contact guarantees the thread
      // appears (and surfaces the result even if it syncs while the app is elsewhere).
      final c = d.listing.creator;
      if (c.uid.isNotEmpty) {
        await ContactsStore().add(Contact(
          npub: c.uid,
          name: c.name ?? c.handle ?? 'Seller',
          avatarUrl: c.avatarUrl ?? '',
          number: c.avatokNumber ?? '',
          handle: c.handle ?? '',
        ));
        // Drop an OPTIMISTIC status bubble into the seller thread NOW — pushed
        // THROUGH SyncHub.injectLocal (NOT a silent DB write). A raw Db write
        // sat invisible in storage until the next app reload (which is exactly
        // why the thread looked like it never arrived); injectLocal emits it on
        // the same stream a real inbound uses, so the chat LIST materialises the
        // seller contact + thread LIVE the instant the buyer taps. Stable
        // rumorId → re-taps are idempotent. The negotiation result (a voice note
        // of the two agents) lands in this same thread when it finishes.
        final convKey = '1:${c.uid}';
        final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        final sellerName = c.name ?? 'the seller';
        SyncHub.I.injectLocal(
          peerUid: c.uid,
          rumorId: 'mkt_pending_${d.listing.id}',
          payload: jsonEncode({
            't': 'text',
            'body': '🤝 Your agent is talking to $sellerName\'s agent about "${d.listing.title}". '
                'The outcome — a voice note of the negotiation — will arrive in this chat shortly.',
          }),
        );
        // Persist the preview subtitle too, so the thread shows the right
        // subtitle even on a COLD chat-list load (when the injectLocal live
        // listener above wasn't mounted to record it).
        try {
          await ChatPreviewStore().record(convKey, '🤝 Your agent is negotiating…', nowSec, false);
        } catch (_) {/* best-effort */}
        // The negotiation result lands in our InboxDO ~10-40s from now. With NO
        // FCM (owner decision) and a socket that can churn, ACTIVELY pull it so
        // the deal card + voice note appear on their own — a handful of bounded,
        // idempotent cursor-resyncs over ~90s, then stop.
        for (final s in const [8, 15, 25, 40, 60, 90]) {
          Future.delayed(Duration(seconds: s), () {
            try { SyncHub.I.forceResync(); } catch (_) {}
          });
        }
      }
      if (!mounted) return;
      // The negotiation runs in the background — let the buyer keep browsing.
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        duration: Duration(seconds: 5),
        content: Text('Your agent is negotiating — the result will arrive in your chat with this seller.'),
      ));
    }
  }

  Future<void> _book() async {
    final d = _d;
    if (d == null) return;
    final isLiveNow = d.listing.kind == 'live_event' && d.listing.status == 'live';
    // Phase 7: already entitled to a live event -> straight into the player.
    if (isLiveNow) {
      try {
        await SessionApi.liveJoin(d.listing.id);
        if (!mounted) return;
        await Navigator.push(context, MaterialPageRoute(builder: (_) => LiveViewerScreen(listingId: d.listing.id)));
        _load();
        return;
      } on SessionApiError catch (_) {/* not booked yet -> checkout below */}
    }
    if (!mounted) return;
    final ok = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => CheckoutSheet(listing: d.listing),
    );
    if (ok == true) {
      _load();
      // "Join & pay" on a live event drops the viewer straight into the stream.
      if (isLiveNow && mounted) {
        await Navigator.push(context, MaterialPageRoute(builder: (_) => LiveViewerScreen(listingId: d.listing.id)));
      }
    }
  }

  /// Phase 8 — message the creator about THIS listing. The thread is tagged
  /// event:<listingId> server-side, so it shows in their AvaInbox as an
  /// "Event inquiry" with the event name; replies ride the same thread.
  void _message() {
    final d = _d;
    if (d == null) return;
    final c = d.listing.creator;
    VerseApi.tagThread(c.uid, 'event:${d.listing.id}'); // fire-and-forget tag
    Analytics.capture('listing_message_tapped', {'listing_id': d.listing.id});
    Navigator.push(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(
      chat: Chat(name: c.name ?? c.handle ?? 'Creator', seed: c.uid, last: '', time: '', avatarUrl: c.avatarUrl ?? ''),
    )));
  }

  Future<void> _review() async {
    final ok = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => _ReviewSheet(listingId: widget.listingId),
    );
    if (ok == true) _load();
  }

  void _overflow() {
    final d = _d;
    if (d == null) return;
    showModalBottomSheet(context: context, backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        builder: (c) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.flag(PhosphorIconsStyle.bold), color: Zine.ink),
        title: Text('Report listing', style: ZineText.value(size: 15, weight: FontWeight.w700)),
        onTap: () async {
          Navigator.pop(c);
          final ok = await ListingsApi.report('listing', d.listing.id, 'inappropriate');
          if (mounted && ok) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Report submitted — thank you')));
        },
      ),
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: Zine.coral),
        title: Text('Block this creator', style: ZineText.value(size: 15, color: Zine.coral, weight: FontWeight.w700)),
        onTap: () async {
          Navigator.pop(c);
          final ok = await ListingsApi.blockCreator(d.listing.creator.uid);
          if (mounted && ok) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Creator blocked'))); Navigator.pop(context); }
        },
      ),
    ])));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Listing',
        markWord: 'Listing',
        actions: [
          ZineBackButton(onTap: _overflow, icon: PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : d == null
              ? Center(child: ZineEmptyState(
                  icon: PhosphorIcons.fileX(PhosphorIconsStyle.bold),
                  text: 'Listing not found.'))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: Zine.blueInk,
                  child: ListingDetailView(
                    card: d.listing, reviews: d.reviews,
                    creatorRating: d.creatorRating, creatorRatingCount: d.creatorRatingCount,
                    followerCount: d.followerCount, canReview: d.booked && !d.isOwner,
                    onReview: _review,
                    onCreatorTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => CreatorChannelScreen(creatorUid: d.listing.creator.uid))),
                  ),
                ),
      bottomNavigationBar: d == null || d.isOwner ? null : Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              // Owner's AvaTOK number — dial/message them directly inside AvaTOK.
              if (const ['sell', 'buy', 'social'].contains(d.listing.kind) &&
                  (d.listing.creator.avatokNumber ?? '').isNotEmpty)
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _message,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(children: [
                      PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 16, color: Zine.ink),
                      const SizedBox(width: 6),
                      Text(d.listing.creator.avatokNumber!, style: ZineText.value(size: 14, color: Zine.ink)),
                      const SizedBox(width: 8),
                      Text('· tap to message or call', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
                    ]),
                  ),
                ),
              Row(children: [
              ZinePressable(
                onTap: _message,
                radius: BorderRadius.circular(100),
                child: SizedBox(width: 52, height: 52, child: Center(
                  child: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), size: 22, color: Zine.ink),
                )),
              ),
              const SizedBox(width: 12),
              if (const ['sell', 'buy', 'social'].contains(d.listing.kind)) ...[
                ZinePressable(
                  onTap: _alreadyTalked ? _alreadyTalkedNotice : _callAgent,
                  radius: BorderRadius.circular(100),
                  child: SizedBox(width: 52, height: 52, child: Center(
                    child: Icon(Icons.support_agent, size: 24,
                        color: _alreadyTalked ? Zine.ink.withOpacity(0.3) : Zine.ink),
                  )),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(child: () {
                final isMarket = const ['sell', 'buy', 'social'].contains(d.listing.kind);
                if (isMarket) {
                  // Marketplace listing: the primary action is to message the owner
                  // directly (price is shown above; agents handle negotiation).
                  return ZineButton(
                    label: 'Message owner',
                    variant: ZineButtonVariant.lime,
                    fontSize: 18, fullWidth: true,
                    onPressed: _message,
                  );
                }
                return ZineButton(
                  label: d.listing.status == 'live'
                      ? 'Join now · ${d.listing.priceLabel}'
                      : d.listing.kind == 'live_event'
                          ? 'Book · ${d.listing.priceLabel}'
                          : 'Book a session · ${d.listing.priceLabel}',
                  variant: d.listing.status == 'live' ? ZineButtonVariant.coral : ZineButtonVariant.lime,
                  fontSize: 18,
                  fullWidth: true,
                  onPressed: _book,
                );
              }()),
            ]),
            ]),
          ),
        ),
      ),
    );
  }
}

/// The REAL details render — also used by the creation pipeline's
/// "preview as buyer" step (A6: one codepath, no preview drift).
class ListingDetailView extends StatelessWidget {
  final ListingCard card;
  final List<ListingReview> reviews;
  final double? creatorRating;
  final int creatorRatingCount, followerCount;
  final bool canReview;
  final VoidCallback? onReview, onCreatorTap;
  const ListingDetailView({
    super.key, required this.card, this.reviews = const [],
    this.creatorRating, this.creatorRatingCount = 0, this.followerCount = 0,
    this.canReview = false, this.onReview, this.onCreatorTap,
  });

  @override
  Widget build(BuildContext context) {
    final covers = card.coverMedia
        .map((m) => (m is Map ? (m['url'] ?? m['r2_key']) : null)?.toString())
        .whereType<String>().where((u) => u.startsWith('http')).toList();
    return ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.only(bottom: 24), children: [
      // media carousel — hero cover with ink border + hard shadow.
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
        child: Container(
          height: 230,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Zine.rSm),
            boxShadow: Zine.shadowSm,
          ),
          child: covers.isEmpty
              ? CoverImage(url: null, seed: card.id.hashCode)
              : PageView(children: [
                  for (final u in covers) CoverImage(url: u, seed: card.id.hashCode),
                ]),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text(card.title, style: ZineText.cardTitle(size: 22))),
            const SizedBox(width: 10),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              if (card.promoPct > 0)
                Text(fmtCoins(card.price),
                    style: ZineText.sub(size: 12, color: Zine.inkMute)
                        .copyWith(decoration: TextDecoration.lineThrough)),
              // money = mint pill (§7.10).
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: BoxDecoration(
                  color: Zine.mint,
                  borderRadius: BorderRadius.circular(100),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
                ),
                child: Text(card.displayPrice, style: ZineText.value(size: 15, weight: FontWeight.w900)),
              ),
            ]),
          ]),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            ZineSticker(card.kind == 'live_event' ? '🎥 Live event' : '🗓 ${card.capacity == 1 ? '1:1 session' : 'Group session (${card.capacity})'}'),
            if (card.startsAt != null) ZineSticker('🕐 ${fmtWhen(card.startsAt)}'),
            if (card.durationMin != null) ZineSticker('${card.durationMin} min'),
            if (card.country != null) ZineSticker('${flagEmoji(card.country)} ${card.country}'),
            if (card.adultsOnly) const ZineSticker('18+', kind: ZineStickerKind.no),
            if (card.translationEnabled)
              ZineSticker('🌐 Voice translation${card.spokenLang != null ? ' · speaks ${translationLangLabel(card.spokenLang!)}' : ''}'),
            for (final b in card.badges) ZineSticker(b.toString()),
            ZineSticker(card.category, kind: ZineStickerKind.hint),
          ]),
          if (card.joinedCount > 0) ...[
            const SizedBox(height: 10),
            Text('🔥 ${card.joinedCount} joined', style: ZineText.value(size: 13, color: Zine.inkSoft, weight: FontWeight.w800)),
          ],
          const SizedBox(height: 16),
          if ((card.description ?? '').isNotEmpty) ...[
            Text(card.description!, style: ZineText.sub(size: 14.5, color: Zine.ink)),
            const SizedBox(height: 18),
          ],
          // creator mini-card → channel
          ZineCard(
            onTap: onCreatorTap,
            padding: const EdgeInsets.all(12),
            radius: Zine.rSm,
            child: Row(children: [
              Avatar(seed: card.creator.uid, name: card.creator.name ?? '?', size: 44,
                  avatarUrl: card.creator.avatarUrl),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(card.creator.name ?? (card.creator.handle ?? 'Creator'),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 15, weight: FontWeight.w800))),
                  if (card.creator.kycVerified) ...[
                    const SizedBox(width: 5),
                    PhosphorIcon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 16, color: Zine.blueInk),
                  ],
                ]),
                Text(
                  [
                    if (creatorRating != null && creatorRatingCount > 0) '★ ${creatorRating!.toStringAsFixed(1)} ($creatorRatingCount)',
                    if (followerCount > 0) '$followerCount followers',
                  ].join(' · '),
                  style: ZineText.tag(size: 10.5, color: Zine.inkSoft),
                ),
              ])),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
            ]),
          ),
          const SizedBox(height: 22),
          Row(children: [
            Text('Reviews', style: ZineText.cardTitle()),
            const SizedBox(width: 10),
            RatingStars(rating: card.ratingAvg, count: card.ratingCount, size: 15),
            const Spacer(),
            if (canReview) ZineLink('Leave a review', onTap: onReview),
          ]),
          if (reviews.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text('No reviews yet — be the first.', style: ZineText.sub(size: 14))),
          for (final r in reviews) ReviewTile(review: r),
        ]),
      ),
    ]);
  }
}

class ReviewTile extends StatelessWidget {
  final ListingReview review;
  const ReviewTile({super.key, required this.review});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Avatar(seed: review.authorId, name: review.authorName ?? '?', size: 34, avatarUrl: review.authorAvatar),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(review.authorName ?? 'AvaTOK user',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 13, weight: FontWeight.w800))),
              Row(children: List.generate(5, (i) => PhosphorIcon(
                  i < review.rating
                      ? PhosphorIcons.star(PhosphorIconsStyle.fill)
                      : PhosphorIcons.star(PhosphorIconsStyle.bold),
                  size: 13, color: i < review.rating ? Zine.coral : Zine.inkMute))),
            ]),
            if (review.body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 2),
                  child: Text(review.body, style: ZineText.sub(size: 13, color: Zine.ink))),
          ])),
        ]),
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout: wallet balance, promo code, consult slot picker (greyed conflicts),
// insufficient-funds inline top-up (A8) — also the live "Join & pay" popup.
// ─────────────────────────────────────────────────────────────────────────────
class CheckoutSheet extends StatefulWidget {
  final ListingCard listing;
  const CheckoutSheet({super.key, required this.listing});
  @override
  State<CheckoutSheet> createState() => _CheckoutSheetState();
}

class _CheckoutSheetState extends State<CheckoutSheet> {
  final _promo = TextEditingController();
  int? _balance;
  DateTime _day = DateTime.now().add(const Duration(days: 1));
  List<Map<String, dynamic>> _slots = [];
  int? _slotStart, _slotEnd;
  bool _busy = false, _loadingSlots = false;
  String? _error;
  // "Would you like this to be translated into the language of your choice?"
  bool _translate = false;
  String? _translateLang;

  bool get _isConsult => widget.listing.kind == 'consult';

  int get _durationMin {
    if (_isConsult && _slotStart != null && _slotEnd != null) {
      return ((_slotEnd! - _slotStart!) / 60000).ceil();
    }
    return widget.listing.durationMin ?? 60;
  }

  /// $3/h = 5 Tokens/min for the booked duration.
  int get _translationCoins => _translate && _translateLang != null ? TranslationApi.quoteCoins(_durationMin) : 0;
  int get _totalCoins => widget.listing.effectivePrice + _translationCoins;

  @override
  void initState() {
    super.initState();
    _loadBalance();
    if (_isConsult) _loadSlots();
  }

  Future<void> _loadBalance() async {
    final j = await MoneyApi.balance();
    if (mounted) setState(() => _balance = (j['balance'] as num?)?.toInt());
  }

  String get _ymd =>
      '${_day.year}-${_day.month.toString().padLeft(2, '0')}-${_day.day.toString().padLeft(2, '0')}';

  Future<void> _loadSlots() async {
    setState(() { _loadingSlots = true; _slotStart = null; });
    final s = await ListingsApi.slotGrid(widget.listing.creator.uid, _ymd, widget.listing.durationMin ?? 60);
    if (mounted) setState(() { _slots = s; _loadingSlots = false; });
  }

  Future<void> _confirm() async {
    if (_isConsult && _slotStart == null) { setState(() => _error = 'Pick a time slot first.'); return; }
    if (_translate && _translateLang == null) { setState(() => _error = 'Select a translation language first.'); return; }
    setState(() { _busy = true; _error = null; });
    final r = await ListingsApi.book(widget.listing.id,
        slotStart: _slotStart, slotEnd: _slotEnd, promoCode: _promo.text.trim(),
        translationLang: _translate ? _translateLang : null);
    if (!mounted) return;
    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 200) {
      Analytics.capture('listing_checkout_done', {'listing_id': widget.listing.id, 'amount': r['amount']});
      Navigator.pop(context, true);
      return;
    }
    if (status == 402) {
      // A8 — inline top-up pre-filled with the shortfall, then checkout resumes
      // (the selected slot is kept in this sheet's state).
      final needed = (r['needed'] as num?)?.toInt() ?? widget.listing.effectivePrice;
      final bal = (r['balance'] as num?)?.toInt() ?? _balance ?? 0;
      final shortfall = (needed - bal).clamp(50, 50000).toInt();
      setState(() => _busy = false);
      final t = await MoneyApi.topup(shortfall);
      if (!mounted) return;
      final url = t['checkout_url']?.toString();
      if (url != null && url.isNotEmpty) {
        setState(() => _error = 'Complete the top-up in your browser, then tap Confirm again — your slot is kept.');
        Analytics.capture('checkout_topup_opened', {'shortfall': shortfall});
      } else {
        setState(() => _error = 'Not enough Tokens (need ${fmtCoins(needed)}, have ${fmtCoins(bal)}) — top-up is currently unavailable.');
      }
      _loadBalance();
      return;
    }
    setState(() {
      _busy = false;
      _error = r['error']?.toString() == 'conflict'
          ? 'That time just got taken — pick another slot.'
          : (r['error']?.toString() ?? 'Booking failed — try again.');
    });
    if (_isConsult) _loadSlots();
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.listing;
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bwLg)),
      ),
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 40, height: 5, margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: Zine.ink, borderRadius: BorderRadius.circular(3)))),
          Text(l.status == 'live' ? 'Join & pay' : 'Confirm booking', style: ZineText.cardTitle(size: 21)),
          const SizedBox(height: 4),
          Text(l.title, style: ZineText.sub(size: 14)),
          const SizedBox(height: 14),
          if (_isConsult) ...[
            Row(children: [
              Text('PICK A TIME', style: ZineText.kicker()),
              const Spacer(),
              ZinePressable(
                onTap: () async {
                  final d = await showDatePicker(context: context, initialDate: _day,
                      firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 90)));
                  if (d != null) { setState(() => _day = d); _loadSlots(); }
                },
                radius: BorderRadius.circular(100),
                boxShadow: Zine.shadowXs,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), size: 14, color: Zine.ink),
                  const SizedBox(width: 6),
                  Text(_ymd, style: ZineText.tag(size: 11.5)),
                ]),
              ),
            ]),
            const SizedBox(height: 10),
            if (_loadingSlots) const Center(child: Padding(padding: EdgeInsets.all(12),
                child: CircularProgressIndicator(color: Zine.blueInk)))
            else if (_slots.isEmpty)
              Padding(padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Text('No availability this day — try another date.', style: ZineText.sub(size: 13.5)))
            else
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final s in _slots) _slotChip(s),
              ]),
            const SizedBox(height: 14),
          ],
          if (l.effectivePrice > 0) ...[
            ZineField(
              controller: _promo,
              hint: 'Promo code (optional)',
              textCapitalization: TextCapitalization.characters,
              leadIcon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            ),
            const SizedBox(height: 12),
          ],
          // Voice translation add-on (only when the creator offers it) — AI = lilac.
          if (l.translationEnabled) ...[
            ZineCard(
              color: Zine.lilac,
              radius: Zine.rSm,
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('🌐 Would you like this to be translated into the language of your choice?',
                        style: ZineText.value(size: 13, weight: FontWeight.w800)),
                    const SizedBox(height: 4),
                    Text(
                      'Live voice translation · \$3 per hour'
                      '${l.spokenLang != null ? ' · the creator speaks ${translationLangLabel(l.spokenLang!)}' : ''}',
                      style: ZineText.sub(size: 12, color: Zine.ink),
                    ),
                  ])),
                  const SizedBox(width: 10),
                  ZineToggle(value: _translate, onChanged: (v) => setState(() => _translate = v)),
                ]),
                if (_translate) ...[
                  const SizedBox(height: 12),
                  ZineDropdown<String>(
                    value: _translateLang,
                    label: 'Select language',
                    hint: 'Pick a language',
                    items: [
                      for (final lng in kTranslationLangs)
                        DropdownMenuItem(value: lng.code, child: Text(lng.label)),
                    ],
                    onChanged: (v) => setState(() => _translateLang = v),
                  ),
                ],
              ]),
            ),
            const SizedBox(height: 12),
          ],
          ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.all(12),
            child: Column(children: [
              Row(children: [
                PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
                const SizedBox(width: 8),
                Text('Wallet: ${_balance == null ? '…' : fmtCoins(_balance!)}',
                    style: ZineText.value(size: 14, weight: FontWeight.w700)),
                const Spacer(),
                Text(l.priceLabel, style: ZineText.value(size: 15, color: Zine.mintInk, weight: FontWeight.w900)),
              ]),
              // Itemized total when translation is on: e.g. $60 + $3 × 1 h = $63.
              if (_translationCoins > 0) ...[
                const Divider(height: 16, color: Zine.ink, thickness: 1),
                Row(children: [
                  Expanded(child: Text(
                    'Voice translation · $_durationMin min',
                    style: ZineText.sub(size: 12.5),
                  )),
                  Text('+ ${fmtCoins(_translationCoins)}', style: ZineText.value(size: 12.5, weight: FontWeight.w800)),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  Expanded(child: Text('Total (including voice translation)',
                      style: ZineText.value(size: 13.5, weight: FontWeight.w800))),
                  Text(fmtCoins(_totalCoins), style: ZineText.value(size: 15, color: Zine.mintInk, weight: FontWeight.w900)),
                ]),
              ],
            ]),
          ),
          if (_error != null) ZineErrorMsg(_error!),
          const SizedBox(height: 16),
          ZineButton(
            label: _totalCoins == 0
                ? 'Confirm (free)'
                : 'Pay ${l.money(_totalCoins)} & confirm',
            fullWidth: true,
            fontSize: 19,
            loading: _busy,
            onPressed: _busy ? null : _confirm,
          ),
        ]),
      ),
    );
  }

  Widget _slotChip(Map<String, dynamic> s) {
    final start = (s['start'] as num?)?.toInt() ?? 0;
    final end = (s['end'] as num?)?.toInt() ?? 0;
    final available = s['available'] == true;
    final sel = _slotStart == start;
    final d = DateTime.fromMillisecondsSinceEpoch(start);
    final label = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return GestureDetector(
      // Occupied slots are shown GREYED, not hidden (spec) — tap does nothing.
      onTap: available ? () => setState(() { _slotStart = start; _slotEnd = end; _error = null; }) : null,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: sel ? Zine.lime : (available ? Zine.card : Zine.paper2),
          border: Border.all(color: available ? Zine.ink : Zine.inkMute, width: Zine.bw),
          borderRadius: BorderRadius.circular(100),
          boxShadow: sel ? Zine.shadowXs : null,
        ),
        child: Text(label, style: ZineText.tag(size: 12,
                color: available ? Zine.ink : Zine.inkMute)
            .copyWith(decoration: available ? null : TextDecoration.lineThrough)),
      ),
    );
  }
}

class _ReviewSheet extends StatefulWidget {
  final String listingId;
  const _ReviewSheet({required this.listingId});
  @override
  State<_ReviewSheet> createState() => _ReviewSheetState();
}

class _ReviewSheetState extends State<_ReviewSheet> {
  int _rating = 5;
  final _body = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _send() async {
    setState(() { _busy = true; _error = null; });
    final ok = await ListingsApi.review(widget.listingId, _rating, _body.text.trim());
    if (!mounted) return;
    if (ok) { Navigator.pop(context, true); return; }
    setState(() { _busy = false; _error = 'Could not submit — only attendees can review after the session ends.'; });
  }

  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bwLg)),
        ),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Rate this session', style: ZineText.cardTitle(size: 20)),
          const SizedBox(height: 12),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: List.generate(5, (i) => IconButton(
              onPressed: () => setState(() => _rating = i + 1),
              icon: PhosphorIcon(
                  i < _rating ? PhosphorIcons.star(PhosphorIconsStyle.fill) : PhosphorIcons.star(PhosphorIconsStyle.bold),
                  size: 32, color: i < _rating ? Zine.coral : Zine.inkMute)))),
          const SizedBox(height: 12),
          ZineField(
            controller: _body,
            maxLines: 3,
            hint: 'Share your experience (optional)',
          ),
          if (_error != null) ZineErrorMsg(_error!),
          const SizedBox(height: 14),
          ZineButton(
            label: 'Send review',
            fullWidth: true,
            loading: _busy,
            onPressed: _busy ? null : _send,
          ),
        ]),
      );
}
