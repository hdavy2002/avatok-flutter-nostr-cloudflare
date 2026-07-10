// [AVA-IDGATE-1] Client side of the just-in-time PUBLIC ACTION gate.
// Spec: Specs/SPEC-2026-07-10-identity-gating.md §3
//
// ⚠️ NOT TO BE CONFUSED WITH `identity_gate.dart` IN THIS SAME FOLDER.
//   • identity_gate.dart  → IdentityGate.ensureVerified() — the STRIPE KYC gate for
//     PAYOUTS (document + selfie). Tier 2. A separate project. Untouched.
//   • this file           → the LIVENESS gate for PUBLIC ACTIONS. Tier 1.
// They have different triggers, different providers, different validity windows
// (180d vs 90d) and different telemetry. Naming this file `identity_gate.dart` would
// have silently overwritten the payout gate; naming its events `identity_gate_shown`
// would have merged two unrelated funnels in PostHog. Hence `public_action_*`.
//
// The Worker returns `403 {error: "identity_required", reason, action}` on any public
// action attempted without a valid (<90 day) Didit liveness pass. This helper turns
// that into a friendly flow instead of a raw error:
//
//     consent screen (BIPA)  →  Didit liveness  →  retry the original request
//
// The 403→trigger→retry pattern is NOT new — it already existed for the old
// `phone_required` gate. We generalised it rather than inventing a second one.
//
// SERVER IS AUTHORITATIVE. This file exists to make the block pleasant, never to
// decide it. Skipping this screen buys nothing: the Worker gates the route, and
// separately 403s the capture session itself if consent was never recorded.
import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import 'biometric_consent_screen.dart';
import 'liveness_didit_screen.dart';

/// Public actions, matching `PublicAction` in worker/src/lib/identity_gate.ts.
/// Keep the strings in sync — they are the `action` property on every gate event in
/// PostHog, and a typo here silently splits a funnel.
class PublicAction {
  static const post = 'post';
  static const listing = 'listing';
  static const comment = 'comment';
  static const live = 'live';
  static const dmStranger = 'dm_stranger';
  static const groupPost = 'group_post';
  static const upload = 'upload';
}

/// Run the gate. Returns `true` if the user is now verified and the caller may
/// proceed (or retry the request that 403'd); `false` if they declined or failed.
///
/// Call this EITHER proactively before opening a compose screen, OR reactively when
/// a request comes back 403 `identity_required`. Both are supported; the reactive
/// path is the safety net for any call site we missed.
Future<bool> ensurePublicActionAllowed(BuildContext context, String action) async {
  Analytics.capture('public_action_gate_shown', {'action': action});

  // 1) Biometric consent FIRST. BIPA §15(b): informed written consent BEFORE
  //    capture. Never open a camera before this returns true. The Worker enforces
  //    the same rule server-side, so a client bug cannot capture without consent —
  //    but the client must not even try.
  if (!context.mounted) return false;
  final consented = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => BiometricConsentScreen(action: action)),
      ) ==
      true;

  if (!consented) {
    // A refusal is a normal outcome, not an error. Nothing was captured.
    Analytics.capture('public_action_gate_abandoned', {'action': action, 'at': 'consent'});
    return false;
  }

  // 2) Liveness. Didit's hosted flow; the Worker records the pass and stamps
  //    liveness_passed_at, which is what the 90-day window is measured from.
  if (!context.mounted) return false;
  final passed = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => DiditLivenessScreen(requester: action)),
      ) ==
      true;

  Analytics.capture(
    passed ? 'public_action_gate_passed' : 'public_action_gate_abandoned',
    {'action': action, if (!passed) 'at': 'liveness'},
  );
  return passed;
}

/// True when a Worker response is the public-action gate rejecting the request.
/// Use at any call site that performs a public action, to trigger the flow and then
/// retry:
///
/// ```dart
/// var r = await ApiAuth.postJson(url, body);
/// if (isIdentityRequired(r.statusCode, r.body)) {
///   if (await ensurePublicActionAllowed(context, PublicAction.post)) {
///     r = await ApiAuth.postJson(url, body); // retry once, now verified
///   }
/// }
/// ```
bool isIdentityRequired(int statusCode, String body) {
  if (statusCode != 403) return false;
  // Substring rather than a JSON parse: the body may be an error page on some edge
  // paths, and a parse failure must not swallow the signal.
  return body.contains('identity_required');
}
