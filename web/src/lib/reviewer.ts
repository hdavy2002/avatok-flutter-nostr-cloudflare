/*
 * reviewer.ts — is the current session a payment-gateway / app-store reviewer?
 *
 * [REVIEWER-ONBOARD-1 2026-08-28] Reviewer accounts get a browse-only surface:
 * the onboarding + terms screen on first sign-in, and no money affordances.
 *
 * ── READ THIS BEFORE RELYING ON IT ──────────────────────────────────────────
 * This is a UI-LEVEL HINT AND NOTHING MORE. It hides buttons. It is not a
 * permission, it is not enforcement, and a determined visitor can set the
 * localStorage key by hand. That is acceptable ONLY because nothing behind
 * those buttons is dangerous: money-in is switched off server-side
 * (`billingEnabled=false`, `walletRealMoney=false`) and Stripe is on TEST keys,
 * so the worst case is a test-mode checkout that moves no real money.
 *
 * If real money-in is ever switched on, DO NOT promote this into an
 * authorisation check. Enforce reviewer restrictions on the server, against the
 * verified session, the way every other money rule in this codebase is
 * enforced. A client-side flag is not a security boundary.
 *
 * The allowlist itself lives in KV remote config (`reviewerEmails`), never in
 * this repo, which is PUBLIC — see routes/config.ts. It holds email addresses,
 * which are identifiers, never credentials. No password, token or sign-in
 * bypass exists for reviewers: they authenticate through Clerk exactly like
 * every other user.
 */

const REVIEWER_KEY = 'avatok_reviewer_mode';

/** Record what the Clerk-aware island determined. Called once, from SidebarUser. */
export function setReviewerMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(REVIEWER_KEY, 'yes');
    else localStorage.removeItem(REVIEWER_KEY);
  } catch {
    /* storage blocked — callers fall back to treating the session as normal */
  }
}

/**
 * True when this browser's session belongs to a reviewer. Defaults to FALSE on
 * any error: an unreadable store must never silently restrict a real user.
 */
export function isReviewerMode(): boolean {
  try {
    return localStorage.getItem(REVIEWER_KEY) === 'yes';
  } catch {
    return false;
  }
}
