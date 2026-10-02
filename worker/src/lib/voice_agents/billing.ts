// [AUMFE-VOICE-BILLING-1 2026-10-02] PURE billing maths + state machine for a paid voice call (no I/O, unit-tested).
// Owner rules: voice is PAID from the wallet (1 token = Rs 1), charged per STARTED minute at the agent's price, and a
// call that ends inside its first 10 seconds costs nothing. Wallet I/O lives in billing_wallet.ts; the DO drives both.
//
// Timeline (f = voiceAgentFreeSeconds, 0 by default; e = seconds since the greeting went out):
//   minute 1 is charged at e = f + 10   (the 10 s no-charge window)
//   minute N (N >= 2) is charged at e = f + (N-1)*60
// so ending at e < f+10 costs 0, ending at f+10..f+60 costs 1 minute, ending at f+61 costs 2, and so on.

/** A call that ends before this many (billable) seconds is free. */
export const NO_CHARGE_WINDOW_S = 10;
/** How many minutes of runway the wallet hold covers. */
export const RUNWAY_MINUTES = 5;

/** Config paise per minute -> whole wallet tokens per minute (1 token = Rs 1 = 100 paise; fractions round UP). 0 = unpriced. */
export function priceTokensPerMin(pricePerMinPaise: number): number {
  const p = Number(pricePerMinPaise);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.ceil(p / 100);
}

/** Free seconds from config, clamped to a sane non-negative integer. */
export function cleanFreeSeconds(freeSeconds: number): number {
  const f = Number(freeSeconds);
  return Number.isFinite(f) && f > 0 ? Math.floor(f) : 0;
}

/** Started minutes that should have been charged by `elapsedS`. */
export function minutesDue(elapsedS: number, freeSeconds: number): number {
  const billable = Math.floor(elapsedS) - cleanFreeSeconds(freeSeconds);
  if (!Number.isFinite(billable) || billable < NO_CHARGE_WINDOW_S) return 0;
  return Math.floor(billable / 60) + 1;
}

/** Elapsed second at which minute `n` (1-based) becomes chargeable. */
export function chargeAtSecond(n: number, freeSeconds: number): number {
  const f = cleanFreeSeconds(freeSeconds);
  return n <= 1 ? f + NO_CHARGE_WINDOW_S : f + (n - 1) * 60;
}

/** Hold size at call start: min(what the wallet can spend, RUNWAY_MINUTES of price). */
export function runwayHoldTokens(spendable: number, priceTokens: number): number {
  const s = Math.max(0, Math.trunc(Number(spendable) || 0));
  return Math.min(s, Math.max(0, priceTokens) * RUNWAY_MINUTES);
}

/** Extra hold to add so the hold tracks min(spendable, runway). Never negative (the hold never shrinks mid-call). */
export function runwayTopUpTokens(held: number, spendable: number, priceTokens: number): number {
  return Math.max(0, runwayHoldTokens(spendable, priceTokens) - Math.max(0, held));
}

/**
 * Elapsed second at which the wallet can no longer cover the next minute, given `chargedMinutes` already paid and
 * `spendable` tokens left AFTER those charges. Infinity when the call is unpriced.
 * (covered minutes = charged + floor(spendable / price); the call runs to the end of the last covered minute.)
 */
export function balanceEndsAtSecond(chargedMinutes: number, spendable: number, priceTokens: number, freeSeconds: number): number {
  if (priceTokens <= 0) return Infinity;
  const covered = Math.max(0, chargedMinutes) + Math.floor(Math.max(0, spendable) / priceTokens);
  return cleanFreeSeconds(freeSeconds) + covered * 60;
}

/** Seconds left on the call: the tighter of the time cap and the balance. Never negative. */
export function remainingSeconds(elapsedS: number, maxSeconds: number, balanceEndS: number): number {
  return Math.max(0, Math.min(maxSeconds, balanceEndS) - elapsedS);
}

export const opIdCharge = (sessionId: string, minute: number): string => `voice:${sessionId}:m${minute}`;
export const opIdReserve = (sessionId: string, topUpTo = 0): string => (topUpTo > 0 ? `voice:${sessionId}:reserve:to:${topUpTo}` : `voice:${sessionId}:reserve`);
export const opIdRelease = (sessionId: string): string => `voice:${sessionId}:release`;
export const reservationRef = (sessionId: string): string => `voice:${sessionId}`;

// ---------------------------------------------------------------------------
// State machine. Pure: the DO feeds it elapsed seconds and charge outcomes, it says what to do next.
// ---------------------------------------------------------------------------

export interface BillingState {
  priceTokens: number;
  freeSeconds: number;
  minutesCharged: number;
  tokensCharged: number;
  /** Spendable tokens after the last charge (or at start). */
  spendable: number;
  closed: boolean;
}

export function newBilling(priceTokens: number, freeSeconds: number, spendable: number): BillingState {
  return { priceTokens, freeSeconds: cleanFreeSeconds(freeSeconds), minutesCharged: 0, tokensCharged: 0, spendable: Math.max(0, spendable), closed: false };
}

/** The next minute to charge at this elapsed time, or null when nothing is owed yet / billing is closed or unpriced. */
export function nextChargeDue(b: BillingState, elapsedS: number): number | null {
  if (b.closed || b.priceTokens <= 0) return null;
  const due = minutesDue(elapsedS, b.freeSeconds);
  return b.minutesCharged < due ? b.minutesCharged + 1 : null;
}

/** Record a successful charge of minute `n` (idempotent: a replay of an already-counted minute changes nothing). */
export function applyCharge(b: BillingState, n: number, spendableAfter: number): BillingState {
  if (n <= b.minutesCharged) return b;
  return { ...b, minutesCharged: n, tokensCharged: b.tokensCharged + b.priceTokens, spendable: Math.max(0, spendableAfter) };
}

/** Close billing exactly once. `charge` is whatever was charged; nothing is ever charged by closing. */
export function closeBilling(b: BillingState): { state: BillingState; firstClose: boolean } {
  if (b.closed) return { state: b, firstClose: false };
  return { state: { ...b, closed: true }, firstClose: true };
}

export function balanceEndS(b: BillingState): number {
  return balanceEndsAtSecond(b.minutesCharged, b.spendable, b.priceTokens, b.freeSeconds);
}

/** Customer-visible spend so far, in paise (tokens*100). */
export function chargedPaise(b: BillingState): number {
  return b.tokensCharged * 100;
}
