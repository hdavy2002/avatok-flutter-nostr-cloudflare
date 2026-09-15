// [CAL-GCAL-1 2026-09-15] Google Calendar readiness for the native listing
// wizard (AUDIT-2026-09-15 §5/A5: the app's "Connected" line does not mean
// ready). Publish, booking and the buyer-side preview all refuse while Google
// busy times cannot be verified (worker/src/cal/gcal_availability.ts via
// listing_blockers.ts, engine.ts and routes/calendar_availability.ts), so the
// Time step has to say the SAME thing — and say "we cannot confirm" when it
// cannot, never "connected, so fine".
//
// The Worker's GET /api/calendar/gcal/status is additive: `ready`, `reason` and
// `last_success_at` (oldest selected successful sync) arrive with the backend
// release, while the older `connected` / `calendars[]` fields stay. This file
// reads the new fields when present and degrades to an explicit UNKNOWN when
// they are not, so an app build shipped before the backend can never paint a
// healthy Google state it did not verify.
import '../../../core/platform_api.dart';

/// Mirrors the server's reason codes in gcal_availability.ts.
enum NativeListingGcalState {
  ready,
  notConnected,
  noSelectedCalendars,
  pending,
  stale,
  error,
  unknown,
}

/// The server's freshness window for a protected booking (30 minutes, the
/// default of gcalAvailabilityReady()).
const Duration kNativeListingGcalMaxAge = Duration(minutes: 30);

class NativeListingGcalReadiness {
  const NativeListingGcalReadiness({
    required this.state,
    this.lastSuccessAt,
    this.detail,
    this.confirmedByServer = false,
  });

  final NativeListingGcalState state;

  /// Epoch millis of the OLDEST selected successful sync, when the status
  /// response or its per-calendar rows let us compute it. Null means "no
  /// successful sync", not "fresh".
  final int? lastSuccessAt;

  /// Human explanation of why the state is what it is. Never contains server
  /// internals or secrets.
  final String? detail;

  /// True when the Worker itself reported readiness (the additive `ready`
  /// field). An unconfirmed reading is never treated as healthy.
  final bool confirmedByServer;

  bool get ready => state == NativeListingGcalState.ready;

  /// Copy shown on the readiness card title line.
  String get headline {
    switch (state) {
      case NativeListingGcalState.ready:
        return 'Google Calendar is ready';
      case NativeListingGcalState.notConnected:
        return 'Google Calendar is not connected';
      case NativeListingGcalState.noSelectedCalendars:
        return 'No Google calendar is selected';
      case NativeListingGcalState.pending:
        return 'Google Calendar has not synced yet';
      case NativeListingGcalState.stale:
        return 'Google Calendar is out of date';
      case NativeListingGcalState.error:
        return 'Google Calendar sync failed';
      case NativeListingGcalState.unknown:
        return 'Google readiness is not confirmed';
    }
  }

  /// What the creator should do about it. `Open calendar & availability` and
  /// `Check again` sit under this text in the wizard.
  String get body {
    switch (state) {
      case NativeListingGcalState.ready:
        return _freshnessSentence() ??
            'Busy events from your selected calendars are counted, so publishing can protect this time.';
      case NativeListingGcalState.notConnected:
        return 'Connect Google Calendar before submitting. Busy events have to be counted, or a customer could book time you are already using.';
      case NativeListingGcalState.noSelectedCalendars:
        return 'Select at least one Google calendar in Calendar & availability so busy events can be counted.';
      case NativeListingGcalState.pending:
        return 'Google Calendar has not finished its first sync. Refresh it in Calendar & availability, then check again.';
      case NativeListingGcalState.stale:
        return 'The last successful sync is older than ${kNativeListingGcalMaxAge.inMinutes} minutes. Refresh Google Calendar before you publish.';
      case NativeListingGcalState.error:
        return 'The last Google sync reported an error. Reconnect Google Calendar, then check again.';
      case NativeListingGcalState.unknown:
        final reason = detail ?? 'This app could not read your Google Calendar status.';
        return '$reason Reconnect or refresh Google Calendar, then check again — AvaTOK will not treat busy times as protected until it can confirm this.';
    }
  }

  String? _freshnessSentence() {
    final at = lastSuccessAt;
    if (at == null) return null;
    final minutes = ((DateTime.now().millisecondsSinceEpoch - at) / 60000).round();
    if (minutes <= 0) return 'Last successful sync: just now.';
    if (minutes == 1) return 'Last successful sync: 1 minute ago.';
    if (minutes < 120) return 'Last successful sync: $minutes minutes ago.';
    final hours = (minutes / 60).round();
    return hours == 1 ? 'Last successful sync: 1 hour ago.' : 'Last successful sync: $hours hours ago.';
  }

