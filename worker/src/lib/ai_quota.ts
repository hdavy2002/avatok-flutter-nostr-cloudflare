// ai_quota.ts — per-uid daily Ava-turn counters (Phase 2 — BYO-AI Proxy + Gate).
//
// The our-keys free tier is capped at `dailyAvaTurnLimit` turns/account/day
// (config.ts, default 25 = kDailyAvaTurnLimit on the client). BYO-key users and
// premium (openChatUncapped) users are NOT subject to this cap — the caller
// decides whether to call this at all (ai_gate.enforceQuota only checks/increments
// for the capped tier).
//
// STORE CHOICE: KV (env.TOKENS) — the project's sanctioned ephemeral-counter store
// (Golden Rule 5: KV is for ephemeral tokens / counters, not durable records, and
// a daily turn-count is exactly that). One key per uid per UTC day, with a TTL so
// yesterday's counters self-evict — no table, no migration, no cleanup cron. A
// daily cap doesn't need atomicity (a rare double-count under concurrent turns is
// harmless and always undercounts in the user's favour at worst), so KV's eventual
// consistency is fine here. (If a hard, race-free cap is ever required, swap the
// body for a DB_META `ava_turns(uid, day, count)` UPSERT — same signatures.)

import type { Env } from "../types";

/** UTC day key, e.g. "2026-06-17". The cap is per UTC calendar day. */
function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function kvKey(uid: string, day = dayKey()): string {
  return `ava_turns:${uid}:${day}`;
}

// Keep a day's counter ~2 days so it survives the day boundary then self-evicts.
const TTL_SECONDS = 2 * 24 * 60 * 60;

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
}

/** Read the current count for `uid` today. Never throws (fails open at used=0). */
export async function check(env: Env, uid: string, limit: number): Promise<QuotaState> {
  let used = 0;
  try {
    const raw = await env.TOKENS.get(kvKey(uid));
    used = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
  } catch { /* fail open */ }
  const remaining = Math.max(0, limit - used);
  return { used, limit, remaining, exceeded: used >= limit };
}

/**
 * Increment `uid`'s count for today by one and return the post-increment state.
 * Best-effort (KV is eventually consistent); never throws. Call this AFTER a turn
 * is accepted (the gate increments only on the capped our-keys path).
 */
export async function increment(env: Env, uid: string, limit: number): Promise<QuotaState> {
  const key = kvKey(uid);
  let used = 0;
  try {
    const raw = await env.TOKENS.get(key);
    used = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    used += 1;
    await env.TOKENS.put(key, String(used), { expirationTtl: TTL_SECONDS });
  } catch { used += 0; /* fail open — don't block a turn on a counter write */ }
  const remaining = Math.max(0, limit - used);
  return { used, limit, remaining, exceeded: used > limit };
}
