// [HF-TOPUP-1] Sanitised reader for the HF wallet top-up flags. Pure: no I/O, so it is safe to import from config.ts.
// HF top-up has its OWN switch (hfTopupEnabled + hfTopupGateway). It deliberately does NOT read the main-app gateway flags
// (razorpayEnabled, paytmEnabled, ...): those are forced off by PERMANENTLY_DISABLED_PAYMENT_FLAGS, which is the retired main
// app's policy and must not be touched. MONEY_IN_DISABLED likewise gates only those retired rails.
import type { Env } from "../types";
import type { GatewayId } from "./payments/types";
import { resolveGateway } from "./payments/registry";

/** Gateways HF can top up through: INR rails only. Stripe here is non-INR only, hdfc_sms is the internal smoke rail. */
export const HF_TOPUP_GATEWAYS: readonly GatewayId[] = ["razorpay", "cashfree", "paytm"];
export type HfTopupGateway = "none" | GatewayId;

export const HF_TOPUP_DEFAULT_PACKS = [100, 200, 500, 1000];
const ABS_MIN = 10;
const ABS_MAX = 50_000;

export interface HfTopupFlags {
  enabled: boolean; gateway: HfTopupGateway; packs: number[]; minRupees: number; maxRupees: number;
}
type Raw = { hfTopupEnabled?: unknown; hfTopupGateway?: unknown; hfTopupPacks?: unknown; hfTopupMinRupees?: unknown; hfTopupMaxRupees?: unknown };

function int(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parsePacks(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const out = [...new Set(parts.map((p) => Math.trunc(Number(p))).filter((n) => Number.isFinite(n) && n >= ABS_MIN && n <= ABS_MAX))].sort((a, b) => a - b);
  return out.length ? out.slice(0, 8) : [...HF_TOPUP_DEFAULT_PACKS];
}

/** Invalid values fall back to the safe side: unknown gateway -> "none", bad numbers -> defaults, min > max -> defaults. */
export function hfTopupFlags(config: Raw): HfTopupFlags {
  const g = String(config.hfTopupGateway ?? "none");
  const gateway: HfTopupGateway = (HF_TOPUP_GATEWAYS as readonly string[]).includes(g) ? (g as GatewayId) : "none";
  let minRupees = Math.min(ABS_MAX, Math.max(ABS_MIN, int(config.hfTopupMinRupees, 50)));
  let maxRupees = Math.min(ABS_MAX, Math.max(ABS_MIN, int(config.hfTopupMaxRupees, 5000)));
  if (minRupees > maxRupees) { minRupees = 50; maxRupees = 5000; }
  const packs = parsePacks(config.hfTopupPacks).filter((p) => p >= minRupees && p <= maxRupees);
  return { enabled: config.hfTopupEnabled === true, gateway, packs: packs.length ? packs : [minRupees], minRupees, maxRupees };
}

/** The ONE place that decides whether money can come in: flag on, a real gateway chosen, and that adapter holds its keys. */
export function hfTopupLive(env: Env, f: HfTopupFlags): { live: boolean; testMode: boolean } {
  if (!f.enabled || f.gateway === "none") return { live: false, testMode: false };
  const adapter = resolveGateway(f.gateway);
  if (!adapter || !adapter.configured(env)) return { live: false, testMode: false };
  let testMode = false;
  try { testMode = adapter.testMode(env) === true; } catch { testMode = false; }
  return { live: true, testMode };
}

/** What /api/config tells the browser. Nothing secret; `enabled` already folds in "adapter has keys". */
export function hfTopupPublic(env: Env, config: Raw): { enabled: boolean; gateway: HfTopupGateway; packs: number[]; minRupees: number; maxRupees: number; testMode: boolean } {
  const f = hfTopupFlags(config);
  const s = hfTopupLive(env, f);
  return { enabled: s.live, gateway: s.live ? f.gateway : "none", packs: f.packs, minRupees: f.minRupees, maxRupees: f.maxRupees, testMode: s.live && s.testMode };
}
