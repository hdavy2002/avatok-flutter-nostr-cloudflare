import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/merch.dart';
import 'package:hf_app/demo/merch_parity_kit.dart';
import 'package:hf_app/demo/share_page_kit.dart';

/// [HF-APP-PARITY-MERCH-1] The pure pieces of the merch parity work: GSTIN pattern, wallet wording, share links, bag groups.
void main() {
  test('GSTIN pattern accepts a real shape and rejects junk', () {
    expect(MerchGstinCard.pattern.hasMatch('27ABCDE1234F1Z5'), isTrue);
    expect(MerchGstinCard.pattern.hasMatch('27abcde1234f1z5'), isFalse);
    expect(MerchGstinCard.pattern.hasMatch('123'), isFalse);
  });

  test('low wallet wording names the shortfall and the test-credit rule', () {
    const plain = ApiException(kind: ApiFailure.http, status: 402, code: 'insufficient_balance', extra: {'shortPaise': 25000});
    expect(merchLowBalanceText(plain), contains('₹250'));
    expect(merchLowBalanceText(plain), isNot(contains('test credit')));
    const testOnly = ApiException(kind: ApiFailure.http, status: 402, code: 'insufficient_balance', extra: {'testCreditNotUsable': true});
    expect(merchLowBalanceText(testOnly), contains('test credit'));
  });

  test('checkout errors map to the website sentences', () {
    const off = ApiException(kind: ApiFailure.http, status: 403, code: 'checkout_off');
    expect(merchCheckoutErrorText(off), 'Buying opens soon.');
    const gst = ApiException(kind: ApiFailure.http, status: 403, code: 'gst_not_ready');
    expect(merchCheckoutErrorText(gst), contains('Nothing was charged'));
  });

  test('share links carry utm_source=share and the network', () {
    expect(sharedPageUrl('priya', 'whatsapp'), contains('utm_source=share&utm_medium=whatsapp'));
    expect(whatsappShareHref('priya', 'Hi'), startsWith('https://wa.me/?text='));
    expect(xShareHref('priya', 'Hi'), contains('utm_medium%3Dx'));
    expect(facebookShareHref('priya'), contains('utm_medium%3Dfacebook'));
  });

  test('a bag group parses and knows when it is still waiting', () {
    final g = FanGroup.fromJson({
      'groupId': 'mgp_1',
      'status': 'awaiting_payment',
      'totalPaise': 90000,
      'orders': [
        {'id': 'shp_1', 'orderNo': 'A1', 'createdAt': 1, 'status': 'awaiting_payment', 'groupId': 'mgp_1', 'product': {'title': 'Tee', 'qty': 1}},
      ],
    });
    expect(g.awaitingPayment, isTrue);
    expect(g.orders.single.groupId, 'mgp_1');
    expect(g.allCancelled, isFalse);
  });
}
