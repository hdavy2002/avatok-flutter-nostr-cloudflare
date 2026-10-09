// [HF-CALLS-1] Pure money + XML helpers for HF masked calls. No I/O, no Env, so it unit-tests without a Worker.
// Contract: Specs/HF-CALLS-CONTRACT.md. Money here is PAISE (integers); the wallet itself holds whole rupees (1 token = Rs 1).

/** Platform fee per minute: Rs 2 fixed + 40% of the rate above Rs 2. Host share = rate - fee = 60% of (rate - Rs 2). */
export const PLATFORM_FIXED_PAISE = 200;
export const MAX_CALL_MINUTES = 60;
export const START_RESERVE_MINUTES = 2;
export const WARN_BEFORE_LIMIT_SEC = 60;

/** Rupee price per minute (hf_hosts.price_per_min) -> paise. */
export const ratePaise = (pricePerMinRupees: number): number => Math.round(Number(pricePerMinRupees) * 100);

/** Host share per minute in whole paise, rounded DOWN (platform keeps the rest). Rs 5/10/20/30 -> 180/480/1080/1680. */
export function hostSharePerMinPaise(rate_paise: number): number {
  const r = Math.trunc(rate_paise);
  if (r <= PLATFORM_FIXED_PAISE) return 0;
  return Math.floor(((r - PLATFORM_FIXED_PAISE) * 6) / 10);
}

/** Per started minute of connected time; nothing connected = nothing billed. */
export function billedMinutes(connectedSeconds: number): number {
  const s = Math.floor(Number(connectedSeconds));
  return s > 0 ? Math.ceil(s / 60) : 0;
}

/** Longest call the balance can pay for, capped at 60 minutes. Whole rupees in, whole minutes out. */
export function maxMinutesFor(availableRupees: number, rateRupees: number): number {
  if (!(rateRupees > 0) || !(availableRupees > 0)) return 0;
  return Math.max(0, Math.min(MAX_CALL_MINUTES, Math.floor(availableRupees / rateRupees)));
}

export interface Settlement { billedMinutes: number; chargeRupees: number; hostEarningPaise: number; capped: boolean }

/**
 * What a finished call costs. Charge never exceeds the funds we could actually secure (balance never goes negative); if it is capped,
 * only the whole minutes the funds paid for count (platform absorbs the partial minute).
 */
export function settleCall(a: { connectedSeconds: number; rateRupees: number; fundsRupees: number }): Settlement {
  const rate = Math.max(0, Math.trunc(a.rateRupees));
  const funds = Math.max(0, Math.trunc(a.fundsRupees));
  const wanted = billedMinutes(a.connectedSeconds);
  if (wanted === 0 || rate === 0) return { billedMinutes: 0, chargeRupees: 0, hostEarningPaise: 0, capped: false };
  const full = wanted * rate;
  if (full <= funds) return { billedMinutes: wanted, chargeRupees: full, hostEarningPaise: wanted * hostSharePerMinPaise(rate * 100), capped: false };
  const mins = Math.floor(funds / rate);
  return { billedMinutes: mins, chargeRupees: funds, hostEarningPaise: mins * hostSharePerMinPaise(rate * 100), capped: true };
}

/**
 * Host earnings reach the wallet in whole rupees, so fractions (Rs 1.80 a minute) are carried per host:
 * credit = floor(all paise earned so far / 100) - rupees already credited.
 */
export function hostTokensToCredit(priorEarnedPaise: number, priorCreditedRupees: number, thisPaise: number): number {
  return Math.max(0, Math.floor((Math.max(0, priorEarnedPaise) + Math.max(0, thisPaise)) / 100) - Math.max(0, priorCreditedRupees));
}

// ── spoken text + Vobiz (Plivo-dialect) XML ─────────────────────────────────

/** Contract wording. The crisis number is spelled digit by digit so the text-to-speech voice does not read it as a quantity. */
export const SAFETY_NOTICE = "This is a friendly chat, not counselling. In crisis, dial 1 4 4 1 6. Press hash at any time to end the call and block.";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const wrap = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** First name only, never digits, handles or long strings: the host hears who is calling but no contact detail. */
export function callerHandle(displayName: string | null | undefined): string {
  const first = String(displayName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first || first.length > 20 || /[0-9@+_.\/\\:]/.test(first)) return "a caller";
  return first;
}

export function announceText(handle: string, previousCalls: number): string {
  const n = Math.max(0, Math.trunc(previousCalls));
  return `Call from ${handle}. ${n} previous ${n === 1 ? "call" : "calls"} with you. Press 1 to accept, 2 to decline.`;
}

/** VERIFY ON FIRST LIVE CALL: Plivo GetDigits (action posts `Digits`; with no input the flow falls through to the next element). */
export function hostAnnounceXml(p: { handle: string; previousCalls: number; digitsUrl: string }): string {
  return wrap(
    `<GetDigits action="${esc(p.digitsUrl)}" method="POST" timeout="10" numDigits="1" validDigits="12" retries="1">` +
    `<Speak>${esc(announceText(p.handle, p.previousCalls))}</Speak></GetDigits>` +
    `<Speak>No response received. Goodbye.</Speak><Hangup/>`,
  );
}

/**
 * Safety notice, then the shared room. VERIFY ON FIRST LIVE CALL: `digitsMatch="#"` + `callbackUrl` (ConferenceAction=digits),
 * `endConferenceOnExit`, `maxMembers`, `timeLimit` (a backstop only; the DO alarm is the real limit).
 */
export function noticeAndConferenceXml(p: { room: string; callbackUrl: string; timeLimitSec: number }): string {
  return wrap(
    `<Speak>${esc(SAFETY_NOTICE)}</Speak>` +
    `<Conference callbackUrl="${esc(p.callbackUrl)}" callbackMethod="POST" digitsMatch="#" startConferenceOnEnter="true" endConferenceOnExit="true" ` +
    `maxMembers="2" timeLimit="${Math.max(60, Math.trunc(p.timeLimitSec))}">${esc(p.room)}</Conference>`,
  );
}

export const hangupXml = (message?: string): string => wrap(message ? `<Speak>${esc(message)}</Speak><Hangup/>` : `<Hangup/>`);
export const emptyXml = (): string => wrap("");
export const callerDidntPickUpXml = (): string => hangupXml("The caller didn't pick up. Goodbye.");
export const LIMIT_WARNING_TEXT = "One minute left on this call.";
