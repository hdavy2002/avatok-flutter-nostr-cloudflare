import '../../../core/api/api_error.dart';
import '../../../core/format/money.dart'
    show formatPaise, formatPaiseRate, formatRupees;
import '../../../core/strings.dart';
import '../../explore/data/host_card.dart' show PriceTier;

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
    this.chargedPaise,
    this.chargedLabel,
    this.plan,
    this.tiers = const <CallTierLine>[],
    this.earningPaise,
    this.earningLabel,
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

  /// Exact connected seconds for a per-second call.
  final int? billableSeconds;
  /// Legacy per-second amount field. It represents rupees and is never labelled as tokens.
  final String? tokensSpent;

  final int? chargedPaise;
  final String? chargedLabel;
  final String? plan;
  final List<CallTierLine> tiers;
  final int? earningPaise;
  final String? earningLabel;

  bool get isMeteredCall => billableSeconds != null;
  bool get isHostView => earningPaise != null || earningLabel != null;

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
      billableSeconds: j['billableSeconds'] == null
          ? null
          : i(j['billableSeconds']),
      tokensSpent: j['tokensSpent'] == null ? null : '${j['tokensSpent']}',
      chargedPaise: j['chargedPaise'] is num
          ? (j['chargedPaise'] as num).round()
          : null,
      chargedLabel: s(j['charged']),
      plan: s(j['plan']),
      tiers: CallTierLine.listFrom(j['tiers']),
      earningPaise: j['earningPaise'] is num
          ? (j['earningPaise'] as num).round()
          : null,
      earningLabel: s(j['earning']),
    );
  }
}

class CallTierLine {
  const CallTierLine({
    required this.tier,
    required this.seconds,
    required this.amountPaise,
  });

  final PriceTier tier;
  final int seconds;
  final int amountPaise;

  String get bandLabel => tierBandLabel(tier);

  static List<CallTierLine> listFrom(Object? raw) {
    if (raw is! List) return const <CallTierLine>[];
    final out = <CallTierLine>[];
    for (final value in raw) {
      if (value is! Map) continue;
      final tier = PriceTier.tryParse(value);
      if (tier == null) continue;
      num? n(Object? v) =>
          v is num ? v : (v is String ? num.tryParse(v) : null);
      out.add(CallTierLine(
        tier: tier,
        seconds: n(value['seconds'])?.round() ?? 0,
        amountPaise: n(value['amountPaise'])?.round() ?? 0,
      ));
    }
    return out;
  }
}

String tierBandLabel(PriceTier tier) {
  final to = tier.toMin;
  if (to == null) return 'After ${tier.fromMin} min';
  if (tier.fromMin <= 0) return 'First $to min';
  return 'Next ${to - tier.fromMin} min';
}

int? currentRatePaise(List<PriceTier> tiers, int elapsedSeconds) {
  if (tiers.isEmpty) return null;
  final seconds = elapsedSeconds < 0 ? 0 : elapsedSeconds;
  for (final tier in tiers) {
    final to = tier.toMin;
    if (seconds >= tier.fromMin * 60 &&
        (to == null || seconds < to * 60)) {
      return tier.paisePerMin;
    }
  }
  return tiers.last.paisePerMin;
}

/// `GET /api/hf/wallet/estimate?host=<slug>`: old mode `{mode:"inr", ratePerMinRupees}`, token mode
/// `{mode:"tokens", ratePerMinRupees, tokensPerMinute, aboutText, affordableSeconds, canStart, hasDebt, balance}`.
class CallEstimate {
  const CallEstimate({
    required this.isMetered,
    required this.ratePerMinRupees,
    this.ratePaisePerMin,
    this.plan,
    this.tiers = const <PriceTier>[],
    this.aboutText,
    this.affordableSeconds,
    this.canStart = true,
    this.hasDebt = false,
    this.startNeedPaise,
    this.startNeed,
    this.balance,
  });

  final bool isMetered;
  final num ratePerMinRupees;
  final int? ratePaisePerMin;
  final String? plan;
  final List<PriceTier> tiers;

  /// `about 3 min 20 s`, or `add tokens to call` with an empty balance (the server writes it).
  final String? aboutText;
  final int? affordableSeconds;
  final bool canStart;
  final bool hasDebt;
  final int? startNeedPaise;
  final String? startNeed;
  final String? balance;

  int get ratePaise =>
      ratePaisePerMin ?? (ratePerMinRupees * 100).round();
  String? get startNeedLabel =>
      startNeedPaise != null ? formatPaise(startNeedPaise!) : startNeed;

