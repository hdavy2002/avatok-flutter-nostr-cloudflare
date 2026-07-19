// Server-owned price list for premium, discrete Ava actions (2026-06-18).
//
// Prices are in TOKENS. CANONICAL site-wide economics: 1 USD = 100 tokens
// (1 token = $0.01 = 1 USD cent), matching wallet.ts (TOKENS_PER_USD), ledger.ts,
// cal/emails.ts, translate.ts, avavoice.ts and the client (kTokensPerUsd=100).
// The CLIENT never sends a price — it names the feature and the server charges
// THIS amount. A patched client can't underpay because the amount is derived
// here, not from the request. Tune freely; keys must match what each feature
// route passes to chargeFeature().
//
// 2026-06-26: the unit was renamed AvaCoins/coins → "Tokens" at the SAME value
// (100/USD), so these numeric prices and all stored balances are unchanged — only
// the label changed. Per-service token costs are owner-tunable; see TOKEN-ECONOMY.md.
// 1 token is the smallest billable unit, so sub-1¢ actions floor to 1 token.
import type { Env } from "./types";
import { json } from "./util";
import { walletOp } from "./routes/wallet";
import { readConfig } from "./routes/config";
import { billingUidFor, bumpTeamAiMsgPool } from "./team_billing";

export const FEATURE_COSTS: Record<string, number> = {
  ava_chat: 1,               // $0.01 — one Ava chat message (Workers-AI Gemma 4); floored to 1-coin min
  ava_memory: 1,             // $0.01 — one AI Search ingest or query (premium memory/file search); 1-coin min
  ava_image_free: 1,         // $0.01 — one free-tier image (Workers-AI Flux-1-schnell); 1-coin min
  ava_image_generate: 8,     // $0.08 — one premium image (Gemini "Nano Banana 2")
  ava_voice_reply: 2,        // $0.02 — Ava speaks a reply
  ava_vision_snapshot: 1,    // $0.01 — one analyzed snapshot beyond the free quota
  ava_mcp_tool: 1,           // $0.01 — one connected-app (Composio) tool call
  guardian_always_on: 30,    // $0.30/mo — always-on safety monitoring for a chat
  // CALL OUTCOME MENU (owner 2026-07-09, Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md):
  // one minute of an Ava receptionist/sales-agent call, charged to the OWNER whose
  // Ava answered (ceil(duration/60) units per session, max 3). Free while
  // betaFreePremium is on — chargeFeature already short-circuits to charged:0.
  ava_receptionist_minute: 3, // ₹3/min — LOCKED by AvaTok_Tiered_Pricing_Brief.pdf 2026-07-19 (supersedes same-day verbal "5"); hard cap 3:00; margin alert >₹2.20/min
  ava_voicemail: 1,          // ₹1 per voicemail (owner 2026-07-19) — charged once per VM session (in-app + PSTN)
  // MARKETPLACE LISTING FEE (M-D2, PLAN §1.3/§5): 100 tokens = $1 to publish a listing
  // for one 30-day period, after the first 5 free (the quota is enforced in
  // lib/listing_billing.ts, independent of tokens). Charged idempotently on
  // opId = `${listing_id}:${period}` so a retried publish never double-charges (§3.3c).
  // Per-vertical key so Connect can price differently later at zero structural cost
  // (§1.3 note) — same 100 for now. betaFreePremium makes both a no-op in beta.
  listing_post: 100,         // $1.00 — commerce listing, 30 days
  listing_post_connect: 100, // $1.00 — connect (dating/matrimony) listing, 30 days
};

export function featureCost(key: string): number | null {
  return Object.prototype.hasOwnProperty.call(FEATURE_COSTS, key) ? FEATURE_COSTS[key] : null;
}

/**
 * Charge the SERVER-set price for a premium feature. Idempotent by [opId]
 * (the WalletDO dedupes the spend). Returns {ok:true,charged} or
 * {ok:false,reason} where reason ∈ 'unknown_feature' | 'insufficient' | 'error'.
 *
 * Feature routes MUST call this server-side before delivering a paid action —
 * never trust the client's PaidFeature gate, which is UX only.
 */
export async function chargeFeature(
  env: Env, uid: string, featureKey: string, opId: string,
  opts?: { forceMeter?: boolean },
): Promise<{ ok: boolean; charged?: number; balance?: number; reason?: string }> {
  const cost = featureCost(featureKey);
  if (cost == null) return { ok: false, reason: "unknown_feature" };
  return chargeAmount(env, uid, featureKey, cost, opId, opts);
}

