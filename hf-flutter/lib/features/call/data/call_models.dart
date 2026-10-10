import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart';
import '../../../core/strings.dart';

/// `GET /api/hf/calls/:id` `status` values (worker `hf_calls.ts`, contract HF-CALLS-1).
enum CallStatus {
  ringingHost('ringing_host'),
  ringingCaller('ringing_caller'),
  connected('connected'),
  completed('completed'),
  hostDeclined('host_declined'),
  noAnswer('no_answer'),
  callerNoAnswer('caller_no_answer'),
  failed('failed'),
  blocked('blocked'),

  /// A value this build does not know. Treated as "still going": polling continues.
  unknown('unknown');

  const CallStatus(this.wire);

  /// The string the server sends (and telemetry reports).
  final String wire;

  static CallStatus parse(Object? raw) {
    final s = '$raw';
    for (final v in CallStatus.values) {
      if (v.wire == s && v != CallStatus.unknown) return v;
    }
    return CallStatus.unknown;
  }

  bool get isRinging => this == ringingHost || this == ringingCaller;

  /// The call is over: polling stops and the summary shows.
  bool get isTerminal =>
      this == completed ||
      this == hostDeclined ||
      this == noAnswer ||
      this == callerNoAnswer ||
      this == failed ||
      this == blocked;
}

/// A server timestamp as a DateTime. It may arrive in seconds or in milliseconds.
DateTime? callTime(Object? v) {
  if (v is! num || !v.isFinite || v <= 0) return null;
  final ms = v < 1e11 ? (v * 1000).round() : v.round();
  return DateTime.fromMillisecondsSinceEpoch(ms);
}

/// One call, as `GET /api/hf/calls/:id` answers it.
///
/// `{id, status, hostSlug, hostName, rate, connectedAt, endedAt, billedMinutes, chargedRupees, endReason,
///   canReview}` plus, for token calls, `{billableSeconds, tokensSpent}` (the caller sees tokens as a text
/// like `"1.20"`; the host never sees tokens). The app only displays these: nothing is computed here.
class CallInfo {
  const CallInfo({
    required this.id,
    required this.status,
    this.hostSlug,
    this.hostName,
    this.rate,
    this.connectedAt,
    this.endedAt,
    this.billedMinutes = 0,
    this.chargedRupees = 0,
    this.endReason,
    this.canReview = false,
    this.billableSeconds,
    this.tokensSpent,
  });

  final String id;
  final CallStatus status;
  final String? hostSlug;
  final String? hostName;

  /// Rupees per minute.
  final num? rate;
  final DateTime? connectedAt;
  final DateTime? endedAt;
  final int billedMinutes;
  final num chargedRupees;

  /// `caller_hangup | host_hangup | hash_block | time_limit | balance | error`.
  final String? endReason;
  final bool canReview;

  /// Token calls only.
  final int? billableSeconds;
  final String? tokensSpent;

  /// A token-mode call: it has a tokens figure.
  bool get isTokenCall => tokensSpent != null;

  /// Seconds actually talked: exact for a token call, whole billed minutes for an old-mode call.
  int get talkedSeconds => billableSeconds ?? billedMinutes * 60;

  /// The host's first name (or a friendly stand-in).
  String get hostFirstName {
    final n = (hostName ?? '').trim();
    if (n.isEmpty) return 'your host';
    return n.split(RegExp(r'\s+')).first;
  }

  factory CallInfo.fromJson(Map<String, dynamic> j) {
    int i(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;
    String? s(Object? v) {
      final t = (v ?? '').toString().trim();
      return t.isEmpty ? null : t;
    }

    return CallInfo(
      id: '${j['id'] ?? ''}',
      status: CallStatus.parse(j['status']),
      hostSlug: s(j['hostSlug']),
      hostName: s(j['hostName']),
      rate: j['rate'] is num ? j['rate'] as num : null,
      connectedAt: callTime(j['connectedAt']),
      endedAt: callTime(j['endedAt']),
      billedMinutes: i(j['billedMinutes']),
      chargedRupees: j['chargedRupees'] is num ? j['chargedRupees'] as num : 0,
      endReason: s(j['endReason']),
      canReview: j['canReview'] == true,
      billableSeconds: j['billableSeconds'] == null ? null : i(j['billableSeconds']),
      tokensSpent: j['tokensSpent'] == null ? null : '${j['tokensSpent']}',
    );
  }
}

/// `GET /api/hf/wallet/estimate?host=<slug>`: old mode `{mode:"inr", ratePerMinRupees}`, token mode
/// `{mode:"tokens", ratePerMinRupees, tokensPerMinute, aboutText, affordableSeconds, canStart, hasDebt, balance}`.
class CallEstimate {
  const CallEstimate({
    required this.isTokens,
    required this.ratePerMinRupees,
    this.tokensPerMinute,
    this.aboutText,
    this.affordableSeconds,
    this.canStart = true,
    this.hasDebt = false,
    this.balance,
  });

