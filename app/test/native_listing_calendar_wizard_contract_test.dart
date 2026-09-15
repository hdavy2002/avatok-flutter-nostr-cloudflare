// [CAL-TIME-1 / CAL-CONFLICT-1 / CAL-GCAL-1 2026-09-15] Source-contract tests
// for the ROUTED native listing wizard (AUDIT-2026-09-15 §1 and §11).
//
// These pin the wiring the audit found missing or unsafe, in the same style as
// test/ui/app_type_scale_contract_test.dart (the repo's toolchains are broken
// locally by design, so the checks run in CI):
//  * the raw "YYYY-MM-DDTHH:MM" text box is gone in favour of real pickers;
//  * the shared/custom/exclusive choice is persisted through the EXISTING
//    AvailabilityApi.saveSchedule, after the draft save, and is hydrated on edit;
//  * a schedule save failure can never advance or claim success;
//  * conflict feedback is live, debounced and stale-response protected;
//  * Google readiness is surfaced from the server's own verdict.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _screenPath = 'lib/features/marketplace/native_listing/native_listing_wizard_screen.dart';
const _timeModelPath = 'lib/features/marketplace/native_listing/native_listing_time_model.dart';
const _conflictPath = 'lib/features/marketplace/native_listing/native_listing_conflict_state.dart';
const _gcalPath = 'lib/features/marketplace/native_listing/native_listing_gcal_readiness.dart';
const _widgetsPath = 'lib/features/marketplace/native_listing/native_listing_time_widgets.dart';

