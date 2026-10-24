import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import '../api_client.dart';
import '../models/merch.dart';

/// [HF-MERCH-APP-1] The influencer merch shop (worker/src/routes/hf_merch.ts, spec Specs/SPEC-2026-10-23-HF-MERCH.md).
/// Everything is dark until `GET /api/config` says `hfMerchEnabled`; every other route answers 404 `not_enabled` while it is off.
///
/// - Influencer (live hosts only, else 403 `not_a_host`): catalog, quote, art, print-file, mockup, products, orders, summary.
/// - Public: `public/:hostSlug`, `public/:hostSlug/:productSlug`, `pincode/:pin`.
/// - Fan: checkout, my-orders, addresses, problem report.
///
/// The phone only shows money the server computed (the "you earn" preview uses the share the catalog route returns).
class MerchRepo {
  MerchRepo(this._api);

  final ApiClient _api;

  static const String _base = '/api/hf/merch';

  /// What the last config read said. Off until it says on. Screens listen to this and call [loadFlags] once.
  static final ValueNotifier<MerchFlags> flags = ValueNotifier<MerchFlags>(const MerchFlags());
  static DateTime? _flagsAt;
  static Future<void>? _flagsRun;

  /// Reads `/api/config` (public, cached by the API client) at most every five minutes. Never throws.
  Future<void> loadFlags({bool force = false}) {
    final at = _flagsAt;
    if (!force && at != null && DateTime.now().difference(at) < const Duration(minutes: 5)) return Future<void>.value();
    return _flagsRun ??= _readFlags().whenComplete(() => _flagsRun = null);
  }

  Future<void> _readFlags() async {
    try {
      final cached = await _api.peekJson('/api/config', auth: false, maxAge: const Duration(days: 30));
      if (cached != null && _flagsAt == null) flags.value = MerchFlags.fromConfig(cached);
    } catch (_) {
      // no saved config: the fresh read below decides
    }
    try {
      final j = await _api.getJson('/api/config', auth: false, store: true);
      flags.value = MerchFlags.fromConfig(j);
      _flagsAt = DateTime.now();
    } catch (_) {
      // keep what we had (off when nothing was ever read)
    }
  }

  // ---------------------------------------------------------------------------------------------- influencer

  MerchCatalog? _catalog;
  DateTime? _catalogAt;

  /// The T-shirt catalogue and the money rules. Kept for five minutes on the phone.
  Future<MerchCatalog> catalog({bool force = false}) async {
    final c = _catalog;
    final at = _catalogAt;
    if (!force && c != null && at != null && DateTime.now().difference(at) < const Duration(minutes: 5)) return c;
    final fresh = MerchCatalog.fromJson(await _api.getJson('$_base/catalog'));
    _catalog = fresh;
    _catalogAt = DateTime.now();
    return fresh;
  }

