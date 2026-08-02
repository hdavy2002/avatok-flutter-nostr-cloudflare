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
    expect(ringInviteIsFresh({'ts': '1000'}, nowMs: 45999), isTrue);
    expect(ringInviteIsFresh({'ts': '1000'}, nowMs: 46000), isFalse);
  });
}
