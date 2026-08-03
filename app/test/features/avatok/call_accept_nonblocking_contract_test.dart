import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('branded Accept never waits while every ring action is disabled', () {
    final source = File(
      'lib/features/avatok/incoming_business_call_screen.dart',
    ).readAsStringSync();

    final start = source.indexOf('void _accept()');
    final end = source.indexOf('Future<void> _completeAccept', start);
    expect(start, greaterThanOrEqualTo(0));
    expect(end, greaterThan(start));
    final acceptBody = source.substring(start, end);

    expect(acceptBody, contains('unawaited(_completeAccept(callId, extra))'));
    expect(
      acceptBody,
      isNot(contains('await PushService.acceptRingingCall')),
    );
    expect(
      acceptBody,
      contains("_dismiss(reason: 'accept', status: 'accepted')"),
    );
  });

  test('native accept bridges are time-boxed and synthetic decline is guarded',
      () {
    final source = File('lib/push/push_service.dart').readAsStringSync();

    expect(source, contains('_programmaticCallkitEnd.mark(callId)'));
    expect(
      source,
      contains(
          'activeCalls()\n          .timeout(const Duration(milliseconds: 900))'),
    );
    expect(source, contains("Analytics.capture('call_accept_open_scheduled'"));
    expect(source, contains("Analytics.capture('call_accept_screen_opened'"));
    expect(
      source,
      contains(
          '.prepareForAccept(room)\n            .timeout(const Duration(seconds: 5))'),
    );
  });
}
