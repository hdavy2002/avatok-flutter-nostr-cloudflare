import 'dart:typed_data';

import '../api_client.dart';
import '../api_exception.dart';
import '../models/bag.dart';
import '../models/merch.dart';
import '../services.dart';

/// One product on a channel page with the category the server derived for it (`tshirts`, `hoodies`, `mugs`, ...).
/// [category] / [categoryLabel] are empty on an older server; the page then shows no category chips.
class ChannelProduct {
  const ChannelProduct({required this.product, this.category = '', this.categoryLabel = ''});

  final PublicProduct product;
  final String category;
  final String categoryLabel;
}

class ChannelShop {
  const ChannelShop({required this.host, required this.checkoutEnabled, required this.items});

  final PublicHost host;
  final bool checkoutEnabled;
  final List<ChannelProduct> items;
}

/// One order of a group checkout.
class GroupOrder {
  const GroupOrder({required this.orderId, required this.orderNo, required this.productId, required this.amountPaise});

  final String orderId;
  final String orderNo;
  final String productId;
  final int amountPaise;
}

/// The answer of a bag checkout (`POST /api/hf/merch/checkout` with `items[]`).
class BagCheckoutResult {
  const BagCheckoutResult({required this.groupId, required this.orders, required this.totalPaise, required this.status, this.checkoutUrl, this.paymentSessionId});

  factory BagCheckoutResult.fromJson(Map<String, dynamic> j) {
    int i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;
    String s(Object? v) => v is String ? v : (v == null ? '' : '$v');
    String? sn(Object? v) => v is String && v.isNotEmpty ? v : null;
    final raw = j['orders'];
    return BagCheckoutResult(
      groupId: s(j['groupId']),
      orders: [
        if (raw is List)
          for (final e in raw)
            if (e is Map)
              GroupOrder(orderId: s(e['orderId']), orderNo: s(e['orderNo']), productId: s(e['productId']), amountPaise: i(e['amountPaise'])),
      ],
      totalPaise: i(j['totalPaise']),
      status: s(j['status']),
      checkoutUrl: sn(j['checkoutUrl']),
      paymentSessionId: sn(j['paymentSessionId']),
    );
  }

  final String groupId;
  final List<GroupOrder> orders;
  final int totalPaise;

  /// `paid` (wallet) | `awaiting_payment` (online).
  final String status;
  final String? checkoutUrl;
  final String? paymentSessionId;

  bool get paid => status == 'paid';
}

/// `GET /api/hf/merch/my-orders/<groupId>` -> `{ok, group:{groupId,status,totalPaise,orders:[...]}, order}`.
class BagGroupStatus {
  const BagGroupStatus({required this.groupId, required this.status, required this.totalPaise, required this.orderNos});

  factory BagGroupStatus.fromJson(Map<String, dynamic> j) {
    final g = j['group'] is Map ? Map<String, dynamic>.from(j['group'] as Map) : <String, dynamic>{};
    final raw = g['orders'];
    return BagGroupStatus(
      groupId: g['groupId'] is String ? g['groupId'] as String : '',
      status: g['status'] is String ? g['status'] as String : '',
      totalPaise: g['totalPaise'] is num ? (g['totalPaise'] as num).round() : 0,
      orderNos: [
        if (raw is List)
          for (final e in raw)
            if (e is Map && e['orderNo'] is String && (e['orderNo'] as String).isNotEmpty) e['orderNo'] as String,
      ],
    );
  }

  final String groupId;
  final String status;
  final int totalPaise;
  final List<String> orderNos;

  bool get paid => status == 'paid';
}

/// [HF-CHANNEL-APP-1] The calls the channel page, the bag and the profile photo screen need on top of [MerchRepo]
/// (spec Specs: .agent-wt/SPEC-HF-CHANNEL.md, contracts C1 to C3). Kept in its own file so the merch repo stays untouched.
///
/// - `GET  /api/hf/merch/public/:host` (public): the same shop strip, read here to keep each product's `category` / `categoryLabel`.
/// - `POST /api/hf/merch/checkout` with `{items[], address, saveAddress, acceptTerms, acceptRefund, method, requestKey, client}`.
///   402 `insufficient_balance` (nothing charged, [ApiException.extra] may carry `shortPaise`), 409 `item_unavailable`
///   (`extra.productId`: nothing was created).
/// - `PUT  /api/hosts/me/photo` raw image bytes -> `{ok, avatarUrl, imageProvenance}`; 400 `bad_type|too_big|too_small`, 404 `not_host`.
class ChannelRepo {
  ChannelRepo(this._api);

