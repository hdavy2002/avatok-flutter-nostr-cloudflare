// Shared KYC models (HF-NATIVE-8). The shapes are copied from worker/src/routes/hf_host_kyc.ts.

/// Who the Aadhaar check is for. The worker stores it with the record (`hf_kyc.role`).
enum KycRole {
  host('host'),
  laneCaller('lane_caller');

  const KycRole(this.wire);

  /// The value sent as `role`.
  final String wire;

  static KycRole? fromWire(String? s) {
    for (final r in KycRole.values) {
      if (r.wire == s) return r;
    }
    return null;
  }
}

/// What the Aadhaar record says. Never holds the full Aadhaar number: only the last 4 digits.
class AadhaarResult {
  const AadhaarResult({
    this.gender,
    this.last4,
    this.firstName,
    this.alreadyVerified = false,
    this.viaDigiLocker = false,
  });

  /// `F`, `M` or `T` (the worker's mapping), or null when it was not sent.
  final String? gender;
  final String? last4;
  final String? firstName;

  /// The worker said this person was verified before (no new check happened).
  final bool alreadyVerified;
  final bool viaDigiLocker;

  /// Women-only space rule (worker lib/hf_lanes.ts): female or transgender.
  bool get isFemaleOrTransgender => gender == 'F' || gender == 'T';

  factory AadhaarResult.fromJson(Map<String, dynamic> j, {bool alreadyVerified = false, bool viaDigiLocker = false}) =>
      AadhaarResult(
        gender: _str(j['gender']),
        last4: _str(j['last4']),
        firstName: _str(j['firstName']),
        alreadyVerified: alreadyVerified || j['already_verified'] == true,
        viaDigiLocker: viaDigiLocker,
      );
}

/// `POST /api/hosts/kyc/aadhaar/otp`: either a code was sent, or the person was verified already.
class AadhaarOtpOutcome {
  const AadhaarOtpOutcome.sent(int this.expiresInSeconds) : verified = null;
  const AadhaarOtpOutcome.alreadyVerified(AadhaarResult this.verified) : expiresInSeconds = null;

  final int? expiresInSeconds;
  final AadhaarResult? verified;
}

/// `POST /api/hosts/kyc/digilocker/start`: a DigiLocker link to open, or already verified.
class DigiLockerStartOutcome {
  const DigiLockerStartOutcome.link(Uri this.url) : verified = null;
  const DigiLockerStartOutcome.alreadyVerified(AadhaarResult this.verified) : url = null;

  final Uri? url;
  final AadhaarResult? verified;
}

/// `POST /api/hosts/kyc/digilocker/complete`: done, or DigiLocker has not answered yet (HTTP 202).
class DigiLockerCompleteOutcome {
  const DigiLockerCompleteOutcome.done(AadhaarResult this.result)
      : pending = false,
        message = null;
  const DigiLockerCompleteOutcome.pending([this.message])
      : pending = true,
        result = null;

  final bool pending;
  final String? message;
  final AadhaarResult? result;
}

/// `POST /api/hosts/payout/verify`.
class PayoutResult {
  const PayoutResult({required this.match, this.nameAtBank, this.accountLast4, this.upiVerified = false});

  /// The bank account holder name matches the Aadhaar name.
  final bool match;

  /// The full name only when it matches; otherwise the worker sends it masked (`P**** S****`).
  final String? nameAtBank;
  final String? accountLast4;
  final bool upiVerified;

  factory PayoutResult.fromJson(Map<String, dynamic> j) => PayoutResult(
        match: j['match'] == true,
        nameAtBank: _str(j['nameAtBank']),
        accountLast4: _str(j['accountLast4']),
        upiVerified: j['upiVerified'] == true,
      );
}

/// `GET /api/hosts/kyc/status`, and the `kyc` object of `GET /api/hosts/me` (same shape).
class KycStatus {
  const KycStatus({
    this.aadhaarDone = false,
    this.gender,
    this.last4,
    this.role,
    this.selfieStatus = 'none',
    this.selfieReason,
    this.payoutDone = false,
    this.payoutLast4,
    this.payoutUpiVerified = false,
  });

  final bool aadhaarDone;
  final String? gender;
  final String? last4;
  final String? role;

  /// `none | pending | approved | rejected`.
  final String selfieStatus;
  final String? selfieReason;
  final bool payoutDone;
  final String? payoutLast4;
  final bool payoutUpiVerified;

  factory KycStatus.fromJson(Map<String, dynamic> j) {
    final a = _map(j['aadhaar']);
    final s = _map(j['selfie']);
    final p = _map(j['payout']);
    return KycStatus(
      aadhaarDone: a['done'] == true,
      gender: _str(a['gender']),
      last4: _str(a['last4']),
      role: _str(a['role']),
      selfieStatus: _str(s['status']) ?? 'none',
      selfieReason: _str(s['reason']),
      payoutDone: p['done'] == true,
      payoutLast4: _str(p['accountLast4']),
      payoutUpiVerified: p['upiVerified'] == true,
    );
  }
}

String? _str(Object? v) {
  final s = (v ?? '').toString().trim();
  return s.isEmpty ? null : s;
}

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
