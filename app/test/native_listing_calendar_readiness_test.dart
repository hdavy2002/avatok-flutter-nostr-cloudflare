// [CAL-GCAL-1 2026-09-15] Regression tests for the Google readiness the wizard
// shows (AUDIT-2026-09-15 §5/A5: "Connected" does not mean ready).
//
// The rule under test: the additive fields (`ready`, `reason`,
// `last_success_at`) are honoured when the Worker sends them, and their ABSENCE
// yields "not confirmed" — never a healthy label. Publish, booking and preview
// all refuse while busy times cannot be verified, so an app that guessed would
// promise something the server will not honour.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/marketplace/native_listing/native_listing_gcal_readiness.dart';

Map<String, dynamic> _calendar({
  bool selected = true,
  Object? lastSuccessAt,
  Object? lastError,
}) =>
    <String, dynamic>{
      'id': 'cal@example.com',
      'summary': 'Work',
      'selected': selected,
      'last_success_at': lastSuccessAt,
      'last_error': lastError,
    };

void main() {
  group('new Worker payload (additive readiness fields)', () {
    test('ready:true with a fresh sync is the only healthy state', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'ready': true,
        'reason': null,
        'last_success_at': DateTime.now().millisecondsSinceEpoch - 60000,
        'calendars': <Map<String, dynamic>>[_calendar(lastSuccessAt: DateTime.now().millisecondsSinceEpoch)],
      });

      expect(readiness.state, NativeListingGcalState.ready);
      expect(readiness.ready, isTrue);
      expect(readiness.confirmedByServer, isTrue);
      expect(readiness.headline, 'Google Calendar is ready');
      expect(readiness.body, contains('1 minute ago'));
    });

    test('ready:true without ever syncing says so instead of claiming freshness', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'ready': true,
        'last_success_at': null,
        'calendars': <Map<String, dynamic>>[],
      });

      expect(readiness.state, NativeListingGcalState.ready);
      expect(readiness.lastSuccessAt, isNull);
      expect(readiness.body, contains('Busy events'));
    });

    test('every server reason maps to its own actionable line', () {
      const expected = <String, NativeListingGcalState>{
        'disconnected': NativeListingGcalState.notConnected,
        'no_selected_calendars': NativeListingGcalState.noSelectedCalendars,
        'pending': NativeListingGcalState.pending,
        'stale': NativeListingGcalState.stale,
        'error': NativeListingGcalState.error,
      };
      expected.forEach((reason, state) {
        final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
          'connected': true,
          'ready': false,
          'reason': reason,
        });
        expect(readiness.state, state, reason: reason);
        expect(readiness.ready, isFalse);
        expect(readiness.headline, isNotEmpty);
        expect(readiness.body, isNotEmpty);
      });
    });

    test('an unknown reason code is unknown, not ready', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'ready': false,
        'reason': 'some_future_reason_code',
      });
      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.ready, isFalse);
    });

    test('stale copy names the freshness window the server enforces', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'ready': false,
        'reason': 'stale',
      });
      expect(readiness.body, contains('30 minutes'));
    });

    test('a disconnected account is NOT ready even if the body says ready', () {
      // gcalAvailabilityReady() is called by the publish/booking paths with
      // requireConnected: true, so the wizard follows the publish rule.
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': false,
        'ready': true,
        'reason': 'disconnected',
      });
      expect(readiness.state, NativeListingGcalState.notConnected);
      expect(readiness.ready, isFalse);
    });
  });

  group('older Worker payload (no additive fields)', () {
    test('missing `ready` is never healthy', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'last_sync_at': DateTime.now().millisecondsSinceEpoch,
        'calendars': <Map<String, dynamic>>[
          _calendar(lastSuccessAt: DateTime.now().millisecondsSinceEpoch),
        ],
      });

      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.ready, isFalse);
      expect(readiness.confirmedByServer, isFalse);
      expect(readiness.headline, 'Google readiness is not confirmed');
      expect(readiness.body, contains('will not treat busy times as protected'));
    });

    test('last_success_at falls back to the OLDEST selected successful sync', () {
      final oldest = DateTime.now().millisecondsSinceEpoch - 900000;
      final newest = DateTime.now().millisecondsSinceEpoch - 60000;
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'calendars': <Map<String, dynamic>>[
          _calendar(lastSuccessAt: newest),
          _calendar(lastSuccessAt: oldest),
          _calendar(selected: false, lastSuccessAt: oldest - 100000),
        ],
      });

      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.lastSuccessAt, oldest, reason: 'a stale sibling must not be hidden by a fresh one');
    });

    test('a selected calendar that never synced yields no freshness at all', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'calendars': <Map<String, dynamic>>[
          _calendar(lastSuccessAt: DateTime.now().millisecondsSinceEpoch),
          _calendar(lastSuccessAt: null),
        ],
      });

      expect(readiness.lastSuccessAt, isNull);
      expect(readiness.detail, contains('first sync'));
    });

    test('a failed sync is surfaced as an error, still not ready', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'calendars': <Map<String, dynamic>>[_calendar(lastSuccessAt: 1, lastError: 'invalid_grant')],
      });

      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.detail, contains('error'));
      expect(readiness.body, isNot(contains('invalid_grant')),
          reason: 'server internals must not reach the creator');
    });

    test('an old-but-recent sync is still not promoted to ready', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'calendars': <Map<String, dynamic>>[
          _calendar(lastSuccessAt: DateTime.now().millisecondsSinceEpoch - 1000),
        ],
      });
      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.confirmedByServer, isFalse);
    });

    test('not connected is derived, but readiness stays unconfirmed', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{'connected': false});
      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.detail, contains('not connected'));
    });

    test('the server-authoritative last_success_at wins over the calendar rows', () {
      final readiness = NativeListingGcalReadiness.fromStatus(<String, dynamic>{
        'connected': true,
        'ready': false,
        'reason': 'pending',
        'last_success_at': null,
        'calendars': <Map<String, dynamic>>[
          _calendar(lastSuccessAt: DateTime.now().millisecondsSinceEpoch),
        ],
      });
      expect(readiness.lastSuccessAt, isNull);
    });
  });

  group('unreadable status', () {
    test('an empty or missing body is unknown, never ready', () {
      for (final status in <Map<String, dynamic>?>[null, <String, dynamic>{}]) {
        final readiness = NativeListingGcalReadiness.fromStatus(status);
        expect(readiness.state, NativeListingGcalState.unknown);
        expect(readiness.ready, isFalse);
      }
    });

    test('a failed fetch is unknown', () {
      final readiness = NativeListingGcalReadiness.unavailable('The app could not read your Google Calendar status.');
      expect(readiness.state, NativeListingGcalState.unknown);
      expect(readiness.ready, isFalse);
      expect(readiness.body, contains('could not read'));
    });

    test('every non-ready state explains how to fix it', () {
      for (final state in NativeListingGcalState.values) {
        if (state == NativeListingGcalState.ready) continue;
        final readiness = NativeListingGcalReadiness(state: state);
        expect(readiness.ready, isFalse);
        expect(readiness.body.length, greaterThan(20), reason: state.name);
      }
    });
  });
}
