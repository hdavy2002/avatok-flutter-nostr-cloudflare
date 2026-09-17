import '../../../core/localization/known_ui_copy.dart';
import '../../../core/localization/ui_text.dart';
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
        return uiCopy(UiMessage.m_google_calendar_is_ready_d1729a8268);
      case NativeListingGcalState.notConnected:
        return uiCopy(UiMessage.m_google_calendar_is_not_connected_34580bfc42);
      case NativeListingGcalState.noSelectedCalendars:
        return uiCopy(UiMessage.m_no_google_calendar_is_selected_48459b6dc3);
      case NativeListingGcalState.pending:
        return uiCopy(UiMessage.m_google_calendar_has_not_synced_8b3bc615f4);
      case NativeListingGcalState.stale:
        return uiCopy(UiMessage.m_google_calendar_is_out_of_fad1c221f1);
      case NativeListingGcalState.error:
        return uiCopy(UiMessage.m_google_calendar_sync_failed_47667ee1ee);
      case NativeListingGcalState.unknown:
        return uiCopy(UiMessage.m_google_readiness_is_not_confirmed_8735e29b93);
    }
  }

  /// What the creator should do about it. `Open calendar & availability` and
  /// `Check again` sit under this text in the wizard.
  String get body {
    switch (state) {
      case NativeListingGcalState.ready:
        return _freshnessSentence() ??
            uiCopy(UiMessage.m_busy_events_from_your_selected_f9cd3308fb);
      case NativeListingGcalState.notConnected:
        return uiCopy(UiMessage.m_connect_google_calendar_before_submitting_eb91097b3f);
      case NativeListingGcalState.noSelectedCalendars:
        return uiCopy(UiMessage.m_select_at_least_one_google_f0d780362b);
      case NativeListingGcalState.pending:
        return uiCopy(UiMessage.m_google_calendar_has_not_finished_4256f493fd);
      case NativeListingGcalState.stale:
        return uiCopy(UiMessage.m_the_last_successful_sync_is_a37ad7079e, {'value1': (kNativeListingGcalMaxAge.inMinutes).toString()});
      case NativeListingGcalState.error:
        return uiCopy(UiMessage.m_the_last_google_sync_reported_038352dc33);
      case NativeListingGcalState.unknown:
        final reason = detail == null ? uiCopy(UiMessage.m_this_app_could_not_read_12fe2a90ce) : knownUiCopy(detail!);
        return uiCopy(UiMessage.m_reason_reconnect_or_refresh_google_6de7c73977, {'reason': (reason).toString()});
    }
  }

  String? _freshnessSentence() {
    final at = lastSuccessAt;
    if (at == null) return null;
    final minutes = ((DateTime.now().millisecondsSinceEpoch - at) / 60000).round();
    if (minutes <= 0) return uiCopy(UiMessage.m_last_successful_sync_just_now_745754390a);
    if (minutes == 1) return uiCopy(UiMessage.m_last_successful_sync_1_minute_1b4810295a);
    if (minutes < 120) return uiCopy(UiMessage.m_last_successful_sync_minutes_minutes_431b2755cf, {'minutes': (minutes).toString()});
    final hours = (minutes / 60).round();
    return hours == 1 ? uiCopy(UiMessage.m_last_successful_sync_1_hour_ac06c3ee79) : uiCopy(UiMessage.m_last_successful_sync_hours_hours_0e2f8cf42c, {'hours': (hours).toString()});
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
