import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/screens/call_real.dart';

void main() {
  testWidgets('AGE-04 age recovery requires affirmative action and never retries a transaction', (tester) async {
    var acknowledgements = 0;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Builder(builder: (context) => TextButton(
      onPressed: () => recoverHfAgeConfirmation(context, acknowledge: () async { acknowledgements++; }),
      child: const Text('Recover'),
    )))));
    await tester.tap(find.text('Recover'));
    await tester.pumpAndSettle();
    expect(acknowledgements, 0);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(acknowledgements, 0);
    await tester.tap(find.text('Recover'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('I am 18 or older'));
    await tester.pumpAndSettle();
    expect(acknowledgements, 1);
    expect(find.textContaining('Please try your call or booking again.'), findsOneWidget);
  });
}
