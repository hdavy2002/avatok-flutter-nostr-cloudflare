import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/merch_art_picker.dart';
import 'package:hf_app/data/models/merch.dart';
import 'package:hf_app/demo/merch_kit.dart';

/// [HF-MERCH-PARITY-1] Studio side: the cap sentence, the royalty note, the product card fields and the picker hooks.
void main() {
  test('cap hint uses the server numbers and falls back to the old sentence', () {
    expect(merchCapHintFor(), merchCapHint);
    expect(merchCapHintFor(capPaise: 300000, gstBps: 1200), 'Clothing is capped at ₹3,000 so the 12% GST rate applies.');
    expect(merchCapHintFor(capPaise: 250000), 'Clothing is capped at ₹2,500 so the 5% GST rate applies.');
  });

  test('over_price_cap text carries the real cap', () {
    const e = ApiException(kind: ApiFailure.http, status: 422, code: 'over_price_cap', extra: {'maxMarkupRupees': 900});
    expect(merchErrorText(e, capPaise: 300000, gstBps: 1200), contains('₹3,000'));
    expect(merchErrorText(e, capPaise: 300000, gstBps: 1200), contains('₹900'));
  });

  test('royalty note shows the influencer share and the hold days', () {
    expect(merchRoyaltyNote(shareBps: 4000, holdDays: 7), 'Your design royalty is 60% of your markup, withdrawable 7 days after delivery.');
  });

  test('a product carries its catalogue name', () {
    final p = MerchProduct.fromJson({'id': 'p1', 'catalogName': 'Classic T-shirt', 'colours': [{'name': 'White', 'hex': '#ffffff'}]});
    expect(p.catalogName, 'Classic T-shirt');
    expect(p.colours.length, 1);
    expect(MerchProduct.fromJson({'id': 'p2'}).catalogName, '');
  });

  test('style chips and examples: twelve styles, six examples, no peacock', () {
    expect(merchAiStyles.length, 12);
    expect(merchAiExamples.length, 6);
    expect(merchAiExamples.any((e) => e.toLowerCase().contains('peacock')), isFalse);
  });

  test('pickMany falls back to the one-picture hook', () async {
    final before = MerchArtPicker.picker;
    MerchArtPicker.picker = () async => PickedArt(bytes: Uint8List.fromList([1, 2, 3]), name: 'a.png', mime: 'image/png');
    final many = await MerchArtPicker.pickMany();
    expect(many.length, 1);
    expect(many.first.name, 'a.png');
    expect((await MerchArtPicker.pick(allowWebp: true))?.name, 'a.png');
    MerchArtPicker.picker = before;
  });
}
