import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// AvaPayout (Phase 3) — client for the existing Wise payout backend.
///   POST /api/payout/setup     link a bank (KYC-gated; tax fields captured)
///   GET  /api/payout/accounts  linked banks
///   POST /api/payout/request   withdraw {account_id, amount_coins} (KYC +
///                              tax + creator-agreement gated server-side)
///   GET  /api/payout/status    recent withdrawal requests
class PayoutApi {
  static Map<String, dynamic> _json(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  static Future<Map<String, dynamic>> setup({
    required String accountHolder,
    required String ifsc,
    required String accountNumber,
    String? label,
    String country = 'IN',
    String currency = 'INR',
    String? taxCountry,
    String? taxIdType,
    String? taxId,
  }) async {
    try {
      final r = await ApiAuth.postJson('$kPayoutBase/setup', {
        'account_holder': accountHolder,
        'ifsc': ifsc,
        'account_number': accountNumber,
        if (label != null && label.isNotEmpty) 'label': label,
        'country': country,
        'currency': currency,
        if (taxCountry != null && taxCountry.isNotEmpty) 'tax_country': taxCountry,
        if (taxIdType != null && taxIdType.isNotEmpty) 'tax_id_type': taxIdType,
        if (taxId != null && taxId.isNotEmpty) 'tax_id': taxId,
      });
      return {..._json(r.body), 'status_code': r.statusCode};
    } catch (_) {
      return {'error': 'network', 'status_code': 0};
    }
  }

  static Future<List<Map<String, dynamic>>> accounts() async {
    try {
      final r = await ApiAuth.getSigned('$kPayoutBase/accounts');
      if (r.statusCode != 200) return [];
      final j = _json(r.body);
      return ((j['accounts'] as List?) ?? []).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> request(String accountId, int amountCoins) async {
    try {
      final r = await ApiAuth.postJson('$kPayoutBase/request', {
        'account_id': accountId,
        'amount_coins': amountCoins,
      });
      return {..._json(r.body), 'status_code': r.statusCode};
    } catch (_) {
      return {'error': 'network', 'status_code': 0};
    }
  }

  static Future<({List<Map<String, dynamic>> requests, bool enabled})> history() async {
    try {
      final r = await ApiAuth.getSigned('$kPayoutBase/status');
      if (r.statusCode != 200) return (requests: <Map<String, dynamic>>[], enabled: false);
      final j = _json(r.body);
      return (
        requests: ((j['requests'] as List?) ?? []).cast<Map<String, dynamic>>(),
        enabled: j['payouts_enabled'] == true,
      );
    } catch (_) {
      return (requests: <Map<String, dynamic>>[], enabled: false);
    }
  }
}
