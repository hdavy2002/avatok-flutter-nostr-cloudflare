import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:hf_app/core/config/flags.dart';

void main() {
  test('reads the public Standard-plan flag from hfStdPlan.enabled', () {
    expect(
      HfFlags.fromJson({
        'hfStdPlan': {'enabled': true},
      }).hfStdPlanEnabled,
      isTrue,
    );
    expect(
      HfFlags.fromJson({
        'hfStdPlan': {'enabled': false},
      }).hfStdPlanEnabled,
      isFalse,
    );
  });

  test('Standard plan fails closed for unknown and all-off config', () {
    expect(HfFlags.unknown.hfStdPlanEnabled, isFalse);
    expect(HfFlags.allOff.hfStdPlanEnabled, isFalse);
    expect(HfFlags.fromJson(const {}).hfStdPlanEnabled, isFalse);
  });

  test('Standard-plan consumer helper fails closed without confirmed data', () {
    expect(hfStdPlanOn(null), isFalse);
    expect(hfStdPlanOn(const AsyncLoading<HfFlags>()), isFalse);
    expect(
      hfStdPlanOn(AsyncError<HfFlags>(StateError('offline'), StackTrace.empty)),
      isFalse,
    );
    expect(hfStdPlanOn(const AsyncData<HfFlags>(HfFlags.unknown)), isFalse);
    expect(
      hfStdPlanOn(
        AsyncData<HfFlags>(
          HfFlags.fromJson({
            'hfStdPlan': {'enabled': true},
          }),
        ),
      ),
      isTrue,
    );
  });
}
