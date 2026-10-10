import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/features/push/data/opt_in_policy.dart';
import 'package:hf_app/features/push/data/push_gateway.dart';

void main() {
  final now = DateTime.utc(2026, 10, 10, 12);

  bool show({
    bool available = true,
    bool flag = true,
    PushPermission permission = PushPermission.notGranted,
    OptInRecord? record,
    DateTime? at,
  }) =>
      shouldShowOptIn(
        gatewayAvailable: available,
        flagOn: flag,
        permission: permission,
        record: record,
        now: at ?? now,
      );

  group('opt-in sheet timing', () {
    test('first time after sign-in: shown', () => expect(show(), isTrue));

    test('not shown without Firebase', () => expect(show(available: false), isFalse));
    test('not shown while hfPushEnabled is off', () => expect(show(flag: false), isFalse));
    test('not shown when notifications are already allowed',
        () => expect(show(permission: PushPermission.granted), isFalse));

    test('Not now: hidden for 14 days, then asked again', () {
      final rec = OptInRecord(answer: OptInAnswer.later, at: now);
      expect(show(record: rec, at: now.add(const Duration(days: 1))), isFalse);
      expect(show(record: rec, at: now.add(const Duration(days: 13, hours: 23))), isFalse);
      expect(show(record: rec, at: now.add(const Duration(days: 14))), isTrue);
      expect(show(record: rec, at: now.add(const Duration(days: 40))), isTrue);
    });

    test('Android said no: same 14-day wait', () {
      final rec = OptInRecord(answer: OptInAnswer.denied, at: now);
      expect(show(record: rec, at: now.add(const Duration(days: 3))), isFalse);
      expect(show(record: rec, at: now.add(const Duration(days: 15))), isTrue);
    });

    test('allowed once and switched off in settings later: never nagged', () {
      final rec = OptInRecord(answer: OptInAnswer.allowed, at: now);
      expect(show(record: rec, at: now.add(const Duration(days: 365))), isFalse);
    });

    test('14 days is the documented re-ask', () => expect(kOptInReask, const Duration(days: 14)));
  });

  group('record storage', () {
    test('round trip', () {
      final rec = OptInRecord(answer: OptInAnswer.later, at: now);
      final back = OptInRecord.decode(rec.encode());
      expect(back?.answer, OptInAnswer.later);
      expect(back?.at, now);
    });

    test('garbage reads as never asked', () {
      expect(OptInRecord.decode(null), isNull);
      expect(OptInRecord.decode(''), isNull);
      expect(OptInRecord.decode('later'), isNull);
      expect(OptInRecord.decode('maybe|2026-10-10T00:00:00Z'), isNull);
      expect(OptInRecord.decode('later|not-a-date'), isNull);
    });
  });
}
