import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// AvaAffiliate client — Spec: Specs/proposals/PROPOSAL-AVA-AFFILIATE.md.
/// Money rule: affiliate earns floor(gross × 10%) of every payment a referred
/// user ever makes on the promoted listing, paid out of the platform share at
/// settlement. All endpoints live under /api/affiliate (worker/src/routes/
/// affiliate.ts, built in parallel — every parser tolerates missing fields).
const String kAffiliateBase = '$kApiBase/affiliate';

/// Public short-link base: https://avatok.ai/a/<link_id>.
const String kAffiliateLinkBase = 'https://avatok.ai/a/';

/// The headline rate, used ONLY for the "estimated commission per sale"
/// preview in the Product Picker. The authoritative rate lives server-side in
/// `commission_rates` (service='affiliate_default').
const double kAffiliateRate = 0.10;

/// Coins are USD cents. "$12.34" / "Free".
String affCoinsLabel(int coins) => coins == 0
    ? 'Free'
    : '\$${(coins / 100).toStringAsFixed(coins % 100 == 0 ? 0 : 2)}';

int estimatedCommissionPerSale(int priceCoins) => (priceCoins * kAffiliateRate).floor();

int _i(dynamic v) => (v as num?)?.toInt() ?? 0;
String _s(dynamic v, [String dflt = '']) => v?.toString() ?? dflt;

class AffiliateProfile {
  final String uid, code, status;
  final int createdAt;
  AffiliateProfile.fromJson(Map<String, dynamic> j)
      : uid = _s(j['uid']),
        code = _s(j['code']),
        status = _s(j['status'], 'active'),
        createdAt = _i(j['created_at']);
  Map<String, dynamic> toJson() =>
      {'uid': uid, 'code': code, 'status': status, 'created_at': createdAt};
}

class AffiliateTotals {
  final int lifetimeCoins, monthCoins, heldCoins, referredUsers;
  const AffiliateTotals.zero()
      : lifetimeCoins = 0, monthCoins = 0, heldCoins = 0, referredUsers = 0;
  AffiliateTotals.fromJson(Map<String, dynamic> j)
      : lifetimeCoins = _i(j['lifetime_coins']),
        monthCoins = _i(j['month_coins']),
        heldCoins = _i(j['held_coins']),
        referredUsers = _i(j['referred_users']);
  Map<String, dynamic> toJson() => {
        'lifetime_coins': lifetimeCoins,
        'month_coins': monthCoins,
        'held_coins': heldCoins,
        'referred_users': referredUsers,
      };
  /// Withdrawable now = lifetime minus the refund-window hold (never negative).
  int get availableCoins =>
      (lifetimeCoins - heldCoins) < 0 ? 0 : lifetimeCoins - heldCoins;
}

/// GET /api/affiliate/me.
class AffiliateMe {
  final AffiliateProfile? affiliate; // null → not an affiliate yet
  final AffiliateTotals totals;
  AffiliateMe(this.affiliate, this.totals);
  AffiliateMe.fromJson(Map<String, dynamic> j)
      : affiliate = (j['affiliate'] is Map)
            ? AffiliateProfile.fromJson((j['affiliate'] as Map).cast<String, dynamic>())
            : null,
        totals = (j['totals'] is Map)
            ? AffiliateTotals.fromJson((j['totals'] as Map).cast<String, dynamic>())
            : const AffiliateTotals.zero();
  Map<String, dynamic> toJson() =>
      {if (affiliate != null) 'affiliate': affiliate!.toJson(), 'totals': totals.toJson()};
}

/// A promotable creator listing (Product Picker card).
class AffiliateListing {
  final String id, app, title;
  final int price; // coins
  final String creatorId, creatorName;
  final String? creatorAvatar;
  final double? rating;
  AffiliateListing.fromJson(Map<String, dynamic> j)
      : id = _s(j['id']),
        app = _s(j['app']),
        title = _s(j['title']),
        price = _i(j['price']),
        creatorId = _s((j['creator'] as Map?)?['id']),
        creatorName = _s((j['creator'] as Map?)?['name'], 'Creator'),
        creatorAvatar = (j['creator'] as Map?)?['avatar']?.toString(),
        rating = (j['rating'] as num?)?.toDouble();
}

class AffiliateLink {
  final String id, listingId, app, title, status;
  final int clicks, binds, earnedCoins;
  final String url;
  AffiliateLink.fromJson(Map<String, dynamic> j)
      : id = _s(j['id']),
        listingId = _s(j['listing_id']),
        app = _s(j['app']),
        title = _s(j['title'], 'Listing'),
        status = _s(j['status'], 'active'),
        clicks = _i(j['clicks']),
        binds = _i(j['binds']),
        earnedCoins = _i(j['earned_coins']),
        url = _s(j['url']).isEmpty ? '$kAffiliateLinkBase${_s(j['id'])}' : _s(j['url']);
  bool get paused => status == 'paused';
}

