// [TOKENS-FX-1] USD→X FX rates for the region-aware top-up quote.
//
// NOTE: FX here is INFORMATIONAL ONLY. Token economics are fixed:
//   canonical  — 1 USD = 100 Tokens (1 Token = $0.01), everywhere.
//   India      — 1 Token = ₹1 FIXED (an owner pricing decision, NOT an FX
//                conversion); minimum top-up ₹100 (= 100 Tokens).
// The quote endpoint returns the live USD rate purely so the client can show
// context (e.g. what ₹100 is "worth"); no balance or price is derived from it.
//
// Provider chain:
//   1. Wise (https://api.wise.com/v1/rates) — used ONLY when the optional
//      secret WISE_API_TOKEN is set. (Distinct from WISE_API_KEY, the payout
//      rail credential; the owner will supply a rates token separately.)
//   2. open.er-api.com — free, keyless. The default until Wise is configured.
//   3. Hard fallback constant (INR only) if both are unreachable.
// Result cached in KV `fx:USD:<cur>` for 6h so neither provider is hammered.
import type { Env } from "../types";

const FX_TTL_SEC = 6 * 60 * 60; // 6h
const HARD_FALLBACK: Record<string, number> = { INR: 96.4 };

export type FxResult = { rate: number | null; source: "identity" | "cache" | "wise" | "er-api" | "hard_fallback" | "unavailable" };

/** Live USD→[target] mid-rate. Never throws; { rate: null } if truly unavailable. */
export async function getUsdRate(env: Env, targetCurrency: string): Promise<FxResult> {
  const cur = String(targetCurrency || "").toUpperCase();
  if (!cur || cur === "USD") return { rate: 1, source: "identity" };

  const kvKey = `fx:USD:${cur}`;
  try {
    const cached = await env.TOKENS.get(kvKey);
    const v = Number(cached);
    if (cached && v > 0) return { rate: v, source: "cache" };
  } catch { /* KV read is best-effort */ }

  let rate: number | null = null;
  let source: FxResult["source"] = "unavailable";

  // Primary: Wise — only when the optional token is configured.
  if (env.WISE_API_TOKEN) {
    try {
      const r = await fetch(`https://api.wise.com/v1/rates?source=USD&target=${encodeURIComponent(cur)}`, {
        headers: { Authorization: `Bearer ${env.WISE_API_TOKEN}` },
      });
      if (r.ok) {
        const j = (await r.json().catch(() => null)) as any;
        const v = Number(Array.isArray(j) ? j[0]?.rate : j?.rate);
        if (v > 0) { rate = v; source = "wise"; }
      }
    } catch { /* fall through */ }
  }

  // Fallback (and the default while no Wise token exists): free keyless service.
  if (rate == null) {
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      if (r.ok) {
        const j = (await r.json().catch(() => null)) as any;
        const v = Number(j?.rates?.[cur]);
        if (v > 0) { rate = v; source = "er-api"; }
      }
    } catch { /* fall through */ }
  }

  if (rate == null) {
    const hf = HARD_FALLBACK[cur];
    return hf ? { rate: hf, source: "hard_fallback" } : { rate: null, source: "unavailable" };
  }

  try { await env.TOKENS.put(kvKey, String(rate), { expirationTtl: FX_TTL_SEC }); } catch { /* cache is best-effort */ }
  return { rate, source };
}
