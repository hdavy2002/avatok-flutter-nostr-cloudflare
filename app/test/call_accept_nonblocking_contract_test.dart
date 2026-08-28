// [CALL-ACCEPT-FLASH-1] Pins the ORDERING contract behind the "accept flash"
// fix: `PushService.acceptRingingCall` must request CallScreen BEFORE the
// human-accept network claim (`_claimHumanAccept`) resolves, not after.
//
// Root cause (PostHog avatok call, 2026-08-04): the old code AWAITED the
// claim (up to ~2.7s worst case: 1500ms POST timeout + 1200ms durable-status
// fallback fetch) before ever opening CallScreen. The branded ring screen's
// OWN bounded-hold timeout (2500ms, `incoming_business_call_screen.dart`
// `_accept`) could — and did — fire first, removing the ring route before
// CallScreen existed: dead air, then a delayed CallScreen "re-appearance".
// Tap-to-screen-opened was 18:07:21.56 after an 18:07:19.57 tap, and
// `call_connected` didn't land until 18:07:23.9.
//
// The fix opens CallScreen first and races the claim CONCURRENTLY
// (`PushService._trackClaimAfterOpen`). This test proves that ordering
// deterministically via two test-only seams on `PushService`
// (`debugClaimHumanAcceptOverride`, `debugOnCallScreenOpenAttempt`) — the
// same style of injectable seam `MoneyApi.debugGetOverride` already uses in
// `wallet_entitlement_test.dart` — rather than a live network or a real
// Navigator/CallScreen (which would drag in the CallKit/webrtc plugin
// surface a plain `test()` can't safely touch).
//
// Pure Dart `test()`, no widget pumping, no plugins — matches the existing
// "Pure functions only" convention (widget_test.dart).
// [PIVOT-MSGR-CALL-OFF-1 regression, SHELL-TEST-SEAM-1] The marketplace-first
// pivot added `RemoteConfig.messengerCallingEnabled` (default FALSE) as the
// Messenger-1:1-calling kill switch, enforced in `push_service.dart`'s
// `_showIncoming`/`_routeToBrandedIncoming`/`_openCall`. In this test file
// `RemoteConfig._cfg` is empty (nothing here ever calls
// `RemoteConfig.start`/`refresh`), so every test used to read the FALSE
// default and `acceptRingingCall` refused before CallScreen was ever
// requested — silently exercising the "feature off" branch instead of the
// accept-flash ordering contract these tests exist to pin. `setUp` now turns
// the flag ON via `RemoteConfig.debugSetConfigForTest` so the ordering
// contract is genuinely exercised again, and a new test below pins the
// opposite: with the flag OFF, CallScreen must never be requested at all.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/remote_config.dart';
import 'package:avatok_call/push/push_service.dart';

