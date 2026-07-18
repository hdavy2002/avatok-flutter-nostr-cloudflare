import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import 'dart:async';
import 'dart:convert';

import '../../sync/party/party_hub.dart';
import '../marketplace/intent_theme.dart';
import '../marketplace/call_agent_sheet.dart';
import '../../core/marketplace_api.dart';
import '../../core/chat_state.dart';
import '../../sync/sync_hub.dart';
import '../avatok/contacts.dart';
import '../../core/session_api.dart';
import '../../core/ui/avatok_dark.dart';
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

  // PartyKit live layer for this listing (ephemeral; gated by partyEnabled).
  PartyRoom? _lparty;
  StreamSubscription? _lpartyEvents;
  StreamSubscription? _lpartyPresence;
  int _viewers = 0; // #7: how many people are viewing this listing right now

  @override
  void initState() {
    super.initState();
    _load();
    _joinListingParty();
    Analytics.capture('listing_detail_viewed', {'listing_id': widget.listingId});
  }

  /// Join this listing's party room so we get a LIVE viewer count (#7) and pull a
  /// fresh copy the instant the seller changes the price / marks it SOLD (#8).
  /// No-op until partyEnabled is flipped on (dormant room).
  void _joinListingParty() {
    try {
      final room = PartyHub.I.join('listing:${widget.listingId}');
      _lparty = room;
      _lpartyPresence = room.presence.listen((roster) {
        if (mounted) setState(() => _viewers = roster.length);
      });
      _lpartyEvents = room.events.listen((e) {
        if (e['t'] == 'listing_update' && mounted) _load(); // price/SOLD changed → refresh
      });
    } catch (_) {/* best-effort live layer */}
  }

  @override
  void dispose() {
    _lpartyEvents?.cancel();
    _lpartyPresence?.cancel();
    _lparty?.leave();
    super.dispose();
  }

  Future<void> _load() async {
    final d = await ListingsApi.detail(widget.listingId);
    if (!mounted) return;
    setState(() { _d = d; _loading = false; });
    // [MKT1-DETAIL] One skeleton, five templates — record which template rendered
    // so we can see the category-template mix buyers actually land on.
    if (d != null) {
      Analytics.capture('listing_template_rendered', {
        'template': d.listing.detailTemplate,
        'intent': d.listing.intent,
        'listing_id': d.listing.id,
      });
    }
    // Talk-once: grey the Call Agent button if this buyer already negotiated this
    // listing version (one agent↔agent conversation per buyer per listing).
    if (d != null && const ['sell', 'buy', 'social'].contains(d.listing.kind) && !d.isOwner) {
      // [AVA-MKT-CVER-1] The REAL content version of the listing we just loaded —
      // read off `d` (the fetched detail), never off a possibly-stale/unset `_d`.
      // The server keys talk-once on (buyer_id, listing_id, content_version) and
      // bumps it on a material owner edit, so an edit reopens the gate here.
      // MUST stay in lockstep with the contentVersion sent by _callAgent below —
      // that reads the same loaded listing (`_d.listing.contentVersion`), so the
      // version we grey the button against is always the one we negotiate against.
      // Absent field (pre-migration server) → 0, matching what it already stores.
      final talked = await MarketplaceApi.alreadyTalked(d.listing.id, d.listing.contentVersion);
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
      // [AVA-MKT-CVER-1] The loaded listing's real content version. `d` is the
      // non-null `_d` guarded above, i.e. the SAME ListingDetail that _load()'s
      // alreadyTalked() check read its version from — so the version we grey the
      // button against and the version we negotiate against can never diverge.
      // (A refresh replaces `_d` and re-runs both, so they move together.)
      contentVersion: d.listing.contentVersion,
      currency: d.listing.currency,
      onMessageSeller: _message, // P5: daily-limit fallback → owner-DM path
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
        // [ISSUE-CONTACT-RESURRECT-1] DELIBERATELY the explicit `add()` — the
        // tombstone-clearing path — NOT `addIfNotDeleted()`. Do not "fix" this
        // to match the automated call sites (_ensureContact / mergeTel /
        // resurrection); it is the opposite case and the distinction is the
        // whole point of the two entry points.
        //
        // Tapping "Contact agent" IS the user choosing to open a conversation
        // with this seller — semantically identical to tapping Add contact, so
        // un-deleting them is CORRECT and intended. Refusing here would be
        // actively harmful: the buyer has already started (and possibly paid
        // for) a negotiation, the result lands in this thread ~30s later, and
        // with no contact row there is nowhere for it to land — the injectLocal
        // bubble below and the eventual voice note would both be swallowed. The
        // user would get silence for something they asked for.
        //
        // It is still worth SEEING when this un-deletes someone, so it's
        // instrumented rather than blocked.
        final store = ContactsStore();
        if ((await store.deletedContacts()).containsKey(c.uid)) {
          Analytics.capture('contact_undeleted', const {
            'source': 'listing_contact_agent',
            'reason': 'explicit_user_action',
          });
        }
        await store.add(Contact(
          uid: c.uid,
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
            'body': '🤝 Your agents are negotiating with $sellerName\'s agent about "${d.listing.title}". '
                'This can take up to an hour — come back and check for the voice conversation.',
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

  /// [MKT1-DETAIL] Report affordance present on EVERY template (§4.2 skeleton
  /// step 6). Same `POST /api/report` path as the overflow menu.
  Future<void> _reportListing() async {
    final d = _d;
    if (d == null) return;
    final ok = await ListingsApi.report('listing', d.listing.id, 'inappropriate');
    if (mounted && ok) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Report submitted — thank you')));
    }
  }

  /// [MKT1-DETAIL] The bottom-bar PRIMARY CTA. Booking listings (live events,
  /// consults, the `book` template) keep the real checkout / slot-picker path
  /// (`_book`); every other template's primary is "Talk to my agent" with the
  /// per-template verb (§4.2), wired to the unchanged `_callAgent`.
  Widget _primaryCta(ListingCard l) {
    final isLive = l.status == 'live';
    final isBooking = isLive ||
        l.kind == 'live_event' ||
        l.kind == 'consult' ||
        l.detailTemplate == 'book';
    if (isBooking) {
      return AdButton(
        label: isLive
            ? 'Join now · ${l.priceLabel}'
            : l.detailTemplate == 'book'
                ? 'Book a slot'
                : l.kind == 'live_event'
                    ? 'Book · ${l.priceLabel}'
                    : 'Book a session · ${l.priceLabel}',
        variant: isLive ? AdButtonVariant.danger : AdButtonVariant.primary,
        fontSize: 18, fullWidth: true,
        onPressed: _book,
      );
    }
    return AdButton(
      label: _agentCtaLabel(l.detailTemplate),
      variant: AdButtonVariant.primary,
      fontSize: 18, fullWidth: true,
      onPressed: _alreadyTalked ? _alreadyTalkedNotice : _callAgent,
    );
  }

  /// Per-template verb for the "Talk to my agent" primary CTA (§4.2 table).
  String _agentCtaLabel(String template) {
    switch (template) {
      case 'rent':
        return 'Talk to my agent · rate & dates';
      case 'lead':
        return 'Ask anything';
      case 'profile':
        return 'Screen & ask';
      case 'sell':
      default:
        return 'Talk to my agent';
    }
  }

  void _overflow() {
    final d = _d;
    if (d == null) return;
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        builder: (c) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.flag(PhosphorIconsStyle.bold), color: AD.textPrimary),
        title: Text('Report listing', style: ADText.rowName(c: AD.textPrimary)),
        onTap: () async {
          Navigator.pop(c);
          final ok = await ListingsApi.report('listing', d.listing.id, 'inappropriate');
          if (mounted && ok) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Report submitted — thank you')));
        },
      ),
      ListTile(
        leading: PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), color: AD.danger),
        title: Text('Block this creator', style: ADText.rowName(c: AD.danger)),
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
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(64),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 10),
              child: Row(children: [
                const AdBackButton(),
                const SizedBox(width: 4),
                Expanded(child: Text('Listing', style: ADText.appTitle())),
                AdBackButton(onTap: _overflow, icon: PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold)),
              ]),
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
          : d == null
              ? Center(child: ZineEmptyState(
                  icon: PhosphorIcons.fileX(PhosphorIconsStyle.bold),
                  text: 'Listing not found.'))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: AD.iconSearch,
                  child: ListingDetailView(
                    card: d.listing, reviews: d.reviews,
                    creatorRating: d.creatorRating, creatorRatingCount: d.creatorRatingCount,
                    followerCount: d.followerCount, canReview: d.booked && !d.isOwner,
                    viewers: _viewers,
                    onReview: _review,
                    onReport: _reportListing,
                    onCreatorTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => CreatorChannelScreen(creatorUid: d.listing.creator.uid))),
                  ),
                ),
      bottomNavigationBar: d == null || d.isOwner ? null : Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
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
                      PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 16, color: AD.textPrimary),
                      const SizedBox(width: 6),
                      Text(d.listing.creator.avatokNumber!, style: ADText.rowName(c: AD.textPrimary)),
                      const SizedBox(width: 8),
                      Text('· tap to message or call', style: ADText.statCaption(c: AD.textSecondary)),
                    ]),
                  ),
                ),
              // [MKT1-DETAIL] §4.2 skeleton CTAs: [Message owner] + a primary that
              // changes VERB per template (wiring unchanged). Message owner is the
              // round chat button; the primary is booking or "Talk to my agent".
              Row(children: [
              ZinePressable(
                onTap: _message,
                color: AD.card,
                borderColor: AD.borderControl,
                boxShadow: const [],
                radius: BorderRadius.circular(100),
                child: SizedBox(width: 52, height: 52, child: Center(
                  child: PhosphorIcon(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), size: 22, color: AD.textPrimary),
                )),
              ),
              const SizedBox(width: 12),
              Expanded(child: _primaryCta(d.listing)),
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
  final VoidCallback? onReview, onCreatorTap, onReport;
  final int viewers; // #7: live viewer count (PartyKit), 0 when none/off
  const ListingDetailView({
    super.key, required this.card, this.reviews = const [],
    this.creatorRating, this.creatorRatingCount = 0, this.followerCount = 0,
    this.canReview = false, this.onReview, this.onCreatorTap, this.onReport,
    this.viewers = 0,
  });

  @override
  Widget build(BuildContext context) {
    // [MKT1-DETAIL] ONE skeleton, five templates (§4.2). The order is fixed for
    // every template: HERO → title+price → owner block (avatar/number/QR) →
    // category block → CTAs (bottom bar, owned by the screen) → reviews → report.
    // Only the CATEGORY BLOCK and the CTA VERBS change per `detailTemplate`.
    final it = IntentTheme.parse(card.intent);
    final covers = card.coverMedia
        .map((m) => (m is Map ? (m['url'] ?? m['r2_key']) : null)?.toString())
        .whereType<String>().where((u) => u.startsWith('http')).toList();
    // §4.1 price semantics — RENT → "/mo", LEAD → "from", PROFILE → "" (nothing).
    final priceStr = priceLabel(card.price, card.currency, card.priceSemantics);
    return ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.only(bottom: 24), children: [
      // 1. HERO — one rule, all templates: video > photo > intent placeholder.
      _ListingHero(card: card, covers: covers, videoId: _youtubeId(card.videoUrl), theme: it),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // 2. Title + price (intent-aware label).
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text(card.title, style: ADText.appTitle())),
            if (priceStr.isNotEmpty) ...[
              const SizedBox(width: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: BoxDecoration(
                  color: card.price <= 0 ? AD.online : it.chipBg,
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: it.tintBorder, width: 1),
                ),
                child: Text(priceStr,
                    style: ADText.rowName(c: card.price <= 0 ? Colors.white : it.tint)),
              ),
            ],
          ]),
          // #7: live viewer count (PartyKit roster). Shown only when others are
          // here too; dormant/0 until partyEnabled is on.
          if (viewers > 1) ...[
            const SizedBox(height: 6),
            Text('👀 $viewers people viewing now',
                style: ADText.preview(c: AD.textTertiary)),
          ],
          const SizedBox(height: 12),
          // [UI-MKT-2] wired stats row: star reviews / eye views / posted-ago.
          // Each guards its own value — never renders 0 or NULL.
          Builder(builder: (_) {
            final chips = <Widget>[
              if (card.ratingAvg != null && card.ratingCount > 0)
                _statPill(PhosphorIcons.star(PhosphorIconsStyle.fill), '${card.ratingAvg!.toStringAsFixed(1)} (${card.ratingCount})', color: AD.iconStar),
              if (card.viewCount > 0)
                _statPill(PhosphorIcons.eye(PhosphorIconsStyle.bold), '${card.viewCount} view${card.viewCount == 1 ? '' : 's'}'),
              if (card.createdAt != null)
                _statPill(PhosphorIcons.clock(PhosphorIconsStyle.bold), _postedAgo(card.createdAt!)),
            ];
            if (chips.isEmpty) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Wrap(spacing: 14, runSpacing: 6, children: chips),
            );
          }),
          Wrap(spacing: 8, runSpacing: 8, children: [
            // FORMATTER FIX: the session-type chip is meaningful ONLY for creator
            // services (live_event/consult) — for marketplace kinds (sell/buy/
            // social) capacity is null, which used to print "Group session (NULL)".
            // Render it only for those kinds AND only when capacity is a real value.
            if (card.kind == 'live_event')
              const AdSticker('🎥 Live event')
            else if (card.kind == 'consult' && card.capacity != null)
              AdSticker(card.capacity == 1 ? '🗓 1:1 session' : '🗓 Group session (${card.capacity})'),
            if (card.startsAt != null) AdSticker('🕐 ${fmtWhen(card.startsAt)}'),
            if (card.durationMin != null) AdSticker('${card.durationMin} min'),
            if (card.country != null && card.country!.isNotEmpty) AdSticker('${flagEmoji(card.country)} ${card.country}'),
            if (card.adultsOnly) const AdSticker('18+', kind: AdStickerKind.no),
            if (card.translationEnabled)
              AdSticker('🌐 Voice translation${card.spokenLang != null ? ' · speaks ${translationLangLabel(card.spokenLang!)}' : ''}'),
            // Guard badges: skip null/empty entries so a stray null never prints "null".
            for (final b in card.badges)
              if (b != null && b.toString().trim().isNotEmpty) AdSticker(b.toString()),
            // Category hint — only when it's a real, non-empty value.
            if (card.category.trim().isNotEmpty) AdSticker(card.category, kind: AdStickerKind.hint),
          ]),
          if (card.joinedCount > 0) ...[
            const SizedBox(height: 10),
            Text('🔥 ${card.joinedCount} joined', style: ADText.preview(c: AD.textSecondary)),
          ],
          const SizedBox(height: 16),
          if ((card.description ?? '').isNotEmpty) ...[
            Text(card.description!, style: ADText.preview(c: AD.textPrimary)),
            const SizedBox(height: 18),
          ],
          // 3. Owner profile block — avatar, AvaTOK number, QR of the deep link.
          _OwnerProfileBlock(
            card: card,
            creatorRating: creatorRating,
            creatorRatingCount: creatorRatingCount,
            followerCount: followerCount,
            onCreatorTap: onCreatorTap,
          ),
          const SizedBox(height: 20),
          // 4. Category block — the ONLY part that varies by template. Reads
          // `attrs` generically (the field_schema drives what's present).
          _CategoryBlock(card: card, theme: it),
          const SizedBox(height: 22),
          // 5. Reviews (existing).
          Row(children: [
            Text('Reviews', style: ADText.appTitle()),
            const SizedBox(width: 10),
            RatingStars(rating: card.ratingAvg, count: card.ratingCount, size: 15),
            const Spacer(),
            if (canReview)
              GestureDetector(
                onTap: onReview,
                behavior: HitTestBehavior.opaque,
                child: Text('Leave a review', style: ADText.preview(c: AD.iconSearch)),
              ),
          ]),
          if (reviews.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text('No reviews yet — be the first.', style: ADText.preview())),
          for (final r in reviews) ReviewTile(review: r),
          // 6. Report — present on EVERY template (skeleton step 6). Hidden in the
          // creation-preview (onReport null) since there's nothing to report yet.
          if (onReport != null) ...[
            const SizedBox(height: 18),
            Center(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: onReport,
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.flag(PhosphorIconsStyle.bold), size: 15, color: AD.textTertiary),
                  const SizedBox(width: 6),
                  Text('Report this listing', style: ADText.preview(c: AD.textTertiary)),
                ]),
              ),
            ),
          ],
        ]),
      ),
    ]);
  }
}

