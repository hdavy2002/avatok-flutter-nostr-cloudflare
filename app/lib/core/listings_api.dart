import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'disk_cache.dart';
import '../identity/identity.dart' show AccountScope;
import 'listing_groups.dart' show listingGroupForCategory;

/// [MKT-CACHE-1 2026-09-09] Two-layer cache for marketplace reads so the
/// Marketplace does NOT re-fetch and re-spin every single time it is opened.
///
/// Layer 1 is an IN-MEMORY map, which is the whole point of this change: the
/// old cache was disk-only, so every re-entry still had to await a
/// platform-channel directory lookup + a file read before the FutureBuilder
/// could leave `ConnectionState.waiting` — i.e. a spinner on every visit even
/// on a cache hit. `peek` is synchronous, so a warm screen renders its cards in
/// the FIRST frame with no spinner at all.
///
/// Layer 2 is the existing [DiskCache] file, which survives a process restart
/// and is what makes a cold start show cards instead of a blank grid.
///
/// PER-ACCOUNT SCOPING (CLAUDE.md rule 1): [DiskCache] is already scoped, but
/// the memory map is process-wide, so it is keyed by [AccountScope.id] here.
/// Without that, a parent and child sharing one phone would see each other's
/// marketplace results after an account switch.
class _CacheEntry {
  final List<dynamic> items;
  final DateTime savedAt;
  const _CacheEntry(this.items, this.savedAt);
}

class ListingsCache {
  static final Map<String, _CacheEntry> _mem = <String, _CacheEntry>{};

  static String _memKey(String key) => '${AccountScope.id ?? 'default'}::$key';

  /// Synchronous memory-only read. Returns null when nothing fresh is held —
  /// callers then fall back to [readFresh] (disk) or the network.
  static List<dynamic>? peek(String key, Duration ttl) {
    final e = _mem[_memKey(key)];
    if (e == null) return null;
    if (DateTime.now().difference(e.savedAt) > ttl) return null;
    return e.items;
  }

  static Future<List<dynamic>?> readFresh(String key, Duration ttl) async {
    final warm = peek(key, ttl);
    if (warm != null) return warm;
    try {
      final raw = await DiskCache.read('marketplace_browse_$key');
      if (raw == null) return null;
      final envelope = jsonDecode(raw);
      if (envelope is! Map) return null;
      final savedAt = (envelope['saved_at'] as num?)?.toInt() ?? 0;
      if (savedAt <= 0 ||
          DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(savedAt)) > ttl) {
        return null;
      }
      final items = envelope['items'] as List<dynamic>?;
      if (items == null) return null;
      // Promote the disk hit into memory so the NEXT visit is spinner-free.
      _mem[_memKey(key)] = _CacheEntry(items, DateTime.fromMillisecondsSinceEpoch(savedAt));
      return items;
    } catch (_) { return null; }
  }

  static Future<void> write(String key, List<dynamic> raw) async {
    _mem[_memKey(key)] = _CacheEntry(raw, DateTime.now());
    await DiskCache.write('marketplace_browse_$key', jsonEncode({
      'saved_at': DateTime.now().millisecondsSinceEpoch,
      'items': raw,
    }));
  }

  /// Drop every in-memory entry. Called on sign-out / account switch so a new
  /// account never renders the previous one's cards before its own fetch lands.
  static void clearMemory() => _mem.clear();
}

/// Fee metadata returned by the listing quote endpoint. Pricing remains
/// server-owned; callers must not invent a fallback amount when this is absent.
class ListingFeeQuote {
  final int amount;
  final String source;
  final int? balance;
  final int? freeRemaining;
  /// Server-assigned entitlement period ordinal (1, 2, ...), not a duration.
  final int period;
  final int periodDays;
  final String? entitlementExpiresAt;
  final String? reason;

  const ListingFeeQuote({
    required this.amount,
    required this.source,
    this.balance,
    this.freeRemaining,
    this.period = 1,
    this.periodDays = 30,
    this.entitlementExpiresAt,
    this.reason,
  });

  bool get isFree => amount <= 0 || source == 'free_entitlement';
  bool get insufficient =>
      amount > 0 && balance != null && balance! < amount;

  factory ListingFeeQuote.fromJson(Map<String, dynamic> j) {
    int? intValue(List<String> keys) {
      for (final key in keys) {
        final value = j[key];
        if (value is num) return value.toInt();
        final parsed = int.tryParse('$value');
        if (parsed != null) return parsed;
      }
      return null;
    }

    return ListingFeeQuote(
      amount: intValue(['amount', 'fee_tokens', 'fee', 'price']) ?? 0,
      source: (j['source'] ?? j['funding_source'] ?? 'paid').toString(),
      balance: intValue(['balance', 'paid_balance', 'eligible_balance', 'wallet_balance']),
      freeRemaining: intValue(['free_remaining', 'free_slots_remaining']),
      period: intValue(['period']) ?? 1,
      periodDays: intValue(['period_days']) ?? 30,
      entitlementExpiresAt:
          (j['entitlement_expires_at'] ?? j['expires_at'])?.toString(),
      reason: j['reason']?.toString(),
    );
  }
}

/// Immutable server-issued commercial settlement receipt.
///
/// This is deliberately separate from [ListingCard.joinedCount]. A ticket or
/// booking count is an entitlement metric, not a financial record. Creator
/// earnings are shown only when the commercial receipt endpoint has produced a
/// settled, internally consistent row.
class CommercialReceipt {
  final String receiptId;
  final String sessionId;
  final String orderId;
  final String listingId;
  final String? bookingId, buyerId, creatorId, policySnapshotId;
  final String kind, currency, settlementState;
  final int grossAmount, platformFeeAmount, creatorAmount, connectedMs;
  final DateTime issuedAt;

  const CommercialReceipt({
    required this.receiptId,
    required this.sessionId,
    required this.orderId,
    required this.listingId,
    required this.kind,
    required this.currency,
    required this.settlementState,
    required this.grossAmount,
    required this.platformFeeAmount,
    required this.creatorAmount,
    required this.connectedMs,
    required this.issuedAt,
    this.bookingId,
    this.buyerId,
    this.creatorId,
    this.policySnapshotId,
  });

  static int _int(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse('$value') ?? 0;
  }

  static DateTime _date(dynamic value) {
    if (value is num) {
      final n = value.toInt();
      return DateTime.fromMillisecondsSinceEpoch(
        n < 100000000000 ? n * 1000 : n,
        isUtc: true,
      );
    }
    final parsed = DateTime.tryParse('$value');
    return (parsed ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true)).toUtc();
  }

  factory CommercialReceipt.fromJson(Map<String, dynamic> j) => CommercialReceipt(
        receiptId: (j['receipt_id'] ?? j['id'] ?? '').toString(),
        sessionId: (j['commercial_session_id'] ?? j['session_id'] ?? '').toString(),
        orderId: (j['order_id'] ?? '').toString(),
        listingId: (j['listing_id'] ?? '').toString(),
        bookingId: j['booking_id']?.toString(),
        buyerId: j['buyer_id']?.toString(),
        creatorId: j['creator_id']?.toString(),
        policySnapshotId: j['policy_snapshot_id']?.toString(),
        kind: (j['kind'] ?? '').toString(),
        currency: (j['currency'] ?? 'TOKENS').toString(),
        settlementState: (j['settlement_state'] ?? '').toString(),
        grossAmount: _int(j['gross_amount']),
        platformFeeAmount: _int(j['platform_fee_amount']),
        creatorAmount: _int(j['creator_amount']),
        connectedMs: _int(j['connected_ms']),
        issuedAt: _date(j['issued_at']),
      );

  /// A malformed row must never become a creator payout total.
  bool get isFinanciallyConsistent =>
      receiptId.isNotEmpty &&
      sessionId.isNotEmpty &&
      orderId.isNotEmpty &&
      listingId.isNotEmpty &&
      kind.isNotEmpty &&
      currency.isNotEmpty &&
      grossAmount >= 0 &&
      platformFeeAmount >= 0 &&
      creatorAmount >= 0 &&
      grossAmount == platformFeeAmount + creatorAmount;

  bool get isSettled => settlementState == 'settled';
}

