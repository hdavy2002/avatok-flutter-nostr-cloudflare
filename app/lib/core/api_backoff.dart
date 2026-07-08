import 'dart:async';

import 'analytics.dart';
import 'ava_log.dart';

/// Minimal exponential backoff state machine for API calls that may return
/// transient errors (503) or validation errors (422). Prevents hammering
/// the server on transient failures.
///
/// Usage: instantiate once per API endpoint that needs backoff, then call
/// [shouldRetry] before each attempt. On 503, keeps backing off; on 422,
/// never retries. On success, resets.
class ApiBackoffState {
  final String endpoint;
  int _attemptsSince503 = 0;
  DateTime? _lastBackoffResetAt;

  // Backoff sequence: 30s, 1m, 5m, 30m (caps at 30m)
  static const List<Duration> backoffSequence = [
    Duration(seconds: 30),
    Duration(minutes: 1),
    Duration(minutes: 5),
    Duration(minutes: 30),
  ];

  ApiBackoffState(this.endpoint);

  /// Whether to attempt this API call now, or skip due to backoff.
  /// - 422 (validation reject): logs once, returns false forever (non-retryable).
  /// - 503 (transient): backs off exponentially, keeps retrying.
  /// - success: resets the backoff counter.
  bool shouldRetry(int status) {
    if (status == 422 || status == 400) {
      // Validation error — never retry this call.
      // [PROFILE-400-LOOP-1] (2026-07-08): 400 now counts as a validation reject
      // too. profileUpsert's own validations (invalid_birth_year /
      // profile_incomplete / implausible_name / photo vet) return 400, not the
      // 422 this guard was built for, so 400s fell through to "allow retry" and
      // the per-launch auto-publish re-POSTed the same invalid payload forever
      // (PostHog: /api/profile 400 x49 across 5 users). Same payload → same
      // verdict; a resubmit only helps after the user EDITS the profile, and the
      // save screen calls [reset] for exactly that.
      AvaLog.I.log('api_backoff', '$endpoint: $status validation error, no retry');
      Analytics.capture('api_error', {'endpoint': endpoint, 'status': status, 'backoff': 'never'});
      _attemptsSince503 = -1; // Mark as permanently failed
      return false;
    }
    if (_attemptsSince503 < 0) {
      // Already hit a 422 — stay failed
      return false;
    }
    if (status == 503) {
      final backoffDuration = backoffSequence[_attemptsSince503.clamp(0, backoffSequence.length - 1)];
      _lastBackoffResetAt = DateTime.now().add(backoffDuration);
      _attemptsSince503++;
      AvaLog.I.log('api_backoff', '$endpoint: 503, next attempt in ${backoffDuration.inSeconds}s');
      Analytics.capture('api_error', {
        'endpoint': endpoint,
        'status': 503,
        'backoff_stage': _attemptsSince503.clamp(0, backoffSequence.length),
        'backoff_seconds': backoffDuration.inSeconds,
      });
      return false;
    }
    if (status == 200 || (status >= 200 && status < 300)) {
      // Success — reset backoff
      if (_attemptsSince503 > 0) {
        AvaLog.I.log('api_backoff', '$endpoint: recovered after ${_attemptsSince503} backoff stages');
      }
      _attemptsSince503 = 0;
      _lastBackoffResetAt = null;
      return true;
    }
    // Other errors (4xx, 5xx) — allow retry (handled by caller)
    return true;
  }

  /// Time until the next retry is allowed (for 503 backoff).
  /// Returns Duration.zero if backoff is not active.
  Duration get timeUntilNextRetry {
    if (_lastBackoffResetAt == null) return Duration.zero;
    final now = DateTime.now();
    if (now.isAfter(_lastBackoffResetAt!)) {
      _lastBackoffResetAt = null;
      return Duration.zero;
    }
    return _lastBackoffResetAt!.difference(now);
  }

  /// True if backoff is currently active (waiting before next retry).
  bool get isBackingOff => _lastBackoffResetAt != null && DateTime.now().isBefore(_lastBackoffResetAt!);

  /// True if this endpoint has been permanently disabled (422 hit).
  bool get isPermanentlyFailed => _attemptsSince503 < 0;

  /// CALLFIX-R7: Reset the backoff state so a user-initiated retry can proceed.
  /// Called when the user fixes input and retries a profile save after a 422.
  void reset() {
    _attemptsSince503 = 0;
    _lastBackoffResetAt = null;
    AvaLog.I.log('api_backoff', '$endpoint: backoff reset by user');
  }
}
