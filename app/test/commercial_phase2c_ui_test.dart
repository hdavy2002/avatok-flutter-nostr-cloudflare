import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:avatok_call/core/commercial_checkout_api.dart';
import 'package:avatok_call/core/commercial_calendar_api.dart';
import 'package:avatok_call/core/commercial_notification.dart';
import 'package:avatok_call/core/commercial_sessions_api.dart';
import 'package:avatok_call/features/booking/commercial_customer_screens.dart';
import 'package:avatok_call/features/explore/commercial_checkout_sheets.dart';
import 'package:avatok_call/core/listings_api.dart';

void main() {
  test('checkout response retains server amount, insufficient balance and replay', () {
    final result = CommercialCheckoutResult.fromResponse(200, '''{
      "ok": true,
      "kind": "live_event",
      "listing_id": "live-1",
      "order_id": "order-1",
      "gross_amount": 1200,
      "currency": "TOKENS",
      "idempotent_replay": true
    }''');
    expect(result.ok, isTrue);
    expect(result.kind, 'live_event');
    expect(result.grossAmount, 1200);
    expect(result.idempotentReplay, isTrue);

    final insufficient = CommercialCheckoutResult.fromResponse(
      402,
      '{"error":"insufficient_funds","needed":1200,"balance":400}',
    );
    expect(insufficient.ok, isFalse);
    expect(insufficient.needed, 1200);
    expect(insufficient.balance, 400);
  });

  test('a network retry reuses the caller-owned checkout idempotency key', () async {
    final key = CommercialCheckoutApi.newIdempotencyKey();
    final sentKeys = <String>[];
    var attempt = 0;
    CommercialCheckoutApi.debugPostOverride = (url, body, headers) async {
      sentKeys.add(headers['Idempotency-Key']!);
      attempt++;
      if (attempt == 1) throw StateError('simulated network failure');
      return http.Response(
        '{"ok":true,"kind":"live_event","idempotent_replay":true}',
        200,
      );
    };
    addTearDown(() => CommercialCheckoutApi.debugPostOverride = null);

    final first = await CommercialCheckoutApi.liveTicket(
      listingId: 'live-1',
      acceptPolicy: true,
      idempotencyKey: key,
    );
    final second = await CommercialCheckoutApi.liveTicket(
      listingId: 'live-1',
      acceptPolicy: true,
      idempotencyKey: key,
    );

    expect(first.error, 'network');
    expect(second.idempotentReplay, isTrue);
    expect(sentKeys, [key, key]);
  });

  test('session buckets use server-anchored join windows and settlement state', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    final session = CommercialSessionRecord.fromJson(
      {
        'entitlement_id': 'e1',
        'kind': 'live_event',
        'listing_id': 'l1',
        'title': 'Event',
        'entitlement_state': 'held',
        'order_status': 'held',
        'starts_at': now - 1000,
        'ends_at': now + 600000,
        'opens_at': now - 60000,
        'closes_at': now + 600000,
        'session_state': 'live',
      },
      serverNow: now,
      fetchedAt: now,
    );
    expect(session.isJoinWindowOpen, isTrue);
    expect(session.isLiveNow, isTrue);
    expect(session.bucket, CommercialSessionBucket.liveNow);
  });

  test('calendar add result distinguishes idempotent replay from conflict', () {
    final added = CommercialCalendarResult.fromResponse(
      200,
      '{"ok":true,"calendar_event_id":"event-1","already_added":true}',
    );
    expect(added.ok, isTrue);
    expect(added.alreadyAdded, isTrue);
    expect(added.eventId, 'event-1');

    final conflict = CommercialCalendarResult.fromResponse(
      409,
      '{"error":"calendar_conflict","conflict":true}',
    );
    expect(conflict.ok, isFalse);
    expect(conflict.conflict, isTrue);
  });

  test('commercial notification deep links retain stable ids and reject credentials', () {
    final payload = CommercialNotificationPayload.fromData({
      'type': 'commercial_receipt',
      'listing_id': 'live-1',
      'booking_id': 'booking-1',
      'title': 'Creator event',
    });
    expect(payload, isNotNull);
    expect(payload!.toPayload(), contains('listing_id'));
    expect(payload.toPayload(), contains('booking_id'));
    expect(payload.toPayload(), isNot(contains('token')));
    final roundTrip = CommercialNotificationPayload.fromPayload(payload.toPayload());
    expect(roundTrip?.bookingId, 'booking-1');
    expect(
      CommercialNotificationPayload.fromData({
        'type': 'commercial_receipt',
        'listing_id': 'live-1',
        'call_id': 'provider-room',
      }),
      isNull,
    );
  });

  testWidgets('customer recovery stays available while join flags remain gated', (tester) async {
    // Retrieval is intentionally independent from discovery/purchase flags, so
    // existing tickets remain recoverable after a capability is paused. Join
    // admission still checks the per-kind kill switches before opening a room.
    final source = File('lib/features/booking/commercial_customer_screens.dart').readAsStringSync();
    expect(source, contains('bool get _enabled => true;'));
    expect(source, contains("CommercialSessionsApi.mineAll(role: 'customer')"));
    expect(source, contains('RemoteConfig.commercialLiveJoinEnabled'));
    expect(source, contains('RemoteConfig.commercialConsultJoinEnabled'));
  });

  testWidgets('booking success shows account-bound receipt reference and calendar action', (tester) async {
    final result = const CommercialCheckoutResult(
      status: 200,
      ok: true,
      kind: 'consult_1to1',
      orderId: 'order-1',
      policySnapshotId: 'policy-1',
      grossAmount: 500,
      currency: 'TOKENS',
      startsAt: 1763942400000,
    );
    var calendarCalled = false;
    await tester.pumpWidget(MaterialApp(
      home: BookingSuccessScreen(
        result: result,
        onAddToCalendar: (_) async => calendarCalled = true,
      ),
    ));
    expect(find.text('Receipt reference'), findsOneWidget);
    expect(find.text('Add to calendar'), findsOneWidget);
    await tester.tap(find.text('Add to calendar'));
    expect(calendarCalled, isTrue);
  });

  testWidgets('checkout sheet requires policy consent and remains disabled when checkout flag is off', (tester) async {
    final listing = ListingCard.fromJson({
      'id': 'l1',
      'kind': 'live_event',
      'title': 'Event',
      'price': 100,
      'effective_price': 100,
      'currency_display': 'TOKENS',
      'creator': {'uid': 'creator'},
      'attrs': {'commercial_refund_window_hours': 24},
    });
    await tester.pumpWidget(MaterialApp(home: LiveCheckoutSheet(listing: listing)));
    await tester.pump();
    expect(find.text('Commercial checkout is not available yet.'), findsOneWidget);
    expect(find.text('Confirm & pay'), findsNothing);
  });
}