/// Response from `GET /api/commercial/session/:sessionId/receipt`.
class CommercialReceiptResponse {
  final bool ready;
  final String? settlementState;
  final List<CommercialReceipt> receipts;

  const CommercialReceiptResponse({
    required this.ready,
    required this.receipts,
    this.settlementState,
  });

  factory CommercialReceiptResponse.fromJson(Map<String, dynamic> j) {
    final rows = ((j['receipts'] as List?) ?? const [])
        .whereType<Map>()
        .map((r) => CommercialReceipt.fromJson(r.cast<String, dynamic>()))
        .toList();
    final one = j['receipt'];
    if (one is Map) {
      rows.add(CommercialReceipt.fromJson(one.cast<String, dynamic>()));
    }
    return CommercialReceiptResponse(
      ready: j['ready'] == true || rows.isNotEmpty,
      settlementState: j['settlement_state']?.toString(),
      receipts: rows,
    );
  }
}

/// A settlement-only rollup for Creator Studio.
///
/// Totals are kept by currency because converting or combining currencies on
/// the client would invent financial data. The server receipt remains the
/// source of truth for every amount.
class CommercialReceiptSummary {
  final List<CommercialReceipt> settledReceipts;
  final int reviewPendingReceiptCount;
  final int refundedReceiptCount;
  final Map<String, int> grossByCurrency;
  final Map<String, int> platformFeeByCurrency;
  final Map<String, int> creatorAmountByCurrency;

  const CommercialReceiptSummary({
    required this.settledReceipts,
    required this.reviewPendingReceiptCount,
    required this.refundedReceiptCount,
    required this.grossByCurrency,
    required this.platformFeeByCurrency,
    required this.creatorAmountByCurrency,
  });

  factory CommercialReceiptSummary.fromReceipts(Iterable<CommercialReceipt> rows) {
    final settled = <CommercialReceipt>[];
    var reviewPending = 0;
    var refunded = 0;
    final gross = <String, int>{};
    final fees = <String, int>{};
    final creator = <String, int>{};
    for (final row in rows) {
      if (row.settlementState == 'refunded' || row.settlementState == 'partial_refund') {
        refunded++;
        continue;
      }
      if (!row.isSettled || !row.isFinanciallyConsistent) {
        reviewPending++;
        continue;
      }
      settled.add(row);
      gross[row.currency] = (gross[row.currency] ?? 0) + row.grossAmount;
      fees[row.currency] = (fees[row.currency] ?? 0) + row.platformFeeAmount;
      creator[row.currency] = (creator[row.currency] ?? 0) + row.creatorAmount;
    }
    return CommercialReceiptSummary(
      settledReceipts: List.unmodifiable(settled),
      reviewPendingReceiptCount: reviewPending,
      refundedReceiptCount: refunded,
      grossByCurrency: Map.unmodifiable(gross),
      platformFeeByCurrency: Map.unmodifiable(fees),
      creatorAmountByCurrency: Map.unmodifiable(creator),
    );
  }
}

/// ListingsApi (Phase 6) — AvaExplore marketplace + creator listings pipeline.
/// Marketplace reads are public (guest browsing works signed-out); everything
/// else rides the authed contract.
const String _base = 'https://$kSignalingHost/api';

/// Reads a boolean that may arrive as a real bool OR as a 0/1 int/string
/// (some worker read paths select the raw D1 column instead of coercing it).
bool _asBool(dynamic v) => v == true || v == 1 || v == '1';

/// Reads a `List<T>` field that may arrive as a real JSON array OR as a
/// JSON-encoded string (some cached/re-encoded rows ship it that way).
/// Never throws on a malformed value — falls back to null.
List<String>? _asStringList(dynamic v) {
  if (v == null) return null;
  if (v is List) return v.map((e) => e.toString()).toList();
  if (v is String && v.isNotEmpty) {
    try {
      final d = jsonDecode(v);
      if (d is List) return d.map((e) => e.toString()).toList();
    } catch (_) {/* malformed — fall through to null */}
  }
  return null;
}

List<int>? _asIntList(dynamic v) {
  if (v == null) return null;
  if (v is List) return v.map((e) => (e as num).toInt()).toList();
  if (v is String && v.isNotEmpty) {
    try {
      final d = jsonDecode(v);
      if (d is List) return d.map((e) => (e as num).toInt()).toList();
    } catch (_) {/* malformed — fall through to null */}
  }
  return null;
}

class ListingCreator {
  final String uid;
  final String? handle, name, avatarUrl, avatokNumber;
  final bool kycVerified;
  /// [LIST-TRUST-1] Follower count shown on the creator trust ladder.
  final int? followerCount;
  ListingCreator.fromJson(Map<String, dynamic> j)
      : uid = (j['uid'] ?? '').toString(),
        handle = j['handle']?.toString(),
        name = j['name']?.toString(),
        avatarUrl = j['avatar_url']?.toString(),
        avatokNumber = j['avatok_number']?.toString(),
        kycVerified = _asBool(j['kyc_verified']),
        followerCount = (j['follower_count'] as num?)?.toInt();
}

/// [LIST-TRUST-1] One row of `creator_stats`
/// (worker/migrations/2026-09-02-creator-stats.sql), verbatim column names.
/// Filled by a worker cron/on-write refresh — never computed client-side.
class CreatorTrustStats {
  final String creatorId;
  final int showsHosted;
  final double hoursLive;
  final double? onTimePct, cancelRate, comebackPct;
  final int? avgResponseMin;
  final int sessionsDone, soldOutCount;
  final int? firstSessionAt, lastSessionAt;
  final int updatedAt;

  CreatorTrustStats.fromJson(Map<String, dynamic> j)
      : creatorId = (j['creator_id'] ?? '').toString(),
        showsHosted = (j['shows_hosted'] as num?)?.toInt() ?? 0,
        hoursLive = (j['hours_live'] as num?)?.toDouble() ?? 0,
        onTimePct = (j['on_time_pct'] as num?)?.toDouble(),
        cancelRate = (j['cancel_rate'] as num?)?.toDouble(),
        comebackPct = (j['comeback_pct'] as num?)?.toDouble(),
        avgResponseMin = (j['avg_response_min'] as num?)?.toInt(),
        sessionsDone = (j['sessions_done'] as num?)?.toInt() ?? 0,
        soldOutCount = (j['sold_out_count'] as num?)?.toInt() ?? 0,
        firstSessionAt = (j['first_session_at'] as num?)?.toInt(),
        lastSessionAt = (j['last_session_at'] as num?)?.toInt(),
        updatedAt = (j['updated_at'] as num?)?.toInt() ?? 0;
}

/// [LIST-SLOTS-1] A bookable slot row from `listing_slots`
/// (worker/migrations/2026-09-02-listing-slots.sql). The booking grain for
/// `consult`; optional refinement for `live`/`event`.
class ListingSlot {
  final String id, listingId, status;
  final int startsAt, endsAt, capacity, bookedCount;
  final String? label;
  ListingSlot.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        listingId = (j['listing_id'] ?? '').toString(),
        startsAt = (j['starts_at'] as num?)?.toInt() ?? 0,
        endsAt = (j['ends_at'] as num?)?.toInt() ?? 0,
        label = j['label']?.toString(),
        capacity = (j['capacity'] as num?)?.toInt() ?? 0,
        bookedCount = (j['booked_count'] as num?)?.toInt() ?? 0,
        status = (j['status'] ?? 'open').toString();
}

/// [LIST-ASK-1] An "Ask the host" question row from `listing_questions`
/// (worker/migrations/2026-09-02-creator-stats.sql). The answer is shown to
/// the asker only, unless promoted into `content_faq` via `promotedToFaq`.
class ListingQuestion {
  final String id, listingId, question;
  final String? answer;
  final int? answeredAt;
  final int createdAt;
  final bool promotedToFaq;
  ListingQuestion.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        listingId = (j['listing_id'] ?? '').toString(),
        question = (j['question'] ?? '').toString(),
        answer = j['answer']?.toString(),
        answeredAt = (j['answered_at'] as num?)?.toInt(),
        createdAt = (j['created_at'] as num?)?.toInt() ?? 0,
        promotedToFaq = _asBool(j['promoted_to_faq']);
}

