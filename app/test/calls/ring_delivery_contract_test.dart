import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/core/calls/ring_delivery_contract.dart';

void main() {
  test('explicit expiry rejects a late ring', () {
    expect(ringInviteIsFresh({'tokenExpiresAt': '999'}, nowMs: 1000), isFalse);
  });

  test('explicit expiry accepts a live ring', () {
    expect(ringInviteIsFresh({'tokenExpiresAt': '1001'}, nowMs: 1000), isTrue);
  });

  test('legacy timestamp uses canonical lifetime', () {
    expect(ringInviteIsFresh({'ts': '1000'}, nowMs: 20999), isTrue);
    expect(ringInviteIsFresh({'ts': '1000'}, nowMs: 21000), isFalse);
  });

  test('late delivery receives only the unexpired ring remainder', () {
    expect(ringInviteRemainingMs({'tokenExpiresAt': '21000'}, nowMs: 16000), 5000);
    expect(ringInviteRemainingMs({'tokenExpiresAt': '21000'}, nowMs: 21000), 0);
  });
}
