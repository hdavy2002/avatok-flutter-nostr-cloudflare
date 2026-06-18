// Server-owned price list for premium, discrete Ava actions (2026-06-18).
//
// Prices are in COINS (1 USD = 1000 coins). The CLIENT never sends a price — it
// names the feature and the server charges THIS amount. A patched client can't
// underpay because the amount is derived here, not from the request. Tune freely;
// keys must match what each feature route passes to chargeFeature().
import type { Env } from "./types";
import { json } from "./util";
import { walletOp } from "./routes/wallet";

export const FEATURE_COSTS: Record<string, number> = {
  ava_chat: 2,               // $0.002 — one Ava chat message (Workers-AI Gemma 4; 3x cost)
  ava_image_free: 5,         // $0.005 — one free-tier image (Workers-AI Flux-1-schnell)
  ava_image_generate: 80,    // $0.08  — one premium image (Gemini "Nano Banana 2")
  ava_voice_reply: 20,       // $0.02  — Ava speaks a reply
  ava_vision_snapshot: 10,   // $0.01  — one analyzed snapshot beyond the free quota
  ava_mcp_tool: 10,          // $0.01  — one connected-app (Strata) tool call
  guardian_always_on: 300,   // $0.30/mo — always-on safety monitoring for a chat
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
  const r = await walletOp(env, uid, {
    // allow_free: feature/AI costs may be paid with the daily FREE coins first
    // (then paid coins). Real marketplace spends omit this → paid-only.
    op: "spend", uid, amount: cost, type: "spend", app_name: featureKey, op_id: opId, allow_free: true,
  });
  if (r.status === 402) return { ok: false, reason: "insufficient", balance: r.body?.balance };
  if (r.status !== 200) return { ok: false, reason: "error" };
  return { ok: true, charged: cost, balance: r.body?.balance };
}

// GET /api/feature/costs — the price list, for the client to DISPLAY (not enforce).
export async function featureCostsRoute(_req: Request, _env: Env): Promise<Response> {
  return json({ coins_per_usd: 1000, costs: FEATURE_COSTS });
}
