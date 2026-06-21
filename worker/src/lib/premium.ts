// premium.ts — single source of truth for "is this user premium for AI features?"
//
// TWO-MODE model (2026-06-18, owner decision — Google BYOK removed):
//   • FREE     — basic Gemma chat only (daily-capped).
//   • PREMIUM  — top up the wallet ($10 min). EVERYTHING runs on Cloudflare,
//                metered per user through the AI Gateway; our own Google key is
//                used ONLY for image generation. No user-supplied keys anywhere.
// Any AI tool (file/image/audio/translate/RAG/image-gen) is premium → free users
// get the upsell.

import type { Env } from "../types";
import { json } from "../util";
import { track } from "../hooks";
import { walletOp } from "../routes/wallet";
import { readConfig } from "../routes/config";

export type PremiumVia = "topup" | "none";

/**
 * Premium for AI features = a topped-up (premium) wallet. Single path.
 * `via` is 'topup' (run on our infra, deduct coins) or 'none' (show the upsell).
 *
 * BETA PHASE (cfg.betaFreePremium): every user is premium — all AI tools unlocked,
 * the daily turn cap bypassed (callers pass this `premium` into skipQuota), and the
 * upsell never fires. Flip betaFreePremium off in KV to restore the metered model.
 */
export async function isPremiumAI(
  _req: Request, env: Env, uid: string, _body?: any,
): Promise<{ premium: boolean; via: PremiumVia }> {
  try {
    const cfg = await readConfig(env);
    if (cfg.betaFreePremium) return { premium: true, via: "topup" };
  } catch { /* fall through to wallet check on config lookup failure */ }
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
    "That's a premium feature. Top up $10 in your wallet to unlock image generation, " +
    "file & photo understanding, memory, and more — all included.";
  return json({
    ok: false,
    blocked: true,
    reason: "premium_required",
    feature,
    message,
    answer: message, // also in `answer` so existing chat clients render it in-bubble
  }, 200);
}
