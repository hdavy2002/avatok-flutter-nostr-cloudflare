import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/commercial_getstream/commercial_live_gateway.dart';

void main() {
  test('server live states stay explicit and never become viewer counts', () {
    final state = CommercialLiveState.fromJson({
      'session_id': 'live_listing_1',
      'state': 'backstage',
      'settlement_state': 'not_ready',
    });
    expect(state.state, LiveServerState.backstage);
    expect(state.sessionId, 'live_listing_1');
    expect(liveServerStateFromJson('made_up'), LiveServerState.unknown);
  });

  test('phase 2E source keeps live join POST-only and no-store', () {
    final router = File('../worker/src/index.ts').readAsStringSync();
    final route = File('../worker/src/routes/commercial_stream_sessions.ts').readAsStringSync();
    expect(router, contains(r'^\/api\/commercial\/live\/[A-Za-z0-9-]{1,64}\/join$/.test(p) && req.method === "POST"'));
    expect(route, contains('noStoreJoinResponse'));
    expect(route, contains("Cache-Control"));
  });

  test('unsupported provider capabilities stay off by default', () {
    const capabilities = CommercialLiveCapabilities();
    expect(capabilities.captions, isFalse);
    expect(capabilities.qualityControls, isFalse);
    expect(capabilities.moderation, isFalse);
  });

  test('control retries use stable logical idempotency keys', () {
    final source = File('lib/features/commercial_getstream/commercial_live_gateway.dart').readAsStringSync();
    expect(source, contains("live-ui:\${url.substring(url.indexOf('/commercial/')).replaceAll('/', ':')}"));
    expect(source, contains('consult-extension-confirm:'));
  });

  test('extension quote keeps server duration, rate and frozen price version', () {
    final quote = CommercialConsultExtensionQuote.fromJson({
      'extension_id': 'extension-1',
      'booking_id': 'booking-1',
      'extension_minutes': 15,
      'amount': 300,
      'currency': 'tokens',
      'policy_version': 'policy-1:extension',
      'base_ends_at': 1_000,
      'extension_ends_at': 901_000,
      'rate_per_minute': 20,
      'state': 'proposed',
      'creator_consented': false,
      'buyer_consented': false,
    });
    expect(quote.extensionEndsAt, 901000);
    expect(quote.ratePerMinute, 20);
    expect(quote.policyVersion, 'policy-1:extension');
  });
}
