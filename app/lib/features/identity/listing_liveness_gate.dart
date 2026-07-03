import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import 'human_check_page.dart';
import 'identity_api.dart';

/// First-time liveness "human check" gate for LISTING CREATION (owner decision
/// 2026-07-03). Liveness is no longer an onboarding gate — instead, anyone who
/// wants to CREATE a marketplace listing must pass the check ONCE. On PASS the
/// server flips kyc_status → 'verified' and they never do it again; the Worker
/// enforces this on publish (403 {error:'liveness_required'}). This helper is
/// the CLIENT side: it routes an unverified seller through the liveness flow so
/// they see the friendly check instead of a raw error.
///
/// Returns `true` if the user is (or becomes) verified — the caller may then
/// open the sell flow. Returns `false` if the user is not verified and either
/// cancelled or failed the check.
///
/// "Already verified" is detected via the KYC status the server uses as the real
/// gate: [IdentityApi] `kyc_status == 'verified'` (IdentityStatus.verified). We
/// try the per-account cached value first (instant, offline-safe) and confirm
/// with server truth only when the cache says not-verified.
Future<bool> ensureListingLiveness(BuildContext context) async {
  // 1) Already verified? No UI — go straight through. Cache first (instant),
  //    then confirm with the server if the cache is cold/not-verified.
  var verified = await IdentityApi.cachedVerified();
  if (!verified) {
    verified = (await IdentityApi.status())?.verified ?? false;
  }
  if (verified) return true;

  if (!context.mounted) return false;

  // 2) Not verified → run the one-time human check (dismissible).
  Analytics.capture('listing_liveness_gate_shown', const {});
  final passed = await Navigator.of(context).push<bool>(
        MaterialPageRoute(
          builder: (_) => const HumanCheckPage(source: HumanCheckSource.listing),
        ),
      ) ==
      true;

  if (passed) {
    Analytics.capture('listing_liveness_passed', const {});
  } else {
    Analytics.capture('listing_liveness_cancelled', const {});
  }
  return passed;
}
