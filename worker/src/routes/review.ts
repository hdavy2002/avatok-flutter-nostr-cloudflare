// REMOVED 2026-06-18 — store-review login bypass deleted.
//
// AvaTOK login is moving to Google-only OAuth (no email OTP), so app-store
// reviewers sign in with a Gmail test account provided in the store console and
// no bypass is needed. The /api/review/login route and its REVIEW_PASSWORD /
// sign-in-token (ticket) minting have been removed from the Worker.
//
// Do NOT re-introduce a password-for-ticket bypass. If reviewers ever need
// access again, hand them a real Google test account instead.
export {};