/// [MKT1-DETAIL] Extract a YouTube video id from a (server-validated, §3.4)
/// YouTube URL. Handles watch / youtu.be / shorts / embed / nocookie forms.
String? _youtubeId(String? url) {
  if (url == null || url.trim().isEmpty) return null;
  final u = url.trim();
  for (final p in <RegExp>[
    RegExp(r'youtube\.com/watch\?[^ ]*[?&]?v=([A-Za-z0-9_-]{6,})'),
    RegExp(r'youtu\.be/([A-Za-z0-9_-]{6,})'),
    RegExp(r'youtube\.com/shorts/([A-Za-z0-9_-]{6,})'),
    RegExp(r'youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{6,})'),
  ]) {
    final m = p.firstMatch(u);
    if (m != null) return m.group(1);
  }
  return null;
}

/// [UI-MKT-2] A small icon+label stat pill for the detail stats row.
Widget _statPill(IconData icon, String label, {Color? color}) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PhosphorIcon(icon, size: 14, color: color ?? AD.textSecondary),
        const SizedBox(width: 4),
        Text(label, style: ADText.preview(c: AD.textSecondary)),
      ],
    );

/// "posted 3h ago" / "posted 2d ago" from a created_at ms timestamp.
String _postedAgo(int createdMs) {
  final diff = DateTime.now().millisecondsSinceEpoch - createdMs;
  if (diff < 0) return 'just now';
  final mins = diff ~/ 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return '${mins}m ago';
  final hrs = mins ~/ 60;
  if (hrs < 24) return '${hrs}h ago';
  final days = hrs ~/ 24;
  if (days < 30) return '${days}d ago';
  final months = days ~/ 30;
  if (months < 12) return '${months}mo ago';
  return '${days ~/ 365}y ago';
}

