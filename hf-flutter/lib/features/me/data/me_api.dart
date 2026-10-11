import 'dart:math';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';

Duration? _noAutoRetry(int retryCount, Object error) => null;

num _num(Object? v) {
  if (v is num) return v;
  return num.tryParse('${v ?? ''}') ?? 0;
}

int? _intOrNull(Object? v) {
  if (v is num) return v.toInt();
  return int.tryParse('${v ?? ''}');
}

String? _str(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

/// `PATCH /api/hf/me {displayName}`. A refusal is `400 invalid_field {field:'displayName', message}`.
class MeApi {
  const MeApi(this._api, this._ref);

  final ApiClient _api;
  final Ref _ref;

  String? get _uid {
    final session = _ref.read(sessionProvider);
    return session.isSignedIn ? (session.user?.id ?? session.me?.uid) : null;
  }

  /// Returns the name as the server saved it (trimmed, spaces tidied).
  Future<String> updateName(String name, {required String expectedUid}) async {
    const changed = ApiError(status: 401, code: 'account_changed',
      message: 'Your account changed. Please open your profile again.');
    if (_uid != expectedUid) throw changed;
    final jwt = await _ref.read(clerkProvider).sessionToken();
    if (_uid != expectedUid || jwt == null) throw changed;
    try {
      final parts = jwt.split('.');
      if (parts.length != 3) throw changed;
      final claims = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
      if (claims is! Map || claims['sub'] != expectedUid) throw changed;
    } on ApiError { rethrow; } catch (_) { throw changed; }
    // Keep this mutation on its original account even if Clerk changes while it is in flight.
    final j = ApiClient.asMap(await _api.request('PATCH', '/api/hf/me', auth: false,
      headers: {'Authorization': 'Bearer $jwt'}, body: {'displayName': name}));
    if (_uid != expectedUid) throw changed;
    return _str(j['displayName']) ?? name;
  }
}

final meApiProvider = Provider<MeApi>((ref) => MeApi(ref.watch(apiClientProvider), ref));

/// Where an account closure stands (`exit` in `GET /api/hf/account/exit`).
class ExitProgress {
  const ExitProgress({required this.status, this.note, this.requestedAt});

  /// `waiting_hold | waiting_payouts | ready | done | cancelled`.
  final String status;
  final String? note;
  final int? requestedAt;

  bool get isActive => status == 'waiting_hold' || status == 'waiting_payouts' || status == 'ready';

  factory ExitProgress.fromJson(Map<String, dynamic> j) => ExitProgress(
        status: (j['status'] ?? '').toString(),
        note: _str(j['note']),
        requestedAt: _intOrNull(j['requestedAt']),
      );
}

/// A payout or refund the closure made: `{amount, status, reason?, utr?}` (amounts in rupees).
class ExitSettlement {
  const ExitSettlement({required this.amount, required this.status, this.reason, this.utr});

  final num amount;
  final String status;
  final String? reason;
  final String? utr;

  static ExitSettlement? fromJson(Object? v) {
    if (v is! Map) return null;
    return ExitSettlement(
      amount: _num(v['amount']),
      status: (v['status'] ?? '').toString(),
      reason: _str(v['reason']),
      utr: _str(v['utr']),
    );
  }
}

/// `GET /api/hf/account/exit`. Money is in rupees, as the worker computes it; the app only shows it.
class ExitState {
  const ExitState({
    required this.decision,
    this.gateEnabled = true,
    this.paidBalance = 0,
    this.withdrawable = 0,
    this.held = 0,
    this.heldReleaseAt,
    this.refundable = 0,
    this.manualRefund = 0,
    this.forfeitRupees = 0,
    this.bankOk = false,
    this.testCredits = 0,
    this.testEarnings = 0,
    this.exit,
    this.payout,
    this.refund,
    this.deletionAt,
    this.tokensMode = false,
  });

  /// `delete` (nothing to settle: delete now) or `exit` (pay out and refund first).
  final String decision;
  final bool gateEnabled;
  final num paidBalance;
  final num withdrawable;
  final num held;
  final int? heldReleaseAt;

  /// Unused purchased tokens (worth this many rupees): refunded through Google Play on request.
  final num refundable;
  final num manualRefund;

  /// Money that would be lost unless the person fixes it first (no verified bank, or money nothing can account for).
  final num forfeitRupees;
  final bool bankOk;
  final num testCredits;
  final num testEarnings;
  final ExitProgress? exit;
  final ExitSettlement? payout;
  final ExitSettlement? refund;

  /// When the account will be deleted (end of the 30-day wait), or null when no deletion is pending.
  final int? deletionAt;
  final bool tokensMode;

  bool get mustSettle => decision == 'exit';
  bool get exitActive => exit?.isActive ?? false;

  factory ExitState.fromJson(Map<String, dynamic> j) {
    final exitRaw = j['exit'];
    final delRaw = j['deletion'];
    return ExitState(
      decision: j['decision'] == 'exit' ? 'exit' : 'delete',
      gateEnabled: j['gateEnabled'] != false,
      paidBalance: _num(j['paidBalance']),
      withdrawable: _num(j['withdrawable']),
      held: _num(j['held']),
      heldReleaseAt: _intOrNull(j['heldReleaseAt']),
      refundable: _num(j['refundable']),
      manualRefund: _num(j['manualRefund']),
      forfeitRupees: _num(j['forfeitRupees']),
      bankOk: j['bankOk'] == true,
      testCredits: _num(j['testCredits']),
      testEarnings: _num(j['testEarnings']),
      exit: exitRaw is Map ? ExitProgress.fromJson(Map<String, dynamic>.from(exitRaw)) : null,
      payout: ExitSettlement.fromJson(j['payout']),
      refund: ExitSettlement.fromJson(j['refund']),
      deletionAt: delRaw is Map ? _intOrNull(delRaw['scheduledAt']) : null,
      tokensMode: j['mode'] == 'tokens',
    );
  }
}

/// `POST /api/account/delete` answered 409 `{deferred:true}`: the worker found money to settle first.
bool isDeferred(ApiError e) => e.status == 409 && e.extra['deferred'] == true;

/// Account closing calls.
///  - `GET /api/hf/account/exit`: what the person gets, and which path applies;
///  - `POST /api/account/delete`: no money to settle, schedule the 30-day deletion (`409 deferred` = settle first);
///  - `POST /api/hf/account/exit {forfeit}` (Idempotency-Key): pay out first, then delete
///    (`409 nothing_to_settle | forfeit_required {forfeitRupees} | bank_required | active_call`);
///  - `DELETE /api/hf/account/exit` and `POST /api/account/delete/cancel`: change my mind.
class AccountApi {
  const AccountApi(this._api);

  final ApiClient _api;

  Future<ExitState> exitState() async => ExitState.fromJson(await _api.getJson('/api/hf/account/exit'));

  /// Returns when the account will be deleted (epoch ms), or null when the server did not say.
  Future<int?> deleteAccount() async {
    final j = await _api.postJson('/api/account/delete');
    return _intOrNull(j['grace_ends_at']);
  }

  Future<void> startExit({required bool forfeit, required String idempotencyKey}) async {
    await _api.postJson('/api/hf/account/exit', body: {'forfeit': forfeit}, idempotencyKey: idempotencyKey);
  }

  Future<void> cancelExit() async {
    await _api.deleteJson('/api/hf/account/exit');
  }

  Future<void> cancelDeletion() async {
    await _api.postJson('/api/account/delete/cancel');
  }
}

final accountApiProvider = Provider<AccountApi>((ref) => AccountApi(ref.watch(apiClientProvider)));

/// The closing state for the delete screen. `ref.invalidate(exitStateProvider)` after every step.
/// A failed read shows its message with Try again; it is not retried behind the person's back.
final exitStateProvider = FutureProvider.autoDispose<ExitState>(
  retry: _noAutoRetry,
  (ref) => ref.watch(accountApiProvider).exitState(),
);

/// A fresh `Idempotency-Key` for one closing attempt. The screen keeps it while the answer is unknown
/// (no network), so a retry is a replay and never a second closure.
String newIdempotencyKey(String? uid) {
  final r = Random.secure();
  final salt = List<int>.generate(8, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  final who = (uid ?? 'u').replaceAll(RegExp(r'[^A-Za-z0-9]'), '');
  final short = who.length > 12 ? who.substring(who.length - 12) : who;
  return 'hfexit-$short-$salt';
}
