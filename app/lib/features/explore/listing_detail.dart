import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/money_api.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
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
    showModalBottomSheet(context: context, builder: (c) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(leading: const Icon(Icons.flag_outlined), title: const Text('Report listing'), onTap: () async {
        Navigator.pop(c);
        final ok = await ListingsApi.report('listing', d.listing.id, 'inappropriate');
        if (mounted && ok) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Report submitted — thank you')));
      }),
      ListTile(leading: const Icon(Icons.block, color: AvaColors.danger), title: const Text('Block this creator'), onTap: () async {
        Navigator.pop(c);
        final ok = await ListingsApi.blockCreator(d.listing.creator.uid);
        if (mounted && ok) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Creator blocked'))); Navigator.pop(context); }
      }),
    ])));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Listing'),
        actions: [IconButton(icon: const Icon(Icons.more_vert), onPressed: _overflow)],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : d == null
              ? const Center(child: Text('Listing not found'))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListingDetailView(
                    card: d.listing, reviews: d.reviews,
                    creatorRating: d.creatorRating, creatorRatingCount: d.creatorRatingCount,
                    followerCount: d.followerCount, canReview: d.booked && !d.isOwner,
                    onReview: _review,
                    onCreatorTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => CreatorChannelScreen(creatorUid: d.listing.creator.uid))),
                  ),
                ),
      bottomNavigationBar: d == null || d.isOwner ? null : SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Row(children: [
            OutlinedButton(
              style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 15, horizontal: 14)),
              onPressed: _message,
              child: const Icon(Icons.chat_bubble_outline, size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(child: FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: d.listing.status == 'live' ? AvaColors.coral : AvaColors.brand,
              padding: const EdgeInsets.symmetric(vertical: 15),
            ),
            onPressed: _book,
            child: Text(
              d.listing.status == 'live'
                  ? 'Join now · ${d.listing.priceLabel}'
                  : d.listing.kind == 'live_event'
                      ? 'Book · ${d.listing.priceLabel}'
                      : 'Book a session · ${d.listing.priceLabel}',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
            ),
          )),
          ]),
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
      // media carousel
      SizedBox(
        height: 230,
        child: covers.isEmpty
            ? CoverImage(url: null, seed: card.id.hashCode, radius: BorderRadius.zero)
            : PageView(children: [
                for (final u in covers) CoverImage(url: u, seed: card.id.hashCode, radius: BorderRadius.zero),
              ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text(card.title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
            const SizedBox(width: 10),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              if (card.promoPct > 0)
                Text(fmtCoins(card.price), style: const TextStyle(color: AvaColors.sub, decoration: TextDecoration.lineThrough, fontSize: 13)),
              Text(card.priceLabel, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800,
                  color: card.effectivePrice == 0 ? AvaColors.brand : AvaColors.ink)),
            ]),
          ]),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 6, children: [
            _chip(card.kind == 'live_event' ? '🎥 Live event' : '🗓 ${card.capacity == 1 ? '1:1 session' : 'Group session (${card.capacity})'}'),
            if (card.startsAt != null) _chip('🕐 ${fmtWhen(card.startsAt)}'),
            if (card.durationMin != null) _chip('${card.durationMin} min'),
            if (card.country != null) _chip('${flagEmoji(card.country)} ${card.country}'),
            if (card.adultsOnly) _chip('18+'),
            if (card.translationEnabled)
              _chip('🌐 Voice translation available${card.spokenLang != null ? ' · speaks ${translationLangLabel(card.spokenLang!)}' : ''}'),
            for (final b in card.badges) _chip(b.toString()),
            _chip(card.category),
          ]),
          if (card.joinedCount > 0) ...[
            const SizedBox(height: 8),
            Text('🔥 ${card.joinedCount} joined', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: AvaColors.sub)),
          ],
          const SizedBox(height: 14),
          if ((card.description ?? '').isNotEmpty) ...[
            Text(card.description!, style: const TextStyle(fontSize: 14.5, height: 1.45)),
            const SizedBox(height: 18),
          ],
          // creator mini-card → channel
          GestureDetector(
            onTap: onCreatorTap,
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
              child: Row(children: [
                Avatar(seed: card.creator.uid, name: card.creator.name ?? '?', size: 44,
                    avatarUrl: card.creator.avatarUrl),
                const SizedBox(width: 10),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text(card.creator.name ?? (card.creator.handle ?? 'Creator'),
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w700))),
                    if (card.creator.kycVerified) ...[
                      const SizedBox(width: 4),
                      const Icon(Icons.verified, size: 15, color: AvaColors.brand),
                    ],
                  ]),
                  Text(
                    [
                      if (creatorRating != null && creatorRatingCount > 0) '★ ${creatorRating!.toStringAsFixed(1)} ($creatorRatingCount)',
                      if (followerCount > 0) '$followerCount followers',
                    ].join(' · '),
                    style: const TextStyle(color: AvaColors.sub, fontSize: 12),
                  ),
                ])),
                const Icon(Icons.chevron_right, color: AvaColors.sub),
              ]),
            ),
          ),
          const SizedBox(height: 20),
          Row(children: [
            Text('Reviews', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(width: 8),
            RatingStars(rating: card.ratingAvg, count: card.ratingCount, size: 15),
            const Spacer(),
            if (canReview) TextButton(onPressed: onReview, child: const Text('Leave a review')),
          ]),
          if (reviews.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('No reviews yet.', style: TextStyle(color: AvaColors.sub))),
          for (final r in reviews) ReviewTile(review: r),
        ]),
      ),
    ]);
  }

  Widget _chip(String t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(10)),
        child: Text(t, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
      );
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
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13))),
              Row(children: List.generate(5, (i) => Icon(
                  i < review.rating ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: 14, color: const Color(0xFFFFB400)))),
            ]),
            if (review.body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 2),
                  child: Text(review.body, style: const TextStyle(fontSize: 13, height: 1.35))),
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

  /// $3/h = 5 AvaCoins/min for the booked duration.
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
        setState(() => _error = 'Not enough AvaCoins (need ${fmtCoins(needed)}, have ${fmtCoins(bal)}) — top-up is currently unavailable.');
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
      decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 36, height: 4, margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: AvaColors.line, borderRadius: BorderRadius.circular(2)))),
          Text(l.status == 'live' ? 'Join & pay' : 'Confirm booking',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text(l.title, style: const TextStyle(color: AvaColors.sub)),
          const SizedBox(height: 14),
          if (_isConsult) ...[
            Row(children: [
              const Text('Pick a time', style: TextStyle(fontWeight: FontWeight.w700)),
              const Spacer(),
              TextButton.icon(
                icon: const Icon(Icons.calendar_today, size: 16),
                label: Text(_ymd),
                onPressed: () async {
                  final d = await showDatePicker(context: context, initialDate: _day,
                      firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 90)));
                  if (d != null) { setState(() => _day = d); _loadSlots(); }
                },
              ),
            ]),
            if (_loadingSlots) const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator()))
            else if (_slots.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 10),
                  child: Text('No availability this day — try another date.', style: TextStyle(color: AvaColors.sub)))
            else
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final s in _slots) _slotChip(s),
              ]),
            const SizedBox(height: 14),
          ],
          if (l.effectivePrice > 0) ...[
            TextField(
              controller: _promo,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                hintText: 'Promo code (optional)', isDense: true,
                prefixIcon: const Icon(Icons.local_offer_outlined, size: 18),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
            const SizedBox(height: 12),
          ],
          // Voice translation add-on (only when the creator offers it).
          if (l.translationEnabled) ...[
            Container(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              decoration: BoxDecoration(
                color: AvaColors.soft, borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _translate ? AvaColors.brand : Colors.transparent),
              ),
              child: Column(children: [
                SwitchListTile(
                  contentPadding: EdgeInsets.zero, dense: true,
                  value: _translate,
                  onChanged: (v) => setState(() => _translate = v),
                  title: const Text('🌐 Would you like this to be translated into the language of your choice?',
                      style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    'Live voice translation · \$3 per hour'
                    '${l.spokenLang != null ? ' · the creator speaks ${translationLangLabel(l.spokenLang!)}' : ''}',
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
                if (_translate)
                  DropdownButtonFormField<String>(
                    value: _translateLang,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Select language', isDense: true),
                    items: [
                      for (final lng in kTranslationLangs)
                        DropdownMenuItem(value: lng.code, child: Text(lng.label)),
                    ],
                    onChanged: (v) => setState(() => _translateLang = v),
                  ),
                if (_translate) const SizedBox(height: 10),
              ]),
            ),
            const SizedBox(height: 12),
          ],
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(12)),
            child: Column(children: [
              Row(children: [
                const Icon(Icons.account_balance_wallet_outlined, size: 18),
                const SizedBox(width: 8),
                Text('Wallet: ${_balance == null ? '…' : fmtCoins(_balance!)}'),
                const Spacer(),
                Text(l.priceLabel, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
              ]),
              // Itemized total when translation is on: e.g. $60 + $3 × 1 h = $63.
              if (_translationCoins > 0) ...[
                const Divider(height: 16),
                Row(children: [
                  Expanded(child: Text(
                    'Voice translation · $_durationMin min',
                    style: const TextStyle(fontSize: 12.5, color: AvaColors.sub),
                  )),
                  Text('+ ${fmtCoins(_translationCoins)}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  const Expanded(child: Text('Total (including voice translation)',
                      style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5))),
                  Text(fmtCoins(_totalCoins), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                ]),
              ],
            ]),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 13)),
          ],
          const SizedBox(height: 14),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _busy ? null : _confirm,
            child: _busy
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : Text(
                    _totalCoins == 0
                        ? 'Confirm (free)'
                        : 'Pay ${l.money(_totalCoins)} & confirm',
                    style: const TextStyle(fontWeight: FontWeight.w800)),
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
          color: sel ? AvaColors.ink : (available ? Colors.white : AvaColors.soft),
          border: Border.all(color: sel ? AvaColors.ink : AvaColors.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(label, style: TextStyle(
            fontWeight: FontWeight.w700, fontSize: 13,
            color: sel ? Colors.white : (available ? AvaColors.ink : AvaColors.sub),
            decoration: available ? null : TextDecoration.lineThrough)),
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
        decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom + MediaQuery.of(context).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Rate this session', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 12),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: List.generate(5, (i) => IconButton(
              onPressed: () => setState(() => _rating = i + 1),
              icon: Icon(i < _rating ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: 34, color: const Color(0xFFFFB400))))),
          TextField(
            controller: _body, maxLines: 3,
            decoration: InputDecoration(hintText: 'Share your experience (optional)',
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12))),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 13))),
          const SizedBox(height: 12),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 13)),
            onPressed: _busy ? null : _send,
            child: const Text('Submit review', style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ]),
      );
}
