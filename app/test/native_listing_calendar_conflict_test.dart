// [CAL-CONFLICT-1 2026-09-15] Regression tests for the live conflict feedback
// in the native wizard's Time step (AUDIT-2026-09-15 §11):
//  * a stale async response must never repaint a newer verdict;
//  * a FAILED check must never be presented as "free";
//  * a draft must never claim time is reserved.
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/calendar/calendar_data.dart';
import 'package:avatok_call/features/marketplace/native_listing/native_listing_conflict_state.dart';
import 'package:avatok_call/features/marketplace/native_listing/native_listing_time_model.dart';

const _window = NativeListingWindow(startAt: 1767227400000, endAt: 1767231000000, timezone: 'Asia/Kolkata');
const _otherWindow = NativeListingWindow(startAt: 1767313800000, endAt: 1767317400000, timezone: 'Asia/Kolkata');

AvailabilityConflict _conflict({String title = 'Team standup'}) => AvailabilityConflict(
      title: title,
      startAt: DateTime.fromMillisecondsSinceEpoch(_window.startAt, isUtc: true),
      endAt: DateTime.fromMillisecondsSinceEpoch(_window.endAt, isUtc: true),
    );

AvailabilityAlternative _alternative() => AvailabilityAlternative(
      startAt: DateTime.fromMillisecondsSinceEpoch(_window.endAt, isUtc: true),
      endAt: DateTime.fromMillisecondsSinceEpoch(_window.endAt + 3600000, isUtc: true),
    );

const _freePreview = AvailabilityConflictPreview(ok: true, conflicts: <AvailabilityConflict>[], alternatives: <AvailabilityAlternative>[]);

void main() {
  group('NativeListingConflictController', () {
    test('drops a stale response for an abandoned time', () {
      final controller = NativeListingConflictController();
      addTearDown(controller.dispose);

      final first = controller.nextWindow(_window);
      expect(controller.state.status, NativeListingConflictStatus.checking);

      final second = controller.nextWindow(_otherWindow);
      expect(controller.isCurrent(first), isFalse);

      controller.complete(first, const AvailabilityConflictPreview(
        ok: false,
        conflicts: <AvailabilityConflict>[],
        alternatives: <AvailabilityAlternative>[],
      ));
      expect(controller.state.status, NativeListingConflictStatus.checking,
          reason: 'the in-flight answer for the old time must be ignored');
      expect(controller.state.window?.signature, _otherWindow.signature);

      controller.complete(second, _freePreview);
      expect(controller.state.status, NativeListingConflictStatus.free);
      expect(controller.state.window?.signature, _otherWindow.signature);
    });

    test('a failed check is UNKNOWN, never free', () {
      final controller = NativeListingConflictController();
      addTearDown(controller.dispose);

      final token = controller.nextWindow(_window);
      controller.fail(token, 'The app could not check your calendar just now.');

      expect(controller.state.status, NativeListingConflictStatus.unknown);
      expect(controller.state.verified, isFalse);
      expect(controller.state.message, contains('could not check'));
      expect(controller.state.status == NativeListingConflictStatus.free, isFalse,
          reason: 'an unverified time must never be shown as available');
    });

    test('a stale failure cannot overwrite a newer verdict', () {
      final controller = NativeListingConflictController();
      addTearDown(controller.dispose);

      final stale = controller.nextWindow(_window);
      final fresh = controller.nextWindow(_otherWindow);
      controller.fail(stale, 'timeout');
      expect(controller.state.status, NativeListingConflictStatus.checking);

      controller.complete(fresh, _freePreview);
      controller.fail(stale, 'timeout');
      expect(controller.state.status, NativeListingConflictStatus.free);
    });

    test('a cleared window ignores anything still in flight', () {
      final controller = NativeListingConflictController();
      addTearDown(controller.dispose);

      final token = controller.nextWindow(_window);
      controller.clear();
      expect(controller.state.status, NativeListingConflictStatus.idle);

      controller.complete(token, _freePreview);
      controller.fail(token, 'boom');
      expect(controller.state.status, NativeListingConflictStatus.idle);
    });

    test('dispose stops late writes', () {
      final controller = NativeListingConflictController();
      final token = controller.nextWindow(_window);
      controller.dispose();

      controller.complete(token, _freePreview);
      expect(controller.state.status, NativeListingConflictStatus.checking);
    });

    test('debounce coalesces rapid edits into one request', () async {
      final controller = NativeListingConflictController(debounceDelay: const Duration(milliseconds: 5));
      addTearDown(controller.dispose);

      var runs = 0;
      controller.debounce(() => runs++);
      controller.debounce(() => runs++);
      controller.debounce(() => runs++);
      expect(runs, 0, reason: 'nothing runs before the delay elapses');

      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(runs, 1, reason: 'only the last edit should reach the server');
    });

    test('cancelDebounce keeps a pending check from firing', () async {
      final controller = NativeListingConflictController(debounceDelay: const Duration(milliseconds: 5));
      addTearDown(controller.dispose);

      var runs = 0;
      controller.debounce(() => runs++);
      controller.cancelDebounce();
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(runs, 0);
    });
  });

  group('conflict state mapping', () {
    test('ok=false becomes a conflict list with alternatives', () {
      final state = NativeListingConflictState.fromPreview(
        _window,
        AvailabilityConflictPreview(
          ok: false,
          conflicts: <AvailabilityConflict>[_conflict()],
          alternatives: <AvailabilityAlternative>[_alternative()],
        ),
      );

      expect(state.status, NativeListingConflictStatus.conflicts);
      expect(state.firstConflict?.title, 'Team standup');
      expect(state.alternatives, hasLength(1));
      expect(state.verified, isTrue);
    });

    test('ok=true is the server saying it found nothing', () {
      final state = NativeListingConflictState.fromPreview(_window, _freePreview);
      expect(state.status, NativeListingConflictStatus.free);
      expect(state.firstConflict, isNull);
    });
  });

  group('creator-facing copy', () {
    test('a draft never claims the time is reserved', () {
      final draft = nativeListingReservedCopy(
        published: false,
        mode: AvailabilityMode.exclusive,
        liveEvent: false,
      );
      expect(draft, contains('Draft'));
      expect(draft, contains('not reserved'));

      final published = nativeListingReservedCopy(
        published: true,
        mode: AvailabilityMode.exclusive,
        liveEvent: false,
      );
      expect(published, contains('reserved for this listing'));
    });

    test('shared and custom consults are booked from opening hours', () {
      for (final mode in <AvailabilityMode>[AvailabilityMode.shared, AvailabilityMode.custom]) {
        expect(
          nativeListingReservedCopy(published: true, mode: mode, liveEvent: false),
          contains('customers can book'),
        );
      }
      expect(
        nativeListingReservedCopy(published: true, mode: AvailabilityMode.shared, liveEvent: true),
        contains('protected on your calendar'),
      );
    });

    test('a conflict message names the commitment and its range', () {
      final message = nativeListingConflictMessage(_conflict(), 'Asia/Kolkata');
      expect(message, contains('Team standup'));
      expect(message, contains('Asia/Kolkata'));

      expect(
        nativeListingConflictMessage(_conflict(title: '   '), 'Asia/Kolkata'),
        contains('another commitment'),
      );
    });

    test('the save-time refusal tells the creator what to do', () {
      expect(nativeListingConflictSaveError(_conflict(), 'Asia/Kolkata'), contains('Pick another time'));
      expect(nativeListingConflictSaveError(null, 'Asia/Kolkata'), contains('conflicts'));
    });
  });
}
