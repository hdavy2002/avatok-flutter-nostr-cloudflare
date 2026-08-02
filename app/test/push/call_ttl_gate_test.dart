import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/push/call_ttl_gate.dart';

void main() {
  group('CallTtlGate', () {
    test('programmatic marker survives duplicate native callbacks', () {
      final gate = CallTtlGate(ttlMs: 90000);

      gate.mark('call-1', nowMs: 1000);

      expect(gate.contains('call-1', nowMs: 1001), isTrue);
      expect(gate.contains('call-1', nowMs: 5000), isTrue);
    });

    test('only one delivery path can reserve an incoming route', () {
      final gate = CallTtlGate(ttlMs: 90000);

      expect(gate.tryReserve('call-1', nowMs: 1000), isTrue);
      expect(gate.tryReserve('call-1', nowMs: 1000), isFalse);
    });

    test('expired calls cannot poison later work', () {
      final gate = CallTtlGate(ttlMs: 100);

      gate.mark('call-1', nowMs: 1000);

      expect(gate.contains('call-1', nowMs: 1101), isFalse);
      expect(gate.tryReserve('call-1', nowMs: 1101), isTrue);
    });
  });
}
