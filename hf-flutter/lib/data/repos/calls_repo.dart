import '../api_client.dart';
import '../api_exception.dart';
import '../models/call.dart';
import '../models/queue.dart';

/// Instant calls (HF-WIRE-7). The worker places the call (Vobiz rings the influencer, then this phone);
/// the app only starts it, follows it and ends it.
///
/// - `GET  /api/hf/wallet/estimate?host=<slug>` -> rate, balance, `canStart`, `affordableSeconds`, `lowBalanceSeconds`.
/// - `POST /api/hf/calls {hostSlug}` -> `{callId, status:'ringing_host'}`.
/// - `GET  /api/hf/calls/:id` -> status (`phase`, `reason`, `costPaise`, `walletPaise`, `capAt`...). Polled.
/// - `POST /api/hf/calls/:id/cancel` (before connect, 409 `already_connected` after) and `/end` (any time).
/// - `POST /api/hf/calls/:id/review {stars, text?}` -> `{ok}`.
/// - `GET  /api/hf/calls?role=caller&cursor=` -> `{items, nextCursor}`.
class CallsRepo {
  const CallsRepo(this._api);

  final ApiClient _api;

  Future<CallEstimate> estimate(String slug) async =>
      CallEstimate.fromJson(await _api.getJson('/api/hf/wallet/estimate', query: {'host': slug}));

  /// Returns the new call id. Throws [ApiException] (see [CallProblem]).
  Future<String> start(String slug, {String? lane}) async {
    final j = await _api.postJson('/api/hf/calls', body: {'hostSlug': slug, if (lane != null) 'lane': lane});
    final id = j['callId'];
    if (id is! String || id.isEmpty) throw ApiException.parse(200);
    return id;
  }

  Future<CallStatus> status(String callId) async =>
      CallStatus.fromJson(await _api.getJson('/api/hf/calls/${Uri.encodeComponent(callId)}'));

  /// Before it connects. A 409 `already_connected` means use [end] instead.
  Future<void> cancel(String callId) async {
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/cancel');
  }

  /// Hang up. Valid before or after connecting.
  Future<void> end(String callId) async {
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/end');
  }

  Future<void> review(String callId, int stars, {String? text}) async {
    await _api.postJson('/api/hf/calls/${Uri.encodeComponent(callId)}/review', body: {
      'stars': stars,
      if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
    });
  }

  Future<CallRecordsPage> history({String? cursor, int limit = 20}) async => CallRecordsPage.fromJson(await _api.getJson(
        '/api/hf/calls',
        query: {'role': 'caller', 'limit': limit, if (cursor != null) 'cursor': cursor},
      ));
}

/// What a failed call request means for the person, so screens branch on this and never on message text.
enum CallProblem {
  /// `hfCallsEnabled` is off (404 `not_enabled`) or the phone line is not set up (503 `calls_not_ready`).
  notOpen,

  /// 402 `low_balance`, 409 `debt_open`: top up.
  lowBalance,

  /// 409 `host_unavailable` (or `host_offline`): busy, offline, blocked. Offer Notify me and Book a time.
  hostUnavailable,

  /// 409 `call_in_progress`.
  inProgress,

  /// Anything else: show [CallProblemInfo.message] and let them retry.
  other,
}

class CallProblemInfo {
  const CallProblemInfo(this.problem, this.message, {this.reason, this.canQueue, this.canBook, this.queueWaiting = 0});

  final CallProblem problem;
  final String message;

  /// [HF-CALL-MODES-E2] Why a `host_unavailable` refusal happened (`on_call`, `connecting`, `queue_only`, `appointments`,
  /// `offline`) and what the fan can do about it. All null / 0 on an old server.
  final HostCallState? reason;
  final bool? canQueue;
  final bool? canBook;
  final int queueWaiting;

  static const String notOpenText = 'Calls are not open yet.';
  static const String unavailableText = "This host isn't available right now.";

  factory CallProblemInfo.of(Object error) {
    if (error is! ApiException) return const CallProblemInfo(CallProblem.other, ApiException.genericText);
    switch (error.code) {
      case 'not_enabled':
      case 'calls_not_ready':
        return const CallProblemInfo(CallProblem.notOpen, notOpenText);
      case 'low_balance':
      case 'debt_open':
        return CallProblemInfo(CallProblem.lowBalance, error.userMessage);
      case 'host_unavailable':
      case 'host_offline':
        final x = error.extra;
        final w = x['queueWaiting'];
        return CallProblemInfo(
          CallProblem.hostUnavailable,
          unavailableText,
          reason: hostCallStateOf(x['reason']),
          canQueue: x['canQueue'] is bool ? x['canQueue'] as bool : null,
          canBook: x['canBook'] is bool ? x['canBook'] as bool : null,
          queueWaiting: w is num ? w.toInt() : 0,
        );
      case 'call_in_progress':
        return CallProblemInfo(CallProblem.inProgress, error.userMessage);
    }
    return CallProblemInfo(CallProblem.other, error.userMessage);
  }
}