  /// Base price per size (paise) for a print of [wIn] x [hIn] inches in these colours.
  Future<Map<String, int>> quote({
    required String catalogId,
    required List<String> colours,
    required String side,
    required double wIn,
    required double hIn,
    required List<String> sizes,
    Map<String, QuoteLine>? breakdownOut,
  }) async {
    final j = await _api.getJson('$_base/quote', query: {
      'catalogId': catalogId,
      'colours': colours.join(','),
      'side': side,
      'w': wIn.toStringAsFixed(2),
      'h': hIn.toStringAsFixed(2),
      'sizes': sizes.join(','),
    });
    final out = <String, int>{};
    final raw = j['sizes'];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map && e['size'] is String && e['basePaise'] is num) {
          out[e['size'] as String] = (e['basePaise'] as num).round();
          if (breakdownOut != null) {
            breakdownOut[e['size'] as String] = QuoteLine(
              printingPaise: e['printingPaise'] is num ? (e['printingPaise'] as num).round() : null,
              shippingPaise: e['shippingPaise'] is num ? (e['shippingPaise'] as num).round() : null,
              maxMarkupRupees: e['maxMarkupRupees'] is num ? (e['maxMarkupRupees'] as num).round() : null,
            );
          }
        }
      }
    }
    return out;
  }

  /// Uploads the picked art. The file name travels in a header, so it is cut down to plain ASCII first (a header cannot carry
  /// other letters; this is the upload-filename trap).
  Future<ArtUpload> uploadArt(Uint8List bytes, {required String contentType, required String fileName}) async {
    final j = await _api.postBytes('$_base/art', bytes, contentType: contentType, headers: {'x-file-name': asciiName(fileName)});
    return ArtUpload.fromJson(j);
  }

  /// The art clipped to its frame, rendered at 300 DPI on the phone. Returns the print file id (equal to the art id).
  Future<String> uploadPrintFile(String artId, Uint8List png) async {
    final j = await _api.postBytes('$_base/print-file', png, contentType: 'image/png', headers: {'x-art-id': artId});
    final id = j['printFileId'];
    return id is String && id.isNotEmpty ? id : artId;
  }

  /// A picture of the shirt with the art on it (shown to buyers). Returns its public URL.
  Future<String> uploadMockup(Uint8List png) async {
    final j = await _api.postBytes('$_base/mockup', png, contentType: 'image/png');
    final u = j['url'];
    if (u is! String || u.isEmpty) throw StateError('mockup url missing');
    return u;
  }

  // ---------------------------------------------------------------------------------------------- [HF-MERCH-STUDIO-2] AI + cut-out

  /// AI picture price, the paid wallet balance and the influencer's recent AI pictures.
  Future<AiInfo> aiInfo() async => AiInfo.fromJson(await _api.getJson('$_base/ai'));

  /// Makes one AI picture (Nano Banana 2). Charges the fixed price from paid wallet money; the server refunds it when the picture
  /// cannot be made. Throws [ApiException]: 402 `insufficient_funds` (extra: chargePaise, balancePaise, shortPaise),
  /// 422 `prompt_blocked` / `art_blocked`, 502 `generation_failed` (extra: refundedPaise), 403 `ai_off`.
  /// Sent through [ApiClient.postBytes] for its long timeout (a picture takes up to two minutes).
  Future<AiResult> generateAi({
    required String requestKey,
    required String prompt,
    String? style,
    List<String> refArtIds = const <String>[],
    String? baseArtId,
    bool plainBackground = true,
    String aspect = '1:1',
  }) async {
    final body = <String, Object?>{
      'requestKey': requestKey,
      'prompt': prompt,
      if (style != null) 'style': style,
      if (refArtIds.isNotEmpty) 'refArtIds': refArtIds,
      if (baseArtId != null) 'baseArtId': baseArtId,
      'plainBackground': plainBackground,
      'aspect': aspect,
    };
    final j = await _api.postBytes('$_base/ai/generate', utf8.encode(jsonEncode(body)),
        contentType: 'application/json', uploadTimeout: const Duration(seconds: 150));
    final gen = _map(j['gen']);
    return AiResult(
      genId: '${gen['genId'] ?? ''}',
      chargedPaise: gen['chargedPaise'] is num ? (gen['chargedPaise'] as num).round() : 0,
      art: ArtUpload.fromJson(_map(j['art'])),
      balancePaise: j['balancePaise'] is num ? (j['balancePaise'] as num).round() : 0,
    );
  }

  /// Cuts the subject out of one of the influencer's pictures (free). Returns the new transparent art.
  Future<ArtUpload> removeBackground(String artId) async {
    final j = await _api.postBytes('$_base/art/${Uri.encodeComponent(artId)}/remove-bg', utf8.encode('{}'),
        contentType: 'application/json', uploadTimeout: const Duration(seconds: 90));
    return ArtUpload.fromJson(_map(j['art']));
  }

  /// [HF-MERCH-AI-DELETE-1] Takes an AI picture off "earlier pictures" for good (a reload does not bring it back). Idempotent.
  Future<void> deleteAiPicture(String artId) async {
    await _api.deleteJson('$_base/ai/pictures/${Uri.encodeComponent(artId)}');
  }

  Future<MerchProduct> createProduct(Map<String, Object?> body) async {
    final j = await _api.postJson('$_base/products', body: body);
    return MerchProduct.fromJson(_map(j['product']));
  }

  Future<List<MerchProduct>> products() async {
    final j = await _api.getJson('$_base/products');
    return [for (final m in _list(j['products'])) MerchProduct.fromJson(m)];
  }

  /// `{markupRupees}`, `{hidden}`, `{title}`, `{description}`. 409 `hidden_by_admin` when she tries to show a product the team hid.
  Future<MerchProduct> patchProduct(String id, Map<String, Object?> body) async {
    final j = await _api.patchJson('$_base/products/${Uri.encodeComponent(id)}', body: body);
    return MerchProduct.fromJson(_map(j['product']));
  }

  /// 409 `open_orders` while an order is not delivered or cancelled (the screen then suggests hiding).
  Future<void> deleteProduct(String id) async {
    await _api.deleteJson('$_base/products/${Uri.encodeComponent(id)}');
  }

  Future<List<SellerOrder>> orders({String? status}) async {
    final j = await _api.getJson('$_base/orders', query: {'status': status});
    return [for (final m in _list(j['orders'])) SellerOrder.fromJson(m)];
  }

  Future<SellerOrder> order(String id) async {
    final j = await _api.getJson('$_base/orders/${Uri.encodeComponent(id)}');
    return SellerOrder.fromJson(_map(j['order']));
  }

  Future<MerchSummary> summary() async => MerchSummary.fromJson(await _api.getJson('$_base/summary'));

  // ---------------------------------------------------------------------------------------------- public

  Future<PublicShop> publicShop(String hostSlug) async =>
      PublicShop.fromJson(await _api.getJson('$_base/public/${Uri.encodeComponent(hostSlug)}', auth: false));

  Future<PublicProductPage> publicProduct(String hostSlug, String productSlug) async => PublicProductPage.fromJson(
      await _api.getJson('$_base/public/${Uri.encodeComponent(hostSlug)}/${Uri.encodeComponent(productSlug)}', auth: false));

  Future<PincodeCheck> pincode(String pin) async {
    final j = await _api.getJson('$_base/pincode/${Uri.encodeComponent(pin)}', auth: false);
    return PincodeCheck(deliverable: j['deliverable'] == true, etaDays: j['etaDays'] is num ? (j['etaDays'] as num).round() : null);
  }

  // ---------------------------------------------------------------------------------------------- fan

  /// Pays from the wallet (`status: paid`) or starts a Cashfree order (`checkoutUrl`). 402 `insufficient_balance` carries
  /// `shortPaise` / `balancePaise` in [ApiException.extra]. The same [requestKey] always returns the same order.
  /// The `X-Client: app` header makes the payment page come back to the app (`<scheme>://orders/<id>`).
  Future<CheckoutResult> checkout({
    required String productId,
    required String colour,
    required String size,
    required int qty,
    required MerchAddress address,
    required bool saveAddress,
    required String method,
    required String requestKey,
  }) async {
    final json = await _api.request(
      'POST',
      '$_base/checkout',
      body: {
        'productId': productId,
        'colour': colour,
        'size': size,
        'qty': qty,
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
    return CheckoutResult.fromJson(ApiClient.asMap(json));
  }

  Future<List<FanOrder>> myOrders() async {
    final j = await _api.getJson('$_base/my-orders');
    return [for (final m in _list(j['orders'])) FanOrder.fromJson(m)];
  }

  Future<FanOrder> myOrder(String id) async {
    final j = await _api.getJson('$_base/my-orders/${Uri.encodeComponent(id)}');
    return FanOrder.fromJson(_map(j['order']));
  }

  Future<List<SavedAddress>> addresses() async {
    final j = await _api.getJson('$_base/addresses');
    return [for (final m in _list(j['addresses'])) SavedAddress.fromJson(m)];
  }

  Future<void> deleteAddress(String id) async {
    await _api.deleteJson('$_base/addresses/${Uri.encodeComponent(id)}');
  }

  /// [kind] is `wrong` or `damaged`; [note] 10 to 1000 characters. Allowed once, within 48 hours of delivery.
  /// [photoKey] comes from [uploadProblemPhoto].
  Future<void> reportProblem(String orderId, {required String kind, required String note, String? photoKey}) async {
    await _api.postJson('$_base/my-orders/${Uri.encodeComponent(orderId)}/problem',
        body: {'kind': kind, 'note': note, if (photoKey != null && photoKey.isNotEmpty) 'photoKey': photoKey});
  }

  /// [HF-APP-PARITY-MERCH-1] Uploads the photo for a problem report (PNG, JPEG or WebP, at most 5 MB) and returns its `photoKey`.
  /// 413 `too_large`, 415 `unsupported_type`, 404 `not_found`, 429 when she tries too often.
  Future<String> uploadProblemPhoto(String orderId, Uint8List bytes, {required String contentType}) async {
    final j = await _api.postBytes('$_base/my-orders/${Uri.encodeComponent(orderId)}/problem-photo', bytes, contentType: contentType);
    final k = j['photoKey'];
    if (k is! String || k.isEmpty) throw StateError('photoKey missing');
    return k;
  }

  /// [HF-APP-PARITY-MERCH-1] Every order paid together from the bag (`mgp_...`). The server first asks the payment gateway
  /// when the group is still waiting, so this is also the payment-return poll.
  Future<FanGroup> myGroup(String groupId) async {
    final j = await _api.getJson('$_base/my-orders/${Uri.encodeComponent(groupId)}');
    return FanGroup.fromJson(_map(j['group']));
  }

  /// [HF-APP-PARITY-MERCH-1] The GST invoice PDF of a paid order. [receiptUrl] is the `receiptUrl` of the order (absolute); the file
  /// needs the sign-in token, so it is read through the API client and never opened as a plain link.
  Future<List<int>> receiptBytes(String receiptUrl) {
    final u = Uri.parse(receiptUrl);
    return _api.getBytes(u.hasQuery ? '${u.path}?${u.query}' : u.path);
  }

  // ---------------------------------------------------------------------------------------------- [HF-APP-PARITY-MERCH-1] GSTIN

  /// `GET /api/hf/merch/tax` -> `{gstin: string | null}`. Optional, recorded only.
  Future<String?> gstin() async {
    final g = (await _api.getJson('$_base/tax'))['gstin'];
    return g is String && g.isNotEmpty ? g : null;
  }

  /// `PUT /api/hf/merch/tax {gstin}`; an empty string removes it. 400 `invalid_gstin`. Returns what the server kept.
  Future<String?> saveGstin(String gstin) async {
    final g = (await _api.putJson('$_base/tax', body: {'gstin': gstin}))['gstin'];
    return g is String && g.isNotEmpty ? g : null;
  }

  // ---------------------------------------------------------------------------------------------- helpers

  /// A fresh id for one checkout attempt; reusing it on a retry makes the server return the same order.
  static String newRequestKey() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'app-merch-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }

  /// Plain ASCII, at most 80 characters, never empty.
  @visibleForTesting
  static String asciiName(String raw) {
    final cleaned = raw.replaceAll(RegExp(r'[^A-Za-z0-9._\- ]+'), '_').trim();
    final cut = cleaned.length > 80 ? cleaned.substring(0, 80) : cleaned;
    return cut.isEmpty ? 'art' : cut;
  }

  static Map<String, dynamic> _map(Object? v) {
    if (v is Map) return Map<String, dynamic>.from(v);
    return <String, dynamic>{};
  }

  static List<Map<String, dynamic>> _list(Object? v) =>
      v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const <Map<String, dynamic>>[];
}