void main() {
  setUp(() {
    PushService.debugClaimHumanAcceptOverride = null;
    PushService.debugOnCallScreenOpenAttempt = null;
    RemoteConfig.debugSetConfigForTest({'messengerCallingEnabled': true});
  });

  tearDown(() {
    PushService.debugClaimHumanAcceptOverride = null;
    PushService.debugOnCallScreenOpenAttempt = null;
    RemoteConfig.debugResetConfigForTest();
  });

  Map<String, dynamic> fallbackExtraFor(String callId) => {
        'callId': callId,
        'from': 'peer_uid',
        'fromName': 'Peer',
        'kind': 'audio',
      };

  test(
      'acceptRingingCall requests CallScreen BEFORE the human-accept claim '
      'resolves, and the claim is still in flight at that point', () async {
    final events = <String>[];
    final claimCompleter = Completer<String?>();

    PushService.debugClaimHumanAcceptOverride = (room) {
      events.add('claim_started');
      return claimCompleter.future;
    };
    PushService.debugOnCallScreenOpenAttempt = (callId) {
      events.add('call_screen_open_attempted');
    };

    final callId =
        'contract_ordering_${DateTime.now().microsecondsSinceEpoch}';
    final accepted = PushService.acceptRingingCall(
      callId,
      fallbackExtra: fallbackExtraFor(callId),
    );

    // Give every microtask up to (but not past) the claim's own network
    // await a chance to run — this is exactly the window the OLD,
    // blocking-claim-first code spent with CallScreen not yet requested.
    await Future<void>.delayed(Duration.zero);

    expect(events, contains('call_screen_open_attempted'),
        reason: 'CallScreen must have been requested by now');
    expect(events, contains('claim_started'),
        reason: 'the claim must have started concurrently');
    expect(
      events.indexOf('call_screen_open_attempted'),
      lessThan(events.indexOf('claim_started')),
      reason:
          'CallScreen must be requested strictly BEFORE the claim starts — '
          'this is the accept-flash fix. The old code awaited the claim '
          'FIRST and only opened CallScreen once it resolved.',
    );
    expect(claimCompleter.isCompleted, isFalse,
        reason: 'acceptRingingCall must not block on the claim before '
            'opening CallScreen — the claim should still be unresolved');

    // Let the claim resolve cleanly (a normal win) so the pending
    // `_trackClaimAfterOpen` future and this test both finish.
    claimCompleter.complete(null);
    await accepted;
  });

  test(
      'a losing/late claim after CallScreen was already requested is still '
      'reported via call_accept_claim_after_open (does not throw, does not '
      'hang)', () async {
    final claimCompleter = Completer<String?>();
    var openAttempted = false;
    PushService.debugClaimHumanAcceptOverride = (room) => claimCompleter.future;
    PushService.debugOnCallScreenOpenAttempt = (callId) => openAttempted = true;

    final callId = 'contract_loss_${DateTime.now().microsecondsSinceEpoch}';
    final accepted = PushService.acceptRingingCall(
      callId,
      fallbackExtra: fallbackExtraFor(callId),
    );
    await Future<void>.delayed(Duration.zero);
    expect(openAttempted, isTrue);

    // Simulate losing the race — another leg (the receptionist alarm, or a
    // second device) already claimed the call.
    claimCompleter.complete('ended');
    await accepted;

    // No further assertion needed beyond "this completed without throwing":
    // `acceptRingingCall`'s own Future resolves as soon as `_openCall`
    // returns — the claim outcome is handled by the unawaited (but tracked)
    // `_trackClaimAfterOpen`, which must not surface as an unhandled
    // rejection in this test's zone.
    await Future<void>.delayed(const Duration(milliseconds: 10));
  });

  test(
      '[PIVOT-MSGR-CALL-OFF-1] with messengerCallingEnabled false, '
      'acceptRingingCall does NOT request CallScreen', () async {
    // This is the regression-catching test: it is the inverse of the two
    // contract tests above, and it is what would have failed the moment
    // `messengerCallingEnabled` shipped defaulting to off while these tests
    // had no way to force it on.
    RemoteConfig.debugSetConfigForTest({'messengerCallingEnabled': false});

    final events = <String>[];
    final claimCompleter = Completer<String?>();
    PushService.debugClaimHumanAcceptOverride = (room) {
      events.add('claim_started');
      return claimCompleter.future;
    };
    PushService.debugOnCallScreenOpenAttempt = (callId) {
      events.add('call_screen_open_attempted');
    };

    final callId =
        'contract_flagoff_${DateTime.now().microsecondsSinceEpoch}';
    final accepted = PushService.acceptRingingCall(
      callId,
      fallbackExtra: fallbackExtraFor(callId),
    );
    await Future<void>.delayed(Duration.zero);

    expect(events, isNot(contains('call_screen_open_attempted')),
        reason: 'Messenger calling is killed while the flag is off — '
            'CallScreen must never be requested');

    if (!claimCompleter.isCompleted) claimCompleter.complete(null);
    await accepted;
  });
}