class AffiliateFunnel {
  final int clicks, installs, binds, firstPurchases, repeatPurchases;
  const AffiliateFunnel.zero()
      : clicks = 0, installs = 0, binds = 0, firstPurchases = 0, repeatPurchases = 0;
  AffiliateFunnel.fromJson(Map<String, dynamic> j)
      : clicks = _i(j['clicks']),
        installs = _i(j['installs']),
        binds = _i(j['binds']),
        firstPurchases = _i(j['first_purchases']),
        repeatPurchases = _i(j['repeat_purchases']);
}

class AffiliateDayPoint {
  final String day; // 'YYYY-MM-DD'
  final int clicks, earnedCoins;
  AffiliateDayPoint.fromJson(Map<String, dynamic> j)
      : day = _s(j['day']),
        clicks = _i(j['clicks']),
        earnedCoins = _i(j['earned_coins']);
}

class AffiliateConversion {
  final int ts, coins;
  final String maskedUser;
  AffiliateConversion.fromJson(Map<String, dynamic> j)
      : ts = _i(j['ts']),
        maskedUser = _s(j['masked_user'], 'User •••'),
        coins = _i(j['coins']);
}

/// GET /api/affiliate/links/:id/stats?range=.
class AffiliateLinkStats {
  final AffiliateFunnel funnel;
  final List<AffiliateDayPoint> timeseries;
  final int srcQr, srcLink, srcShare;
  final List<AffiliateConversion> recent;
  AffiliateLinkStats.fromJson(Map<String, dynamic> j)
      : funnel = (j['funnel'] is Map)
            ? AffiliateFunnel.fromJson((j['funnel'] as Map).cast<String, dynamic>())
            : const AffiliateFunnel.zero(),
        timeseries = ((j['timeseries'] as List?) ?? const [])
            .map((e) => AffiliateDayPoint.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        srcQr = _i((j['sources'] as Map?)?['qr']),
        srcLink = _i((j['sources'] as Map?)?['link']),
        srcShare = _i((j['sources'] as Map?)?['share']),
        recent = ((j['recent'] as List?) ?? const [])
            .map((e) => AffiliateConversion.fromJson((e as Map).cast<String, dynamic>()))
            .toList();
}

/// One generated marketing-kit image (v2 asset kit, flag-gated).
class AffiliateAsset {
  final String id, format, url; // format: 'story' | 'post' | 'banner'
  final int createdAt;
  AffiliateAsset.fromJson(Map<String, dynamic> j)
      : id = _s(j['id']),
        format = _s(j['format'], 'post'),
        url = _s(j['url']),
        createdAt = _i(j['created_at']);
}

class AffiliateSubscriber {
  final String maskedHandle;
  final int boundAt, ltvCoins, commissionCoins;
  AffiliateSubscriber.fromJson(Map<String, dynamic> j)
      : maskedHandle = _s(j['masked_handle'], 'User •••'),
        boundAt = _i(j['bound_at']),
        ltvCoins = _i(j['ltv_coins']),
        commissionCoins = _i(j['commission_coins']);
}

class AffiliateApi {
  static const _storage = FlutterSecureStorage();
  static const _meCacheKey = 'affiliate_me_v1'; // per-account scoped (rulebook)

  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  // ── registration / profile ───────────────────────────────────────────────
  /// POST /api/affiliate/register → {ok:true, me} | {error, status}.
  /// 403 means the caller is below Trust Ladder L1 (verify email first).
  static Future<Map<String, dynamic>> register() async {
    try {
      final r = await ApiAuth.postJson('$kAffiliateBase/register', const {});
      final j = _j(r.body);
      if (r.statusCode == 200) {
        final me = AffiliateMe(AffiliateProfile.fromJson(j), const AffiliateTotals.zero());
        await _cacheMe(me);
        return {'ok': true, 'me': me};
      }
      return {'error': _s(j['error'], 'register_failed'), 'status': r.statusCode};
    } catch (_) {
      return {'error': 'network', 'status': 0};
    }
  }

  /// GET /api/affiliate/me. Null on network/server failure (callers fall back
  /// to [cachedMe]). A 404 means "not an affiliate yet" → AffiliateMe(null,…).
  static Future<AffiliateMe?> me() async {
    try {
      final r = await ApiAuth.getSigned('$kAffiliateBase/me');
      if (r.statusCode == 404) return AffiliateMe(null, const AffiliateTotals.zero());
      if (r.statusCode != 200) return null;
      final m = AffiliateMe.fromJson(_j(r.body));
      await _cacheMe(m);
      return m;
    } catch (_) {
      return null;
    }
  }

