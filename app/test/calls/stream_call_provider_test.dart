import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/calls/rtc/stream_call_api.dart';
import 'package:avatok_call/core/calls/rtc/stream_call_provider.dart';

void main() {
  test('provider wire values are stable and unknown values stay legacy', () {
    expect(CallMediaProvider.cloudflare.wire, 'cloudflare');
    expect(CallMediaProvider.stream.wire, 'stream');
    expect(CallMediaProviderWire.fromWire('stream'), CallMediaProvider.stream);
    expect(CallMediaProviderWire.fromWire('missing'), CallMediaProvider.cloudflare);
  });

  test('legacy payload remains owned by the AvaTOK ring path', () {
    expect(
      StreamCallPilot.ringOwner(const <String, dynamic>{}),
      CallRingOwner.avatok,
    );
    expect(
      StreamCallPilot.ringOwner(const <String, dynamic>{
        'provider': 'cloudflare',
      }),
      CallRingOwner.avatok,
    );
  });

  test('provider decisions are explicit and immutable for a call', () {
    const legacy = CallProviderDecision.cloudflare(reason: 'pilot_off');
    expect(legacy.provider, CallMediaProvider.cloudflare);
    expect(legacy.usesStream, isFalse);
    expect(legacy.streamTicket, isNull);
  });
}
