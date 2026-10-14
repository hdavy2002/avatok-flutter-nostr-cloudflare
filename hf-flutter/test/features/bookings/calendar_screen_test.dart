import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/features/bookings/ui/customer_bookings_screen.dart';
import 'package:hf_app/features/bookings/ui/host_booking_summary_card.dart';
import 'package:hf_app/features/bookings/data/hf_booking_models.dart';
import 'package:hf_app/features/bookings/data/hf_bookings_providers.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

void main() {
  testWidgets('summary on calendar cannot reopen itself; dashboard remains tappable', (tester) async {
    Future<void> pumpSummary(bool tappable) => tester.pumpWidget(ProviderScope(
      overrides: [hostBookingSummaryProvider.overrideWith((ref) async => const BookingSummary())],
      child: MaterialApp(home: Scaffold(body: HostBookingSummaryCard(openCalendarOnTap: tappable))),
    ));
    await pumpSummary(false);
    await tester.pumpAndSettle();
    final summaryInk = find.descendant(of: find.byType(HostBookingSummaryCard), matching: find.byType(InkWell));
    expect(tester.widget<InkWell>(summaryInk).onTap, isNull);
    await pumpSummary(true);
    await tester.pumpAndSettle();
    expect(tester.widget<InkWell>(summaryInk).onTap, isNotNull);
  });

  testWidgets('320dp large text calendar navigates month and Today without overflow', (tester) async {
    tester.view.physicalSize = const Size(320, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeApiClient()..onJson('GET', '/api/hf/bookings', {'bookings': []});
    await tester.pumpWidget(ProviderScope(overrides: [
      apiClientProvider.overrideWithValue(api),
      sessionProvider.overrideWith(() => StubSession(const SessionState(
        status: SessionStatus.signedIn, user: ClerkUser(id: 'calendar-user')))),
      flagsProvider.overrideWith((ref) async => HfFlags.fromJson({'hfBookingsEnabled': true})),
    ], child: MaterialApp(builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(2), disableAnimations: true),
      child: child!), home: const CustomerBookingsScreen())));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.textContaining('Times shown in device local time'), findsOneWidget);
    final firstRange = api.calls.last.query?['from'];
    await tester.tap(find.byTooltip('Next month'));
    await tester.pumpAndSettle();
    expect(api.calls.last.query?['from'], isNot(firstRange));
    await tester.tap(find.text('Today'));
    await tester.pumpAndSettle();
    expect(api.calls.last.query?['from'], firstRange);
    expect(tester.takeException(), isNull);
  });

  testWidgets('disabled calendar never requests booking data', (tester) async {
    final api = FakeApiClient();
    await tester.pumpWidget(ProviderScope(overrides: [
      apiClientProvider.overrideWithValue(api),
      sessionProvider.overrideWith(() => StubSession(const SessionState(
        status: SessionStatus.signedIn, user: ClerkUser(id: 'calendar-user')))),
      flagsProvider.overrideWith((ref) async => HfFlags.unknown),
    ], child: const MaterialApp(home: CustomerBookingsScreen())));
    await tester.pumpAndSettle();
    expect(find.textContaining('Bookings are not available yet'), findsOneWidget);
    expect(api.calls, isEmpty);
  });
}