  factory CallEstimate.fromJson(Map<String, dynamic> j) {
    final mode = j['mode'];
    final metered = mode == 'rupees' || mode == 'tokens';
    num? n(Object? v) =>
        v is num ? v : (v is String ? num.tryParse(v) : null);
    return CallEstimate(
      isMetered: metered,
      ratePerMinRupees: n(j['ratePerMinRupees']) ?? 0,
      ratePaisePerMin: n(j['ratePaisePerMin'])?.round(),
      plan: j['plan'] == null ? null : '${j['plan']}',
      tiers: PriceTier.listFrom(j['tiers']),
      aboutText: j['aboutText'] == null ? null : '${j['aboutText']}',
      affordableSeconds: n(j['affordableSeconds'])?.toInt(),
      // Old mode has no balance check on the server estimate: the start call is the authority.
      canStart: metered ? j['canStart'] != false : true,
      hasDebt: j['hasDebt'] == true,
      startNeedPaise: n(j['startNeedPaise'])?.round(),
      startNeed: j['startNeed'] == null ? null : '${j['startNeed']}',
      balance: j['balance'] == null ? null : '${j['balance']}',
    );
  }
}

/// `POST /api/hf/calls` success: `{ok, callId, status:"ringing_host", rate, maxMinutes, maxSeconds?, mode?:"tokens"}`.
class StartedCall {
  const StartedCall({
    required this.callId,
    this.rate,
    this.maxMinutes,
    this.isMetered = false,
    this.plan,
  });

  final String callId;
  final num? rate;
  final int? maxMinutes;
  final bool isMetered;
  final String? plan;