void main() {
  final screen = File(_screenPath).readAsStringSync();
  final timeModel = File(_timeModelPath).readAsStringSync();
  final conflict = File(_conflictPath).readAsStringSync();
  final gcal = File(_gcalPath).readAsStringSync();
  final widgets = File(_widgetsPath).readAsStringSync();

  group('Time step', () {
    test('no longer asks the creator to type an ISO timestamp', () {
      expect(screen, isNot(contains('Start date and time (YYYY-MM-DDTHH:MM)')));
      expect(screen, isNot(contains("hint: '2026-12-31T18:00'")));
      expect(screen, contains('NativeListingDateTimeField('),
          reason: 'the start must be a real date + time picker in the listing timezone');
    });

    test('the picker writes the wall clock the Worker expects', () {
      expect(timeModel, contains('DateTime.tryParse(raw)'));
      expect(timeModel, contains('nativeListingEpochForWallClock'));
      expect(timeModel, contains("'T\${p(value.hour)}:\${p(value.minute)}'"));
      // A DST gap must be reported, not silently shifted (the old fallback).
      expect(timeModel, contains('return null;'));
      expect(timeModel, isNot(contains('return parsed.millisecondsSinceEpoch;')));
    });

    test('offers the three availability choices with what each one reserves', () {
      expect(screen, contains('NativeListingAvailabilityModeField('));
      expect(widgets, contains("title: 'Use my usual hours'"));
      expect(widgets, contains("title: 'Choose different hours'"));
      expect(widgets, contains("title: 'Reserve specific dates'"));
      expect(widgets, contains('drafts do not'));
    });

    test('custom mode edits weekly windows in the schedule timezone', () {
      expect(screen, contains('NativeListingWeeklyHoursField('));
      expect(screen, contains('timezone: _scheduleTimezone'));
    });

    test('an exclusive consult is fixed-date, because that is what publish reserves', () {
      expect(screen, contains("_scheduleMode = mode == AvailabilityMode.exclusive ? 'fixed_date' : 'on_request';"));
      expect(screen, contains("if (_kind == 'live_event') _scheduleMode = 'fixed_date';"));
    });

    test('re-choosing the listing kind cannot silently downgrade an exclusive consult', () {
      // Step 0 rewrites `_scheduleMode` from the kind. If it ignored the chosen
      // availability it would flip an exclusive consult back to on_request, and
      // publish (fixed_date AND exclusive) would stop reserving the window.
      expect(
        screen,
        contains("_availabilityMode == AvailabilityMode.exclusive ? 'fixed_date' : 'on_request'"),
      );
    });
  });

  group('availability persistence', () {
    test('saves the listing schedule through the existing shared API', () {
      expect(screen, contains('AvailabilityApi.saveSchedule(plan.applyTo(base))'));
      expect(screen, contains('AvailabilityApi.fetchSchedule(listingId: _id)'));
      expect(screen, contains('AvailabilityApi.cachedSchedule(listingId: _id)'),
          reason: 'an offline edit must still open on the saved mode and windows');
    });

    test('a brand-new listing saves the draft first', () {
      // `_save()` assigns `_id`, and the schedule save fails closed without one,
      // so the CREATOR-WIDE row can never be overwritten by accident.
      final guardIndex = screen.indexOf('Save the draft before setting this listing');
      final saveIndex = screen.indexOf('AvailabilityApi.saveSchedule(');
      expect(guardIndex, greaterThan(0));
      expect(saveIndex, greaterThan(guardIndex));
    });

    test('a failed schedule save must not advance or claim success', () {
      expect(screen, contains('if (_step == 3 && !await _commitTimeStep()) return;'));
      expect(screen, contains('return _saveListingSchedule();'));
      expect(screen, contains("_error = message;"));
    });

    test('publishing follows a successful schedule save', () {
      expect(screen, contains('if (_scheduleDirty && !await _saveListingSchedule()) return;'));
    });

    test('preserves the creator horizon and unrelated exceptions', () {
      expect(timeModel, contains('nativeListingClampHorizon'));
      expect(timeModel, isNot(contains("'horizon_days': 62")));
      expect(timeModel, contains('horizonDays: nativeListingClampHorizon(base.horizonDays)'));
      expect(timeModel, contains('exceptions: List<AvailabilityException>.of(base.exceptions)'));
    });

    test('a version conflict is preserved, not overwritten', () {
      expect(screen, contains('if (error.statusCode == 409) await _hydrateListingSchedule();'));
      expect(timeModel, contains('version: base.version'));
    });
  });

  group('live conflict feedback', () {
    test('queries the shared preview route for the chosen window', () {
      expect(screen, contains('AvailabilityApi.previewConflicts('));
      expect(screen, contains('startAt: window.startAt'));
      expect(screen, contains('timezone: window.timezone'));
    });

    test('debounces and drops stale responses', () {
      expect(conflict, contains('void debounce(void Function() action)'));
      expect(conflict, contains('bool isCurrent(int token)'));
      expect(conflict, contains('if (!isCurrent(token)) return;'));
      expect(screen, contains('_conflicts.debounce(() => _runConflictPreview(window, token))'));
    });

    test('a failed check is unknown, never free', () {
      expect(conflict, contains('NativeListingConflictState.unknown'));
      expect(widgets, contains("const AdSticker('Not verified', kind: AdStickerKind.hint)"),
          reason: 'the UI must say a failed check was not a verdict');
    });

    test('draft and published copy are different', () {
      expect(conflict, contains("return 'Draft: this time is not reserved yet."));
      expect(conflict, contains('Published: this time is reserved for this listing.'));
    });
  });

  group('Google readiness', () {
    test('reads the existing status client and never invents readiness', () {
      expect(gcal, contains('PlatformApi.gcalStatus()'));
      expect(gcal, contains("if (!status.containsKey('ready'))"));
      expect(gcal, contains('confirmedByServer: false'));
      expect(gcal, contains('_oldestSelectedSuccess'));
    });

    test('the wizard shows it on the Time step and on the summary', () {
      expect(screen, contains('NativeListingGcalReadinessCard('));
      expect(screen, contains('_refreshGcalReadiness'));
      expect(screen, contains('_gcalSummary()'));
    });
  });

  test('the wizard does not reach for the unused legacy controller or step', () {
    expect(screen, isNot(contains('ListingWizardController')));
    expect(screen, isNot(contains('Step4Time')));
  });
}
