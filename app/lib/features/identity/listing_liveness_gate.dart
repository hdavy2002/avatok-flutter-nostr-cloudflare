import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/verification_api.dart';
import 'phone_verify_screen.dart';

/// First-time PHONE-OTP gate for LISTING CREATION (owner decision 2026-07-07).
///
/// Liveness is now the ONBOARDING gate only. The marketplace "sell" gate is a
/// one-time PHONE OTP: anyone who wants to CREATE a marketplace listing confirms
/// a real mobile number ONCE. On confirm the server flips the phone proof →
/// 'verified' (the phone tick turns GREEN in the Identity menu) and enforces
/// phone_verified on publish (the Worker returns 403 {error:'phone_required'}
/// otherwise). This helper is the CLIENT side: it routes an unverified seller
/// through the phone-OTP flow so they see the friendly check instead of a raw
/// error.
///
/// Kept the name `ensureListingLiveness` so existing call sites (marketplace_hub,
/// sell_listing_flow) are unchanged; the gate is still flag-gated upstream by
/// RemoteConfig.listingLivenessGate.
///
/// Returns `true` if the user is (or becomes) phone-verified — the caller may
/// then open the sell flow. Returns `false` if they cancelled or failed.
Future<bool> ensureListingLiveness(BuildContext context) async {
  // 1) Already phone-verified (account-keyed)? No UI — go straight through.
  if (await VerificationApi.isPhoneVerified()) return true;

  if (!context.mounted) return false;

  // 2) Not verified → run the one-time phone-OTP confirm (dismissible).
  Analytics.capture('listing_phone_gate_shown', const {});
  final passed = await Navigator.of(context).push<bool>(
        MaterialPageRoute(
          builder: (_) => const PhoneVerifyScreen(reason: 'listing'),
        ),
      ) ==
      true;

  Analytics.capture(
      passed ? 'listing_phone_passed' : 'listing_phone_cancelled', const {});
  return passed;
}
