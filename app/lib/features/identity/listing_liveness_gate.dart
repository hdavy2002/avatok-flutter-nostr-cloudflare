import 'package:flutter/material.dart';

import 'public_action_gate.dart';

/// [AVA-IDGATE-1] Marketplace listing gate — now a thin delegate.
///
/// WAS (2026-07-07): a one-time PHONE OTP. The Worker rejected publish with
/// `403 {error:'phone_required'}` and this helper routed the seller through a
/// Firebase SMS flow.
///
/// NOW (2026-07-10): all phone verification is removed app-wide. Creating a listing
/// is a PUBLIC ACTION and goes through the same liveness gate as posts, comments,
/// going live, DMs to strangers, group posts and public uploads. The Worker now
/// rejects with `403 {error:'identity_required'}`.
///
/// The function name and signature are UNCHANGED so the existing call sites
/// (marketplace_hub, sell_listing_flow) keep working untouched. It is now one line.
/// Prefer calling `ensurePublicActionAllowed(context, PublicAction.listing)` directly
/// in new code; this wrapper exists only to avoid churning working call sites.
///
/// Returns `true` if the user is (or becomes) liveness-verified — the caller may then
/// open the sell flow. Returns `false` if they declined or failed.
Future<bool> ensureListingLiveness(BuildContext context) =>
    ensurePublicActionAllowed(context, PublicAction.listing);