/// [MKT1-DETAIL] The shared HERO (§4.2 skeleton step 1): ONE rule, all
/// templates — full-bleed YouTube player when a (server-validated) video is
/// present, else a swipeable photo gallery, else an intent-tinted placeholder.
/// Keeps the favourite heart + page dots + analytics from the old gallery.
class _ListingHero extends StatefulWidget {
  final ListingCard card;
  final List<String> covers;
  final String? videoId;
  final IntentTheme theme;
  const _ListingHero({required this.card, required this.covers, required this.videoId, required this.theme});
  @override
  State<_ListingHero> createState() => _ListingHeroState();
}

class _ListingHeroState extends State<_ListingHero> {
  final _pc = PageController();
  int _page = 0;
  bool _favBusy = false;

  ListingCard get card => widget.card;

  @override
  void dispose() { _pc.dispose(); super.dispose(); }

  Future<void> _toggleFav() async {
    if (_favBusy || card.id.isEmpty) return;
    final next = !card.favorited;
    setState(() { card.favorited = next; _favBusy = true; });
    Analytics.capture(next ? 'listing_favorited' : 'listing_unfavorited', {'listing_id': card.id});
    final ok = next
        ? await ListingsApi.favorite(card.id)
        : await ListingsApi.unfavorite(card.id);
    if (!mounted) return;
    setState(() { if (!ok) card.favorited = !next; _favBusy = false; });
  }

