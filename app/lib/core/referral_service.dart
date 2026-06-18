import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// AvaReferral client — "invite a friend, the inviter earns coins".
///
/// SERVER-AUTHORITATIVE: the client never sends an amount. It only forwards the
/// inviter's code (their @handle, captured from the invite link) to the server,
/// which decides whether to credit and by how much. See worker `routes/referral.ts`.
///
/// Wiring still needed (two hooks):
///   1) CAPTURE: when the app is opened from an invite link `kInviteBase<handle>`
///      (deep link / Play Install Referrer), call [setPendingCode] with `<handle>`.
///   2) CLAIM: right AFTER the user completes a verified sign-in on a NEW account,
///      call [claimPendingAfterSignup]. The server credits the inviter (held 7d),
///      enforces self-referral / device / cap fraud gates, and is idempotent.
class ReferralService {
  ReferralService._();
  static final ReferralService I = ReferralService._();

  static String get _claimUrl => '$kApiBase/referral/claim';
  static String get _summaryUrl => '$kApiBase/referral/summary';

  /// Captured-but-not-yet-claimed invite code (the inviter's handle), held for
  /// this launch until the user finishes signing up.
  String? _pendingCode;

  /// Build the personal invite link a user shares (carries their handle as the code).
  static String inviteLink(String handle) => '$kInviteBase${handle.replaceAll('@', '')}';

  /// Stash the inviter code captured from the invite link (call on deep-link open).
  void setPendingCode(String? code) {
    final c = code?.trim().replaceAll('@', '');
    if (c != null && c.isNotEmpty) _pendingCode = c;
  }

  /// After a verified sign-in on a new account, redeem any pending invite code.
  /// Safe to call unconditionally — no-op when nothing is pending. Idempotent
  /// server-side (one reward per invitee, ever).
  Future<Map<String, dynamic>?> claimPendingAfterSignup({String? deviceId}) async {
    final code = _pendingCode;
    if (code == null || code.isEmpty) return null;
    final r = await claim(code, deviceId: deviceId);
    _pendingCode = null; // one shot regardless of outcome
    return r;
  }

  /// Tell the server "I joined via <code>"; it credits the INVITER if it qualifies.
  Future<Map<String, dynamic>> claim(String code, {String? deviceId}) async {
    final res = await ApiAuth.postJson(_claimUrl, {
      'code': code.trim().replaceAll('@', ''),
      if (deviceId != null && deviceId.isNotEmpty) 'device_id': deviceId,
    });
    try {
      return (jsonDecode(res.body) as Map).cast<String, dynamic>();
    } catch (_) {
      return {'ok': false, 'reason': 'bad_response', 'status': res.statusCode};
    }
  }

  /// Inviter stats for the Invite screen: rewarded_invites, coins_earned, cap…
  Future<Map<String, dynamic>> summary() async {
    final res = await ApiAuth.getSigned(_summaryUrl);
    try {
      return (jsonDecode(res.body) as Map).cast<String, dynamic>();
    } catch (_) {
      return {'reward_coins': 10, 'rewarded_invites': 0, 'coins_earned': 0};
    }
  }
}