  /// Reads the status body defensively. `null`/unreadable means UNKNOWN.
  static NativeListingGcalReadiness fromStatus(Map<String, dynamic>? status) {
    if (status == null || status.isEmpty) {
      return const NativeListingGcalReadiness(
        state: NativeListingGcalState.unknown,
        detail: 'The app could not read your Google Calendar status.',
      );
    }
    final calendars = ((status['calendars'] as List?) ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList(growable: false);
    final selected = calendars.where((row) => row['selected'] == true).toList(growable: false);
    final lastSuccess = status.containsKey('last_success_at')
        ? (status['last_success_at'] is num ? (status['last_success_at'] as num).toInt() : null)
        : _oldestSelectedSuccess(selected);

    if (!status.containsKey('ready')) {
      // Older Worker: readiness is not exposed. Derive a human explanation from
      // the same rows the server uses, but keep the STATE unknown — a client
      // must not promote an unexposed server rule to "healthy".
      return NativeListingGcalReadiness(
        state: NativeListingGcalState.unknown,
        lastSuccessAt: lastSuccess,
        detail: _unconfirmedDetail(status, selected),
        confirmedByServer: false,
      );
    }

    // The wizard cares about the PUBLISH rule, which passes requireConnected:
    // true (listing_blockers.ts), so a disconnected account is not ready even
    // when the status body's default (requireConnected: false) says `ready`.
    if (status['connected'] != true) {
      return NativeListingGcalReadiness(
        state: NativeListingGcalState.notConnected,
        lastSuccessAt: lastSuccess,
        confirmedByServer: true,
      );
    }
    if (status['ready'] == true) {
      return NativeListingGcalReadiness(
        state: NativeListingGcalState.ready,
        lastSuccessAt: lastSuccess,
        confirmedByServer: true,
      );
    }
    final reason = status['reason']?.toString();
    final state = switch (reason) {
      'disconnected' => NativeListingGcalState.notConnected,
      'no_selected_calendars' => NativeListingGcalState.noSelectedCalendars,
      'pending' => NativeListingGcalState.pending,
      'stale' => NativeListingGcalState.stale,
      'error' => NativeListingGcalState.error,
      _ => NativeListingGcalState.unknown,
    };
    return NativeListingGcalReadiness(
      state: state,
      lastSuccessAt: lastSuccess,
      detail: state == NativeListingGcalState.unknown
          ? 'The server reported "not ready" without saying why.'
          : null,
      confirmedByServer: true,
    );
  }

  /// A failed status fetch. Always UNKNOWN — never a guess in either direction.
  static NativeListingGcalReadiness unavailable([String? detail]) => NativeListingGcalReadiness(
        state: NativeListingGcalState.unknown,
        detail: detail ?? 'The app could not read your Google Calendar status.',
      );

  static String _unconfirmedDetail(Map<String, dynamic> status, List<Map<String, dynamic>> selected) {
    if (status['connected'] != true) return 'Google Calendar is not connected.';
    if (selected.isEmpty) return 'No Google calendar is selected.';
    if (selected.any((row) => row['last_error'] != null && row['last_error'].toString().isNotEmpty)) {
      return 'Your last Google sync reported an error.';
    }
    if (selected.any((row) => row['last_success_at'] is! num)) {
      return 'Google Calendar has not finished its first sync.';
    }
    final oldest = selected
        .map((row) => (row['last_success_at'] as num).toInt())
        .reduce((a, b) => a < b ? a : b);
    final minutes = ((DateTime.now().millisecondsSinceEpoch - oldest) / 60000).round();
    if (minutes > kNativeListingGcalMaxAge.inMinutes) {
      return 'Your selected calendars last synced $minutes minutes ago.';
    }
    return 'Connected and synced recently, but this app version cannot confirm readiness.';
  }

  /// `last_success_at` is the OLDEST selected successful sync: if any selected
  /// calendar has never succeeded, the group is not fresh and the answer is
  /// null rather than the freshest sibling.
  static int? _oldestSelectedSuccess(List<Map<String, dynamic>> selected) {
    if (selected.isEmpty) return null;
    int? oldest;
    for (final row in selected) {
      final value = row['last_success_at'];
      if (value is! num) return null;
      final ms = value.toInt();
      if (oldest == null || ms < oldest) oldest = ms;
    }
    return oldest;
  }
}

/// A failed gcal status read, kept typed so the screen can log it without
/// turning it into a verdict.
class NativeListingGcalStatusException implements Exception {
  const NativeListingGcalStatusException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Reads the status through the EXISTING core client (PlatformApi.gcalStatus,
/// untouched by this change). Failures are surfaced as an exception instead of
/// an empty map so the screen shows "not confirmed" rather than a blank.
Future<Map<String, dynamic>> nativeListingReadGcalStatus() async {
  try {
    final status = await PlatformApi.gcalStatus();
    if (status.isEmpty) throw const NativeListingGcalStatusException('The server returned no Google status.');
    return status;
  } on NativeListingGcalStatusException {
    rethrow;
  } catch (_) {
    throw const NativeListingGcalStatusException('The app could not read your Google Calendar status.');
  }
}