/**
 * [RECEPT-BILLING-3] Like chargeFeature, but for a CALLER-SUPPLIED amount — used
 * by per-second metered features (receptionist exact settle: ceil of accrued
 * token-hundredths) where the price is not a fixed FEATURE_COSTS entry. Same
 * protections as chargeFeature: betaFreePremium short-circuit (unless forceMeter),
 * team billing, idempotent WalletDO spend by opId, and the double-entry Q_WALLET
 * ledger message. The amount is server-computed by the calling DO/route — never
 * client-supplied.
 */
export async function chargeAmount(
  env: Env, uid: string, featureKey: string, amount: number, opId: string,
  opts?: { forceMeter?: boolean },
): Promise<{ ok: boolean; charged?: number; balance?: number; reason?: string }> {
  const cost = Math.max(0, Math.ceil(Number(amount) || 0)); // wallet is integer tokens
  if (cost === 0) return { ok: true, charged: 0 };
  // BETA PHASE: all services are free for everyone — never deduct coins. Flip
  // betaFreePremium off in KV to re-enable metering. (Lookup failure → charge as normal.)
  // [RECEPT-BILLING-LIVE-1] forceMeter (owner 2026-07-19): lets ONE feature charge for
  // real during beta (receptionist billing test) without un-freeing the whole platform.
  try { if (!opts?.forceMeter && (await readConfig(env)).betaFreePremium) return { ok: true, charged: 0 }; } catch { /* meter normally */ }
  // TEAM BILLING: if `uid` is on a Team plan, the spend leaves the TEAM wallet, not
  // the member's. The op_id stays keyed to the member + action (audit shows WHO
  // spent); only the payer changes. Non-members resolve to themselves (no-op).
  const payer = await billingUidFor(env, uid).catch(() => uid);
  const r = await walletOp(env, payer, {
    // allow_free: feature/AI costs may be paid with the daily FREE coins first
    // (then paid coins). Real marketplace spends omit this → paid-only.
    op: "spend", uid: payer, amount: cost, type: "spend", app_name: featureKey, op_id: opId, allow_free: true,
  });
  if (r.status === 402) return { ok: false, reason: "insufficient", balance: r.body?.balance };
  if (r.status !== 200) return { ok: false, reason: "error" };

  // Double-entry (audit item A2): a feature/AI charge moves PAID coins from the
  // user's account into the platform:fees bucket. Promo FREE coins are not real
  // money and never enter the wallet_ledger, so ONLY the paid portion is ledgered.
  // Emitted as a ledger-only Q_WALLET message (no uid/type) → the consumer writes
  // the wallet_ledger row and recomputes the platform:fees bucket, WITHOUT a
  // duplicate wallet_transactions row (the DO already wrote that legacy row).
  // Idempotent: id = `${opId}:fee` is the wallet_ledger PK. Without this, the DO
  // balance drifts below ledger Σ and trips nightly recon (the exact gap seen on
  // 2026-06-21: a 10-coin ava_mcp_tool spend with no matching ledger row).
  const paidUsed = Number(r.body?.paid_used ?? cost);
  if (paidUsed > 0) {
    try {
      await env.Q_WALLET.send({
        id: `${opId}:fee`,
        ts: Date.now(),
        ledger: {
          debit: `user:${payer}`,
          credit: "platform:fees",
          type: "spend",
          ref: opId,
          // `member` records the originating staffer when the payer is a team wallet,
          // so audit/recon can attribute team spend back to the actor.
          meta: JSON.stringify({ amount: paidUsed, feature: featureKey, member: payer === uid ? undefined : uid }),
        },
      });
    } catch { /* best-effort; recon catches any missed row */ }
  }
  // Team AI-message pool gauge: when a team wallet paid for an Ava chat message,
  // tick the manager's monthly counter (display only; the wallet is the real gate).
  if (payer !== uid && featureKey === "ava_chat") { try { await bumpTeamAiMsgPool(env, payer); } catch { /* gauge */ } }
  return { ok: true, charged: cost, balance: r.body?.balance };
}

// GET /api/feature/costs — the price list, for the client to DISPLAY (not enforce).
export async function featureCostsRoute(_req: Request, _env: Env): Promise<Response> {
  return json({ coins_per_usd: 100, costs: FEATURE_COSTS });
}