  Widget _heart() => Positioned(
        top: 10, right: 10,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _toggleFav,
          child: Container(
            padding: const EdgeInsets.all(7),
            decoration: BoxDecoration(
              color: const Color(0xF2FFFFFF),
              shape: BoxShape.circle,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: const [],
            ),
            child: Icon(
              card.favorited ? Icons.favorite : Icons.favorite_border,
              size: 20,
              color: card.favorited ? AD.danger : AD.textOnInput,
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final vid = widget.videoId;
    // Video hero — full-bleed inline YouTube (its own 16:9 height).
    if (vid != null) {
      return Stack(children: [
        _YouTubeHero(videoId: vid, url: card.videoUrl ?? ''),
        if (card.id.isNotEmpty) _heart(),
      ]);
    }
    final covers = widget.covers;
    return SizedBox(
      height: 240,
      child: Stack(children: [
        Positioned.fill(
          child: covers.isEmpty
              // Intent-tinted placeholder (no photo, no video).
              ? Container(
                  color: widget.theme.chipBg,
                  child: Center(child: PhosphorIcon(widget.theme.icon, size: 64, color: widget.theme.tint)),
                )
              : PageView(
                  controller: _pc,
                  onPageChanged: (i) => setState(() => _page = i),
                  children: [for (final u in covers) CoverImage(url: u, seed: card.id.hashCode, radius: BorderRadius.zero)],
                ),
        ),
        if (covers.length > 1)
          Positioned(
            bottom: 10, left: 0, right: 0,
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < covers.length; i++)
                AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  width: i == _page ? 18 : 6, height: 6,
                  decoration: BoxDecoration(
                    color: i == _page ? Colors.white : AD.textFaint,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                ),
            ]),
          ),
        if (card.id.isNotEmpty) _heart(),
      ]),
    );
  }
}

