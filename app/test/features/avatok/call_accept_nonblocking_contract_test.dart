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
    final acceptStart = source.indexOf(
      'static Future<void> acceptRingingCall(String callId',
    );
    final acceptEnd = source.indexOf(
      'static Future<String?> _claimHumanAccept',
      acceptStart,
    );
    expect(acceptStart, greaterThanOrEqualTo(0));
    expect(acceptEnd, greaterThan(acceptStart));
    final acceptFlow = source.substring(acceptStart, acceptEnd);
    expect(
      acceptFlow.indexOf('unawaited(_finishAcceptedRing(callId))'),
      lessThan(acceptFlow.indexOf('await _claimHumanAccept(callId)')),
      reason: 'the Android ring must close before the accept network claim',
    );
    expect(
      acceptFlow,
      contains('if (openExtra == null)'),
      reason: 'the branded push payload must skip the native lookup delay',
    );
    // The contract is that the activeCalls() lookup is TIME-BOXED at 900 ms, so
    // a wedged OEM call-service bridge can never hold up an accepted call.
    // Matched whitespace-insensitively on purpose: the previous version pinned
    // the exact indentation of the continuation line, so simply moving this call
    // inside the `if (openExtra == null)` guard above — a behaviour improvement,
    // not a contract change — reindented it by two spaces and failed the build.
    // A contract test should assert the contract, not the layout.
    expect(
      source,
      matches(RegExp(r'activeCalls\(\)\s*\.timeout\(const Duration\(milliseconds: 900\)\)')),
      reason: 'the native activeCalls lookup must stay time-boxed at 900ms',
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
