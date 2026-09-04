/* [LIST-IDGATE-UX-1] Worker error codes → sentences a person can act on.
 *
 * The listing surfaces used to render `e.error` straight from ApiError, so the
 * owner's own screenshot of the create form reads:
 *
 *     ⚠ identity_required
 *
 * That is a wire-protocol token, not a message. Worse, the two identity gates emit
 * two DIFFERENT strings from two different checks against two different tables, and
 * the web handled neither:
 *
 *   • `identity_required`              — the LIVENESS gate (identity_proofs), fires at
 *                                        DRAFT CREATION (worker listings.ts createListing)
 *   • `identity verification required` — the KYC gate (kyc_status), fires at PUBLISH
 *                                        (worker authz.ts requireKyc)
 *
 * The old form copy claimed the check happens at publish. It does not, and that
 * sentence sent people looking in the wrong place.
 *
 * RULE: every message here says what to DO. "cover_required" is not "cover required",
 * it is "add at least one photo". If a new worker error reaches this file with no
 * entry, `listingErrorMessage` falls back to a plain sentence rather than the code —
 * an unrecognised code is a gap in this map, never something to show a person.
 */

/** What the user should do about each refusal. Keys are the worker's `error` values. */
const MESSAGES: Record<string, string> = {
  // --- identity, both gates ---
  identity_required:
    'We need to verify it’s really you before you can create a listing. This takes about a minute with your camera.',
  'identity verification required':
    'Publishing a paid session needs your identity verified first. This is a one-time check.',

  // --- publish requirements (worker listings.ts publishListing) ---
  cover_required: 'Add at least one photo before publishing — you can add up to five.',
  'max 5 photos': 'That’s more than five photos. Remove a few and try again.',
  'title and category required': 'Give your listing a title and pick a category before publishing.',
  'unknown category': 'That category is no longer available. Pick another one.',
  'bad price': 'The price doesn’t look right. Enter a whole number of tokens, or 0 for free.',
  'starts_at (future) and duration_min (5–480) required':
    'Pick a start date and time in the future, and how long it runs (between 5 minutes and 8 hours).',
  no_availability:
    'Set your availability in AvaCalendar before publishing a consult — people need slots they can book.',
  conflict: 'You already have something booked at that time. Pick a different slot.',
  'already published': 'This listing is already published.',
  renewal_required: 'This listing has expired. Renew it before publishing again.',
  // Shared by the publish gate (listings.ts) and commercial checkout's wallet
  // hold (commercial_checkout.ts) — same code, same underlying fact.
  insufficient_funds: 'Your Token balance is too low for this. Add Tokens, or pay by card/UPI instead.',
  billing_unavailable: 'Publishing is temporarily unavailable. Please try again shortly.',

  // --- edit refusals ---
  'cannot move a published event — cancel and re-create':
    'A published event’s date can’t be changed. Cancel it and create a new one.',

  // --- lane / platform state ---
  marketplace_publish_disabled: 'Publishing is paused right now. Please try again later.',
  commercial_checkout_required: 'This listing is sold through the new checkout — this route is closed.',
  lane_misconfigured: 'Purchases are temporarily unavailable. We’ve been alerted.',

  // --- [WEB-COMM-PAY-1] commercial checkout (worker/src/routes/commercial_checkout.ts) —
  // SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md §3.4. Keys are the worker's exact
  // `error` string; see CommercialPayStep.tsx and GatewayPicker.tsx for where these surface.
  'ticket already owned': 'You already have a ticket for this event — check My Bookings.',
  'consultation already booked': 'You’ve already booked this consultation — check My Bookings.',
  'booking notice policy': 'That time is too soon to book. Pick a slot further out.',
  'price changed since payment': 'The price changed while you were paying. You haven’t been charged again — please try booking once more.',
  'commercial checkout disabled': 'Bookings for this listing aren’t open yet. Please check back soon.',
  'commercial checkout unavailable': 'Purchases are temporarily unavailable. We’ve been alerted.',
  'valid Idempotency-Key required': 'That didn’t go through. Please try again.',
  'policy confirmation required': 'Please tick the box confirming you’ve read the cancellation terms.',
  'listing unavailable': 'This listing isn’t available right now.',
  'cannot buy your own service': 'You can’t book your own listing.',
  'consultation must have exactly one buyer': 'This consultation can’t be booked right now.',
  'commercial policy unavailable': 'This listing’s booking terms aren’t set up yet. Please check back soon.',
  'invalid commercial price': 'This listing’s price looks wrong. We’ve been alerted.',
  'event schedule unavailable': 'This event’s schedule isn’t set. Please check back soon.',
  'slot {start_at,end_at} required': 'Pick a time before continuing.',
  'future consultation slot required': 'Pick a time that hasn’t already passed.',
  'commercial tax configuration invalid': 'Checkout is temporarily unavailable. We’ve been alerted.',
  'calendar conflict': 'That time was just taken. Pick another slot.',
  'consultation slot already booked': 'That time was just taken. Pick another slot.',
  'checkout authority mismatch': 'That didn’t go through. Please try again.',
  'idempotency key reused for different checkout': 'That didn’t go through. Please refresh and try again.',
  'commercial checkout retryable': 'That didn’t go through. Please try again in a moment.',
  payment_failed: 'That payment didn’t go through. No charge was made — please try again.',

  // --- [WEB-COMM-PAY-2] worker/src/routes/pay.ts (POST /api/pay/:gateway/order,
  // GET /api/pay/methods, GET /api/pay/:gateway/status) — the gateway funding rail,
  // independent of the wallet checkout above. See GatewayPicker.tsx / CommercialPayStep.tsx.
  'checkout unavailable': 'Card and UPI payment isn’t open yet. Try again shortly, or pay from your wallet balance.',
  'unknown gateway': 'That payment method isn’t available. Pick another one.',
  'listingId required': 'Something went wrong loading this booking. Please go back and try again.',
  'listing not available': 'This listing isn’t available right now.',
  'invalid price': 'This listing’s price looks wrong. We’ve been alerted.',
  'stripe is for international buyers only': 'That card gateway is for international payments. Pick a different method to pay in rupees.',
  'order_id already used': 'That didn’t go through. Please try again.',
  'could not start payment': 'Could not start that payment. Try again, or pick a different method.',
  'order_id required': 'That didn’t go through. Please try again.',
  'not found': 'We couldn’t find that payment. Please try again.',

  // --- [LIST-SUBMIT-REVIEW-1] creator submit-for-review + the publish gate
  // behind it (worker/src/routes/listings.ts submitListingForApproval,
  // worker/src/routes/admin_listings.ts approvalRequired) ---
  approval_required: 'This listing has been sent for review. Someone on the team checks it before it goes live — we’ll let you know.',
  'listing not draft': 'This listing has already been submitted, so there’s nothing to send. Check its status below.',
  section_unavailable: 'That section isn’t accepting new listings right now.',

  // --- [FREE-ENTRY-GATE-1] worker/src/lib/free_entry_gate.ts, enforced in
  // worker/src/routes/listings.ts createListing/updateListing (403 on both). ---
  free_entry_not_allowed: 'Free shows are limited to test accounts right now. Turn off “This is a free show” and set a price to continue.',
};

