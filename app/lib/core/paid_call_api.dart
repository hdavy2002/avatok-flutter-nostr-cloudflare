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

  /// Caller: pick a length → wallet-check + hold the FULL cost up front (§3B
  /// steps 3-5, §11 "Wallet can't cover the chosen length" / "escrow_held").
  /// Returns {ok, hold_id, balance_after} or {ok:false, reason: 'insufficient_funds'|...}.
  static Future<Map<String, dynamic>> prepare({
    required String to,
    String? serviceId,
    required int minutes,
    required int rate,
  }) =>
      _post('$kApiBase/call/paid/prepare', {
        'to': to,
        if (serviceId != null && serviceId.isNotEmpty) 'service_id': serviceId,
        'minutes': minutes,
        'rate': rate,
      });

  /// Caller: confirm connect after the funds are held (§3B step 5 "connect").
  /// Idempotent by [holdId] + call id — a retry never double-connects.
  static Future<Map<String, dynamic>> confirm({required String holdId, required String callId}) =>
      _post('$kApiBase/call/paid/confirm', {'hold_id': holdId, 'call_id': callId});

  /// Caller abandoned the price/length prompt (§11 "Caller abandons at the
  /// price/length prompt" → hold never taken / released). Best-effort — the
  /// server also auto-expires an unconfirmed hold after ESCROW_PROMPT_TIMEOUT.
  static Future<void> cancel({required String holdId}) async {
    try { await ApiAuth.postJson('$kApiBase/call/paid/cancel', {'hold_id': holdId}); } catch (_) {/* best-effort */}
  }
}

/// The callee's published paid-call offer shown to the caller pre-connect.
class PaidCallOffer {
  final int rate; // tokens/min the caller pays
  final List<int> lengthOptions; // minutes, callee-defined (no fixed ladder)
  final String calleeName;
  final bool isAgent; // true = paid AI agent (§3B example b), false = human P2P
  const PaidCallOffer({
    required this.rate, required this.lengthOptions, this.calleeName = '', this.isAgent = false,
  });
  factory PaidCallOffer.fromJson(Map<String, dynamic> j) => PaidCallOffer(
        rate: (j['rate'] as num?)?.toInt() ?? 0,
        lengthOptions: ((j['length_options'] as List?) ?? const [])
            .map((e) => (e as num).toInt()).toList(),
        calleeName: (j['callee_name'] ?? '').toString(),
        isAgent: j['is_agent'] == true,
      );

  int totalFor(int minutes) => rate * minutes;
}