  final ApiClient _api;

  static ChannelRepo? _override;
  static ChannelRepo? _cached;

  /// The app-wide instance on the shared API client. Tests install their own with [override].
  static ChannelRepo get instance => _override ?? (_cached ??= ChannelRepo(Services.instance.api));

  static set override(ChannelRepo? r) => _override = r;

  static const String _base = '/api/hf/merch';

  Future<ChannelShop> shop(String hostSlug) async {
    final j = await _api.getJson('$_base/public/${Uri.encodeComponent(hostSlug)}', auth: false);
    final shop = PublicShop.fromJson(j);
    final raw = j['products'];
    final maps = <Map<String, dynamic>>[
      if (raw is List)
        for (final e in raw)
          if (e is Map) Map<String, dynamic>.from(e),
    ];
    String str(Object? v) => v is String ? v : '';
    return ChannelShop(
      host: shop.host,
      checkoutEnabled: shop.checkoutEnabled,
      items: [
        for (var i = 0; i < shop.products.length; i++)
          ChannelProduct(
            product: shop.products[i],
            category: i < maps.length ? str(maps[i]['category']) : '',
            categoryLabel: i < maps.length ? str(maps[i]['categoryLabel']) : '',
          ),
      ],
    );
  }

  /// Pays the whole bag with one wallet charge or one online payment. The same [requestKey] always returns the same result.
  /// The `X-Client: app` header makes the payment page come back to the app.
  Future<BagCheckoutResult> bagCheckout({
    required List<BagLine> lines,
    required MerchAddress address,
    required bool saveAddress,
    required String method,
    required String requestKey,
  }) async {
    final json = await _api.request(
      'POST',
      '$_base/checkout',
      body: {
        'items': [for (final l in lines) l.toCheckoutItem()],
        'address': address.toJson(),
        'saveAddress': saveAddress,
        'acceptTerms': true,
        'acceptRefund': true,
        'method': method,
        'requestKey': requestKey,
        'client': 'app',
      },
      headers: {'X-Client': 'app'},
    );
    return BagCheckoutResult.fromJson(ApiClient.asMap(json));
  }

  /// Where a bag payment stands. Throws [ApiException] when it cannot be read.
  Future<BagGroupStatus> groupStatus(String groupId) async {
    final j = await _api.getJson('$_base/my-orders/${Uri.encodeComponent(groupId)}');
    return BagGroupStatus.fromJson(j);
  }

  /// Sends the cropped picture (4:5, about 1200 x 1500). [HF-MOD-2] With the AI photo check on, the server answers
  /// 202 + status 'checking': the CURRENT picture stays until Clef-flash passes the new one (a few seconds).
  Future<ProfilePhotoUpload> uploadProfilePhoto(Uint8List bytes, {String contentType = 'image/jpeg'}) async {
    final j = await _api.putBytes('/api/hosts/me/photo', bytes, contentType: contentType);
    final u = j['avatarUrl'];
    return ProfilePhotoUpload(url: u is String && u.isNotEmpty ? u : null, checking: j['status'] == 'checking');
  }

  /// A friendly sentence for a photo upload that was refused.
  static String photoProblemText(Object e) {
    if (e is ApiException) {
      switch (e.code) {
        case 'bad_type':
          return 'That picture type is not allowed. Please choose a normal photo.';
        case 'too_big':
          return 'That picture is too large (over 4 MB). Please choose a smaller one.';
        case 'too_small':
          return 'That picture is too small. Please choose a bigger one.';
        case 'not_host':
          return 'Only influencers can set a page photo.';
      }
      return e.userMessage;
    }
    return ApiException.genericText;
  }
}

/// [HF-MOD-2] What the server said about a new profile photo.
class ProfilePhotoUpload {
  const ProfilePhotoUpload({required this.url, required this.checking});

  /// The picture showing on the page now (the old one while [checking]).
  final String? url;

  /// The new picture is being checked by the AI and goes live only if it passes.
  final bool checking;
}
