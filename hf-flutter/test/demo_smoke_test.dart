import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/state.dart';
import 'package:hf_app/demo/theme.dart';

void main() {
  test('rupees use Indian grouping', () {
    expect(inr(124050.5), '₹1,24,050.50');
    expect(inr(-45, paise: false), '− ₹45');
  });

  test('top up credits paid ÷ 1.18 to the paisa', () {
    expect(DemoState.creditFor(500), 423.72);
    expect(DemoState.creditFor(2), 1.69);
  });
}