/// [MKT1-DETAIL] Full-bleed YouTube hero. Thumbnail + play affordance; tap plays
/// inline (youtube_player_iframe, already a dependency — see chat_media_cards.dart's
/// YouTubeCard). Mitigates the §3.4 embed RISK with `strictRelatedVideos: true`
/// (rel=0 — only same-channel related videos at the end).
/// TODO(M-D5): the package doesn't expose a `youtube-nocookie.com` host toggle on
/// its public params; wire the nocookie origin if/when it lands upstream.
class _YouTubeHero extends StatefulWidget {
  final String videoId;
  final String url;
  const _YouTubeHero({required this.videoId, required this.url});
  @override
  State<_YouTubeHero> createState() => _YouTubeHeroState();
}

class _YouTubeHeroState extends State<_YouTubeHero> {
  YoutubePlayerController? _ctrl;

  @override
  void dispose() {
    _ctrl?.close();
    super.dispose();
  }

  void _play() {
    Analytics.capture('listing_video_play', {'video_id': widget.videoId});
    setState(() {
      _ctrl = YoutubePlayerController.fromVideoId(
        videoId: widget.videoId,
        autoPlay: true,
        params: const YoutubePlayerParams(
          showControls: true,
          showFullscreenButton: true,
          enableCaption: true,
          strictRelatedVideos: true, // rel=0 (§3.4 risk note)
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = _ctrl;
    if (c != null) return YoutubePlayer(controller: c, aspectRatio: 16 / 9);
    return GestureDetector(
      onTap: _play,
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: Stack(fit: StackFit.expand, alignment: Alignment.center, children: [
          Image.network(
            'https://img.youtube.com/vi/${widget.videoId}/hqdefault.jpg',
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => Container(color: AD.card),
          ),
          Container(color: Colors.black.withValues(alpha: 0.12)),
          Container(
            width: 60, height: 60,
            decoration: BoxDecoration(
              color: AD.brandYoutube,
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 2),
              boxShadow: const [],
            ),
            child: const Icon(Icons.play_arrow, color: Colors.white, size: 34),
          ),
        ]),
      ),
    );
  }
}

/// [MKT1-DETAIL] Owner profile block (§4.2 skeleton step 3): avatar, the owner's
/// AvaTOK number, and a QR of the listing deep link. Tapping the row opens the
/// creator channel; tapping the QR opens a share sheet (copy / share the link).
class _OwnerProfileBlock extends StatelessWidget {
  final ListingCard card;
  final double? creatorRating;
  final int creatorRatingCount, followerCount;
  final VoidCallback? onCreatorTap;
  const _OwnerProfileBlock({
    required this.card,
    this.creatorRating,
    this.creatorRatingCount = 0,
    this.followerCount = 0,
    this.onCreatorTap,
  });

  // The client-rendered listing deep link (no server work, §4.2). Universal-link
  // form so a scan opens AvaTOK (Play-Store fallback lives on the web side).
  String get _deepLink => 'https://avatok.ai/l/${card.id}';

  void _openQrSheet(BuildContext context) {
    final number = card.creator.avatokNumber ?? '';
    final name = card.creator.name ?? card.creator.handle ?? 'this listing';
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Share this listing', style: ADText.appTitle(), textAlign: TextAlign.center),
            const SizedBox(height: 16),
            Center(child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AD.inputField,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: QrImageView(data: _deepLink, size: 200, backgroundColor: AD.inputField),
            )),
            if (number.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(number, textAlign: TextAlign.center, style: ADText.rowName(c: AD.textPrimary)),
            ],
            const SizedBox(height: 8),
            Text(_deepLink, textAlign: TextAlign.center, style: ADText.statCaption(c: AD.textTertiary)),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: AdButton(
                label: 'Copy link',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: _deepLink));
                  Analytics.capture('listing_link_copied', {'listing_id': card.id});
                  if (c.mounted) {
                    Navigator.pop(c);
                    ScaffoldMessenger.of(c).showSnackBar(const SnackBar(content: Text('Link copied')));
                  }
                },
              )),
              const SizedBox(width: 12),
              Expanded(child: AdButton(
                label: 'Share',
                fullWidth: true,
                onPressed: () async {
                  Analytics.capture('listing_link_shared', {'listing_id': card.id});
                  await Share.share('$name on AvaTOK — $_deepLink');
                  if (c.mounted) Navigator.pop(c);
                },
              )),
            ]),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final number = card.creator.avatokNumber ?? '';
    final subtitle = [
      if (creatorRating != null && creatorRatingCount > 0) '★ ${creatorRating!.toStringAsFixed(1)} ($creatorRatingCount)',
      if (followerCount > 0) '$followerCount followers',
    ].join(' · ');
    return AdCard(
      padding: const EdgeInsets.all(12),
      radius: AD.rListCard,
      child: Row(children: [
        Expanded(child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onCreatorTap,
          child: Row(children: [
            Avatar(seed: card.creator.uid, name: card.creator.name ?? '?', size: 44, avatarUrl: card.creator.avatarUrl),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(card.creator.name ?? (card.creator.handle ?? 'Creator'),
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName())),
                if (card.creator.kycVerified) ...[
                  const SizedBox(width: 5),
                  PhosphorIcon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill), size: 16, color: AD.iconSearch),
                ],
              ]),
              if (number.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Row(children: [
                    PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 13, color: AD.textSecondary),
                    const SizedBox(width: 5),
                    Text(number, style: ADText.statCaption(c: AD.textSecondary)),
                  ]),
                ),
              if (subtitle.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(subtitle, style: ADText.statCaption(c: AD.textSecondary)),
                ),
            ])),
          ]),
        )),
        const SizedBox(width: 10),
        // QR — client-rendered (qr_flutter is a dependency). Tap → share sheet.
        if (card.id.isNotEmpty)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => _openQrSheet(context),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(
                  color: AD.inputField,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: QrImageView(data: _deepLink, size: 58, backgroundColor: AD.inputField),
              ),
              const SizedBox(height: 3),
              Text('Share', style: ADText.statCaption(c: AD.textTertiary)),
            ]),
          ),
      ]),
    );
  }
}

