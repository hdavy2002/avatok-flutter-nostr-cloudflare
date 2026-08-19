import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  // [CALL-ACCEPT-GAP-1 2026-08-03] CONTRACT RESTATED, not relaxed.
  //
  // The original NONBLOCK-1 rule was written as "pop the ring screen
  // immediately", and this test pinned that MECHANISM literally. The mechanism
  // turned out to cause a worse bug than the one it fixed: popping before
  // CallScreen is pushed leaves a blank gap of 0.7-9s (two route animations with
  // dead air between them), which users reported as "the incoming call screen
  // disappears, I get confused, then it re-appears".
  //
  // The GUARANTEE behind NONBLOCK-1 is what matters and is unchanged: the user
  // must never be left looking at a ring screen where every action is dead and
  // nothing is happening. That is now met by holding the route only until the
  // call screen exists, with a hard bound and a visible connecting state —
  // rather than by popping into nothing.
  //
  // Per this file's own lesson below: assert the contract, not the layout.
  test('branded Accept is bounded, never open-ended', () {
    final source = File(
      'lib/features/avatok/incoming_business_call_screen.dart',
    ).readAsStringSync();

    final start = source.indexOf('void _accept()');
    final end = source.indexOf('Future<void> _completeAccept', start);
    expect(start, greaterThanOrEqualTo(0));
    expect(end, greaterThan(start));
    final acceptBody = source.substring(start, end);

    // The accept must never be awaited inline — a wedged platform Future must
    // not be able to block the tap handler itself.
    expect(acceptBody, contains('unawaited('));
    expect(acceptBody, contains('_completeAccept(callId, extra)'));
    expect(
      acceptBody,
      isNot(contains('await PushService.acceptRingingCall')),
      reason: 'the tap handler must not block on the network or the platform',
    );

    // Holding the ring route is allowed ONLY with a hard upper bound, so a
    // stalled accept can never strand the user on a dead screen.
    expect(
      acceptBody,
      matches(RegExp(r'\.timeout\(\s*const Duration\(milliseconds: \d+\)')),
      reason: 'the hold must be time-boxed — that bound IS the NONBLOCK-1 guarantee',
    );

    // However it resolves — success, timeout or error — the route must leave.
    expect(acceptBody, contains('.whenComplete('));
    expect(
      acceptBody,
      contains("_dismiss(reason: 'accept', status: 'accepted')"),
      reason: "status must be non-terminal, or accepting plants the terminal marker (PIV-3)",
    );

    // The accepted surface stays visually continuous with the ring surface.
    // Internal connection stages belong in telemetry, not in a progress screen.
    expect(
      source,
      isNot(contains("'Connecting…'")),
      reason: 'accept must not expose an intermediate connecting screen',
    );
    expect(source, contains("? 'AvaTOK audio call'"));
  });

  test('native accept bridges are time-boxed and synthetic decline is guarded',
      () {
    final source = File('lib/push/push_service.dart').readAsStringSync();

    expect(source, contains('_programmaticCallkitEnd.mark(callId)'));
    final acceptStart = source.indexOf(
      'static Future<void> acceptRingingCall(',
    );
    final acceptEnd = source.indexOf(
      'static Future<String?> _claimHumanAccept',
      acceptStart,
    );
    expect(acceptStart, greaterThanOrEqualTo(0));
    expect(acceptEnd, greaterThan(acceptStart));
    final acceptFlow = source.substring(acceptStart, acceptEnd);
    final finishRing =
        acceptFlow.indexOf('unawaited(_finishAcceptedRing(callId))');
    final openCall = acceptFlow.indexOf(
      'await _openCall(openExtra, claimPending: true)',
    );
    final trackClaim =
        acceptFlow.indexOf('unawaited(_trackClaimAfterOpen(callId))');
    expect(finishRing, greaterThanOrEqualTo(0));
    expect(openCall, greaterThan(finishRing),
        reason: 'the Android ring must close before CallScreen opens');
    expect(trackClaim, greaterThan(openCall),
        reason: 'CallScreen must open before the network claim is tracked');
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
    // Whitespace-insensitive for the same reason given above: prepareForAccept
    // is now guarded by `hasOtherLiveAudioSession` (it is a no-op on a clean
    // accept, so it no longer blocks the UI for nothing), which reindented it.
    // The contract is the 5s bound, not the indentation.
    expect(
      source,
      matches(RegExp(r'\.prepareForAccept\(room\)\s*\.timeout\(const Duration\(seconds: 5\)\)')),
      reason: 'the prior-session yield must stay time-boxed at 5s',
    );
    // ...and it must only be paid for when there is actually another audio
    // owner to yield. On a clean accept this loop has nothing to iterate, and
    // making every accept wait behind a 5s timeout for that was a large part of
    // the blank gap after the tap.
    expect(
      source,
      contains('hasOtherLiveAudioSession(room)'),
      reason: 'a clean accept must not pay for a yield that has nothing to yield',
    );
  });
}
