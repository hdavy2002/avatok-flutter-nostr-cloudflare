// plans.ts — Phase 1 subscription tiers (Free / Plus / Pro / Max) + the daily
// allowance matrix and the tier-state store. SERVER-OWNED: the client may READ
// this matrix to render the Subscribe screen, but NEVER to enforce — every cap
// is checked server-side (see usage.ts / enforceAllowance).
//
// Phase 1 only gates FIRST-PARTY AI services (Messenger AI, AI voice, receptionist,
// image gen) — there is no creator/marketplace pricing yet, so a flat monthly tier
// is a clean fit. Phase 2 (creators, cash-out) moves consumption onto AvaCoins
// pay-per-use; this file stays the "what a subscription unlocks" source of truth.
//
// Tunable WITHOUT redeploy: an admin can override the matrix via the KV key
// `plan_config` (same pattern as platform_config). The hard-coded DEFAULTS below
// are the safe fallback.
//
// `null` in a cap === UNLIMITED (no counter touched). JSON has no Infinity, so the
// wire format uses null and the gate treats null as "always allow".

import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";

const KEY = "plan_config";

/** Billing dimensions a daily counter can meter. Keep in sync with usage.ts.
 *
 * COST MODEL (owner, 2026-06-23): text→LLM is cheap per million tokens, so
 * `ava_chat` is UNLIMITED on every tier and never shown to users as a meter
 * (Messenger calls Ava on-demand via #ava/@ava then exits; ChatAVA compresses its
 * own context after N turns). The genuinely expensive things — and the only ones
 * metered/gated — are realtime voice (Gemini Live: voice_min, recept,
 * translate_min), the LiveKit SFU (conf_min), and image gen (Nano Banana: image). */
export type Dim =
  | "ava_chat"        // UNLIMITED everywhere (kept for completeness; never capped)
  | "image"           // AI image generations/day
  | "voice_min"       // AI voice-agent minutes/day (AvaVoice/AvaVision)
  | "recept"          // AI receptionist sessions/day
  | "translate_min"   // live-translation minutes/day
  | "conf_min";       // group-conference minutes/day

export type TierId = 0 | 1 | 2 | 3; // 0=Free 1=Plus 2=Pro 3=Max

export interface Plan {
  id: TierId;
  key: "free" | "plus" | "pro" | "max";
  name: string;
  priceUsd: number;            // monthly, USD. 0 = free.
  // Daily caps. null === unlimited. Human messaging + 1:1 P2P calls are NOT
  // listed because they are unlimited on every tier (no AI cost to us).
  caps: Record<Dim, number | null>;
  confParticipants: number;    // max group-conference size on this tier
  features: {
    memory: boolean;           // RAG / long-term memory
    fileAnalysis: boolean;     // upload + analyse PDF/Excel/etc in chat
    webSearch: boolean;        // web search in Ava chat
    premiumImageModel: boolean;// premium image model (Nano Banana) vs free Flux
  };
  // Stripe recurring price (web checkout). Optional: if absent we build an
  // ad-hoc price_data line so the tier still works before Price IDs are minted.
  stripePriceId?: string;
  // Google Play subscription product id (Android native billing).
  playProductId?: string;
}

export const PLANS: Record<TierId, Plan> = {
  0: {
    id: 0, key: "free", name: "Free", priceUsd: 0,
    caps: { ava_chat: null, image: 3, voice_min: 10, recept: 3, translate_min: 0, conf_min: 60 },
    confParticipants: 5,
    features: { memory: false, fileAnalysis: false, webSearch: false, premiumImageModel: false },
  },
  1: {
    id: 1, key: "plus", name: "Plus", priceUsd: 10,
    caps: { ava_chat: null, image: 30, voice_min: 60, recept: 30, translate_min: 30, conf_min: 180 },
    confParticipants: 10,
    features: { memory: true, fileAnalysis: true, webSearch: true, premiumImageModel: true },
    playProductId: "avatok_plus_monthly",
  },
  2: {
    id: 2, key: "pro", name: "Pro", priceUsd: 20,
    caps: { ava_chat: null, image: 100, voice_min: 180, recept: 100, translate_min: 120, conf_min: 480 },
    confParticipants: 25,
    features: { memory: true, fileAnalysis: true, webSearch: true, premiumImageModel: true },
    playProductId: "avatok_pro_monthly",
  },
  3: {
    id: 3, key: "max", name: "Max", priceUsd: 50,
    caps: { ava_chat: null, image: null, voice_min: null, recept: null, translate_min: null, conf_min: null },
    confParticipants: 25,
    features: { memory: true, fileAnalysis: true, webSearch: true, premiumImageModel: true },
    playProductId: "avatok_max_monthly",
  },
};

