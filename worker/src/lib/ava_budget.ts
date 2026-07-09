// ava_budget.ts — Phase C/D. Budget Manager + trust ledger + learning-loop
// counters (plan §9, Constitution 1/2/10/11/13). ALL state is KV on env.TOKENS
// — daily counters expire on their own, nothing here touches D1 or a DO.
//
// KV KEYS (all this module's — documented for the ledger route + ops):
//   avabudget:<uid>:<ymd>          per-user daily eval count   (limit 500)
//   avamoments:<uid>:<ymd>         account-wide unsolicited-Moments count/day
//                                   (Constitution 2 — 500/day across ALL chats)
//   avacap:<capId>:<ymd>           platform-wide per-capability daily evals
//   avacapwf:<capId>:<ymd>         per-capability daily would_fire count
//   avacapout:<capId>:<outcome>:<ymd>  learning-loop outcome counters
//   avatrust:<uid>:<conv>          trust ledger {score, muted_until, updated_at}
//
// KV increments are read-modify-write (not atomic). That is ACCEPTABLE here:
// these are soft budgets/telemetry counters, a rare lost increment errs toward
// slightly MORE headroom, and shadow mode has zero user impact. If a budget
// ever becomes a hard billing line, move it to a DO.

import type { Env } from "../types";

export const DEFAULT_USER_DAILY_EVALS = 500;   // per-user daily eval budget (Governor knob)
export const DEFAULT_MOMENTS_DAILY = 500;      // Constitution 2 — account-wide/day
export const TRUST_MUTE_SCORE = -3;            // at or below → 30-day conv mute
export const TRUST_MUTE_MS = 30 * 86_400_000;  // 30 days

const COUNTER_TTL = 2 * 86_400;   // seconds — daily keys self-expire
const TRUST_TTL = 90 * 86_400;    // refreshed on every write

export type MomentOutcome = "accepted" | "edited" | "ignored" | "dismissed";
export const MOMENT_OUTCOMES: MomentOutcome[] = ["accepted", "edited", "ignored", "dismissed"];

