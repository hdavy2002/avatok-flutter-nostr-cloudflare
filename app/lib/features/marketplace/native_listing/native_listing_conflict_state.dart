// [CAL-CONFLICT-1 2026-09-15] The live conflict feedback behind the native
// wizard's Time step (AUDIT-2026-09-15 §11: "date selection is not a clear live
// calendar preview"). The web only checks conflicts after saving the draft; the
// active app form checked nothing at all.
//
// THREE THINGS THIS MUST NEVER DO
//  1. Show a stale verdict. A slow response for an abandoned time must not
//     overwrite a newer one, so every request carries a token and only the
//     newest token's result is applied.
//  2. Turn a FAILED check into "free". A network error, a 503 or an unreadable
//     body is UNKNOWN, never availability. Booking enforcement is the server's
//     job and the server re-checks at publish; the screen must not imply it did.
//  3. Let the creator believe a draft reserved time. Draft copy and published
//     copy are different strings for a reason.
import 'dart:async';

import '../../calendar/calendar_data.dart';
import 'native_listing_time_model.dart';

enum NativeListingConflictStatus { idle, checking, free, conflicts, unknown }

/// Immutable snapshot of the Time step's conflict feedback.
class NativeListingConflictState {
  const NativeListingConflictState._({
    required this.status,
    this.window,
    this.conflicts = const <AvailabilityConflict>[],
    this.alternatives = const <AvailabilityAlternative>[],
    this.message,
    this.checkedAt,
  });

  final NativeListingConflictStatus status;
  final NativeListingWindow? window;
  final List<AvailabilityConflict> conflicts;
  final List<AvailabilityAlternative> alternatives;

  /// Set only for [NativeListingConflictStatus.unknown] — why the check could
  /// not be completed. Never a claim about availability.
  final String? message;
  final DateTime? checkedAt;

  static const NativeListingConflictState idle =
      NativeListingConflictState._(status: NativeListingConflictStatus.idle);

  factory NativeListingConflictState.checking(NativeListingWindow window) =>
      NativeListingConflictState._(status: NativeListingConflictStatus.checking, window: window);

  /// Builds the verdict from a successful preview response. `ok == true` is the
  /// server saying it found nothing; anything else is a conflict.
  factory NativeListingConflictState.fromPreview(
      NativeListingWindow? window, AvailabilityConflictPreview preview) {
    if (preview.ok) {
      return NativeListingConflictState._(
        status: NativeListingConflictStatus.free,
        window: window,
        alternatives: preview.alternatives,
        checkedAt: DateTime.now(),
      );
    }
    return NativeListingConflictState._(
      status: NativeListingConflictStatus.conflicts,
      window: window,
      conflicts: preview.conflicts,
      alternatives: preview.alternatives,
      checkedAt: DateTime.now(),
    );
  }

  factory NativeListingConflictState.unknown(NativeListingWindow? window, String message) =>
      NativeListingConflictState._(
        status: NativeListingConflictStatus.unknown,
        window: window,
        message: message,
        checkedAt: DateTime.now(),
      );

  AvailabilityConflict? get firstConflict => conflicts.isEmpty ? null : conflicts.first;

  /// True only when the server actually answered about this window.
  bool get verified =>
      status == NativeListingConflictStatus.free || status == NativeListingConflictStatus.conflicts;
}

/// Token-guarded owner of the Time step's conflict state. Deliberately free of
/// Flutter imports so the stale-response rules can be unit-tested directly.
class NativeListingConflictController {
  NativeListingConflictController({this.debounceDelay = const Duration(milliseconds: 600)});

  final Duration debounceDelay;
  Timer? _timer;
  int _sequence = 0;
  bool _disposed = false;
  NativeListingConflictState _state = NativeListingConflictState.idle;

  NativeListingConflictState get state => _state;

  /// Starts a new check for [window]. Every earlier token becomes stale in the
  /// same step, so an in-flight response for the previous time is discarded.
  int nextWindow(NativeListingWindow window) {
    _sequence++;
    _state = NativeListingConflictState.checking(window);
    return _sequence;
  }

  bool isCurrent(int token) => token == _sequence && !_disposed;

  void complete(int token, AvailabilityConflictPreview preview) {
    if (!isCurrent(token)) return;
    _state = NativeListingConflictState.fromPreview(_state.window, preview);
  }

  void fail(int token, String message) {
    if (!isCurrent(token)) return;
    _state = NativeListingConflictState.unknown(_state.window, message);
  }

  /// Coalesces rapid edits (every tap of a picker or a keystroke in duration)
  /// into one request.
  void debounce(void Function() action) {
    _timer?.cancel();
    _timer = Timer(debounceDelay, () {
      if (!_disposed) action();
    });
  }

  void cancelDebounce() {
    _timer?.cancel();
    _timer = null;
  }

  /// No concrete window to check (an on-request consult, or an unset time).
  void clear() {
    cancelDebounce();
    _sequence++;
    _state = NativeListingConflictState.idle;
  }

  void dispose() {
    _disposed = true;
    cancelDebounce();
  }
}

/// What "this time is free / taken" MEANS for this listing, in the creator's
/// words. Drafts hold nothing: the reservation for an exclusive fixed consult
/// is written by publication, never by saving the form.
String nativeListingReservedCopy({
  required bool published,
  required AvailabilityMode mode,
  required bool liveEvent,
}) {
  if (!published) {
    return 'Draft: this time is not reserved yet. It is reserved when the listing is published.';
  }
  if (liveEvent) return 'Published: this event is protected on your calendar.';
  switch (mode) {
    case AvailabilityMode.exclusive:
      return 'Published: this time is reserved for this listing.';
    case AvailabilityMode.custom:
    case AvailabilityMode.shared:
      return 'Published: customers can book inside your opening hours.';
  }
}

/// One-line description of a conflicting commitment.
String nativeListingConflictMessage(AvailabilityConflict conflict, String timezone) {
  final title = conflict.title.trim().isEmpty ? 'another commitment' : conflict.title.trim();
  return 'This time overlaps $title '
      '(${nativeListingHumanRange(conflict.startAt.millisecondsSinceEpoch, conflict.endAt.millisecondsSinceEpoch, timezone)}).';
}

/// The banner text used when the creator tries to leave the Time step while the
/// server has already confirmed a conflict.
String nativeListingConflictSaveError(AvailabilityConflict? conflict, String timezone) {
  if (conflict == null) return 'This time conflicts with something on your calendar. Pick another time.';
  return '${nativeListingConflictMessage(conflict, timezone)} Pick another time before continuing.';
}

/// Copy for an alternative the preview offered.
String nativeListingAlternativeLabel(AvailabilityAlternative alternative, String timezone) =>
    nativeListingHumanRange(
      alternative.startAt.millisecondsSinceEpoch,
      alternative.endAt.millisecondsSinceEpoch,
      timezone,
    );