  factory StartedCall.fromJson(Map<String, dynamic> j) => StartedCall(
    callId: '${j['callId'] ?? ''}',
    rate: j['rate'] is num ? j['rate'] as num : null,
    maxMinutes: j['maxMinutes'] is num
        ? (j['maxMinutes'] as num).toInt()
        : null,
    isMetered:
        j['mode'] == 'tokens' ||
        j['mode'] == 'rupees' ||
        j['plan'] == 'standard',
    plan: j['plan'] == null ? null : '${j['plan']}',
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
    if (e.isNotEnabled) {
      return CallStartProblem(
        CallProblemKind.comingSoon,
        Strings.comingSoonBody,
        code: code,
      );
    }
    if (e.isOffline) {
      return CallStartProblem(CallProblemKind.retry, e.userMessage, code: code);
    }
    switch (code) {
      case 'host_unavailable':
      case 'host_declined':
      case 'blocked':
        return CallStartProblem(
          CallProblemKind.hostUnavailable,
          CallStrings.hostUnavailable,
          code: code,
        );
      case 'call_in_progress':
        return CallStartProblem(
          CallProblemKind.callInProgress,
          e.userMessage,
          code: code,
        );
      case 'not_verified':
      case 'unauthorized':
        return CallStartProblem(
          CallProblemKind.signIn,
          e.userMessage,
          code: code,
        );
      case 'lane_required':
        final lane = e.extra['lane'];
        return CallStartProblem(
          CallProblemKind.lane,
          e.userMessage,
          lane: lane is String && lane.isNotEmpty ? lane : 'women',
          code: code,
        );
      case 'low_balance':
        final shortfall = e.extra['shortfallRupees'];
        return CallStartProblem(
          CallProblemKind.wallet,
          shortfall is String && shortfall.isNotEmpty
              ? 'You need about $shortfall more in your wallet to start this call.'
              : e.userMessage,
          code: code,
        );
      case 'debt_open':
        return CallStartProblem(
          CallProblemKind.debt,
          e.userMessage,
          code: code,
        );
      case 'wallet_busy':
      case 'call_failed':
      case 'rate_limited':
        return CallStartProblem(
          CallProblemKind.retry,
          e.userMessage,
          code: code,
        );
      case 'account_closing':
      case 'calls_not_ready':
        // Trying again changes nothing: just the worker's own words.
        return CallStartProblem(
          CallProblemKind.message,
          e.userMessage,
          code: code,
        );
    }
    if (e.status == 429 || e.status >= 500) {
      return CallStartProblem(CallProblemKind.retry, e.userMessage, code: code);
    }
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
  static const String addMoney = 'Add money';
  static const String clearWhatYouOwe = 'Clear what you owe';
  static const String notifyMe = 'Notify me';
  static const String verifyToCall = 'Verify to call';
  static const String signInAgain = 'Sign in again';
  static const String goToMyCall = 'Go to my call';
  static const String callsOpenSoon = 'Calls open soon';

  /// The 2-minute minimum rule (worker: START_RESERVE_MINUTES).
  static String startRule(String? startNeed) => startNeed == null
      ? 'A call starts only if you have 2 minutes of balance. There is no time limit: it ends when you hang up or your balance is used up.'
      : 'A call starts only if you have at least $startNeed (2 minutes). There is no time limit: it ends when you hang up or your balance is used up.';
  static const String legacyStartRule =
      'A call starts only if you have 2 minutes of balance. A call lasts up to 60 minutes.';
  static String needToStart(String? startNeed) => startNeed == null
      ? 'You need at least 2 minutes of balance to start. Add money to call.'
      : 'You need at least $startNeed to start a call. Add money to call.';
  static const String billedPerSecond =
      'Billed per second, at the Standard rate. The same rate for every host.';
  static const String rateCardTitle = 'Standard rate';
  static const String phoneRings =
      'Your phone will ring. Pick up to connect. Your number stays private.';
  static const String ringingNoCharge = 'Ringing or no answer costs nothing.';

  static const String screenTitle = 'Your call';
  static const String yourPhoneWillRing =
      'Your phone will ring in a few seconds';
  static const String yourPhoneWillRingSub =
      'Please keep your phone nearby and pick up when it rings. Your number stays private.';
  static const String cancelCall = 'Cancel call';
  static const String cancelling = 'Cancelling…';
  static const String tooLateToCancel =
      "It's too late to cancel: you are already connected.";
  static const String cancelFailed =
      "We couldn't cancel the call. Please try again.";
  static const String connected = 'Connected';
  static const String endWithHash =
      'Press # on your phone to end the call and block.';
  static const String noLimitHint =
      'There is no time limit. The call ends when you hang up or your balance is used up.';
  static const String legacyLimitHint = 'A call can last up to 60 minutes.';
  static String currentRate(int paisePerMin) =>
      'Current rate: ${formatPaiseRate(paisePerMin)}';
  static const String checking = 'Checking your call…';
  static const String connectionTrouble =
      "We can't reach the server. If your phone is ringing, you can still pick up.";
  static const String callNotFound = "We couldn't find this call.";
  static const String done = 'Done';
  static const String rateYourCall = 'Rate your call';
  static const String callEnded = 'Call ended';
  static const String timeTalked = 'Time talked';
  static const String charged = 'Charged';
  static const String earned = 'You earned';
  static const String noTimeBilled = 'No time billed';

  // ---- Confirm sheet (mockup CallSheet) ----
  static const String rateLabel = 'Rate';
  static const String minBalanceNote =
      'Calls start only with 2 minutes of balance.';
  static const String orTapToCall = 'Or tap here to call';
  static const String addMoneyToCall = 'add money to call';
  static String slideToCall(String name) => 'Slide to call $name';
  static String yourWalletAmount(String amount) => 'Your wallet $amount';
  static const String yourWalletPlain = 'Your wallet';
  static String stepRingFirst(String name) =>
      'We ring $name first. No answer, no charge.';
  static const String stepPhoneLead = 'Then ';
  static const String stepPhoneBold = 'your phone rings';
  static const String stepPhoneTail = '. Pick up to connect.';
  static const String stepEnd =
      'Press # any time to end. There is no time limit.';
  static const String legacyStepEnd =
      'Press # any time to end. Max 60 minutes.';

  // ---- Call screen (mockup Calling) ----
  static const String bothPrivate = 'Both numbers stay private';
  static const String progressLabel = 'Call progress';
  static const String progressYou = 'You';
  static const String progressTalking = 'Talking';
  static String ringingHostHeadline(String name) => 'Ringing $name…';
  static const String ringingHostNote =
      "If they don't pick up, you won't be charged.";
  static String saidYes(String name) => '$name said yes';
  static const String phoneWillRingNow =
      'Your phone will ring now.\nPick it up.';
  static const String billingStarts =
      'Billing starts only once you are connected.';
  static const String endFromPhone = 'End the call from your phone';

  /// "Ringing {name}… If they don't pick up, you won't be charged."
  static String ringingHost(String name) =>
      "Ringing $name… If they don't pick up, you won't be charged.";

  /// "{name} said yes. Your phone will ring now. Pick it up."
  static String ringingCaller(String name) =>
      '$name said yes. Your phone will ring now. Pick it up.';

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
        return 'The call reached its time limit.';
      case 'balance':
        return 'Your balance ran out.';
      case 'error':
        return 'The call ended because of a problem.';
    }
    return null;
  }

  /// A rupee figure for the summary. Wallet calls show the server's amount as rupees.
  static String chargedText(CallInfo info) {
    final charged = info.chargedPaise;
    if (charged != null) return formatPaise(charged);
    final label = info.chargedLabel;
    if (label != null) return label;
    final tokens = info.tokensSpent;
    if (tokens != null) {
      final n = num.tryParse(tokens);
      return n == null ? '₹$tokens' : formatRupees(n);
    }
    return formatRupees(info.chargedRupees);
  }

  /// Is there any charge to show?
  static bool hasCharge(CallInfo info) {
    if (info.chargedPaise != null) return info.chargedPaise! > 0;
    final tokens = info.tokensSpent;
    if (tokens != null) return (num.tryParse(tokens) ?? 0) > 0;
    return info.chargedRupees > 0;
  }

  static String? earningText(CallInfo info) {
    final paise = info.earningPaise;
    if (paise != null) return formatPaise(paise);
    return info.earningLabel;
  }
}