  static Future<void> _cacheMe(AffiliateMe m) async {
    try {
      await _storage.write(key: scopedKey(_meCacheKey), value: jsonEncode(m.toJson()));
    } catch (_) {/* cache is best-effort */}
  }

  /// Last good /me snapshot for instant paint (per-account scoped).
  static Future<AffiliateMe?> cachedMe() async {
    try {
      final v = await readScoped(_storage, _meCacheKey);
      if (v == null || v.isEmpty) return null;
      return AffiliateMe.fromJson(jsonDecode(v) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  // ── listings & links ─────────────────────────────────────────────────────
  static Future<List<AffiliateListing>> listings({String? app, String? q}) async {
    final p = <String>[
      if (app != null && app.isNotEmpty) 'app=${Uri.encodeQueryComponent(app)}',
      if (q != null && q.trim().isNotEmpty) 'q=${Uri.encodeQueryComponent(q.trim())}',
    ];
    final r = await ApiAuth.getSigned(
        '$kAffiliateBase/listings${p.isEmpty ? '' : '?${p.join('&')}'}');
    return ((_j(r.body)['listings'] as List?) ?? const [])
        .map((e) => AffiliateListing.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  /// POST /api/affiliate/links {listing_id} → the link (idempotent per pair).
  static Future<AffiliateLink?> createLink(String listingId) async {
    try {
      final r = await ApiAuth.postJson('$kAffiliateBase/links', {'listing_id': listingId});
      if (r.statusCode != 200) return null;
      final l = (_j(r.body)['link'] as Map?)?.cast<String, dynamic>();
      return l == null ? null : AffiliateLink.fromJson(l);
    } catch (_) {
      return null;
    }
  }

  static Future<List<AffiliateLink>> links() async {
    final r = await ApiAuth.getSigned('$kAffiliateBase/links');
    return ((_j(r.body)['links'] as List?) ?? const [])
        .map((e) => AffiliateLink.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  /// range: '7d' | '30d' | '90d'.
  static Future<AffiliateLinkStats?> linkStats(String linkId, {String range = '30d'}) async {
    try {
      final r = await ApiAuth.getSigned('$kAffiliateBase/links/$linkId/stats?range=$range',
          timeout: const Duration(seconds: 15));
      if (r.statusCode != 200) return null;
      return AffiliateLinkStats.fromJson(_j(r.body));
    } catch (_) {
      return null;
    }
  }

  static Future<List<AffiliateSubscriber>> subscribers(String linkId) async {
    final r = await ApiAuth.getSigned('$kAffiliateBase/links/$linkId/subscribers');
    return ((_j(r.body)['subscribers'] as List?) ?? const [])
        .map((e) => AffiliateSubscriber.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  // ── v2 marketing-asset kit (flag affiliateAssetKitEnabled) ───────────────
  /// POST /api/affiliate/links/:id/assets {style?} — generates 3 promo images
  /// (story/post/banner) via Gemini. Slow (3 image calls) → generous timeout.
  /// Returns {'ok': true, 'assets': List<AffiliateAsset>} or {'error', 'status'}
  /// (429 = daily limit, 503 = kit disabled / key unset).
  static Future<Map<String, dynamic>> generateAssets(String linkId, {String? style}) async {
    try {
      final r = await ApiAuth.postJson(
        '$kAffiliateBase/links/$linkId/assets',
        {if (style != null && style.trim().isNotEmpty) 'style': style.trim()},
        timeout: const Duration(seconds: 120),
      );
      final j = _j(r.body);
      if (r.statusCode == 200) {
        final assets = ((j['assets'] as List?) ?? const [])
            .map((e) => AffiliateAsset.fromJson((e as Map).cast<String, dynamic>()))
            .toList();
        return {'ok': true, 'assets': assets};
      }
      return {'error': _s(j['error'], 'generate_failed'), 'status': r.statusCode};
    } catch (_) {
      return {'error': 'network', 'status': 0};
    }
  }

  /// GET /api/affiliate/links/:id/assets — newest first. Null on failure.
  static Future<List<AffiliateAsset>?> listAssets(String linkId) async {
    try {
      final r = await ApiAuth.getSigned('$kAffiliateBase/links/$linkId/assets',
          timeout: const Duration(seconds: 15));
      if (r.statusCode != 200) return null;
      return ((_j(r.body)['assets'] as List?) ?? const [])
          .map((e) => AffiliateAsset.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return null;
    }
  }

  /// POST /api/affiliate/links/:id/pause — toggles; returns the new status or null.
  static Future<String?> pauseToggle(String linkId) async {
    try {
      final r = await ApiAuth.postJson('$kAffiliateBase/links/$linkId/pause', const {});
      if (r.statusCode != 200) return null;
      return _s(_j(r.body)['status'], 'paused');
    } catch (_) {
      return null;
    }
  }
}
