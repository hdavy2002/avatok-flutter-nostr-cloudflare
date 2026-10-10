import '../../../core/format/money.dart';

// Typed answers for the Host dashboard. Parsing is tolerant: a missing key is a safe default, so the
// screen keeps working while the legacy (rupee wallet) and token-mode (host ledger) shapes both exist.
// Hosts only ever see rupees: nothing in here is a token amount.

num? _num(Object? v) => v is num ? v : (v is String ? num.tryParse(v) : null);
int _int(Object? v, [int fallback = 0]) => _num(v)?.round() ?? fallback;
int? _intOrNull(Object? v) => _num(v)?.round();

String? _str(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

Map<String, dynamic>? _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : null;

List<Map<String, dynamic>> _maps(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const <Map<String, dynamic>>[];

/// `GET /api/hosts/me`: only what the dashboard needs, the profile status and the reviewer's note.
class HostProfileStatus {
  const HostProfileStatus({required this.hasHost, this.status = 'draft', this.reviewNote});

  final bool hasHost;

  /// `draft | generating | pending_host | pending_review | submitted | live | rejected | paused`.
  final String status;

  /// The reviewer's reason when the profile was rejected or paused.
  final String? reviewNote;

  bool get isLive => status == 'live';
  bool get isInReview => status == 'pending_review' || status == 'submitted';

  /// Money screens (earnings, withdrawals) show once the profile has been through review.
  bool get showsMoney => status == 'live' || status == 'paused' || status == 'rejected';

  factory HostProfileStatus.fromJson(Map<String, dynamic> j) {
    final host = _map(j['host']);
    if (host == null) return const HostProfileStatus(hasHost: false);
    return HostProfileStatus(
      hasHost: true,
      status: _str(host['status']) ?? 'draft',
      reviewNote: _str(host['reviewNote']),
    );
  }
}

/// One row of `GET /api/hosts/me/calls`. Caller handles only, never numbers.
class HostCall {
  const HostCall({
    required this.id,
    required this.status,
    this.callerHandle,
    this.createdAt,
    this.billedMinutes = 0,
    this.earningRupees = 0,
    this.endReason,
  });

  final String id;
  final String status;
  final String? callerHandle;
  final int? createdAt;
  final int billedMinutes;

  /// Rupees the worker already worked out (a `num`; shown as is, never recomputed).
  final num earningRupees;
  final String? endReason;

  bool get completed => status == 'completed';

  factory HostCall.fromJson(Map<String, dynamic> j) => HostCall(
        id: (j['id'] ?? '').toString(),
        status: (j['status'] ?? '').toString(),
        callerHandle: _str(j['callerHandle']),
        createdAt: _intOrNull(j['createdAt']),
        billedMinutes: _int(j['billedMinutes']),
        earningRupees: _num(j['earningRupees']) ?? 0,
        endReason: _str(j['endReason']),
      );
}

class HostCallsData {
  const HostCallsData({this.calls = const <HostCall>[], this.todayCalls = 0, this.todayMinutes = 0, this.todayEarningRupees = 0});

  final List<HostCall> calls;
  final int todayCalls;
  final int todayMinutes;
  final num todayEarningRupees;

  factory HostCallsData.fromJson(Map<String, dynamic> j) {
    final today = _map(j['today']) ?? const <String, dynamic>{};
    return HostCallsData(
      calls: [for (final c in _maps(j['calls'])) HostCall.fromJson(c)],
      todayCalls: _int(today['calls']),
      todayMinutes: _int(today['minutes']),
      todayEarningRupees: _num(today['earningRupees']) ?? 0,
    );
  }
}

/// One call's earning, from `GET /api/hf/wallet` `host.perCall` (token mode only).
class CallEarning {
  const CallEarning({
    required this.callId,
    this.at,
    this.earnedPaise = 0,
    this.paidPaise = 0,
    this.testPaise = 0,
    this.availableAt,
  });

  final String callId;
  final int? at;
  final int earnedPaise;
  final int paidPaise;
  final int testPaise;

  /// When the 7-day hold ends (epoch ms), null when not known or already free.
  final int? availableAt;

  /// Earned only from test credits: shown as a test call and never withdrawable.
  bool get isTest => testPaise > 0 && paidPaise == 0;

  factory CallEarning.fromJson(Map<String, dynamic> j) => CallEarning(
        callId: (j['callId'] ?? '').toString(),
        at: _intOrNull(j['at']),
        earnedPaise: _int(j['earnedPaise']),
        paidPaise: _int(j['paidPaise']),
        testPaise: _int(j['testPaise']),
        availableAt: _intOrNull(j['availableAt']),
      );
}

/// Money that unlocks on one day.
class HoldRelease {
  const HoldRelease({required this.date, required this.paise});
  final DateTime date;
  final int paise;
}

/// The host block of `GET /api/hf/wallet`, in rupees. Two shapes:
/// - token mode: `pendingPaise / availablePaise / totalEarnedPaise / testEarningsPaise / paidOutPaise` and `perCall[]`;
/// - legacy: `heldRupees / availableRupees / lifetimePaidEarnings / testEarningsRupees` (no per-call list).
class HostEarnings {
  const HostEarnings({
    required this.total,
    required this.pending,
    required this.available,
    this.testEarnings,
    this.paidOut,
    this.perCall = const <CallEarning>[],
    this.tokenMode = false,
  });

  /// Display strings, already in rupees (`₹1,250`).
  final String total;
  final String pending;
  final String available;

  /// Null when there are no test earnings.
  final String? testEarnings;

  /// Null when none has been paid out (or the server did not say).
  final String? paidOut;
  final List<CallEarning> perCall;
  final bool tokenMode;

  /// The host block, or null when the answer has none (not a host).
  static HostEarnings? fromWalletJson(Map<String, dynamic> j) {
    final h = _map(j['host']);
    if (h == null) return null;
    final tokenMode = h.containsKey('availablePaise') || h.containsKey('pendingPaise');
    if (tokenMode) {
      final test = _int(h['testEarningsPaise']);
      final paidOut = _int(h['paidOutPaise']);
      return HostEarnings(
        total: Money.paise(_int(h['totalEarnedPaise'])),
        pending: Money.paise(_int(h['pendingPaise'])),
        available: Money.paise(_int(h['availablePaise'])),
        testEarnings: test > 0 ? Money.paise(test) : null,
        paidOut: paidOut > 0 ? Money.paise(paidOut) : null,
        perCall: [for (final p in _maps(h['perCall'])) CallEarning.fromJson(p)],
        tokenMode: true,
      );
    }
    final test = _num(h['testEarningsRupees']) ?? 0;
    return HostEarnings(
      total: Money.rupees(_num(h['lifetimePaidEarnings']) ?? 0),
      pending: Money.rupees(_num(h['heldRupees'] ?? h['pendingRupees']) ?? 0),
      available: Money.rupees(_num(h['availableRupees']) ?? 0),
      testEarnings: test > 0 ? Money.rupees(test) : null,
    );
  }

  /// Fallback when the wallet answer is not available: the withdrawals answer carries the same two numbers.
  factory HostEarnings.fromPayouts(PayoutsData p) => HostEarnings(
        total: '',
        pending: p.heldDisplay,
        available: p.withdrawableDisplay,
        testEarnings: p.testEarnings > 0 ? Money.rupees(p.testEarnings) : null,
        tokenMode: p.tokenMode,
      );

  /// Per-call earning by call id (token mode), for the test-or-paid tag on the calls list.
  Map<String, CallEarning> get byCall => {for (final e in perCall) e.callId: e};

  /// Held money grouped by the day it unlocks, soonest first. Only holds that end after [now] count.
  List<HoldRelease> releases(DateTime now) {
    final nowMs = now.millisecondsSinceEpoch;
    final byDay = <DateTime, int>{};
    for (final e in perCall) {
      final at = e.availableAt;
      if (at == null || at <= nowMs || e.paidPaise <= 0) continue;
      final d = DateTime.fromMillisecondsSinceEpoch(at);
      final day = DateTime(d.year, d.month, d.day);
      byDay[day] = (byDay[day] ?? 0) + e.paidPaise;
    }
    final days = byDay.keys.toList()..sort();
    return [for (final d in days) HoldRelease(date: d, paise: byDay[d]!)];
  }
}

/// One withdrawal request of `GET /api/hosts/me/payouts`.
class PayoutRequest {
  const PayoutRequest({
    required this.id,
    required this.amount,
    required this.status,
    this.accountLast4,
    this.ifsc,
    this.utr,
    this.reason,
    this.createdAt,
    this.paidAt,
  });

  final String id;

  /// Whole rupees.
  final int amount;

  /// `requested | approved | paid | rejected | cancelled`.
  final String status;
  final String? accountLast4;
  final String? ifsc;

  /// The bank reference, only once paid.
  final String? utr;

  /// Why it was not paid, only when rejected.
  final String? reason;
  final int? createdAt;
  final int? paidAt;

  /// A host can cancel only while the request is still waiting for approval.
  bool get canCancel => status == 'requested';

  factory PayoutRequest.fromJson(Map<String, dynamic> j) => PayoutRequest(
        id: (j['id'] ?? '').toString(),
        amount: _int(j['amount']),
        status: (j['status'] ?? '').toString(),
        accountLast4: _str(j['accountLast4']),
        ifsc: _str(j['ifsc']),
        utr: _str(j['utr']),
        reason: _str(j['reason']),
        createdAt: _intOrNull(j['createdAt']),
        paidAt: _intOrNull(j['paidAt']),
      );
}

class PayoutsData {
  const PayoutsData({
    this.enabled = false,
    this.minRupees = 500,
    this.maxPerWeek = 2,
    this.holdDays = 7,
    this.hostStatus,
    this.kycOk = false,
    this.bankOk = false,
    this.bankLast4,
    this.bankIfsc,
    this.withdrawable = 0,
    this.held = 0,
    this.testEarnings = 0,
    this.withdrawablePaise,
    this.pendingPaise,
    this.requests = const <PayoutRequest>[],
  });

  final bool enabled;
  final int minRupees;
  final int maxPerWeek;
  final int holdDays;
  final String? hostStatus;
  final bool kycOk;
  final bool bankOk;
  final String? bankLast4;
  final String? bankIfsc;

  /// Whole rupees the host can ask for right now.
  final int withdrawable;
  final int held;
  final int testEarnings;

  /// Token mode also sends paise; null in the legacy shape.
  final int? withdrawablePaise;
  final int? pendingPaise;
  final List<PayoutRequest> requests;

  bool get tokenMode => withdrawablePaise != null;
  bool get hostLive => hostStatus == 'live';

  String get withdrawableDisplay =>
      withdrawablePaise != null ? Money.paise(withdrawablePaise!) : Money.rupees(withdrawable);
  String get heldDisplay => pendingPaise != null ? Money.paise(pendingPaise!) : Money.rupees(held);

  /// Why the Withdraw button is off, or null when it can be used.
  PayoutBlock? get block {
    if (!hostLive) return PayoutBlock.notLive;
    if (!kycOk) return PayoutBlock.kyc;
    if (!bankOk) return PayoutBlock.bank;
    if (withdrawable < minRupees) return PayoutBlock.tooLow;
    return null;
  }

  factory PayoutsData.fromJson(Map<String, dynamic> j) {
    final bank = _map(j['bank']);
    return PayoutsData(
      enabled: j['enabled'] == true,
      minRupees: _int(j['minRupees'], 500),
      maxPerWeek: _int(j['maxPerWeek'], 2),
      holdDays: _int(j['holdDays'], 7),
      hostStatus: _str(j['hostStatus']),
      kycOk: j['kycOk'] == true,
      bankOk: j['bankOk'] == true,
      bankLast4: _str(bank?['accountLast4']),
      bankIfsc: _str(bank?['ifsc']),
      withdrawable: _int(j['withdrawable']),
      held: _int(j['held']),
      testEarnings: _int(j['testEarnings']),
      withdrawablePaise: _intOrNull(j['withdrawablePaise']),
      pendingPaise: _intOrNull(j['pendingPaise']),
      requests: [for (final r in _maps(j['requests'])) PayoutRequest.fromJson(r)],
    );
  }
}

/// Why the Withdraw button is off.
enum PayoutBlock { notLive, kyc, bank, tooLow }