  final bool isTokens;
  final num ratePerMinRupees;
  final String? tokensPerMinute;

  /// `about 3 min 20 s`, or `add tokens to call` with an empty balance (the server writes it).
  final String? aboutText;
  final int? affordableSeconds;
  final bool canStart;
  final bool hasDebt;
  final String? balance;

  factory CallEstimate.fromJson(Map<String, dynamic> j) {
    final tokens = j['mode'] == 'tokens';
    return CallEstimate(
      isTokens: tokens,
      ratePerMinRupees: j['ratePerMinRupees'] is num ? j['ratePerMinRupees'] as num : 0,
      tokensPerMinute: j['tokensPerMinute'] == null ? null : '${j['tokensPerMinute']}',
      aboutText: j['aboutText'] == null ? null : '${j['aboutText']}',
      affordableSeconds: j['affordableSeconds'] is num ? (j['affordableSeconds'] as num).toInt() : null,
      // Old mode has no balance check on the server estimate: the start call is the authority.
      canStart: tokens ? j['canStart'] != false : true,
      hasDebt: j['hasDebt'] == true,
      balance: j['balance'] == null ? null : '${j['balance']}',
    );
  }
}

/// `POST /api/hf/calls` success: `{ok, callId, status:"ringing_host", rate, maxMinutes, maxSeconds?, mode?:"tokens"}`.
class StartedCall {
  const StartedCall({required this.callId, this.rate, this.maxMinutes, this.isTokens = false});

  final String callId;
  final num? rate;
  final int? maxMinutes;
  final bool isTokens;

  factory StartedCall.fromJson(Map<String, dynamic> j) => StartedCall(
        callId: '${j['callId'] ?? ''}',
        rate: j['rate'] is num ? j['rate'] as num : null,
        maxMinutes: j['maxMinutes'] is num ? (j['maxMinutes'] as num).toInt() : null,
        isTokens: j['mode'] == 'tokens',
      );
}

/// What the person should be offered when starting a call fails.
enum CallProblemKind {
  /// A flag is off: the calm "Coming soon" panel.
  comingSoon,

  /// The host cannot take a call (busy, offline, blocked, declined): offer Notify me.
  hostUnavailable,

  /// Resume the call that is already going.
  callInProgress,

  /// The session is not verified: sign in again.
  signIn,

  /// A lane host: open the lane verification screen.
  lane,

  /// Not enough balance: open the Wallet.
  wallet,

  /// Money owed after a refund: open the Wallet.
  debt,

  /// A temporary failure: Try again.
  retry,

  /// Just a message (account closing, calls not ready, anything else).
  message,
}

class CallStartProblem {
  const CallStartProblem(this.kind, this.message, {this.lane, this.code});

  final CallProblemKind kind;
  final String message;

  /// `women` or `lgbtq` for [CallProblemKind.lane].
  final String? lane;

  /// The server's error code, for telemetry.
  final String? code;

