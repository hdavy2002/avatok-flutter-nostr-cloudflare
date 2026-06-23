// Server-owned price list for premium, discrete Ava actions (2026-06-18).
//
// Prices are in COINS. CANONICAL site-wide economics: 1 USD = 100 coins
// (1 coin = $0.01 = 1 USD cent), matching wallet.ts (COINS_PER_USD), ledger.ts,
// cal/emails.ts, translate.ts, avavoice.ts and the client (kCoinsPerUsd=100).
// The CLIENT never sends a price — it names the feature and the server charges
// THIS amount. A patched client can't underpay because the amount is derived
// here, not from the request. Tune freely; keys must match what each feature
// route passes to chargeFeature().
//
// NOTE (2026-06-23 coin-unit normalization 1000→100 coins/USD): three actions
// that priced below 1¢ in the old 1000-coins/USD scheme (ava_chat $0.002,
// ava_memory $0.002, ava_image_free $0.005) are floored to the 1-coin (1¢)
// minimum, since 1 coin is now the smallest billable unit. Everything else
// converted exactly (÷10) and keeps its USD price.
import type { Env } from "./types";
import { json } from "./util";
import { walletOp } from "./routes/wallet";
import { readConfig } from "./routes/config";

export const FEATURE_COSTS: Record<string, number> = {
  ava_chat: 1,               // $0.01 — one Ava chat message (Workers-AI Gemma 4); floored to 1-coin min
  ava_memory: 1,             // $0.01 — one AI Search ingest or query (premium memory/file search); 1-coin min
  ava_image_free: 1,         // $0.01 — one free-tier image (Workers-AI Flux-1-schnell); 1-coin min
  ava_image_generate: 8,     // $0.08 — one premium image (Gemini "Nano Banana 2")
  ava_voice_reply: 2,        // $0.02 — Ava speaks a reply
  ava_vision_snapshot: 1,    // $0.01 — one analyzed snapshot beyond the free quota
  ava_mcp_tool: 1,           // $0.01 — one connected-app (Composio) tool call
  guardian_always_on: 30,    // $0.30/mo — always-on safety monitoring for a chat
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
): Promise<{ ok: boolean; charged?: number; balance?: number; reason?: string }> {
  const cost = featureCost(featureKey);
  if (cost == null) return { ok: false, reason: "unknown_feature" };
  if (cost === 0) return { ok: true, charged: 0 };
  // BETA PHASE: all services are free for everyone — never deduct coins. Flip
  // betaFreePremium off in KV to re-enable metering. (Lookup failure → charge as normal.)
  try { if ((await readConfig(env)).betaFreePremium) return { ok: true, charged: 0 }; } catch { /* meter normally */ }
  const r = await walletOp(env, uid, {
    // allow_free: feature/AI costs may be paid with the daily FREE coins first
    // (then paid coins). Real marketplace spends omit this → paid-only.
    op: "spend", uid, amount: cost, type: "spend", app_name: featureKey, op_id: opId, allow_free: true,
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
          debit: `user:${uid}`,
          credit: "platform:fees",
          type: "spend",
          ref: opId,
          meta: JSON.stringify({ amount: paidUsed, feature: featureKey }),
        },
      });
    } catch { /* best-effort; recon catches any missed row */ }
  }
  return { ok: true, charged: cost, balance: r.body?.balance };
}

// GET /api/feature/costs — the price list, for the client to DISPLAY (not enforce).
export async function featureCostsRoute(_req: Request, _env: Env): Promise<Response> {
  return json({ coins_per_usd: 100, costs: FEATURE_COSTS });
}
