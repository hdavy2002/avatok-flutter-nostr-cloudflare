// Cloudflare-native messaging unit tests (the old scaffold MyApp test is gone).
// Pure functions only — no plugins, no network — so this always runs in CI.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/config.dart';

void main() {
  test('dmConvId is order-independent and matches the server shape', () {
    expect(dmConvId('user_a', 'user_b'), 'dm_user_a__user_b');
    expect(dmConvId('user_b', 'user_a'), 'dm_user_a__user_b');
    expect(dmConvId('user_a', 'user_b').startsWith('dm_'), isTrue);
  });

  test('dmPeer extracts the other side regardless of order', () {
    final conv = dmConvId('user_a', 'user_b');
    expect(dmPeer(conv, 'user_a'), 'user_b');
    expect(dmPeer(conv, 'user_b'), 'user_a');
  });

  test('dmPeer rejects non-dm conversation ids', () {
    expect(dmPeer('g_1234', 'user_a'), isNull);
    expect(dmPeer('dm_broken', 'user_a'), isNull);
  });
}
