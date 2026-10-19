/// Instant-call shapes (HF-WIRE-7). Everything is read defensively: a missing or odd field never throws,
/// it falls back to a calm default, because the worker adds fields over time.

int _int(Object? v, [int d = 0]) => v is num ? v.toInt() : (v is String ? int.tryParse(v) ?? d : d);
int? _intOrNull(Object? v) => v is num ? v.toInt() : null;
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// [HF-WIRE-13] Owner's rule: a wallet needs at least Rs 20 to start a call (the server's number wins; this is the fallback).
const int kDefaultMinBalancePaise = 2000;

String _rupeeWord(int paise) {
  final r = paise / 100;
  return r == r.roundToDouble() ? '\u20B9${r.round()}' : '\u20B9${r.toStringAsFixed(2)}';
}

/// "You need at least ₹20 in your wallet to call. Top up to keep going."
String lowBalanceText(int minPaise) => 'You need at least ${_rupeeWord(minPaise)} in your wallet to call. Top up to keep going.';

/// "Call ended in the first minute. We charged ₹1 and returned the rest to your wallet."
String firstMinuteChargeText(int chargePaise) => 'Call ended in the first minute. We charged ${_rupeeWord(chargePaise)} and returned the rest to your wallet.';

/// What a call with one influencer would cost this person right now (`GET /api/hf/wallet/estimate?host=`).
class CallEstimate {
  const CallEstimate({
    required this.ratePerMinRupees,
    required this.canStart,
    required this.balancePaise,
    required this.startNeedPaise,
    required this.affordableSeconds,
    required this.lowBalanceSeconds,
    required this.hasDebt,
    this.minBalancePaise = kDefaultMinBalancePaise,
    this.lowBalanceMessage,
  });

  factory CallEstimate.fromJson(Map<String, dynamic> j) {
    final rate = j['ratePerMinRupees'];
    final paise = _intOrNull(j['ratePaisePerMin']);
    return CallEstimate(
      ratePerMinRupees: rate is num ? rate.toDouble() : (paise == null ? 0.0 : paise / 100),
      canStart: j['canStart'] != false,
      balancePaise: _intOrNull(j['balancePaise']),
      startNeedPaise: _intOrNull(j['startNeedPaise']),
      affordableSeconds: _intOrNull(j['affordableSeconds']),
      lowBalanceSeconds: _int(j['lowBalanceSeconds'], 180),
      hasDebt: j['hasDebt'] == true,
      minBalancePaise: _intOrNull(j['minBalancePaise']) ?? kDefaultMinBalancePaise,
      lowBalanceMessage: _str(j['lowBalanceMessage']),
    );
  }

  final double ratePerMinRupees;

  /// The server's own yes/no on starting (enough for the minimum, no debt).
  final bool canStart;

  /// Null when the server could not say (old rupee mode); the server then decides at start.
  final int? balancePaise;
  final int? startNeedPaise;
  final int? affordableSeconds;

  /// Below this much talk time left, the app offers a top-up. Comes from the server (3 minutes).
  final int lowBalanceSeconds;
  final bool hasDebt;

  /// [HF-WIRE-13] The least a wallet must hold to start a call, in paise. Comes from the server (config hfCallMinBalanceRupees, Rs 20).
  final int minBalancePaise;

  /// The server's own wording for the low-balance state, when it sent one.
  final String? lowBalanceMessage;

  /// Below the wallet minimum: block the start and show a top-up.
  bool get belowMinBalance => balancePaise != null && balancePaise! < minBalancePaise;

  /// What to tell the person when the balance is low: the server's words, else the owner's sentence built from the server's minimum.
  String get lowMessage => (lowBalanceMessage != null && lowBalanceMessage!.isNotEmpty) ? lowBalanceMessage! : lowBalanceText(minBalancePaise);

  /// Whole minutes of talk time the wallet covers, when known.
  int? get talkMinutes => affordableSeconds == null ? null : affordableSeconds! ~/ 60;

  /// Not enough for a comfortable call: top up first.
  bool get low => !canStart || hasDebt || belowMinBalance || (affordableSeconds != null && affordableSeconds! < lowBalanceSeconds);
}

/// The phases the call screen shows.
enum CallPhase { ringingHost, hostAccepted, dialingFan, connected, ended }

/// Why an ended call ended, in the app's words. `null` while it is live.
enum CallReason { declined, missed, busy, offline, noBalance, ended }

/// `GET /api/hf/calls/:id`. Never carries a phone number.
class CallStatus {
  const CallStatus({
    required this.id,
    required this.status,
    required this.phase,
    required this.reason,
    required this.hostSlug,
    required this.hostName,
    required this.connectedAt,
    required this.endedAt,
    required this.billedMinutes,
    required this.costPaise,
    required this.walletPaise,
    required this.capAt,
    required this.lowBalanceSeconds,
    required this.canReview,
    required this.endReason,
    this.firstMinuteDrop = false,
    this.firstMinuteChargePaise,
    this.firstMinuteMessage,
  });

