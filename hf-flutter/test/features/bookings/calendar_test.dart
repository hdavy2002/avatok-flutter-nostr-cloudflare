import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/bookings/data/hf_booking_models.dart';
import 'package:hf_app/features/bookings/data/hf_bookings_api.dart';
import 'package:hf_app/features/bookings/data/hf_bookings_providers.dart';

import '../../support/fake_api_client.dart';

void main() {
  final from = DateTime(2026, 10);
  final to = DateTime(2026, 11);
  Map<String, Object> row(String id) => {
    'id': id, 'status': 'confirmed',
    'startUtc': DateTime(2026, 10, 12, 23, 30).toUtc().toIso8601String(),
    'endUtc': DateTime(2026, 10, 13, 0, 30).toUtc().toIso8601String(),
  };

  test('calendar follows cursors, deduplicates and supplies overlap range', () async {
    final api = FakeApiClient()..on('GET', '/api/hf/bookings', (call) {
      expect(call.query?['role'], 'customer');
      expect(call.query?['from'], from.toUtc().toIso8601String());
      expect(call.query?['to'], to.toUtc().toIso8601String());
      return call.query?['cursor'] == null
          ? {'bookings': [row('one')], 'nextCursor': 'page2'}
          : {'bookings': [row('one'), row('two')]};
    });
    final rows = await HfBookingsApi(api).calendar(role: 'customer', from: from,
      to: to, isCurrent: () => true);
    expect(rows.map((r) => r.id), ['one', 'two']);
    expect(api.calls.length, 2);
  });

  test('repeated cursor fails rather than presenting an incomplete month', () async {
    final api = FakeApiClient()..onJson('GET', '/api/hf/bookings',
      {'bookings': [row('one')], 'nextCursor': 'same'});
    await expectLater(HfBookingsApi(api).calendar(role: 'host', from: from,
      to: to, isCurrent: () => true), throwsA(isA<ApiError>()));
    expect(api.calls.length, 2);
  });

  test('account or range disposal stops paging and drops late response', () async {
    final response = Completer<Object?>();
    final api = FakeApiClient()..on('GET', '/api/hf/bookings', (_) => response.future);
    var active = true;
    final pending = HfBookingsApi(api).calendar(role: 'host', from: from,
      to: to, isCurrent: () => active);
    active = false;
    response.complete({'bookings': [row('private')], 'nextCursor': 'next'});
    expect(await pending, isEmpty);
    expect(api.calls.length, 1);
  });

  test('cross-midnight appointment appears on both days, end is exclusive', () {
    final booking = BookingRecord.fromJson(row('overnight'));
    expect(bookingOverlapsDay(booking, DateTime(2026, 10, 12)), isTrue);
    expect(bookingOverlapsDay(booking, DateTime(2026, 10, 13)), isTrue);
    expect(bookingOverlapsDay(booking, DateTime(2026, 10, 14)), isFalse);
    final midnightEnd = BookingRecord(id: 'midnight', status: 'confirmed',
      startUtc: DateTime(2026, 10, 12, 23).toUtc(),
      endUtc: DateTime(2026, 10, 13).toUtc());
    expect(bookingOverlapsDay(midnightEnd, DateTime(2026, 10, 13)), isFalse);
  });
}
