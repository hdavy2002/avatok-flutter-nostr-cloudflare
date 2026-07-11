import 'dart:convert';
import 'dart:math';

import 'api_auth.dart';
import 'config.dart';

/// PaidCallApi — caller-pays calls (Specs/PLAN-2026-07-11-dialpad-business-calls-
/// ava-voice-agent.md §3B/§11, Phase B2). Escrow is a HOLD, never an immediate
/// charge: `prepare` verifies the wallet covers the full chosen length and holds
/// it; `confirm` actually connects (server flips the hold live + starts the
/// per-minute metering); a failed/abandoned prompt never takes the hold (§11
/// refund matrix). Follows [MoneyApi]'s idempotent-POST pattern so a double-tap
/// or flaky network can never double-hold/double-charge.
///
/// Base: `$kApiBase/call/paid` (server route lands with WP2/WP3).
class PaidCallApi {
  PaidCallApi._();

  static String _uuid() {
    final r = Random.secure();
    String h(int n) => List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}';
  }

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static Future<Map<String, dynamic>> _post(String url, Map<String, dynamic> body) async {
    final key = _uuid();
    for (var attempt = 0; ; attempt++) {
      try {
        final res = await ApiAuth.postJsonH(url, body, {'Idempotency-Key': key});
        final j = _json(res.body);
        if (j.isEmpty && res.statusCode >= 400) return {'error': 'http ${res.statusCode}', 'status': res.statusCode};
        return {...j, 'status': res.statusCode};
      } catch (_) {
        if (attempt >= 1) return {'error': 'network'};
      }
    }
  }

  /// The callee's published price + their own custom length options, before the
  /// caller is shown the price/length prompt (§3B step 2). Returns null when the
  /// callee has no paid offer configured (human toggle off, or no service agent).
  static Future<PaidCallOffer?> offer({required String to, String? serviceId}) async {
    try {
      final qs = 'to=${Uri.encodeQueryComponent(to)}${serviceId != null && serviceId.isNotEmpty ? '&service_id=${Uri.encodeQueryComponent(serviceId)}' : ''}';
      final r = await ApiAuth.getSigned('$kApiBase/call/paid/offer?$qs');
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      if (j.isEmpty || j['available'] != true) return null;
      return PaidCallOffer.fromJson(j);
    } catch (_) {
      return null;
    }
  }

  /// Caller: price quote ONLY — no wallet check, no hold (server contract:
  /// worker/src/routes/call_billing_routes.ts preparePaidCallRoute). The hold
  /// happens on [confirm]. Body: {callee, minutes, call_id}.
  /// Returns {ok, rate, minutes, total, length_options} or {error,...}.
  static Future<Map<String, dynamic>> prepare({
    required String callee,
    required int minutes,
    required String callId,
  }) =>
      _post('$kApiBase/call/paid/prepare', {
        'callee': callee,
        'minutes': minutes,
        'call_id': callId,
      });

  /// Caller: confirm — holds the FULL chosen-duration cost and arms the
  /// CallRoom DO's per-minute billing ticker (§3B step 5, confirmPaidCallRoute).
  /// Idempotent per call_id — a retry never double-holds.
  /// Returns {ok, held, call_id} or {error, reason:'WALLET_INSUFFICIENT'|...}.
  static Future<Map<String, dynamic>> confirm({
    required String callee,
    required int minutes,
    required String callId,
  }) =>
      _post('$kApiBase/call/paid/confirm', {
        'callee': callee,
        'minutes': minutes,
        'call_id': callId,
      });

  /// Caller backed out AFTER [confirm] already held escrow (identity-gate 403
  /// abort, abandoned dial). Disarms + refunds via the CallRoom DO — safe to
  /// call unconditionally; a no-op when nothing was held. Best-effort: §11's
  /// RING_TIMEOUT auto-refund is the server-side backstop.
  static Future<void> cancel({required String callId}) async {
    try { await ApiAuth.postJson('$kApiBase/call/paid/cancel', {'call_id': callId}); } catch (_) {/* best-effort */}
  }
}

/// The callee's published paid-call offer shown to the caller pre-connect.
class PaidCallOffer {
  final int rate; // tokens/min the caller pays
  final List<int> lengthOptions; // minutes, callee-defined (no fixed ladder)
  final String calleeName;
  final bool isAgent; // true = paid AI agent (§3B example b), false = human P2P
  final String calleeUid; // server-resolved uid behind the dialed number
  const PaidCallOffer({
    required this.rate, required this.lengthOptions, this.calleeName = '', this.isAgent = false,
    this.calleeUid = '',
  });
  factory PaidCallOffer.fromJson(Map<String, dynamic> j) => PaidCallOffer(
        rate: (j['rate'] as num?)?.toInt() ?? 0,
        lengthOptions: ((j['length_options'] as List?) ?? const [])
            .map((e) => (e as num).toInt()).toList(),
        calleeName: (j['callee_name'] ?? '').toString(),
        isAgent: j['is_agent'] == true,
        calleeUid: (j['callee_uid'] ?? '').toString(),
      );

  int totalFor(int minutes) => rate * minutes;
}
