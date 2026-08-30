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
  insufficient_funds: 'Your token balance is too low to publish this listing.',
  billing_unavailable: 'Publishing is temporarily unavailable. Please try again shortly.',

  // --- edit refusals ---
  'cannot move a published event — cancel and re-create':
    'A published event’s date can’t be changed. Cancel it and create a new one.',

  // --- lane / platform state ---
  marketplace_publish_disabled: 'Publishing is paused right now. Please try again later.',
  commercial_checkout_required: 'This listing is sold through the new checkout — this route is closed.',
  lane_misconfigured: 'Purchases are temporarily unavailable. We’ve been alerted.',
};

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
export function listingErrorMessage(code: unknown, detail?: unknown): string {
  const key = typeof code === 'string' ? code : '';
  const known = MESSAGES[key];
  if (known) return known;
  if (typeof detail === 'string' && detail.trim() && !/^[a-z_]+$/.test(detail.trim())) {
    return detail.trim();
  }
  // Deliberately generic. Showing an unmapped code is the bug this module exists to
  // fix, so the fallback must never be the code itself.
  return 'That didn’t go through. Please try again, or contact us if it keeps happening.';
}
