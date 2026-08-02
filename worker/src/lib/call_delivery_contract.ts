/**
 * One canonical lifetime for an unanswered human-call invitation.
 *
 * Owner rule (2026-08-03): four rings, approximately 20 seconds. Every ring
 * surface receives the same absolute expiry; a late FCM delivery may use only
 * the time that remains and must never start a fresh local timer.
 */
export const CALL_RING_LIFETIME_MS = 20_000;