const VALID_TIERS: TierId[] = [0, 1, 2, 3];
export function isTierId(n: unknown): n is TierId {
  return typeof n === "number" && (VALID_TIERS as number[]).includes(n);
}

/** The matrix actually served — KV `plan_config` overrides merge over DEFAULTS. */
export async function readPlans(env: Env): Promise<Record<TierId, Plan>> {
  try {
    const stored = (await env.TOKENS.get(KEY, "json")) as Partial<Record<TierId, Partial<Plan>>> | null;
    if (!stored) return PLANS;
    const merged: Record<TierId, Plan> = { ...PLANS };
    for (const t of VALID_TIERS) {
      if (stored[t]) merged[t] = { ...PLANS[t], ...stored[t], caps: { ...PLANS[t].caps, ...(stored[t]!.caps ?? {}) } } as Plan;
    }
    return merged;
  } catch {
    return PLANS;
  }
}

/** Cap lookup for a tier+dimension. null === unlimited. */
export function capFor(plans: Record<TierId, Plan>, tier: TierId, dim: Dim): number | null {
  return plans[tier]?.caps?.[dim] ?? plans[0].caps[dim];
}

/** The next tier up to upsell toward when a cap is hit (Max has none). */
export function nextTier(tier: TierId): TierId | null {
  return tier < 3 ? ((tier + 1) as TierId) : null;
}

// ── tier state (DB_META.subscriptions) ──────────────────────────────────────
// A user's current billing tier + when it renews/expires. Source of truth is the
// payment webhook (Stripe) / Play verification; this table is the fast read.

export interface SubState {
  tier: TierId;
  status: "active" | "canceled" | "none";
  source: "stripe" | "play" | "none";
  renewsAt: number | null;     // epoch ms; downgrade to Free at period end
}

const NONE: SubState = { tier: 0, status: "none", source: "none", renewsAt: null };

/** Read a user's subscription state. Fails OPEN to Free (never blocks on error). */
export async function getSub(env: Env, uid: string): Promise<SubState> {
  try {
    const r = await env.DB_META
      .prepare("SELECT tier, status, source, renews_at FROM subscriptions WHERE uid=?1")
      .bind(uid)
      .first<{ tier: number; status: string; source: string; renews_at: number | null }>();
    if (!r) return NONE;
    // A canceled sub still grants its tier until the period actually ends.
    if (r.status === "canceled" && r.renews_at && Date.now() > r.renews_at) return NONE;
    const tier = isTierId(r.tier) ? r.tier : 0;
    return { tier, status: (r.status as SubState["status"]) || "none", source: (r.source as SubState["source"]) || "none", renewsAt: r.renews_at ?? null };
  } catch {
    return NONE;
  }
}

/** Convenience: just the effective tier number (0 when none/free). */
export async function tierOf(env: Env, uid: string): Promise<TierId> {
  return (await getSub(env, uid)).tier;
}

/** Upsert a user's subscription tier (called by the payment webhook / verifier). */
export async function setSub(
  env: Env,
  uid: string,
  p: { tier: TierId; status: SubState["status"]; source: SubState["source"]; renewsAt: number | null; ref?: string },
): Promise<void> {
  await env.DB_META
    .prepare(
      `INSERT INTO subscriptions (uid, tier, status, source, renews_at, ref, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(uid) DO UPDATE SET tier=?2, status=?3, source=?4, renews_at=?5, ref=COALESCE(?6, ref), updated_at=?7`,
    )
    .bind(uid, p.tier, p.status, p.source, p.renewsAt, p.ref ?? null, Date.now())
    .run();
}

// ── GET /api/subscribe/plans ────────────────────────────────────────────────
// Public-ish (auth required so we can echo the caller's current tier). Returns
// the matrix the Subscribe screen renders + the user's current tier/state.
export async function getPlans(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const plans = await readPlans(env);
  const sub = await getSub(env, ctx.uid);
  return json(
    { plans: VALID_TIERS.map((t) => plans[t]), current: sub },
    200,
    { "cache-control": "private, max-age=30" },
  );
}