/// [MKT1-DETAIL] The ONLY part of the skeleton that varies (§4.2 step 4). Reads
/// `attrs` GENERICALLY — the category's field_schema drives what's present, so
/// nothing is hardcoded per category. Each template gets its own heading + verb,
/// per the §4.2 table:
///   sell    → Specifications        rent → Rental details
///   book    → Credentials & booking lead → Services
///   profile → Experience & skills
class _CategoryBlock extends StatelessWidget {
  final ListingCard card;
  final IntentTheme theme;
  const _CategoryBlock({required this.card, required this.theme});

  // Internal / private keys that must NEVER surface to buyers (§3.6b: the
  // mandate and its sub-fields, plus i18n bookkeeping). Excluded, not enumerated
  // to render — the render itself stays generic over whatever else is in attrs.
  static const _hidden = {
    'mandate', 'never_disclose', 'seller_private_rules', 'public_agent_brief',
    'server_enforced_constraints', 'floor_price', 'floor_pct', 'ask_before_commit',
    'orig_lang', 'title_orig', 'desc_orig', 'agent_instructions', 'agent_playbook',
  };

  String get _heading {
    switch (card.detailTemplate) {
      case 'rent':
        return 'Rental details';
      case 'book':
        return 'Credentials & booking';
      case 'lead':
        return 'Services';
      case 'profile':
        return 'Experience & skills';
      case 'sell':
      default:
        return 'Specifications';
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = <MapEntry<String, String>>[];
    card.attrs.forEach((k, v) {
      if (_hidden.contains(k)) return;
      final val = _attrValue(v);
      if (val == null) return;
      rows.add(MapEntry(_humanizeKey(k), val));
    });
    // BOOK listings point at the slot picker that lives behind the CTA.
    final bookHint = card.detailTemplate == 'book';
    if (rows.isEmpty && !bookHint) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        PhosphorIcon(theme.icon, size: 16, color: theme.tint),
        const SizedBox(width: 8),
        Text(_heading, style: ADText.appTitle()),
      ]),
      const SizedBox(height: 12),
      if (rows.isNotEmpty)
        AdCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          radius: AD.rListCard,
          child: Column(children: [
            for (var i = 0; i < rows.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(
                    width: 130,
                    child: Text(rows[i].key, style: ADText.statCaption(c: AD.textSecondary)),
                  ),
                  const SizedBox(width: 10),
                  Expanded(child: Text(rows[i].value, style: ADText.preview(c: AD.textPrimary))),
                ]),
              ),
          ]),
        ),
      if (bookHint) ...[
        if (rows.isNotEmpty) const SizedBox(height: 10),
        Row(children: [
          PhosphorIcon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), size: 15, color: AD.textSecondary),
          const SizedBox(width: 6),
          Expanded(child: Text('Pick an available time when you tap "Book a slot" below.',
              style: ADText.preview(c: AD.textSecondary))),
        ]),
      ],
    ]);
  }
}