class ListingCard {
  final String id, kind, title, oneLiner, category, status;
  final int price, effectivePrice, promoPct, joinedCount, ratingCount;
  final String currency;
  final String? country;
  final bool adultsOnly;
  final List<dynamic> badges;
  final List<dynamic> coverMedia;
  final int? startsAt, durationMin, capacity;
  final double? ratingAvg;
  final ListingCreator creator;
  // Voice translation: creator offers it + their transmission language.
  final bool translationEnabled;
  final String? spokenLang;
  // AvaMarketplace: expiry + type + location.
  final int? expiresAt;
  final String? marketType, location;
  // [UI-MKT-4] wired card stats (all from the extended list endpoint, never dummy):
  // review_count, view_count, created_at (for the <48h "NEW" chip), and the
  // per-user favorited flag. `favorited` is mutable so the heart can optimistically
  // toggle without a re-fetch.
  final int reviewCount, viewCount;
  final int? createdAt;
  bool favorited;
  // [AVA-MKT-CVER-1] The listing's content version — the negotiation reopen key.
  // The server keys talk-once on (buyer_id, listing_id, content_version) and bumps
  // this on a material owner edit (title/description/price/currency/category), so a
  // bump reopens "talk to my agent" for every buyer. Echoed back verbatim on
  // /marketplace/negotiate{,/state} — see listing_detail.dart.
  // Defaults to 0 when absent: this client ships before the migration is applied
  // everywhere, and every existing mkt_negotiations row is at version 0, so 0 is
  // the value that matches what the server already stores.
  final int contentVersion;
  // [MKT1-DETAIL] Category-driven detail contract (Phase 3 buyer surfaces). These come
  // from the listing's CATEGORY (server resolves them in getListing / ships them on the
  // card): the five detail templates in listing_detail.dart key on `detailTemplate`, and
  // the browse cards read `intent` / `priceSemantics` to render the right price shape.
  //   intent          — SELL|RENT|BOOK|LEAD|PROFILE
  //   detailTemplate  — sell|rent|book|lead|profile (PINNED at the listing's cat_version)
  //   priceSemantics  — asking|per_month|from|range|none
  //   attrs           — the category's structured answers, rendered by the template
  //   videoUrl        — optional YouTube link (§2.2)
  //   vertical        — which marketplace this belongs to; a listing never crosses (§2.0)
  // All default safe so a card/detail that arrives from a server shipping this before OR
  // after the client keeps rendering (the two ship independently).
  final String intent, detailTemplate, priceSemantics, vertical;
  final Map<String, dynamic> attrs;
  final String? videoUrl;
  String? description; // only on the details endpoint
  // [LIST-CONTENT-2] booking/schedule + trust/vibe fields
  // (Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.1/§C.2,
  // Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §4). All optional/defaulted
  // so a client shipping before or after the worker adds them keeps rendering.
  final String? slug, blurb, scheduleMode, recurrenceTime, timezone, billingUnit, credential;
  final List<int>? recurrenceDays;
  final List<String>? vibeTags;
  final bool freeEntry;
  final int? maxPerBooking, responseTimeMin, booked24h;
  final CreatorTrustStats? creatorTrustStats;
  // [MKT-3GROUP-1] Which of the three marketplace groups this card belongs to.
  // Server-authoritative; null for marketplace-goods listings, an
  // ai_voice_agents listing (removed from the front page), or an older
  // server that hasn't shipped the column — callers fall back to
  // `listingGroupForCategory(category)` (core/listing_groups.dart) then.
  final String? groupId;
  // [MKT-3GROUP-1] `listings.media_mode`: 'audio_video' | 'audio_only'.
  // Defaults to 'audio_video' to match the server column default; THE FIELD
  // ONLY — wiring it into the GetStream call UI is separate work.
  final String mediaMode;

  ListingCard.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        kind = (j['kind'] ?? 'consult').toString(),
        title = (j['title'] ?? '').toString(),
        oneLiner = (j['one_liner'] ?? '').toString(),
        category = (j['category'] ?? '').toString(),
        status = (j['status'] ?? '').toString(),
        price = (j['price'] as num?)?.toInt() ?? 0,
        effectivePrice = (j['effective_price'] as num?)?.toInt() ?? 0,
        promoPct = (j['promo_pct'] as num?)?.toInt() ?? 0,
        joinedCount = (j['joined_count'] as num?)?.toInt() ?? 0,
        ratingCount = (j['rating_count'] as num?)?.toInt() ?? 0,
        currency = (j['currency_display'] ?? 'INR').toString(),
        country = j['country']?.toString(),
        adultsOnly = j['adults_only'] == true,
        badges = (j['badges'] as List?) ?? const [],
        coverMedia = (j['cover_media'] as List?) ?? const [],
        startsAt = (j['starts_at'] as num?)?.toInt(),
        durationMin = (j['duration_min'] as num?)?.toInt(),
        capacity = (j['capacity'] as num?)?.toInt(),
        ratingAvg = (j['rating_avg'] as num?)?.toDouble(),
        translationEnabled = j['translation_enabled'] == true,
        spokenLang = j['spoken_lang']?.toString(),
        expiresAt = (j['expires_at'] as num?)?.toInt(),
        marketType = j['market_type']?.toString(),
        location = j['location']?.toString(),
        reviewCount = (j['review_count'] as num?)?.toInt() ?? 0,
        viewCount = (j['view_count'] as num?)?.toInt() ?? 0,
        createdAt = (j['created_at'] as num?)?.toInt(),
        favorited = j['favorited'] == true,
        contentVersion = int.tryParse('${j['content_version'] ?? 0}') ?? 0,
        intent = (j['intent'] ?? 'SELL').toString(),
        detailTemplate = (j['detail_template'] ?? 'sell').toString(),
        priceSemantics = (j['price_semantics'] ?? 'asking').toString(),
        vertical = (j['vertical'] ?? 'commerce').toString(),
        attrs = _parseAttrs(j['attrs']),
        videoUrl = j['video_url']?.toString(),
        creator = ListingCreator.fromJson((j['creator'] as Map?)?.cast<String, dynamic>() ?? const {}),
        description = j['description']?.toString(),
        slug = j['slug']?.toString(),
        blurb = j['blurb']?.toString(),
        scheduleMode = j['schedule_mode']?.toString(),
        recurrenceDays = _asIntList(j['recurrence_days']),
        recurrenceTime = j['recurrence_time']?.toString(),
        timezone = j['timezone']?.toString(),
        billingUnit = j['billing_unit']?.toString(),
        freeEntry = _asBool(j['free_entry']),
        maxPerBooking = (j['max_per_booking'] as num?)?.toInt(),
        responseTimeMin = (j['response_time_min'] as num?)?.toInt(),
        vibeTags = _asStringList(j['vibe_tags']),
        credential = j['credential']?.toString(),
        booked24h = (j['booked_24h'] as num?)?.toInt(),
        creatorTrustStats = (j['creator_trust_stats'] is Map)
            ? CreatorTrustStats.fromJson((j['creator_trust_stats'] as Map).cast<String, dynamic>())
            : null,
        groupId = j['group_id']?.toString(),
        mediaMode = (j['media_mode'] ?? 'audio_video').toString();

  /// The group this card belongs to — the server's `group_id` when present,
  /// else the offline mirror keyed off `category`. See [groupId] for why the
  /// server value is preferred.
  String? get resolvedGroupId => groupId ?? listingGroupForCategory(category);

  /// [MKT1-DETAIL] `attrs` arrives as a JSON object (Dart Map) from the server, but be
  /// defensive: tolerate a JSON *string* (some caches / re-encodes ship it that way) and
  /// NEVER throw on a malformed blob — a bad attrs must not break the detail page, so it
  /// falls back to an empty map.
  static Map<String, dynamic> _parseAttrs(dynamic v) {
    if (v is Map) return v.cast<String, dynamic>();
    if (v is String && v.isNotEmpty) {
      try {
        final d = jsonDecode(v);
        if (d is Map) return d.cast<String, dynamic>();
      } catch (_) {/* malformed — fall through to {} */}
    }
    return <String, dynamic>{};
  }

  /// True when this listing was created less than 48h ago (drives the "NEW" chip).
  bool get isNew {
    final c = createdAt;
    if (c == null || c <= 0) return false;
    return DateTime.now().millisecondsSinceEpoch - c < 48 * 3600 * 1000;
  }

