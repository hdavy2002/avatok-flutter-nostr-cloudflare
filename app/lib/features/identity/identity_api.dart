import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// AvaIdentity (Phase 3) — client for the AvaID gateway with the Stripe
/// Identity provider (document + matching-selfie KYC) layered on top of the
/// onboarding age/phone/email checks. One gate, two providers: the server's
/// kyc_status is what unlocks creator/payout actions (universal §5 matrix).
///
/// Per-account: the last-seen KYC status is cached under a scopedKey so a
/// shared phone never shows one account's verification state to another.
class IdentityStatus {
  final String status; // unverified|pending|pending_input|verified|rejected
  final String kycStatus; // from kyc_status (the actual gate)
  final String? provider;
  final String? failureReason;
  final bool stripeConfigured;
  const IdentityStatus({
    required this.status,
    required this.kycStatus,
    this.provider,
    this.failureReason,
    this.stripeConfigured = false,
  });

  bool get verified => kycStatus == 'verified';
}

class StripeKycSession {
  final String sessionId;
  final String? clientSecret;
  final String? ephemeralKey;
  final String? url; // Stripe-hosted verification page (web fallback)
  const StripeKycSession({required this.sessionId, this.clientSecret, this.ephemeralKey, this.url});
}

class IdentityApi {
  static const _storage = FlutterSecureStorage();
  static const _cacheKey = 'avaidentity_kyc_status';

  static Map<String, dynamic> _json(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  /// GET /api/id/status — server truth; caches the kyc status per account.
  static Future<IdentityStatus?> status() async {
    try {
      final r = await ApiAuth.getSigned('$kIdBase/status');
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      final kyc = (j['kyc'] is Map) ? j['kyc'] as Map : const {};
      final s = IdentityStatus(
        status: (j['status'] ?? 'unverified').toString(),
        kycStatus: (kyc['status'] ?? 'unverified').toString(),
        provider: kyc['provider']?.toString(),
        failureReason: j['failure_reason']?.toString(),
        stripeConfigured: j['stripe_configured'] == true,
      );
      await _storage.write(key: scopedKey(_cacheKey), value: s.kycStatus);
      return s;
    } catch (_) {
      return null;
    }
  }

  /// Last-seen KYC status for instant (offline) paint — per-account scoped.
  static Future<bool> cachedVerified() async =>
      (await readScoped(_storage, _cacheKey)) == 'verified';

  /// POST /api/id/session {provider:'stripe'} — start a Stripe Identity
  /// VerificationSession (document + selfie with liveness).
  static Future<StripeKycSession?> startStripeSession() async {
    try {
      final r = await ApiAuth.postJson('$kIdBase/session', {'provider': 'stripe'});
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      return StripeKycSession(
        sessionId: (j['session_id'] ?? '').toString(),
        clientSecret: j['client_secret']?.toString(),
        ephemeralKey: j['ephemeral_key']?.toString(),
        url: j['url']?.toString(),
      );
    } catch (_) {
      return null;
    }
  }

  // ── A1 agreements (creator agreement before first withdrawal) ─────────────

  /// GET /api/agreements/status → (currentVersion, accepted).
  static Future<({String version, bool accepted})?> agreementStatus(
      [String docId = 'creator-agreement']) async {
    try {
      final r = await ApiAuth.getSigned('$kAgreementsBase/status?doc_id=$docId');
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      return (version: (j['current_version'] ?? '1').toString(), accepted: j['accepted'] == true);
    } catch (_) {
      return null;
    }
  }

  /// GET /api/agreements/doc — the versioned markdown text (may 404 → null).
  static Future<String?> agreementDoc([String docId = 'creator-agreement']) async {
    try {
      final r = await ApiAuth.getSigned('$kAgreementsBase/doc?doc_id=$docId');
      return r.statusCode == 200 ? r.body : null;
    } catch (_) {
      return null;
    }
  }

  /// POST /api/agreements/accept {doc_id, version}.
  static Future<bool> acceptAgreement(String version,
      [String docId = 'creator-agreement']) async {
    try {
      final r = await ApiAuth.postJson(
          '$kAgreementsBase/accept', {'doc_id': docId, 'version': version});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
