import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/channel_pop_kit.dart';
import 'package:hf_app/demo/screens/bag.dart';
import 'package:hf_app/demo/screens/merch_product.dart';

/// The fan-side merch gaps closed against the website: size guide chart, states list, last pincode, sold-out tile.
void main() {
  test('size guide is the website chart', () {
    expect(kMerchSizeChart.first, ('S', 38, 27));
    expect(kMerchSizeChart.last, ('3XL', 48, 32));
    expect(kMerchSizeChart.length, 6);
  });

  test('state list matches the website (36 entries, no repeats)', () {
    expect(kIndianStates.length, 36);
    expect(kIndianStates.toSet().length, 36);
    expect(kIndianStates, contains('Uttarakhand'));
  });

  test('last pincode keeps only valid pincodes', () {
    MerchLastPincode.value = null;
    MerchLastPincode.remember('12');
    expect(MerchLastPincode.value, isNull);
    MerchLastPincode.remember(' 248001 ');
    expect(MerchLastPincode.value, '248001');
    MerchLastPincode.value = null;
  });

  testWidgets('a sold-out tile shows a Sold out pill and no Add button', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 200,
          child: GpProductCard(title: 'Tee', categoryLabel: 'T-shirts', priceText: '₹599', imageUrl: null, onTap: () {}, onAdd: () {}, soldOut: true),
        ),
      ),
    ));
    expect(find.text('Sold out'), findsOneWidget);
    expect(find.text('Add'), findsNothing);
  });
}