  bool get isMarketplace => (marketType ?? '').isNotEmpty || const ['sell', 'buy', 'social'].contains(kind);
  bool get isExpired => expiresAt != null && expiresAt! < DateTime.now().millisecondsSinceEpoch;
  /// Marketplace price shows the listing's own currency in major units
  /// (e.g. "3000 INR"); creator listings keep the USD-cents money() format.
  String get displayPrice => isMarketplace
      ? (price > 0 ? '$price $currency' : (kind == 'buy' ? 'Budget' : 'Free'))
      : priceLabel;

  String? get coverUrl {
    for (final m in coverMedia) {
      final url = (m is Map ? (m['url'] ?? m['r2_key']) : null)?.toString();
      if (url != null && url.startsWith('http')) return url;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // [POSTER-FIRST-1 2026-09-05] The generated poster.
  //
  // The poster carries the title and tagline as painted lettering and nothing
  // else — no price, no duration, no rules — so a card that shows the poster
  // must NOT also print the title underneath it, and every fact still comes
  // from these fields, never from the image.
  //
  // Two wires, same as web: the DETAIL response carries `attrs.poster` (which
  // knows the per-ratio variants), while the LIST responses send no `attrs` at
  // all and the only signal is the `source: "ai_poster"` marker on the
  // cover_media entry the worker prepends. Both must work — the same card
  // widget renders in a grid and on a detail page.
  // ---------------------------------------------------------------------------

  Map<String, dynamic>? get _posterAttrs {
    final p = attrs['poster'];
    if (p is Map) return Map<String, dynamic>.from(p);
    return null;
  }

  /// True only when a poster exists AND is usable. A poster that is still
  /// generating, or that failed, must fall back to the ordinary card rather
  /// than render an empty frame.
  bool get hasAiPoster => posterUrl != null;

  /// The portrait poster — the canonical one, and what a card slot wants.
  String? get posterUrl {
    final p = _posterAttrs;
    if (p != null) {
      final status = (p['status'] ?? '').toString();
      final url = (p['url'] ?? '').toString();
      if (url.startsWith('http') && (status == 'draft' || status == 'approved')) {
        final v = p['variants'];
        if (v is Map && v['portrait'] is Map) {
          final pv = (v['portrait'] as Map)['url']?.toString();
          if (pv != null && pv.startsWith('http')) return pv;
        }
        return url;
      }
      // Mid-flight or failed is a definitive "no poster" — do not fall through
      // to the cover_media guess, which would resurrect a previous attempt.
      if (status == 'generating' || status == 'failed') return null;
    }
    for (final m in coverMedia) {
      if (m is Map && m['source'] == 'ai_poster') {
        final url = (m['url'] ?? m['r2_key'])?.toString();
        if (url != null && url.startsWith('http')) return url;
      }
    }
    return null;
  }

  /// The best poster for a given render width. Falls back to the portrait
  /// whenever the wider variants have not been generated — `posterVariantsEnabled`
  /// is young, and every listing published before it has portrait only.
  String? posterUrlForWidth(double width) {
    final p = _posterAttrs;
    final v = p?['variants'];
    String? pick(String key) {
      if (v is Map && v[key] is Map) {
        final u = (v[key] as Map)['url']?.toString();
        if (u != null && u.startsWith('http')) return u;
      }
      return null;
    }
    if (width >= 1024) return pick('wide') ?? pick('tablet') ?? posterUrl;
    if (width >= 640) return pick('tablet') ?? posterUrl;
    return posterUrl;
  }

  /// "overlay" means the artwork is deliberately textless because the model
  /// could not be trusted to spell the title — the CLIENT draws it instead.
  bool get posterNeedsLettering => (_posterAttrs?['lettering'] ?? '') == 'overlay';

  /// The exact strings the poster was built from. Falls back to the row's own
  /// title/blurb for a poster generated before `copy` was persisted.
  String get posterTitle {
    final c = _posterAttrs?['copy'];
    final t = (c is Map ? c['title'] : null)?.toString();
    return (t != null && t.isNotEmpty) ? t : title;
  }

  String get posterTagline {
    final c = _posterAttrs?['copy'];
    final t = (c is Map ? c['tagline'] : null)?.toString();
    return (t != null && t.isNotEmpty) ? t : (blurb ?? '');
  }

  /// "₹1250" — 1 token = Rs 1.
  String money(int tokens) => tokens == 0 ? 'Free' : '₹$tokens';
  String get priceLabel => money(effectivePrice);

  /// Phase 2 creator-service policy choices live inside the existing bounded
  /// attrs object until checkout freezes them into an immutable server policy
  /// snapshot. Older listings receive conservative display defaults only; the
  /// server must still supply/validate the real checkout policy.
  int get commercialRefundWindowHours =>
      (attrs['commercial_refund_window_hours'] as num?)?.toInt() ?? 24;
  int get commercialCancellationWindowHours =>
      (attrs['commercial_cancellation_window_hours'] as num?)?.toInt() ?? 24;
  bool get commercialRescheduleAllowed =>
      attrs['commercial_reschedule_allowed'] == true;
  int get commercialBookingNoticeHours =>
      (attrs['commercial_booking_notice_hours'] as num?)?.toInt() ?? 2;
  String get commercialPreparationInstructions =>
      (attrs['commercial_preparation_instructions'] ?? '').toString();
  String get commercialNoShowPolicy =>
      (attrs['commercial_no_show_policy'] ?? 'session_charged').toString();
}

class ListingReview {
  final String id, authorId, body;
  final String? authorName, authorAvatar;
  final int rating, createdAt;
  /// [LIST-REVIEW-2] Trust columns from `reviews`
  /// (worker/migrations/2026-09-02-reviews-trust.sql). `verifiedAttendee` is
  /// set server-side from the entitlement at write time — never client-posted.
  final bool verifiedAttendee;
  final String? creatorReply;
  final int? creatorReplyAt;
  final int helpfulCount;
  /// Whether the CURRENT viewer already voted this review helpful.
  final bool viewerMarkedHelpful;
  /// Resolved URLs for `reviews.photo_keys` (<=3 R2 keys).
  final List<String> photoUrls;
  ListingReview.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        authorId = (j['author_id'] ?? '').toString(),
        authorName = j['author_name']?.toString(),
        authorAvatar = j['author_avatar']?.toString(),
        body = (j['body'] ?? '').toString(),
        rating = (j['rating'] as num?)?.toInt() ?? 0,
        createdAt = (j['created_at'] as num?)?.toInt() ?? 0,
        verifiedAttendee = _asBool(j['verified_attendee']),
        creatorReply = (j['creator_reply'] ?? j['reply'])?.toString(),
        creatorReplyAt = (j['creator_reply_at'] as num?)?.toInt() ?? (j['reply_at'] as num?)?.toInt(),
        helpfulCount = (j['helpful_count'] as num?)?.toInt() ?? 0,
        viewerMarkedHelpful = _asBool(j['viewer_marked_helpful']),
        photoUrls = _asStringList(j['photo_urls']) ?? const [];
}

class ListingDetail {
  final ListingCard listing;
  final List<ListingReview> reviews;
  final double? creatorRating;
  final int creatorRatingCount, followerCount;
  final bool following, booked, isOwner;
  ListingDetail.fromJson(Map<String, dynamic> j)
      : listing = ListingCard.fromJson((j['listing'] as Map).cast<String, dynamic>()),
        reviews = ((j['reviews'] as List?) ?? const [])
            .map((r) => ListingReview.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        creatorRating = ((j['creator_stats'] as Map?)?['rating_avg'] as num?)?.toDouble(),
        creatorRatingCount = ((j['creator_stats'] as Map?)?['rating_count'] as num?)?.toInt() ?? 0,
        followerCount = ((j['creator_stats'] as Map?)?['follower_count'] as num?)?.toInt() ?? 0,
        following = (j['viewer'] as Map?)?['following'] == true,
        booked = (j['viewer'] as Map?)?['booked'] == true,
        isOwner = (j['viewer'] as Map?)?['is_owner'] == true;
}

class CreatorChannel {
  final String uid;
  final String? handle, name, avatarUrl, bio, bannerKey, introVideoRef, pinnedListingId;
  final bool kycVerified;
  final double? ratingAvg;
  final int ratingCount, followerCount;
  final List<dynamic> links;
  final Map<String, dynamic> publicFields;
  final List<ListingCard> listings;
  final List<ListingReview> reviews;
  final bool following, notify;
  CreatorChannel.fromJson(Map<String, dynamic> j)
      : uid = ((j['creator'] as Map)['uid'] ?? '').toString(),
        handle = (j['creator'] as Map)['handle']?.toString(),
        name = (j['creator'] as Map)['name']?.toString(),
        avatarUrl = (j['creator'] as Map)['avatar_url']?.toString(),
        bio = (j['creator'] as Map)['bio']?.toString(),
        bannerKey = (j['creator'] as Map)['banner_r2_key']?.toString(),
        introVideoRef = (j['creator'] as Map)['intro_video_ref']?.toString(),
        pinnedListingId = (j['creator'] as Map)['pinned_listing_id']?.toString(),
        kycVerified = (j['creator'] as Map)['kyc_verified'] == true,
        ratingAvg = ((j['creator'] as Map)['rating_avg'] as num?)?.toDouble(),
        ratingCount = ((j['creator'] as Map)['rating_count'] as num?)?.toInt() ?? 0,
        followerCount = ((j['creator'] as Map)['follower_count'] as num?)?.toInt() ?? 0,
        links = ((j['creator'] as Map)['links'] as List?) ?? const [],
        publicFields = (((j['creator'] as Map)['public_fields']) as Map?)?.cast<String, dynamic>() ?? const {},
        listings = ((j['listings'] as List?) ?? const [])
            .map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        reviews = ((j['reviews'] as List?) ?? const [])
            .map((r) => ListingReview.fromJson((r as Map).cast<String, dynamic>()))
            .toList(),
        following = (j['viewer'] as Map?)?['following'] == true,
        notify = (j['viewer'] as Map?)?['notify'] != false;
}

class ExploreCategory {
  final String id, label, emoji;
  /// [MKT-3GROUP-1] Which of the three marketplace groups this category rolls
  /// into ('india_goes_live' | 'find_your_people' | 'book_their_time'). Null
  /// for a marketplace-goods category (cars, property, mobiles, …) or an
  /// older server that hasn't shipped the column yet — callers fall back to
  /// `listingGroupForCategory` (core/listing_groups.dart) in that case.
  final String? groupId;
  ExploreCategory.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        label = (j['label'] ?? '').toString(),
        emoji = (j['emoji'] ?? '').toString(),
        groupId = j['group_id']?.toString();

  /// The server's `group_id` when present, else the offline mirror keyed off
  /// `id`. Null for a marketplace-goods category, which belongs to no group.
  String? get resolvedGroupId => groupId ?? listingGroupForCategory(id);
}

/// A non-throwing, typed result for the native listing wizard contract.
///
/// [ApiAuth] still throws for transport failures and records HTTP failures in
/// its central telemetry path. HTTP error responses are returned here so the
/// wizard can surface the server's `error`, `message`, and `field` without
/// losing the status code (notably 403 identity gates and 503 slot support).
class ListingApiError {
  final int statusCode;
  final String code;
  final String? message;
  final String? field;
  final String? detail;
  final Map<String, dynamic> body;

  const ListingApiError({
    required this.statusCode,
    required this.code,
    this.message,
    this.field,
    this.detail,
    this.body = const <String, dynamic>{},
  });

  factory ListingApiError.fromResponse(int statusCode, String rawBody) {
    Map<String, dynamic> body;
    try {
      final decoded = jsonDecode(rawBody);
      body = decoded is Map
          ? decoded.cast<String, dynamic>()
          : <String, dynamic>{};
    } catch (_) {
      body = <String, dynamic>{};
    }
    final code = (body['code'] ?? body['reason'] ?? body['error'] ?? 'request_failed').toString();
    final message = body['message']?.toString();
    final detail = body['detail']?.toString();
    final field = body['field']?.toString();
    return ListingApiError(
      statusCode: statusCode,
      code: code,
      message: message,
      field: field,
      detail: detail,
      body: body,
    );
  }

  String get userMessage => message ?? detail ?? code;
}

class ListingApiResult<T> {
  final int statusCode;
  final T? data;
  final ListingApiError? error;

  const ListingApiResult({required this.statusCode, this.data, this.error});

  bool get ok => error == null && statusCode >= 200 && statusCode < 300;
}

/// Raw listing payload used by the wizard. Keeping the complete wire object in
/// [json] lets the UI hydrate every current and future attrs field without a
/// lossy client-side schema translation.
class ListingWizardListing {
  final Map<String, dynamic> json;
  final Map<String, dynamic> attrs;

  ListingWizardListing.fromJson(Map<String, dynamic> value)
      : json = Map<String, dynamic>.unmodifiable(value),
        attrs = value['attrs'] is Map
            ? Map<String, dynamic>.unmodifiable(
                (value['attrs'] as Map).cast<String, dynamic>())
            : const <String, dynamic>{};

  String get id => (json['id'] ?? '').toString();
  String get status => (json['status'] ?? '').toString();
  String get kind => (json['kind'] ?? '').toString();
  String get title => (json['title'] ?? '').toString();
  List<dynamic> get coverMedia =>
      json['cover_media'] is List ? List<dynamic>.unmodifiable(json['cover_media'] as List) : const [];
}

class ListingDraftCreated {
  final String listingId;
  const ListingDraftCreated(this.listingId);
}

class ListingWizardConfig {
  final Map<String, dynamic> values;
  const ListingWizardConfig(this.values);

  bool get conferenceEnabled => values['conferenceEnabled'] == true;
}

class ListingPromotion {
  final Map<String, dynamic> json;
  ListingPromotion.fromJson(Map<String, dynamic> value)
      : json = Map<String, dynamic>.unmodifiable(value);
  String get id => (json['id'] ?? '').toString();
  String get kind => (json['kind'] ?? '').toString();
  int get pctOff => (json['pct_off'] as num?)?.toInt() ?? 0;
}

class ListingSlot {
  final Map<String, dynamic> json;
  ListingSlot.fromJson(Map<String, dynamic> value)
      : json = Map<String, dynamic>.unmodifiable(value);
  String get id => (json['id'] ?? '').toString();
  int get startsAt => (json['starts_at'] as num?)?.toInt() ?? 0;
  int get durationMin => (json['duration_min'] as num?)?.toInt() ?? 0;
  String get label => (json['label'] ?? '').toString();
  int get capacity => (json['capacity'] as num?)?.toInt() ?? 0;
}

class ListingReviewIssue {
  final String severity;
  final String? field;
  final String message;
  final String source;

  const ListingReviewIssue({
    required this.severity,
    required this.message,
    required this.source,
    this.field,
  });

  factory ListingReviewIssue.fromJson(Map<String, dynamic> value) => ListingReviewIssue(
        severity: (value['severity'] ?? 'warn').toString(),
        field: value['field']?.toString(),
        message: (value['message'] ?? '').toString(),
        source: (value['source'] ?? 'rules').toString(),
      );
}

class ListingReviewResult {
  final String verdict;
  final String model;
  final List<ListingReviewIssue> issues;

  const ListingReviewResult({required this.verdict, required this.model, required this.issues});

  factory ListingReviewResult.fromJson(Map<String, dynamic> value) => ListingReviewResult(
        verdict: (value['verdict'] ?? 'fail').toString(),
        model: (value['model'] ?? 'unavailable').toString(),
        issues: ((value['issues'] as List?) ?? const [])
            .whereType<Map>()
            .map((row) => ListingReviewIssue.fromJson(row.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

class ListingSubmitResult {
  final String? status;
  const ListingSubmitResult({this.status});
}

class ListingRepeatResult {
  final List<String> listingIds;
  const ListingRepeatResult(this.listingIds);
}

class PublicImageUpload {
  final String url;
  final Map<String, dynamic> json;
  PublicImageUpload.fromJson(Map<String, dynamic> value)
      : url = (value['url'] ?? '').toString(),
        json = Map<String, dynamic>.unmodifiable(value);
}

class ListingsApi {
  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static ListingApiResult<T> _result<T>(
    dynamic response,
    T Function(Map<String, dynamic>) parse,
  ) {
    final status = response.statusCode as int;
    if (status < 200 || status >= 300) {
      return ListingApiResult<T>(
        statusCode: status,
        error: ListingApiError.fromResponse(status, response.body as String),
      );
    }
    final body = _j(response.body as String);
    try {
      return ListingApiResult<T>(statusCode: status, data: parse(body));
    } catch (_) {
      return ListingApiResult<T>(
        statusCode: status,
        error: ListingApiError(
          statusCode: status,
          code: 'invalid_response',
          message: 'The server returned an invalid listing response.',
          body: body,
        ),
      );
    }
  }

  static String _listingPath(String id, [String suffix = '']) =>
      '$_base/listings/${Uri.encodeComponent(id)}$suffix';

  // ── native listing wizard contract ──────────────────────────────────────
  static Future<ListingApiResult<ListingWizardListing>> getWizardListing(String id) async {
    final r = await ApiAuth.getSigned(_listingPath(id));
    return _result(r, (body) {
      final listing = body['listing'];
      if (listing is Map) return ListingWizardListing.fromJson(listing.cast<String, dynamic>());
      return ListingWizardListing.fromJson(body);
    });
  }

  static Future<ListingApiResult<ListingDraftCreated>> createListingDraft({
    required String kind,
    required Map<String, dynamic> fields,
  }) async {
    final r = await ApiAuth.postJson('$_base/listings', {'kind': kind, ...fields});
    return _result(r, (body) {
      final id = body['listing_id']?.toString() ?? '';
      if (id.isEmpty) throw const FormatException('missing listing_id');
      return ListingDraftCreated(id);
    });
  }

  static Future<ListingApiResult<bool>> updateCumulativeDraft(
    String id,
    Map<String, dynamic> fields,
  ) async {
    final r = await ApiAuth.putJson(_listingPath(id), fields);
    return _result(r, (_) => true);
  }

  /// Returns the public categories plus the per-account free-entry gate when
  /// available from `/api/listings/mine`. The category endpoint itself is
  /// public; callers can use [categories] for the legacy list-only API.
  static Future<ListingApiResult<List<ExploreCategory>>> getWizardCategories() async {
    final r = await ApiAuth.getSigned('$_base/explore/categories');
    return _result(r, (body) => ((body['categories'] as List?) ?? const [])
        .whereType<Map>()
        .map((row) => ExploreCategory.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false));
  }

  static Future<ListingApiResult<ListingWizardConfig>> getListingConfig() async {
    final r = await ApiAuth.getSigned('$_base/config');
    return _result(r, (body) {
      final config = body['config'];
      return ListingWizardConfig(
        (config is Map ? config : body).cast<String, dynamic>(),
      );
    });
  }

  static Future<ListingApiResult<ListingPromotion>> createListingPromotion(
    String id, {
    required String kind,
    required int pctOff,
    String? code,
    int? maxUses,
    int? endsAt,
  }) async {
    final r = await ApiAuth.postJson(_listingPath(id, '/promotions'), {
      'kind': kind,
      'pct_off': pctOff,
      if (code != null && code.isNotEmpty) 'code': code,
      if (maxUses != null) 'max_uses': maxUses,
      if (endsAt != null) 'ends_at': endsAt,
    });
    return _result(r, (body) {
      final promotion = body['promotion'];
      final value = (promotion is Map ? promotion : body).cast<String, dynamic>();
      if (value['id'] == null && body['promotion_id'] != null) {
        value['id'] = body['promotion_id'];
      }
      return ListingPromotion.fromJson(value);
    });
  }

  static Future<ListingApiResult<ListingSlot>> addListingSlot(
    String id, {
    required int startsAt,
    required int durationMin,
    required int capacity,
    String? label,
  }) async {
    final r = await ApiAuth.postJson(_listingPath(id, '/slots'), {
      'starts_at': startsAt,
      'duration_min': durationMin,
      'capacity': capacity,
      if (label != null && label.isNotEmpty) 'label': label,
    });
    return _result(r, (body) {
      final slot = body['slot'];
      if (slot is! Map) throw const FormatException('missing slot');
      return ListingSlot.fromJson(slot.cast<String, dynamic>());
    });
  }

  static Future<ListingApiResult<bool>> removeListingSlot(String slotId) async {
    final r = await ApiAuth.deleteSigned(
      '$_base/slots/${Uri.encodeComponent(slotId)}',
    );
    return _result(r, (_) => true);
  }

  static Future<ListingApiResult<ListingReviewResult>> reviewListing(String id) async {
    final r = await ApiAuth.postJson(_listingPath(id, '/review'), {});
    return _result(r, (body) => ListingReviewResult.fromJson(body));
  }

  static Future<ListingApiResult<ListingSubmitResult>> submitListingForReview(String id) async {
    final r = await ApiAuth.postJson(_listingPath(id, '/submit'), {});
    return _result(r, (body) => ListingSubmitResult(status: body['status']?.toString()));
  }

  static Future<ListingApiResult<ListingRepeatResult>> repeatListing(
    String id, {
    required int weeks,
  }) async {
    final r = await ApiAuth.postJson(_listingPath(id, '/repeat'), {'weeks': weeks});
    return _result(r, (body) => ListingRepeatResult(
          ((body['listing_ids'] as List?) ?? const [])
              .map((value) => value.toString())
              .toList(growable: false),
        ));
  }

  static Future<ListingApiResult<PublicImageUpload>> uploadPublicListingImage(
    List<int> bytes, {
    required String contentType,
    String? fileName,
  }) async {
    final r = await ApiAuth.postBytes(
      kUploadPublicUrl,
      bytes,
      extraHeaders: {
        'x-content-type': contentType,
        'x-app': 'avatok',
        if (fileName != null && fileName.isNotEmpty) 'x-file-name': fileName,
      },
      timeout: const Duration(seconds: 60),
    );
    return _result(r, (body) {
      final upload = PublicImageUpload.fromJson(body);
      if (upload.url.isEmpty) throw const FormatException('missing upload url');
      return upload;
    });
  }

  static List<ListingCard> _cards(Map<String, dynamic> j) =>
      ((j['listings'] as List?) ?? const [])
          .map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>()))
          .toList();

  // ── marketplace reads (public) ────────────────────────────────────────────
  /// [MKT-CACHE-1] Category labels change about as often as a D1 migration, so
  /// they hold for 6 hours. `forceFresh` (pull-to-refresh) still bypasses it.
  static const Duration _categoriesTtl = Duration(hours: 6);
  static const String _categoriesKey = 'explore_categories';

  /// Synchronous warm-cache read for the shelf's first frame. Null = nothing in
  /// memory; the caller must await [categories].
  static List<ExploreCategory>? categoriesPeek() =>
      _categoriesFrom(ListingsCache.peek(_categoriesKey, _categoriesTtl));

  static List<ExploreCategory>? _categoriesFrom(List<dynamic>? raw) => raw
      ?.map((c) => ExploreCategory.fromJson((c as Map).cast<String, dynamic>()))
      .toList();

  static Future<List<ExploreCategory>> categories({bool forceFresh = false}) async {
    if (!forceFresh) {
      final cached = _categoriesFrom(
          await ListingsCache.readFresh(_categoriesKey, _categoriesTtl));
      if (cached != null && cached.isNotEmpty) return cached;
    }
    final r = await ApiAuth.getSigned('$_base/explore/categories');
    final list = (_j(r.body)['categories'] as List?) ?? const [];
    if (list.isNotEmpty) await ListingsCache.write(_categoriesKey, list);
    return list
        .map((c) => ExploreCategory.fromJson((c as Map).cast<String, dynamic>()))
        .toList();
  }

  /// [MKT-CACHE-1] Shelf TTL. Short enough that a newly published session shows
  /// up on the next visit, long enough that walking Marketplace → a listing →
  /// back does not re-hit the network three times.
  static const Duration _shelfTtl = Duration(minutes: 5);

  static String _exploreKey({String? kind, String? category, String? country}) =>
      'explore_${kind ?? ''}_${category ?? ''}_${country ?? ''}';

  /// Synchronous warm-cache read — see [categoriesPeek].
  static List<ListingCard>? explorePeek({String? kind, String? category, String? country}) =>
      _cardsFrom(ListingsCache.peek(
          _exploreKey(kind: kind, category: category, country: country), _shelfTtl));

  static List<ListingCard>? _cardsFrom(List<dynamic>? raw) => raw
      ?.map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>()))
      .toList();

  /// [MKT-CACHE-1] `cache: true` opts a call into the two-layer cache. It is
  /// OPT-IN, not the default, because several callers (a creator's own listing
  /// list, post-publish refreshes) must see their own write immediately — a
  /// stale read there looks like the publish silently failed.
  static Future<List<ListingCard>> explore({
    String? kind, String? category, String? country, String? creator,
    bool cache = false, bool forceFresh = false,
  }) async {
    // Never cache a per-creator query — it is the "did my listing appear?" path.
    final cacheable = cache && creator == null;
    final key = _exploreKey(kind: kind, category: category, country: country);
    if (cacheable && !forceFresh) {
      final cached = _cardsFrom(await ListingsCache.readFresh(key, _shelfTtl));
      if (cached != null) return cached;
    }
    final q = <String>[
      if (kind != null) 'kind=$kind',
      if (category != null && category.isNotEmpty) 'category=$category',
      if (country != null) 'country=$country',
      if (creator != null) 'creator=$creator',
      'limit=40',
    ].join('&');
    final r = await ApiAuth.getSigned('$_base/explore?$q');
    final list = (_j(r.body)['listings'] as List?) ?? const [];
    if (cacheable) await ListingsCache.write(key, list);
    return list.map((x) => ListingCard.fromJson((x as Map).cast<String, dynamic>())).toList();
  }

  /// AvaMarketplace browse — buy/sell/social only. Country-filtered by default
  /// (the user's detected country); pass country='' for all countries. A query
  /// routes through search (FTS/AI), filtered to marketplace listings.
  static const Duration _marketTtl = Duration(minutes: 10);

  static String _marketKey({String? country, String? category}) =>
      'market_${country ?? ''}_${category ?? ''}';

  /// Synchronous warm-cache read for the grid's first frame — see
  /// [categoriesPeek]. Only valid for the unsearched grid; a query is never
  /// cached.
  static List<ListingCard>? marketBrowsePeek({String? country, String? category}) =>
      _cardsFrom(ListingsCache.peek(
          _marketKey(country: country, category: category), _marketTtl));

  static Future<List<ListingCard>> marketBrowse({String? country, String? category, String? q, bool forceFresh = false}) async {
    if (q != null && q.trim().isNotEmpty) {
      // Search is never cached (results depend on the live query).
      final params = <String>[
        'q=${Uri.encodeQueryComponent(q.trim())}', 'limit=40',
        if (country != null && country.isNotEmpty) 'country=$country',
        if (category != null && category.isNotEmpty) 'category=${Uri.encodeQueryComponent(category)}',
      ].join('&');
      final r = await ApiAuth.getSigned('$_base/marketplace/search?$params');
      return _cards(_j(r.body));
    }
    final params = <String>[
      'market=1', 'limit=40',
      if (country != null && country.isNotEmpty) 'country=$country',
      if (category != null && category.isNotEmpty) 'category=${Uri.encodeQueryComponent(category)}',
    ].join('&');
    final cacheKey = _marketKey(country: country, category: category);
    // Stale-while-revalidate: serve a fresh-enough cache instantly unless the
    // caller forced a refresh (pull-to-refresh).
    if (!forceFresh) {
      final cached = await ListingsCache.readFresh(cacheKey, _marketTtl);
      if (cached != null) {
        return cached.map((r) => ListingCard.fromJson((r as Map).cast<String, dynamic>())).toList();
      }
    }
    final r = await ApiAuth.getSigned('$_base/explore?$params');
    final list = (_j(r.body)['listings'] as List?) ?? const [];
    await ListingsCache.write(cacheKey, list);
    return list.map((x) => ListingCard.fromJson((x as Map).cast<String, dynamic>())).toList();
  }

  /// Best-effort fee quote for the review screen. A missing quote is an
  /// unavailable pricing state, never permission to invent a client price.
  static Future<ListingFeeQuote?> feeQuote({String? listingId}) async {
    try {
      final suffix = listingId == null || listingId.isEmpty
          ? ''
          : '?listing_id=${Uri.encodeQueryComponent(listingId)}';
      final r = await ApiAuth.getSigned('$_base/marketplace/listing-quote$suffix');
      if (r.statusCode != 200) return null;
      final root = _j(r.body);
      final quote = root['quote'];
      return ListingFeeQuote.fromJson(
          (quote is Map ? quote : root).cast<String, dynamic>());
    } catch (_) {
      return null;
    }
  }

  static const String _liveNowKey = 'explore_live_now';

  /// Synchronous warm-cache read — see [categoriesPeek].
  static List<ListingCard>? liveNowPeek() =>
      _cardsFrom(ListingsCache.peek(_liveNowKey, _liveNowTtl));

  /// A shorter TTL than the rest of the shelf: "live now" is the one row where
  /// a 5-minute-old answer is actively wrong.
  static const Duration _liveNowTtl = Duration(minutes: 2);

  static Future<List<ListingCard>> liveNow({bool cache = false, bool forceFresh = false}) async {
    if (cache && !forceFresh) {
      final cached = _cardsFrom(await ListingsCache.readFresh(_liveNowKey, _liveNowTtl));
      if (cached != null) return cached;
    }
    final r = await ApiAuth.getSigned('$_base/explore/live-now');
    final list = (_j(r.body)['listings'] as List?) ?? const [];
    if (cache) await ListingsCache.write(_liveNowKey, list);
    return list.map((x) => ListingCard.fromJson((x as Map).cast<String, dynamic>())).toList();
  }

  static Future<List<ListingCard>> search({
    required String q, String? kind, String? category, String? country,
    int? minPrice, int? maxPrice, int? from, int? to, double? minRating,
    String sort = 'soonest',
  }) async {
    final params = <String>[
      'q=${Uri.encodeQueryComponent(q)}', 'sort=$sort', 'limit=40',
      if (kind != null) 'kind=$kind',
      if (category != null && category.isNotEmpty) 'category=$category',
      if (country != null && country.isNotEmpty) 'country=$country',
      if (minPrice != null) 'minPrice=$minPrice',
      if (maxPrice != null) 'maxPrice=$maxPrice',
      if (from != null) 'from=$from',
      if (to != null) 'to=$to',
      if (minRating != null) 'minRating=$minRating',
    ].join('&');
    final r = await ApiAuth.getSigned('$_base/explore/search?$params');
    return _cards(_j(r.body));
  }

  static Future<ListingDetail?> detail(String id) async {
    final r = await ApiAuth.getSigned('$_base/listings/$id');
    if (r.statusCode != 200) return null;
    return ListingDetail.fromJson(_j(r.body));
  }

  static Future<CreatorChannel?> creator(String uid) async {
    final r = await ApiAuth.getSigned('$_base/creators/$uid');
    if (r.statusCode != 200) return null;
    return CreatorChannel.fromJson(_j(r.body));
  }

  // ── [UI-MKT-3] favorites (marketplace hearts, per-account scoped server-side) ──
  /// Heart a listing. Returns true on success (idempotent server-side).
  static Future<bool> favorite(String listingId) async =>
      (await ApiAuth.postJson('$_base/marketplace/favorites', {'listing_id': listingId})).statusCode == 200;

  /// Un-heart a listing (listing_id rides the query so the signed DELETE stays body-less).
  static Future<bool> unfavorite(String listingId) async =>
      (await ApiAuth.deleteSigned('$_base/marketplace/favorites?listing_id=${Uri.encodeQueryComponent(listingId)}')).statusCode == 200;

  /// The user's favorited listings (full cards, newest-saved first).
  static Future<List<ListingCard>> favorites() async {
    final r = await ApiAuth.getSigned('$_base/marketplace/favorites');
    return _cards(_j(r.body));
  }

  // ── creator insights (owner-gated dashboards) ─────────────────────────────
  /// Cross-listing rollup: views by day/country/age group, bookings, revenue.
  static Future<Map<String, dynamic>?> creatorStats() async {
    final r = await ApiAuth.getSigned('$_base/creators/me/stats');
    return r.statusCode == 200 ? _j(r.body) : null;
  }

  /// Per-listing dashboard (views, audience, conversion).
  static Future<Map<String, dynamic>?> listingStats(String id) async {
    final r = await ApiAuth.getSigned('$_base/listings/$id/stats');
    return r.statusCode == 200 ? _j(r.body) : null;
  }

  /// The commercial route is intentionally session-scoped: it returns only
  /// immutable receipts visible to the authenticated creator or customer.
  /// A 202 means settlement is not ready yet and is still a valid response.
  static Future<CommercialReceiptResponse?> commercialReceipt(String sessionId) async {
    if (sessionId.isEmpty) return null;
    final encoded = Uri.encodeComponent(sessionId);
    final r = await ApiAuth.getSigned('$_base/commercial/session/$encoded/receipt');
    if (r.statusCode != 200 && r.statusCode != 202) return null;
    return CommercialReceiptResponse.fromJson(_j(r.body));
  }

  /// Session IDs are server-defined and deterministic for the current live
  /// session contract. This helper does not grant admission or expose a token.
  static String liveCommercialSessionId(String listingId, {int sessionVersion = 1}) =>
      'live_${listingId}_$sessionVersion';

  static String consultCommercialSessionId(String bookingId) => 'consult_$bookingId';

  /// Calendar bookings carry the consult booking id used by the commercial
  /// session contract. This discovers only the creator's own booking ids; it
  /// does not infer any money from booking price or count.
  static Future<List<String>> commercialConsultSessionIds(String listingId) async {
    final ids = <String>{};
    // Current/upcoming bookings precede history. Session actions now use the
    // creator schedule projection; this helper remains receipt-summary only.
    for (final when in const ['upcoming', 'past']) {
      dynamic r;
      try {
        r = await ApiAuth.getSigned('$_base/booking/list?role=creator&when=$when');
      } catch (_) {
        continue;
      }
      if (r.statusCode != 200) continue;
      final rows = ((_j(r.body)['bookings'] as List?) ?? const [])
          .whereType<Map>()
          .map((row) => row.cast<String, dynamic>());
      for (final row in rows) {
        if (row['listing_id']?.toString() == listingId && row['id'] != null) {
          ids.add(consultCommercialSessionId(row['id'].toString()));
        }
      }
    }
    return ids.toList();
  }

  // ── creator pipeline ──────────────────────────────────────────────────────
  static Future<String?> createDraft(String kind, Map<String, dynamic> fields) async {
    final r = await ApiAuth.postJson('$_base/listings', {'kind': kind, ...fields});
    final j = _j(r.body);
    return r.statusCode == 200 ? j['listing_id']?.toString() : null;
  }

  /// Native eight-step wizard contract. These methods intentionally return the
  /// server JSON so the Flutter wizard can surface field-level errors without
  /// recreating worker validation rules locally.
  static Future<Map<String, dynamic>> wizardGet(String id) async {
    final r = await ApiAuth.getSigned('$_base/listings/${Uri.encodeComponent(id)}');
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardCreate(String kind, Map<String, dynamic> body) async {
    final r = await ApiAuth.postJson('$_base/listings', {'kind': kind, ...body});
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardUpdate(String id, Map<String, dynamic> body) async {
    final r = await ApiAuth.putJson('$_base/listings/${Uri.encodeComponent(id)}', body);
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardReview(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/${Uri.encodeComponent(id)}/review', {});
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardSubmit(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/${Uri.encodeComponent(id)}/submit', {});
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardRepeat(String id, int weeks) async {
    final r = await ApiAuth.postJson('$_base/listings/${Uri.encodeComponent(id)}/repeat', {'weeks': weeks});
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardAddSlot(String id, Map<String, dynamic> slot) async {
    final r = await ApiAuth.postJson('$_base/listings/${Uri.encodeComponent(id)}/slots', slot);
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardRemoveSlot(String slotId) async {
    final r = await ApiAuth.deleteSigned('$_base/slots/${Uri.encodeComponent(slotId)}');
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<Map<String, dynamic>> wizardUpload(List<int> bytes, {required String mime, String? fileName}) async {
    final r = await ApiAuth.postBytes('https://$kSignalingHost/upload/public', bytes,
        extraHeaders: {'x-content-type': mime, if (fileName != null) 'x-file-name': fileName, 'x-app': 'avatok'});
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode >= 200 && r.statusCode < 300};
  }

  static Future<bool> update(String id, Map<String, dynamic> fields) async =>
      (await ApiAuth.putJson('$_base/listings/$id', fields)).statusCode == 200;

  /// Returns fee/status metadata on success, or {error, conflictWith?/reason?}
  /// on failure.
  static Future<Map<String, dynamic>> publish(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/publish', {});
    final j = _j(r.body);
    return {...j, 'status': r.statusCode, 'ok': r.statusCode == 200};
  }

  static Future<Map<String, dynamic>> setStatus(String id, String status) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/status', {'status': status});
    return {..._j(r.body), 'ok': r.statusCode == 200};
  }

  static Future<String?> duplicate(String id) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/duplicate', {});
    return r.statusCode == 200 ? _j(r.body)['listing_id']?.toString() : null;
  }

  static Future<bool> cancel(String id, {bool permanent = false}) async =>
      (await ApiAuth.deleteSigned('$_base/listings/$id${permanent ? '?permanent=true' : ''}')).statusCode == 200;

  static Future<List<ListingCard>> mine() async {
    final r = await ApiAuth.getSigned('$_base/listings/mine');
    return _cards(_j(r.body));
  }

  static Future<bool> addPromotion(String id, {required String kind, required int pctOff, String? code, int? maxUses, int? endsAt}) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/promotions', {
      'kind': kind, 'pct_off': pctOff,
      if (code != null) 'code': code,
      if (maxUses != null) 'max_uses': maxUses,
      if (endsAt != null) 'ends_at': endsAt,
    });
    return r.statusCode == 200;
  }

  // ── booking / reviews / social ────────────────────────────────────────────
  /// Returns the response json + 'status' (402 → insufficient_funds w/ `needed`).
  static Future<Map<String, dynamic>> book(String id, {int? slotStart, int? slotEnd, String? promoCode, String? translationLang}) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/book', {
      if (slotStart != null) 'slot': {'start_at': slotStart, if (slotEnd != null) 'end_at': slotEnd},
      if (promoCode != null && promoCode.isNotEmpty) 'promo_code': promoCode,
      // "Would you like this to be translated…?" — $3/h prepay, refunds unused.
      if (translationLang != null && translationLang.isNotEmpty) 'translation': {'lang': translationLang},
    }, timeout: const Duration(seconds: 20));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<bool> review(String id, int rating, String? body) async {
    final r = await ApiAuth.postJson('$_base/listings/$id/reviews', {'rating': rating, if (body != null && body.isNotEmpty) 'body': body});
    return r.statusCode == 200;
  }

  static Future<bool> follow(String uid, {bool? notify}) async =>
      (await ApiAuth.postJson('$_base/creators/$uid/follow', {if (notify != null) 'notify': notify})).statusCode == 200;

  static Future<bool> unfollow(String uid) async =>
      (await ApiAuth.deleteSigned('$_base/creators/$uid/follow')).statusCode == 200;

  static Future<bool> blockCreator(String uid) async =>
      (await ApiAuth.postJson('$_base/creators/$uid/block', {})).statusCode == 200;

  static Future<bool> report(String targetType, String targetId, String reason) async =>
      (await ApiAuth.postJson('$_base/report', {'targetType': targetType, 'targetId': targetId, 'reason': reason})).statusCode == 200;

  static Future<bool> updateChannel(Map<String, dynamic> fields) async =>
      (await ApiAuth.putJson('$_base/creators/me', fields)).statusCode == 200;

  /// Consult slot grid for a day — occupied slots come back flagged (greyed UX).
  static Future<List<Map<String, dynamic>>> slotGrid(String creatorUid, String dateYmd, int durMin) async {
    final r = await ApiAuth.getSigned('https://$kSignalingHost/api/calendar/slots?creator=$creatorUid&date=$dateYmd&dur=$durMin');
    return (((_j(r.body)['slots']) as List?) ?? const []).map((s) => (s as Map).cast<String, dynamic>()).toList();
  }
}
