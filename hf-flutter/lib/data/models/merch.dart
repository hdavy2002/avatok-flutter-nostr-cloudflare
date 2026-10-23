/// [HF-MERCH-APP-1] Shapes of the influencer merch shop API (`/api/hf/merch/*`, worker/src/routes/hf_merch.ts).
/// Money is whole paise (an int) everywhere; the screens print rupees. Unknown or missing fields fall back to empty values.

int _i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;
/// Nullable int: null when the field is absent (older worker responses), so screens can skip the breakdown.
int? _in(Object? v) => v is num ? v.round() : null;
String _s(Object? v) => v is String ? v : (v == null ? '' : '$v');
String? _sn(Object? v) => v is String && v.isNotEmpty ? v : null;
double _d(Object? v) => v is num ? v.toDouble() : double.tryParse('$v') ?? 0;
List<Map<String, dynamic>> _maps(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const <Map<String, dynamic>>[];
List<String> _strings(Object? v) => v is List ? [for (final e in v) if (e is String && e.isNotEmpty) e] : const <String>[];

/// The slice of `GET /api/config` the merch screens read.
class MerchFlags {
  const MerchFlags({this.enabled = false, this.checkoutEnabled = false, this.minMarkupRupees = 10, this.holdDays = 7});

  factory MerchFlags.fromConfig(Map<String, dynamic> j) => MerchFlags(
        enabled: j['hfMerchEnabled'] == true,
        checkoutEnabled: j['hfMerchCheckoutEnabled'] == true,
        minMarkupRupees: j['hfMerchMinMarkupRupees'] is num ? _i(j['hfMerchMinMarkupRupees']) : 10,
        holdDays: j['hfMerchHoldDays'] is num ? _i(j['hfMerchHoldDays']) : 7,
      );

  final bool enabled;
  final bool checkoutEnabled;
  final int minMarkupRupees;
  final int holdDays;
}

class MerchColour {
  const MerchColour({required this.name, required this.hex});

  factory MerchColour.fromJson(Map<String, dynamic> j) => MerchColour(name: _s(j['name']), hex: _s(j['hex']));

  final String name;

  /// `#rrggbb` from the server.
  final String hex;
}

List<MerchColour> _colours(Object? v) => [for (final m in _maps(v)) MerchColour.fromJson(m)];

// ------------------------------------------------------------------------------------------------ influencer

class CatalogSize {
  const CatalogSize({required this.size, required this.basePaise, this.maxMarkupRupees});

  /// [HF-MERCH-GST-2] Highest markup (rupees) that keeps this size under the price cap; null when the server does not send it.
  final int? maxMarkupRupees;

  final String size;

  /// "Up to" base price: the biggest print the shirt takes. The real base comes from `quote`.
  final int basePaise;
}

class CatalogItem {
  const CatalogItem({
    required this.id,
    required this.name,
    required this.areaW,
    required this.areaH,
    required this.colours,
    required this.sizes,
    this.mockupUrl,
    this.kind = '',
    this.category = 'other',
    this.categoryLabel = 'More',
    this.family = 'other',
    this.sides = const <String>['front'],
    this.areas = const <String, PrintArea>{},
    this.imageUrl,
  });

  factory CatalogItem.fromJson(Map<String, dynamic> j) {
    final area = j['printArea'];
    final a = area is Map ? Map<String, dynamic>.from(area) : <String, dynamic>{};
    final areasRaw = j['printAreas'] is Map ? Map<String, dynamic>.from(j['printAreas'] as Map) : <String, dynamic>{};
    final areas = <String, PrintArea>{
      for (final e in areasRaw.entries)
        if (e.value is Map && _d((e.value as Map)['wIn']) > 0 && _d((e.value as Map)['hIn']) > 0)
          e.key: PrintArea(_d((e.value as Map)['wIn']), _d((e.value as Map)['hIn'])),
    };
    final sides = _strings(j['side']).where((s) => s == 'front' || s == 'back').toList();
    return CatalogItem(
      kind: _s(j['kind']),
      category: _sn(j['category']) ?? 'other',
      categoryLabel: _sn(j['categoryLabel']) ?? 'More',
      family: _sn(j['family']) ?? 'other',
      sides: sides.isEmpty ? const <String>['front'] : sides,
      areas: areas,
      imageUrl: _sn(j['imageUrl']),
      id: _s(j['id']),
      name: _s(j['name']),
      areaW: _d(a['wIn']) > 0 ? _d(a['wIn']) : 12,
      areaH: _d(a['hIn']) > 0 ? _d(a['hIn']) : 14,
      colours: _colours(j['colours']),
      sizes: [for (final m in _maps(j['sizes'])) CatalogSize(size: _s(m['size']), basePaise: _i(m['basePaise']), maxMarkupRupees: _in(m['maxMarkupRupees']))],
      mockupUrl: _sn(j['mockupUrl']),
    );
  }

  final String id;
  final String name;

  /// Print area in inches (the catalogue gives the front; the back is assumed to match).
  final double areaW;
  final double areaH;
  final List<MerchColour> colours;
  final List<CatalogSize> sizes;
  final String? mockupUrl;

  /// [HF-MERCH-STUDIO-2] Printrove kind, category tab, silhouette family, sides that print, per-side print areas (inches).
  final String kind;
  final String category;
  final String categoryLabel;
  final String family;
  final List<String> sides;
  final Map<String, PrintArea> areas;
  final String? imageUrl;

  /// Print area for [side] (falls back to the catalogue's first area).
  PrintArea areaFor(String side) => areas[side] ?? PrintArea(areaW, areaH);

  int get fromPaise => sizes.isEmpty ? 0 : sizes.map((s) => s.basePaise).reduce((a, b) => a < b ? a : b);
}

/// Print area in inches.
class PrintArea {
  const PrintArea(this.wIn, this.hIn);
  final double wIn;
  final double hIn;
}

class MerchCatalog {
  const MerchCatalog({required this.items, required this.minMarkupRupees, required this.platformShareBps, required this.holdDays, this.priceCapPaise, this.gstRateBps});

  factory MerchCatalog.fromJson(Map<String, dynamic> j) => MerchCatalog(
        items: [for (final m in _maps(j['items'])) CatalogItem.fromJson(m)],
        minMarkupRupees: j['minMarkupRupees'] is num ? _i(j['minMarkupRupees']) : 10,
        platformShareBps: j['platformShareBps'] is num ? _i(j['platformShareBps']) : 4000,
        holdDays: j['holdDays'] is num ? _i(j['holdDays']) : 7,
        priceCapPaise: _in(j['priceCapPaise']),
        gstRateBps: _in(j['gstRateBps']),
      );

  /// [HF-MERCH-GST-2] Highest fan price (paise) a shirt may have so the 5% GST rate applies; null on older servers.
  final int? priceCapPaise;

  /// GST rate in basis points (500 = 5%); null on older servers.
  final int? gstRateBps;

  final List<CatalogItem> items;
  final int minMarkupRupees;
  final int platformShareBps;
  final int holdDays;

  /// What the influencer earns on one unit with this markup (same floor rule as the server; shown, never charged).
  int youEarnPaise(int markupRupees) => (markupRupees * 100 * (10000 - platformShareBps)) ~/ 10000;
}

class ArtUpload {
  const ArtUpload({required this.artId, required this.url, required this.width, required this.height, required this.warnings});

  factory ArtUpload.fromJson(Map<String, dynamic> j) {
    final checks = j['checks'];
    return ArtUpload(
      artId: _s(j['artId']),
      url: _s(j['url']),
      width: _i(j['width']),
      height: _i(j['height']),
      warnings: checks is Map ? _strings(checks['warnings']) : const <String>[],
    );
  }

  final String artId;
  final String url;
  final int width;
  final int height;
  final List<String> warnings;
}

/// [HF-MERCH-STUDIO-2] One AI picture the influencer made (GET /api/hf/merch/ai `recent`).
class AiGen {
  const AiGen({required this.genId, required this.art, required this.prompt, this.style, required this.createdAt});

  factory AiGen.fromJson(Map<String, dynamic> j) => AiGen(
        genId: _s(j['genId']),
        art: ArtUpload(artId: _s(j['artId']), url: _s(j['url']), width: _i(j['width']), height: _i(j['height']), warnings: const <String>[]),
        prompt: _s(j['prompt']),
        style: _sn(j['style']),
        createdAt: DateTime.fromMillisecondsSinceEpoch(_i(j['createdAt'])),
      );

  final String genId;
  final ArtUpload art;
  final String prompt;
  final String? style;
  final DateTime createdAt;
}

/// [HF-MERCH-STUDIO-2] AI picture price and the paid wallet balance (GET /api/hf/merch/ai).
class AiInfo {
  const AiInfo({required this.enabled, required this.chargePaise, required this.balancePaise, required this.testCreditPaise, required this.canAfford, required this.recent});

  factory AiInfo.fromJson(Map<String, dynamic> j) => AiInfo(
        enabled: j['enabled'] == true,
        chargePaise: _i(j['chargePaise']),
        balancePaise: _i(j['balancePaise']),
        testCreditPaise: _i(j['testCreditPaise']),
        canAfford: j['canAfford'] == true,
        recent: [for (final m in _maps(j['recent'])) AiGen.fromJson(m)],
      );

  final bool enabled;
  final int chargePaise;

  /// Paid wallet money only (free test credit cannot pay for AI pictures).
  final int balancePaise;
  final int testCreditPaise;
  final bool canAfford;
  final List<AiGen> recent;
}

/// Result of POST /api/hf/merch/ai/generate.
class AiResult {
  const AiResult({required this.genId, required this.chargedPaise, required this.art, required this.balancePaise});
  final String genId;
  final int chargedPaise;
  final ArtUpload art;
  final int balancePaise;
}

/// [HF-MERCH-PRICE-LABELS-2] One size of a quote: printing (incl. GST) and shipping, both null on older responses.
class QuoteLine {
  const QuoteLine({this.printingPaise, this.shippingPaise, this.maxMarkupRupees});

  /// [HF-MERCH-GST-2] Highest markup (rupees) for this size under the price cap; null when not sent.
  final int? maxMarkupRupees;

  final int? printingPaise;
  final int? shippingPaise;
}

class ProductSize {
  const ProductSize({required this.size, required this.basePaise, required this.pricePaise, required this.youEarnPaise, this.printingPaise, this.shippingPaise, this.bufferPaise});

  /// Printing incl. GST / shipping / rounding buffer (paise); null when the server does not send them yet.
  final int? printingPaise;
  final int? shippingPaise;
  final int? bufferPaise;

  final String size;
  final int basePaise;
  final int pricePaise;
  final int youEarnPaise;
}

class MerchProduct {
  const MerchProduct({
    required this.id,
    required this.slug,
    required this.title,
    required this.description,
    required this.status,
    required this.reviewNote,
    required this.imageUrl,
    required this.colours,
    required this.sizes,
    required this.markupRupees,
    required this.soldCount,
    required this.publicUrl,
    this.breakdownEstimated = false,
  });

  factory MerchProduct.fromJson(Map<String, dynamic> j) => MerchProduct(
        id: _s(j['id']),
        slug: _s(j['slug']),
        title: _s(j['title']),
        description: _s(j['description']),
        status: _s(j['status']),
        reviewNote: _sn(j['reviewNote']),
        imageUrl: _sn(j['imageUrl']),
        colours: _colours(j['colours']),
        sizes: [
          for (final m in _maps(j['sizes']))
            ProductSize(
              size: _s(m['size']),
              basePaise: _i(m['basePaise']),
              pricePaise: _i(m['pricePaise']),
              youEarnPaise: _i(m['youEarnPaise']),
              printingPaise: _in(m['printingPaise']),
              shippingPaise: _in(m['shippingPaise']),
              bufferPaise: _in(m['bufferPaise']),
            ),
        ],
        markupRupees: _i(j['markupRupees']),
        soldCount: _i(j['soldCount']),
        publicUrl: _s(j['publicUrl']),
        breakdownEstimated: j['breakdownEstimated'] == true,
      );

  /// True when the printing / shipping split of an older product is an estimate.
  final bool breakdownEstimated;

  final String id;
  final String slug;
  final String title;
  final String description;

  /// `pending` | `live` | `rejected` | `hidden`.
  final String status;
  final String? reviewNote;
  final String? imageUrl;
  final List<MerchColour> colours;
  final List<ProductSize> sizes;
  final int markupRupees;
  final int soldCount;
  final String publicUrl;

  int get fromPaise => sizes.isEmpty ? 0 : sizes.map((s) => s.pricePaise).reduce((a, b) => a < b ? a : b);
}

class MerchSummary {
  const MerchSummary({
    this.live = 0,
    this.pending = 0,
    this.hidden = 0,
    this.ordersNew = 0,
    this.processing = 0,
    this.shipped = 0,
    this.delivered = 0,
    this.pendingPaise = 0,
    this.availablePaise = 0,
    this.lifetimePaise = 0,
  });

  factory MerchSummary.fromJson(Map<String, dynamic> j) {
    final p = j['products'] is Map ? Map<String, dynamic>.from(j['products'] as Map) : <String, dynamic>{};
    final o = j['orders'] is Map ? Map<String, dynamic>.from(j['orders'] as Map) : <String, dynamic>{};
    final e = j['earnings'] is Map ? Map<String, dynamic>.from(j['earnings'] as Map) : <String, dynamic>{};
    return MerchSummary(
      live: _i(p['live']),
      pending: _i(p['pending']),
      hidden: _i(p['hidden']),
      ordersNew: _i(o['new']),
      processing: _i(o['processing']),
      shipped: _i(o['shipped']),
      delivered: _i(o['delivered']),
      pendingPaise: _i(e['pendingPaise']),
      availablePaise: _i(e['availablePaise']),
      lifetimePaise: _i(e['lifetimePaise']),
    );
  }

  final int live;
  final int pending;
  final int hidden;
  final int ordersNew;
  final int processing;
  final int shipped;
  final int delivered;
  final int pendingPaise;
  final int availablePaise;
  final int lifetimePaise;
}

class TimelineEntry {
  const TimelineEntry({required this.at, required this.label});

  final DateTime at;
  final String label;
}

List<TimelineEntry> _timeline(Object? v) => [
      for (final m in _maps(v)) TimelineEntry(at: DateTime.fromMillisecondsSinceEpoch(_i(m['at'])), label: _s(m['label'])),
    ];

class ShippingInfo {
  const ShippingInfo({this.courier, this.awb, this.trackingUrl});

  static ShippingInfo? fromJson(Object? v) {
    if (v is! Map) return null;
    final m = Map<String, dynamic>.from(v);
    return ShippingInfo(courier: _sn(m['courier']), awb: _sn(m['awb']), trackingUrl: _sn(m['trackingUrl']));
  }

  final String? courier;
  final String? awb;
  final String? trackingUrl;
}

/// One order as the influencer sees it. The buyer is masked by the server (first name, city, state, partial address).
class SellerOrder {
  const SellerOrder({
    required this.id,
    required this.orderNo,
    required this.createdAt,
    required this.status,
    required this.title,
    required this.imageUrl,
    required this.colour,
    required this.size,
    required this.qty,
    required this.pricePaise,
    required this.basePaise,
    required this.youEarnPaise,
    required this.availableAt,
    required this.credited,
    required this.firstName,
    required this.city,
    required this.state,
    required this.addressMasked,
    required this.shipping,
    required this.timeline,
  });

  factory SellerOrder.fromJson(Map<String, dynamic> j) {
    final p = j['product'] is Map ? Map<String, dynamic>.from(j['product'] as Map) : <String, dynamic>{};
    final m = j['money'] is Map ? Map<String, dynamic>.from(j['money'] as Map) : <String, dynamic>{};
    final b = j['buyer'] is Map ? Map<String, dynamic>.from(j['buyer'] as Map) : <String, dynamic>{};
    return SellerOrder(
      id: _s(j['id']),
      orderNo: _s(j['orderNo']),
      createdAt: DateTime.fromMillisecondsSinceEpoch(_i(j['createdAt'])),
      status: _s(j['status']),
      title: _s(p['title']),
      imageUrl: _sn(p['imageUrl']),
      colour: _s(p['colour']),
      size: _s(p['size']),
      qty: _i(p['qty']) == 0 ? 1 : _i(p['qty']),
      pricePaise: _i(m['pricePaise']),
      basePaise: _i(m['basePaise']),
      youEarnPaise: _i(m['youEarnPaise']),
      availableAt: m['availableAt'] is num ? DateTime.fromMillisecondsSinceEpoch(_i(m['availableAt'])) : null,
      credited: m['credited'] == true,
      firstName: _s(b['firstName']),
      city: _s(b['city']),
      state: _s(b['state']),
      addressMasked: _s(b['addressMasked']),
      shipping: ShippingInfo.fromJson(j['shipping']),
      timeline: _timeline(j['timeline']),
    );
  }

  final String id;
  final String orderNo;
  final DateTime createdAt;

  /// `new` | `processing` | `shipped` | `delivered` | `cancelled`.
  final String status;
  final String title;
  final String? imageUrl;
  final String colour;
  final String size;
  final int qty;
  final int pricePaise;
  final int basePaise;
  final int youEarnPaise;
  final DateTime? availableAt;
  final bool credited;
  final String firstName;
  final String city;
  final String state;
  final String addressMasked;
  final ShippingInfo? shipping;
  final List<TimelineEntry> timeline;
}

// ------------------------------------------------------------------------------------------------ fan

class PublicSize {
  const PublicSize({required this.size, required this.pricePaise, required this.inStock});

  final String size;
  final int pricePaise;
  final bool inStock;
}

class PublicProduct {
  const PublicProduct({
    required this.id,
    required this.slug,
    required this.title,
    required this.imageUrl,
    required this.colours,
    required this.sizes,
    required this.fromPaise,
    required this.photos,
    required this.description,
    required this.maxQty,
  });

  factory PublicProduct.fromJson(Map<String, dynamic> j) => PublicProduct(
        id: _s(j['id']),
        slug: _s(j['slug']),
        title: _s(j['title']),
        imageUrl: _sn(j['imageUrl']),
        colours: _colours(j['colours']),
        sizes: [
          for (final m in _maps(j['sizes']))
            PublicSize(size: _s(m['size']), pricePaise: _i(m['pricePaise']), inStock: m['inStock'] != false),
        ],
        fromPaise: _i(j['fromPricePaise']),
        photos: _strings(j['photos']),
        description: _s(j['description']),
        maxQty: j['maxQty'] is num && _i(j['maxQty']) > 0 ? _i(j['maxQty']) : 3,
      );

  final String id;
  final String slug;
  final String title;
  final String? imageUrl;
  final List<MerchColour> colours;
  final List<PublicSize> sizes;
  final int fromPaise;

  /// Only filled on the product page.
  final List<String> photos;
  final String description;
  final int maxQty;
}

class PublicHost {
  const PublicHost({required this.slug, required this.displayName, this.avatarUrl});

  factory PublicHost.fromJson(Object? v) {
    final j = v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    return PublicHost(slug: _s(j['slug']), displayName: _s(j['displayName']), avatarUrl: _sn(j['avatarUrl']));
  }

  final String slug;
  final String displayName;
  final String? avatarUrl;
}

/// `GET /api/hf/merch/public/:hostSlug` (the strip) and `.../:hostSlug/:productSlug` (one product).
class PublicShop {
  const PublicShop({required this.host, required this.checkoutEnabled, required this.products});

  factory PublicShop.fromJson(Map<String, dynamic> j) => PublicShop(
        host: PublicHost.fromJson(j['host']),
        checkoutEnabled: j['checkoutEnabled'] == true,
        products: [for (final m in _maps(j['products'])) PublicProduct.fromJson(m)],
      );

  final PublicHost host;
  final bool checkoutEnabled;
  final List<PublicProduct> products;
}

class PublicProductPage {
  const PublicProductPage({required this.host, required this.checkoutEnabled, required this.product, this.gstRateBps});

  factory PublicProductPage.fromJson(Map<String, dynamic> j) => PublicProductPage(
        host: PublicHost.fromJson(j['host']),
        checkoutEnabled: j['checkoutEnabled'] == true,
        product: PublicProduct.fromJson(j['product'] is Map ? Map<String, dynamic>.from(j['product'] as Map) : <String, dynamic>{}),
        gstRateBps: _in(j['gstRateBps']) ?? (j['product'] is Map ? _in((j['product'] as Map)['gstRateBps']) : null),
      );

  /// [HF-MERCH-GST-2] GST rate in basis points (500 = 5%); null when the server does not send it.
  final int? gstRateBps;

  final PublicHost host;
  final bool checkoutEnabled;
  final PublicProduct product;
}

class PincodeCheck {
  const PincodeCheck({required this.deliverable, this.etaDays});

  final bool deliverable;
  final int? etaDays;
}

/// A delivery address typed on the checkout screen.
class MerchAddress {
  const MerchAddress({
    required this.name,
    required this.phone,
    required this.line1,
    this.line2 = '',
    required this.city,
    required this.state,
    required this.pincode,
  });

  Map<String, Object?> toJson() => {
        'name': name,
        'phone': phone,
        'line1': line1,
        if (line2.isNotEmpty) 'line2': line2,
        'city': city,
        'state': state,
        'pincode': pincode,
      };

  final String name;
  final String phone;
  final String line1;
  final String line2;
  final String city;
  final String state;
  final String pincode;
}

class SavedAddress {
  const SavedAddress({
    required this.id,
    required this.name,
    required this.phone,
    required this.line1,
    required this.line2,
    required this.city,
    required this.state,
    required this.pincode,
  });

  factory SavedAddress.fromJson(Map<String, dynamic> j) => SavedAddress(
        id: _s(j['id']),
        name: _s(j['name']),
        phone: _s(j['phone']),
        line1: _s(j['line1']),
        line2: _s(j['line2']),
        city: _s(j['city']),
        state: _s(j['state']),
        pincode: _s(j['pincode']),
      );

  final String id;
  final String name;
  final String phone;
  final String line1;
  final String line2;
  final String city;
  final String state;
  final String pincode;

  MerchAddress toAddress() => MerchAddress(name: name, phone: phone, line1: line1, line2: line2, city: city, state: state, pincode: pincode);
}

class CheckoutResult {
  const CheckoutResult({required this.orderId, required this.orderNo, required this.status, this.checkoutUrl, this.paymentSessionId});

  factory CheckoutResult.fromJson(Map<String, dynamic> j) => CheckoutResult(
        orderId: _s(j['orderId']),
        orderNo: _s(j['orderNo']),
        status: _s(j['status']),
        checkoutUrl: _sn(j['checkoutUrl']),
        paymentSessionId: _sn(j['paymentSessionId']),
      );

  final String orderId;
  final String orderNo;

  /// `paid` (wallet) | `awaiting_payment` (Cashfree).
  final String status;
  final String? checkoutUrl;
  final String? paymentSessionId;

  bool get paid => status == 'paid';
}

/// One order as the buyer sees it.
class FanOrder {
  const FanOrder({
    required this.id,
    required this.orderNo,
    required this.createdAt,
    required this.status,
    required this.title,
    required this.imageUrl,
    required this.colour,
    required this.size,
    required this.qty,
    required this.hostName,
    required this.hostSlug,
    required this.totalPaise,
    required this.payMethod,
    required this.shipping,
    required this.receiptUrl,
    required this.canReportProblem,
    required this.refundStatus,
    required this.rejectReason,
    required this.timeline,
    this.gstInvoice,
  });

  factory FanOrder.fromJson(Map<String, dynamic> j) {
    final p = j['product'] is Map ? Map<String, dynamic>.from(j['product'] as Map) : <String, dynamic>{};
    return FanOrder(
      id: _s(j['id']),
      orderNo: _s(j['orderNo']),
      createdAt: DateTime.fromMillisecondsSinceEpoch(_i(j['createdAt'])),
      status: _s(j['status']),
      title: _s(p['title']),
      imageUrl: _sn(p['imageUrl']),
      colour: _s(p['colour']),
      size: _s(p['size']),
      qty: _i(p['qty']) == 0 ? 1 : _i(p['qty']),
      hostName: _s(p['hostName']),
      hostSlug: _s(p['hostSlug']),
      totalPaise: _i(j['totalPaise']),
      payMethod: _sn(j['payMethod']),
      shipping: ShippingInfo.fromJson(j['shipping']),
      receiptUrl: _sn(j['receiptUrl']),
      gstInvoice: j['gstInvoice'] == false ? false : null,
      canReportProblem: j['canReportProblem'] == true,
      refundStatus: _s(j['refundStatus']),
      rejectReason: _sn(j['rejectReason']),
      timeline: _timeline(j['timeline']),
    );
  }

  final String id;
  final String orderNo;
  final DateTime createdAt;

  /// `awaiting_payment` | `placed` | `approved` | `printing` | `shipped` | `delivered` | `cancelled` | `refunded`.
  final String status;
  final String title;
  final String? imageUrl;
  final String colour;
  final String size;
  final int qty;
  final String hostName;
  final String hostSlug;
  final int totalPaise;
  final String? payMethod;
  final ShippingInfo? shipping;
  final String? receiptUrl;

  /// [HF-MERCH-GST-2] false = an older order whose document is a plain receipt; null/true = GST invoice.
  final bool? gstInvoice;
  final bool canReportProblem;
  final String refundStatus;
  final String? rejectReason;
  final List<TimelineEntry> timeline;
}