  factory CallStatus.fromJson(Map<String, dynamic> j) {
    final status = _str(j['status']) ?? 'ringing_host';
    final phase = _phase(_str(j['phase']), status);
    var cost = _intOrNull(j['costPaise']);
    // Older worker: only chargedRupees on the row.
    cost ??= (((j['chargedRupees'] is num) ? (j['chargedRupees'] as num) : 0) * 100).round();
    return CallStatus(
      id: _str(j['id']) ?? '',
      status: status,
      phase: phase,
      reason: phase == CallPhase.ended ? _reason(_str(j['reason']), status, _str(j['endReason'])) : null,
      hostSlug: _str(j['hostSlug']),
      hostName: _str(j['hostName']),
      connectedAt: _intOrNull(j['connectedAt']),
      endedAt: _intOrNull(j['endedAt']),
      billedMinutes: _int(j['billedMinutes']),
      costPaise: cost,
      walletPaise: _intOrNull(j['walletPaise']),
      capAt: _intOrNull(j['capAt']),
      lowBalanceSeconds: _int(j['lowBalanceSeconds'], 180),
      canReview: j['canReview'] == true,
      endReason: _str(j['endReason']),
      firstMinuteDrop: j['firstMinuteDrop'] == true,
      firstMinuteChargePaise: _intOrNull(j['firstMinuteChargePaise']),
      firstMinuteMessage: _str(j['firstMinuteMessage']),
    );
  }

  final String id;

  /// The raw row status (`ringing_host`, `connected`, `completed`, `host_declined`...).
  final String status;
  final CallPhase phase;
  final CallReason? reason;
  final String? hostSlug;
  final String? hostName;

  /// Epoch ms.
  final int? connectedAt;
  final int? endedAt;
  final int billedMinutes;

  /// Cost so far while connected; the final charge once ended.
  final int costPaise;

  /// What is left in the wallet for this call while connected (null otherwise).
  final int? walletPaise;

  /// Epoch ms when the balance runs out (null if unknown).
  final int? capAt;
  final int lowBalanceSeconds;
  final bool canReview;
  final String? endReason;

  /// [HF-WIRE-13] The call joined but broke in the first minute: only a small fixed charge was taken and the rest went back to the wallet.
  final bool firstMinuteDrop;
  final int? firstMinuteChargePaise;
  final String? firstMinuteMessage;

  /// The line shown on the call-ended screen for a first-minute break (server wording when sent).
  String get firstMinuteText => (firstMinuteMessage != null && firstMinuteMessage!.isNotEmpty) ? firstMinuteMessage! : firstMinuteChargeText(firstMinuteChargePaise ?? costPaise);

  bool get isEnded => phase == CallPhase.ended;

  /// Did the two people ever talk?
  bool get wasConnected => connectedAt != null || (status == 'completed' && billedMinutes > 0);

  /// Declined, missed, busy or offline: the "Busy right now" screen.
  bool get unavailable => isEnded && !wasConnected && (reason == CallReason.declined || reason == CallReason.missed || reason == CallReason.busy || reason == CallReason.offline);

  static CallPhase _phase(String? p, String status) {
    switch (p) {
      case 'ringing_host':
        return CallPhase.ringingHost;
      case 'host_accepted':
        return CallPhase.hostAccepted;
      case 'dialing_fan':
        return CallPhase.dialingFan;
      case 'connected':
        return CallPhase.connected;
      case 'ended':
        return CallPhase.ended;
    }
    switch (status) {
      case 'ringing_host':
        return CallPhase.ringingHost;
      case 'ringing_caller':
        return CallPhase.dialingFan;
      case 'connected':
        return CallPhase.connected;
      default:
        return CallPhase.ended;
    }
  }

  static CallReason _reason(String? r, String status, String? endReason) {
    switch (r) {
      case 'declined':
        return CallReason.declined;
      case 'missed':
        return CallReason.missed;
      case 'busy':
        return CallReason.busy;
      case 'offline':
        return CallReason.offline;
      case 'no_balance':
        return CallReason.noBalance;
      case 'ended':
        return CallReason.ended;
    }
    switch (status) {
      case 'host_declined':
        return CallReason.declined;
      case 'no_answer':
      case 'caller_no_answer':
        return CallReason.missed;
      case 'blocked':
        return CallReason.busy;
      case 'failed':
        return endReason == 'caller_hangup' ? CallReason.ended : CallReason.offline;
    }
    return endReason == 'balance' ? CallReason.noBalance : CallReason.ended;
  }
}

/// One row of the call records list (`GET /api/hf/calls?role=caller`).
class CallRecordItem {
  const CallRecordItem({
    required this.id,
    required this.status,
    required this.reason,
    required this.hostName,
    required this.hostSlug,
    required this.at,
    required this.seconds,
    required this.amountPaise,
    required this.stars,
  });

  factory CallRecordItem.fromJson(Map<String, dynamic> j) => CallRecordItem(
        id: _str(j['id']) ?? '',
        status: _str(j['status']) ?? '',
        reason: _str(j['reason']),
        hostName: _str(j['otherHandle']) ?? 'A host',
        hostSlug: _str(j['hostSlug']),
        at: _int(j['at']),
        seconds: _int(j['seconds']),
        amountPaise: _intOrNull(j['amountPaise']),
        stars: _int(j['myStars']),
      );

  final String id;
  final String status;
  final String? reason;
  final String hostName;
  final String? hostSlug;
  final int at;
  final int seconds;
  final int? amountPaise;

  /// The caller's own rating, 0 when none.
  final int stars;

  int get minutes => seconds <= 0 ? 0 : (seconds / 60).ceil();

  /// Never connected: declined, missed, busy, offline.
  bool get didNotConnect => status != 'completed' || (seconds <= 0 && (amountPaise ?? 0) == 0);
}

class CallRecordsPage {
  const CallRecordsPage({required this.items, required this.nextCursor});

  factory CallRecordsPage.fromJson(Map<String, dynamic> j) {
    final raw = j['items'];
    return CallRecordsPage(
      items: raw is List ? [for (final e in raw) if (e is Map) CallRecordItem.fromJson(Map<String, dynamic>.from(e))] : const [],
      nextCursor: _str(j['nextCursor']),
    );
  }

  final List<CallRecordItem> items;
  final String? nextCursor;
}