  /// Maps a `POST /api/hf/calls` failure to what the screen does (spec section 2.8 table).
  /// `host_unavailable` always uses the one calm sentence (HF-WELL-3: never a rejection).
  static CallStartProblem fromError(ApiError e) {
    final code = e.code;
    if (e.isNotEnabled) return CallStartProblem(CallProblemKind.comingSoon, Strings.comingSoonBody, code: code);
    if (e.isOffline) return CallStartProblem(CallProblemKind.retry, e.userMessage, code: code);
    switch (code) {
      case 'host_unavailable':
      case 'host_declined':
      case 'blocked':
        return CallStartProblem(CallProblemKind.hostUnavailable, CallStrings.hostUnavailable, code: code);
      case 'call_in_progress':
        return CallStartProblem(CallProblemKind.callInProgress, e.userMessage, code: code);
      case 'not_verified':
      case 'unauthorized':
        return CallStartProblem(CallProblemKind.signIn, e.userMessage, code: code);
      case 'lane_required':
        final lane = e.extra['lane'];
        return CallStartProblem(CallProblemKind.lane, e.userMessage,
            lane: lane is String && lane.isNotEmpty ? lane : 'women', code: code);
      case 'low_balance':
        return CallStartProblem(CallProblemKind.wallet, e.userMessage, code: code);
      case 'debt_open':
        return CallStartProblem(CallProblemKind.debt, e.userMessage, code: code);
      case 'wallet_busy':
      case 'call_failed':
      case 'rate_limited':
        return CallStartProblem(CallProblemKind.retry, e.userMessage, code: code);
      case 'account_closing':
      case 'calls_not_ready':
        // Trying again changes nothing: just the worker's own words.
        return CallStartProblem(CallProblemKind.message, e.userMessage, code: code);
    }
    if (e.status == 429 || e.status >= 500) return CallStartProblem(CallProblemKind.retry, e.userMessage, code: code);
    // account_closing, calls_not_ready, invalid_lane and anything unknown: the worker's own words.
    return CallStartProblem(CallProblemKind.message, e.userMessage, code: code);
  }
}

/// Copy for the call feature. The brand name is never typed here.
abstract final class CallStrings {
  static const String hostUnavailable = "This host isn't available right now.";
  static const String safetyNotice =
      'This is a friendly chat, not counselling. In crisis, dial 14416. Press # at any time to end the call and block.';
  static const String startCall = 'Start call';
  static const String notNow = 'Not now';
  static const String addTokens = 'Add tokens';
  static const String clearWhatYouOwe = 'Clear what you owe';
  static const String notifyMe = 'Notify me';
  static const String verifyToCall = 'Verify to call';
  static const String signInAgain = 'Sign in again';
  static const String goToMyCall = 'Go to my call';
  static const String callsOpenSoon = 'Calls open soon';

  /// The 2-minute minimum rule (worker: START_RESERVE_MINUTES).
  static const String twoMinuteRule = 'A call starts only if you have 2 minutes of balance. A call lasts up to 60 minutes.';
  static const String phoneRings = 'Your phone will ring. Pick up to connect. Your number stays private.';
  static const String ringingNoCharge = 'Ringing or no answer costs nothing.';

  static const String screenTitle = 'Your call';
  static const String yourPhoneWillRing = 'Your phone will ring in a few seconds';
  static const String yourPhoneWillRingSub =
      'Please keep your phone nearby and pick up when it rings. Your number stays private.';
  static const String cancelCall = 'Cancel call';
  static const String cancelling = 'Cancelling…';
  static const String tooLateToCancel = "It's too late to cancel: you are already connected.";
  static const String cancelFailed = "We couldn't cancel the call. Please try again.";
  static const String connected = 'Connected';
  static const String endWithHash = 'Press # on your phone to end the call and block.';
  static const String maxLengthHint = 'A call can last up to 60 minutes.';
  static const String checking = 'Checking your call…';
  static const String connectionTrouble = "We can't reach the server. If your phone is ringing, you can still pick up.";
  static const String callNotFound = "We couldn't find this call.";
  static const String done = 'Done';
  static const String rateYourCall = 'Rate your call';
  static const String callEnded = 'Call ended';
  static const String timeTalked = 'Time talked';
  static const String charged = 'Charged';
  static const String noTimeBilled = 'No time billed';

  /// "Ringing {name}… If they don't pick up, you won't be charged."
  static String ringingHost(String name) => "Ringing $name… If they don't pick up, you won't be charged.";

  /// "{name} said yes. Your phone will ring now. Pick it up."
  static String ringingCaller(String name) => '$name said yes. Your phone will ring now. Pick it up.';

  /// Why a call ended, in simple English. Null when there is nothing useful to add.
  static String? endReasonText(String? reason, String hostName) {
    switch (reason) {
      case 'caller_hangup':
        return 'You ended the call.';
      case 'host_hangup':
        return '$hostName ended the call.';
      case 'hash_block':
        return 'The call ended because # was pressed. That person is now blocked.';
      case 'time_limit':
        return 'The call reached the 60-minute limit.';
      case 'balance':
        return 'Your balance ran out.';
      case 'error':
        return 'The call ended because of a problem.';
    }
    return null;
  }

  /// A rupee or token figure for the summary. Token calls show the server's text with a unit.
  static String chargedText(CallInfo info) {
    final tokens = info.tokensSpent;
    if (tokens != null) {
      final n = num.tryParse(tokens);
      return n == null ? '$tokens tokens' : Money.tokensWithUnit(n);
    }
    return Money.rupees(info.chargedRupees);
  }

  /// Is there any charge to show?
  static bool hasCharge(CallInfo info) {
    final tokens = info.tokensSpent;
    if (tokens != null) return (num.tryParse(tokens) ?? 0) > 0;
    return info.chargedRupees > 0;
  }
}
