import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/theme.dart';
import 'package:hf_app/demo/verified_tick.dart';

// [HF-VERIFIED-BLIP-1] The tick beside a creator's name: green for Video KYC, lavender for channel only, nothing otherwise.
Widget _wrap(Widget w) => MaterialApp(home: Scaffold(body: Center(child: w)));

void main() {
  testWidgets('no tick when only the phone is checked', (tester) async {
    await tester.pumpWidget(_wrap(const VerifiedTick(name: 'Sana M', videoKyc: false, channel: false, phone: true, surface: 'test')));
    expect(find.byType(Icon), findsNothing);
  });

  testWidgets('Video KYC tick is green and opens the checks sheet', (tester) async {
    await tester.pumpWidget(_wrap(const VerifiedTick(name: 'Priya Sharma', videoKyc: true, channel: false, phone: true, space: 'women', surface: 'test')));
    final box = tester.widget<Container>(find.descendant(of: find.byType(VerifiedTick), matching: find.byType(Container)).first);
    expect((box.decoration as BoxDecoration).color, C.kycGreen);
    await tester.tap(find.byType(VerifiedTick));
    await tester.pumpAndSettle();
    expect(find.text('Priya is verified'), findsOneWidget);
    expect(find.text('Video KYC'), findsOneWidget);
    expect(find.text('WhatsApp number'), findsOneWidget);
    expect(find.text('Women-only channel'), findsOneWidget);
  });

  testWidgets('channel-only tick is lavender, and still ticks do not open a sheet', (tester) async {
    await tester.pumpWidget(_wrap(nameWithTick('Humphrey Davy', style: t(17), videoKyc: false, channel: true, surface: 'test', interactive: false)));
    final box = tester.widget<Container>(find.descendant(of: find.byType(VerifiedTick), matching: find.byType(Container)).first);
    expect((box.decoration as BoxDecoration).color, C.lav);
    await tester.tap(find.byType(VerifiedTick));
    await tester.pumpAndSettle();
    expect(find.textContaining('is verified'), findsNothing);
  });
}
