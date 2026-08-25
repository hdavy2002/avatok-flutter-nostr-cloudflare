import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/core/listings_api.dart';
import '../lib/features/listings/creator_receipt_summary_screen.dart';

void main() {
  test('commercial receipt parser keeps the immutable money split', () {
    final receipt = CommercialReceipt.fromJson({
      'receipt_id': 'commercial:receipt:order-1',
      'commercial_session_id': 'live_listing-1_1',
      'order_id': 'order-1',
      'listing_id': 'listing-1',
      'creator_id': 'creator-1',
      'kind': 'live_event',
      'gross_amount': 1500,
      'platform_fee_amount': 300,
      'creator_amount': 1200,
      'currency': 'TOKENS',
      'settlement_state': 'settled',
      'connected_ms': 60000,
      'issued_at': 1763942400000,
    });

    expect(receipt.isSettled, isTrue);
    expect(receipt.isFinanciallyConsistent, isTrue);
    expect(receipt.creatorAmount, 1200);
    expect(receipt.issuedAt.isUtc, isTrue);
  });

  test('receipt summary excludes malformed and unsettled rows from totals', () {
    final settled = CommercialReceipt.fromJson({
      'receipt_id': 'r1',
      'commercial_session_id': 'live_l_1',
      'order_id': 'o1',
      'listing_id': 'l',
      'kind': 'live_event',
      'gross_amount': 1000,
      'platform_fee_amount': 200,
      'creator_amount': 800,
      'currency': 'TOKENS',
      'settlement_state': 'settled',
    });
    final malformed = CommercialReceipt.fromJson({
      'receipt_id': 'r2',
      'commercial_session_id': 'live_l_1',
      'order_id': 'o2',
      'listing_id': 'l',
      'kind': 'live_event',
      'gross_amount': 1000,
      'platform_fee_amount': 100,
      'creator_amount': 950,
      'currency': 'TOKENS',
      'settlement_state': 'settled',
    });
    final pending = CommercialReceipt.fromJson({
      'receipt_id': 'r3',
      'commercial_session_id': 'live_l_1',
      'order_id': 'o3',
      'listing_id': 'l',
      'kind': 'live_event',
      'gross_amount': 1000,
      'platform_fee_amount': 200,
      'creator_amount': 800,
      'currency': 'TOKENS',
      'settlement_state': 'review_pending',
    });

    final summary = CommercialReceiptSummary.fromReceipts([settled, malformed, pending]);
    expect(summary.settledReceipts, hasLength(1));
    expect(summary.creatorAmountByCurrency['TOKENS'], 800);
    expect(summary.platformFeeByCurrency['TOKENS'], 200);
    expect(summary.reviewPendingReceiptCount, 2);
    expect(summary.refundedReceiptCount, 0);
  });

  testWidgets('creator receipt UI stays closed while commercial flags are off', (tester) async {
    var loaderCalled = false;
    await tester.pumpWidget(MaterialApp(
      home: CreatorReceiptSummaryScreen(
        sessionIds: const ['live_listing-1_1'],
        loadReceipt: (_) async {
          loaderCalled = true;
          return const CommercialReceiptResponse(ready: true, receipts: []);
        },
      ),
    ));

    expect(find.text('Commercial earnings are unavailable while services are off.'), findsOneWidget);
    expect(loaderCalled, isFalse);
  });
}
