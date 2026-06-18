// premium.ts — single source of truth for "is this user premium for AI features?"
//
// Per the locked free/premium model (Specs/AVA-FREE-PREMIUM-MODEL.md): premium AI
// is unlocked by EITHER
//   (a) a connected AI Studio key (X-Ava-Gemini-Key) — runs on the user's own
//       Google free quota, $0 to us; OR
//   (b) a wallet top-up (the WalletDO `premium` flag, set on first top-up).
// Free users get basic Gemma chat only; any AI tool (file/image/audio/translate/
// RAG/image-gen) returns the upsell.

import type { Env } from "../types";
import { json } from "../util";
import { track } from "../hooks";
import { walletOp } from "../routes/wallet";

export type PremiumVia = "byo_key" | "topup" | "none";

/** True if the request carries the user's own AI Studio (Gemini) key. */
export function hasByoKey(req: Request, body?: any): boolean {
  const h = req.headers.get("x-ava-gemini-key");
  if (h && h.trim()) return true;
  const bk = body?.key;
  return typeof bk === "string" && bk.trim().length > 0;
}

/**
 * Premium for AI features = BYO key OR a topped-up (premium) wallet.
 * `via` tells the caller how to bill: 'byo_key' → run on the user's key, no coins;
 * 'topup' → our infra, deduct coins; 'none' → not premium (show the upsell).
 */
export async function isPremiumAI(
  req: Request, env: Env, uid: string, body?: any,
): Promise<{ premium: boolean; via: PremiumVia }> {
  if (hasByoKey(req, body)) return { premium: true, via: "byo_key" };
  try {
    const bal = await walletOp(env, uid, { op: "balance", uid });
    if (Number(bal.body?.premium ?? 0) === 1) return { premium: true, via: "topup" };
  } catch { /* treat as not-premium on lookup failure */ }
  return { premium: false, via: "none" };
}

/** Standard upsell response when a FREE user hits a premium AI feature. */
export function premiumUpsell(env: Env, uid: string, feature: string): Response {
  track(env, uid, "premium_gate_shown", "avaai", { feature });
  const message =
    "That needs premium AI. Add your own AI Studio key in Settings (we show you how), " +
    "or top up $10 to unlock premium features.";
  return json({
    ok: false,
    blocked: true,
    reason: "premium_required",
    feature,
    message,
    answer: message, // also in `answer` so existing chat clients render it in-bubble
  }, 200);
}