/// Humanise an attrs key: `year_built` / `yearBuilt` → "Year Built".
String _humanizeKey(String k) {
  var s = k.replaceAll('_', ' ').replaceAll('-', ' ');
  s = s.replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]} ${m[2]}').trim();
  if (s.isEmpty) return k;
  return s
      .split(RegExp(r'\s+'))
      .map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}')
      .join(' ');
}

/// Render an attrs value for display, or null to skip it (empty / nested object).
String? _attrValue(dynamic v) {
  if (v == null) return null;
  if (v is bool) return v ? 'Yes' : 'No';
  if (v is List) {
    final parts = v.map((e) => e?.toString().trim() ?? '').where((s) => s.isNotEmpty).toList();
    return parts.isEmpty ? null : parts.join(', ');
  }
  if (v is Map) return null; // nested objects aren't a labelled-grid value
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
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
                  style: ADText.rowName())),
              Row(children: List.generate(5, (i) => PhosphorIcon(
                  i < review.rating
                      ? PhosphorIcons.star(PhosphorIconsStyle.fill)
                      : PhosphorIcons.star(PhosphorIconsStyle.bold),
                  size: 13, color: i < review.rating ? AD.iconStar : AD.textTertiary))),
            ]),
            if (review.body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 2),
                  child: Text(review.body, style: ADText.preview(c: AD.textPrimary))),
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
        color: AD.overlaySheet,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 40, height: 5, margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: AD.borderControl, borderRadius: BorderRadius.circular(3)))),
          Text(l.status == 'live' ? 'Join & pay' : 'Confirm booking', style: ADText.appTitle()),
          const SizedBox(height: 4),
          Text(l.title, style: ADText.preview()),
          const SizedBox(height: 14),
          if (_isConsult) ...[
            Row(children: [
              Text('PICK A TIME', style: ADText.sectionLabel()),
              const Spacer(),
              ZinePressable(
                onTap: () async {
                  final d = await showDatePicker(context: context, initialDate: _day,
                      firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 90)));
                  if (d != null) { setState(() => _day = d); _loadSlots(); }
                },
                color: AD.card,
                borderColor: AD.borderControl,
                radius: BorderRadius.circular(100),
                boxShadow: const [],
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), size: 14, color: AD.textPrimary),
                  const SizedBox(width: 6),
                  Text(_ymd, style: ADText.preview(c: AD.textPrimary)),
                ]),
              ),
            ]),
            const SizedBox(height: 10),
            if (_loadingSlots) const Center(child: Padding(padding: EdgeInsets.all(12),
                child: CircularProgressIndicator(color: AD.iconSearch)))
            else if (_slots.isEmpty)
              Padding(padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Text('No availability this day — try another date.', style: ADText.preview()))
            else
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final s in _slots) _slotChip(s),
              ]),
            const SizedBox(height: 14),
          ],
          if (l.effectivePrice > 0) ...[
            AdField(
              controller: _promo,
              hint: 'Promo code (optional)',
              textCapitalization: TextCapitalization.characters,
              leadIcon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            ),
            const SizedBox(height: 12),
          ],
          // Voice translation add-on (only when the creator offers it) — AI accent.
          if (l.translationEnabled) ...[
            AdCard(
              radius: AD.rListCard,
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('🌐 Would you like this to be translated into the language of your choice?',
                        style: ADText.rowName()),
                    const SizedBox(height: 4),
                    Text(
                      'Live voice translation · \$3 per hour'
                      '${l.spokenLang != null ? ' · the creator speaks ${translationLangLabel(l.spokenLang!)}' : ''}',
                      style: ADText.preview(c: AD.textPrimary),
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
          AdCard(
            radius: AD.rListCard,
            padding: const EdgeInsets.all(12),
            child: Column(children: [
              Row(children: [
                PhosphorIcon(PhosphorIcons.wallet(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                const SizedBox(width: 8),
                Text('Wallet: ${_balance == null ? '…' : fmtCoins(_balance!)}',
                    style: ADText.rowName()),
                const Spacer(),
                Text(l.priceLabel, style: ADText.rowName(c: AD.online)),
              ]),
              // Itemized total when translation is on: e.g. $60 + $3 × 1 h = $63.
              if (_translationCoins > 0) ...[
                const Divider(height: 16, color: AD.borderControl, thickness: 1),
                Row(children: [
                  Expanded(child: Text(
                    'Voice translation · $_durationMin min',
                    style: ADText.preview(),
                  )),
                  Text('+ ${fmtCoins(_translationCoins)}', style: ADText.preview(c: AD.textPrimary)),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  Expanded(child: Text('Total (including voice translation)',
                      style: ADText.rowName())),
                  Text(fmtCoins(_totalCoins), style: ADText.rowName(c: AD.online)),
                ]),
              ],
            ]),
          ),
          if (_error != null) AdErrorMsg(_error!),
          const SizedBox(height: 16),
          AdButton(
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
          color: sel ? AD.primaryBadge : (available ? AD.card : AD.headerFooter),
          border: Border.all(color: sel ? AD.primaryBadge : AD.borderControl, width: 1),
          borderRadius: BorderRadius.circular(100),
          boxShadow: const [],
        ),
        child: Text(label, style: ADText.preview(
                c: sel ? Colors.white : (available ? AD.textPrimary : AD.textTertiary))
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
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Rate this session', style: ADText.appTitle()),
          const SizedBox(height: 12),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: List.generate(5, (i) => IconButton(
              onPressed: () => setState(() => _rating = i + 1),
              icon: PhosphorIcon(
                  i < _rating ? PhosphorIcons.star(PhosphorIconsStyle.fill) : PhosphorIcons.star(PhosphorIconsStyle.bold),
                  size: 32, color: i < _rating ? AD.iconStar : AD.textTertiary)))),
          const SizedBox(height: 12),
          AdField(
            controller: _body,
            maxLines: 3,
            hint: 'Share your experience (optional)',
          ),
          if (_error != null) AdErrorMsg(_error!),
          const SizedBox(height: 14),
          AdButton(
            label: 'Send review',
            fullWidth: true,
            loading: _busy,
            onPressed: _busy ? null : _send,
          ),
        ]),
      );
}
