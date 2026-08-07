/**
 * One canonical lifetime for an unanswered human-call invitation.
 *
 * Owner rule (2026-08-03): four rings, approximately 20 seconds. Every ring
 * surface receives the same absolute expiry; a late FCM delivery may use only
 * the time that remains and must never start a fresh local timer.
 */
export const CALL_RING_LIFETIME_MS = 20_000;

/**
 * [CALL-4RINGS-1 2026-08-08] Headroom added to the ring BACKSTOP once real ring
 * counting is on.
 *
 * With `callRealRingCount` the primary signal is four genuine ring cycles, and
 * the wall clock demotes to a backstop whose only job is "a silent or lying
 * device must not hold the caller forever". It therefore has to be strictly
 * LATER than four honest cycles could plausibly finish, or it fires first and
 * we are right back to a wall-clock rule wearing a ring-count costume.
 *
 * The slack covers the two lags between "we placed the call" and "cycle 1
 * started on their phone": FCM/WS delivery plus CallKit raising the ring
 * (measured at 0.6–3.6 s in prod 2026-08-07), and the ~250 ms receipt POST.
 */
export const RING_BACKSTOP_SLACK_MS = 4_000;

/**
 * The absolute ring lifetime this call should be given.
 *
 * `enabled === false` returns exactly `CALL_RING_LIFETIME_MS`, so the flag off
 * is byte-for-byte today's behaviour. Otherwise it is never SHORTER than today
 * either — `max()`, not a replacement — because shortening the ring is the one
 * change nobody asked for.
 */
export function ringLifetimeMs(opts: {
  enabled: boolean;
  rings: number;
  cycleMs: number;
}): number {
  if (!opts.enabled) return CALL_RING_LIFETIME_MS;
  const rings = Number.isFinite(opts.rings) && opts.rings >= 1 ? Math.min(12, Math.round(opts.rings)) : 4;
  const cycle = Number.isFinite(opts.cycleMs) && opts.cycleMs >= 1_000
    ? Math.min(20_000, Math.round(opts.cycleMs))
    : 6_000;
  return Math.max(CALL_RING_LIFETIME_MS, rings * cycle + RING_BACKSTOP_SLACK_MS);
}