/** UTC yyyymmdd — the day bucket for all daily counters. */
export function ymd(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function readCount(env: Env, key: string): Promise<number> {
  try {
    const v = await env.TOKENS.get(key);
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function bump(env: Env, key: string): Promise<number> {
  const next = (await readCount(env, key)) + 1;
  try { await env.TOKENS.put(key, String(next), { expirationTtl: COUNTER_TTL }); } catch { /* best-effort */ }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkAndSpend — the per-wake budget gate (plan §9). Spends one eval against
// the per-user daily budget AND the per-capability daily counter, then reports
// whether the wake may proceed. Fail-OPEN toward "allowed" only on KV read
// errors in shadow (counting is telemetry there); the returned reason is what
// the ODL stamps into the shadow event.
// ─────────────────────────────────────────────────────────────────────────────
export interface SpendResult {
  allowed: boolean;
  reason: string | null;      // "user_daily_budget" | "capability_daily_limit" | null
  userEvalsToday: number;
  capEvalsToday: number;
}

export async function checkAndSpend(
  env: Env,
  args: { uid: string; capabilityId: string; capDailyLimit: number; userDailyLimit?: number },
): Promise<SpendResult> {
  const day = ymd();
  const userLimit = args.userDailyLimit ?? DEFAULT_USER_DAILY_EVALS;
  const userEvals = await bump(env, `avabudget:${args.uid}:${day}`);
  const capEvals = await bump(env, `avacap:${args.capabilityId}:${day}`);
  if (userEvals > userLimit) {
    return { allowed: false, reason: "user_daily_budget", userEvalsToday: userEvals, capEvalsToday: capEvals };
  }
  if (capEvals > args.capDailyLimit) {
    return { allowed: false, reason: "capability_daily_limit", userEvalsToday: userEvals, capEvalsToday: capEvals };
  }
  return { allowed: true, reason: null, userEvalsToday: userEvals, capEvalsToday: capEvals };
}

/**
 * spendMoment — the account-wide unsolicited-Moments budget (Constitution 2:
 * 500/day across all chats; explicit requests are unbudgeted and never call
 * this). Also bumps the per-capability would_fire counter for the ledger.
 */
export async function spendMoment(
  env: Env,
  args: { uid: string; capabilityId: string; dailyLimit?: number },
): Promise<{ allowed: boolean; momentsToday: number }> {
  const day = ymd();
  const limit = args.dailyLimit ?? DEFAULT_MOMENTS_DAILY;
  const n = await bump(env, `avamoments:${args.uid}:${day}`);
  void bump(env, `avacapwf:${args.capabilityId}:${day}`);
  return { allowed: n <= limit, momentsToday: n };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust ledger (Constitution 10): +1 accepted/edited, −1 dismissed, 0 ignored.
// score ≤ −3 → this CONVERSATION is muted for 30 days (dismissed = dropped).
// ─────────────────────────────────────────────────────────────────────────────
export interface TrustState {
  score: number;
  muted_until: number; // epoch ms; 0 = not muted
  updated_at: number;
}

const TRUST_ZERO: TrustState = { score: 0, muted_until: 0, updated_at: 0 };

export async function getTrust(env: Env, uid: string, conv: string): Promise<TrustState> {
  if (!uid || !conv) return TRUST_ZERO;
  try {
    const v = (await env.TOKENS.get(`avatrust:${uid}:${conv}`, "json")) as TrustState | null;
    if (!v || typeof v !== "object") return TRUST_ZERO;
    return { score: Number(v.score) || 0, muted_until: Number(v.muted_until) || 0, updated_at: Number(v.updated_at) || 0 };
  } catch { return TRUST_ZERO; }
}

export function isMuted(t: TrustState, now: number = Date.now()): boolean {
  return t.muted_until > now;
}

const OUTCOME_DELTA: Record<MomentOutcome, number> = { accepted: 1, edited: 1, ignored: 0, dismissed: -1 };

/**
 * recordOutcome — the learning loop (Constitution 11). Updates the trust
 * ledger for (uid, conv), applies the 30-day mute at ≤ −3, and bumps the
 * per-capability outcome counter that feeds the Capability Cost Ledger (D25).
 */
export async function recordOutcome(
  env: Env,
  args: { uid: string; conv: string; capability: string; outcome: MomentOutcome },
): Promise<TrustState> {
  const now = Date.now();
  const cur = await getTrust(env, args.uid, args.conv);
  const next: TrustState = {
    score: cur.score + (OUTCOME_DELTA[args.outcome] ?? 0),
    muted_until: cur.muted_until,
    updated_at: now,
  };
  if (next.score <= TRUST_MUTE_SCORE && !isMuted(next, now)) {
    next.muted_until = now + TRUST_MUTE_MS;
  }
  try {
    await env.TOKENS.put(`avatrust:${args.uid}:${args.conv}`, JSON.stringify(next), { expirationTtl: TRUST_TTL });
  } catch { /* best-effort */ }
  void bump(env, `avacapout:${args.capability}:${args.outcome}:${ymd()}`);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger snapshot — today's per-capability counters for GET /api/ava/ledger
// (the Capability Cost Ledger's raw KV feed; PostHog holds the history).
// ─────────────────────────────────────────────────────────────────────────────
export interface CapabilityLedgerRow {
  capability: string;
  evals: number;
  would_fire: number;
  outcomes: Record<MomentOutcome, number>;
}

export async function ledgerSnapshot(env: Env, capabilityIds: string[]): Promise<{ day: string; rows: CapabilityLedgerRow[] }> {
  const day = ymd();
  const rows: CapabilityLedgerRow[] = [];
  for (const id of capabilityIds) {
    const outcomes = {} as Record<MomentOutcome, number>;
    for (const o of MOMENT_OUTCOMES) outcomes[o] = await readCount(env, `avacapout:${id}:${o}:${day}`);
    rows.push({
      capability: id,
      evals: await readCount(env, `avacap:${id}:${day}`),
      would_fire: await readCount(env, `avacapwf:${id}:${day}`),
      outcomes,
    });
  }
  return { day, rows };
}