/** HTTP status texts the worker's `res.statusText` fallback can produce — never a
 *  usable error code, so `apiErrorCode` skips over them when something better exists. */
const STATUS_TEXT_RE = /^(ok|created|accepted|no content|bad request|unauthorized|forbidden|not found|conflict|gone|too many requests|internal server error|bad gateway|service unavailable|gateway timeout)$/i;

/**
 * The worker is inconsistent about error shape: most refusals carry a top-level
 * `error`, but publishListing's approval 409 carries only `code`/`reason`, so
 * ApiError.error falls back to statusText ("Conflict") and every lookup keyed on
 * it silently misses. Always resolve the code through this.
 */
export function apiErrorCode(e: { error?: string; body?: unknown }): string {
  const body = e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : null;
  const fromBody = (key: string) => {
    const v = body?.[key];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  // ORDER MATTERS, and it is `error` FIRST — not `code`/`reason` first.
  //
  // Most refusals in this API carry the real application code in `error` AND a
  // secondary `reason` describing why. identityGate returns
  // `{ error: "identity_required", reason: "never_passed" }` and the publish
  // KYC gate returns `{ error: "identity verification required", reason: "kyc" }`.
  // Preferring `reason` there resolves to "never_passed" / "kyc", which match
  // nothing in MESSAGES and — worse — make isLivenessGate()/isKycGate() both
  // return false, so the "Verify now" card silently stops appearing and the
  // creator is told only that something went wrong. `reason` is a LAST resort.
  const err = typeof e.error === 'string' ? e.error.trim() : '';
  if (err && !STATUS_TEXT_RE.test(err)) return err;
  // Only now consider the body. publishListing's approval 409 is the case that
  // needs this: it has no `error` key at all, so ApiError.error fell back to
  // "Conflict" and was rejected above, leaving `code: "approval_required"`.
  const code = fromBody('code');
  if (code) return code;
  const reason = fromBody('reason');
  if (reason) return reason;
  // A bare status-text fallback ("Conflict", "Bad Request"...) is not a real
  // application code — it's ApiError.error falling back to res.statusText.
  // Showing it would be exactly the bug this module exists to fix, so treat
  // it as "no usable code" rather than a code nothing maps to.
  return '';
}

/** True when the refusal is the liveness gate, which the client can resolve in place. */
export function isLivenessGate(code: string): boolean {
  return code === 'identity_required';
}

/** True when the refusal is the publish-time KYC gate. */
export function isKycGate(code: string): boolean {
  return code === 'identity verification required';
}

/**
 * Turn a worker error code into a sentence. `detail` is used when the worker sent a
 * human string alongside the code (publishListing does this for `cover_required`).
 */
export function listingErrorMessage(code: unknown, detail?: unknown, message?: unknown): string {
  const key = typeof code === 'string' ? code : '';
  const known = MESSAGES[key];
  if (known) return known;
  // The approval 409 (worker/src/routes/admin_listings.ts approvalRequired) carries a
  // good human sentence in `message` — prefer it over the generic fallback, same rule
  // as `detail` below: never show a bare snake_case code.
  if (typeof message === 'string' && message.trim() && !/^[a-z_]+$/.test(message.trim())) {
    return message.trim();
  }
  if (typeof detail === 'string' && detail.trim() && !/^[a-z_]+$/.test(detail.trim())) {
    return detail.trim();
  }
  // Deliberately generic. Showing an unmapped code is the bug this module exists to
  // fix, so the fallback must never be the code itself.
  return 'That didn’t go through. Please try again, or contact us if it keeps happening.';
}
