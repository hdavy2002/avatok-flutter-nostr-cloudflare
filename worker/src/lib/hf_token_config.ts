// [HF-TOK-MATH-1] Sanitised reader for the HF token flags (hfTokensEnabled, hfCheckoutProvider, hfPricingVersion, hfCallCostPaisePerMin,
// hfHostShareBps, hfPlayPackageId). Pure: no I/O, no Env, safe to import from config.ts. Nothing reads it yet (declared-only in this issue).
// Invalid values fall to the safe side: unknown provider -> "none", bad numbers -> defaults.
import { STD_PLAN_DEFAULTS, stdTariff, validTariff, type StdPlanConfig, type Tariff } from "./hf_token_math";

export const HF_CHECKOUT_PROVIDERS = ["google_play", "paytm", "razorpay", "cashfree"] as const;
export type HfCheckoutProvider = "none" | (typeof HF_CHECKOUT_PROVIDERS)[number];

export const HF_TOKEN_DEFAULTS = {
  enabled: false,
  provider: "google_play" as HfCheckoutProvider,
  pricingVersion: "gp-r1",
  callCostPaisePerMin: 200,
  hostShareBps: 6000,
  playPackageId: "com.hellofraands.app",
};

/** First HF Android build whose wallet and calling UI understands the Standard-plan rupee contract. */
export const HF_STD_PLAN_MIN_COMPAT_BUILD = 2078;

export interface HfTokenConfig {
  enabled: boolean; provider: HfCheckoutProvider; pricingVersion: string; callCostPaisePerMin: number; hostShareBps: number; playPackageId: string;
}
type Raw = {
  hfTokensEnabled?: unknown; hfCheckoutProvider?: unknown; hfPricingVersion?: unknown;
  hfCallCostPaisePerMin?: unknown; hfHostShareBps?: unknown; hfPlayPackageId?: unknown;
};

const VERSION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function boundedInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function readHfTokenConfig(cfg: Raw): HfTokenConfig {
  const d = HF_TOKEN_DEFAULTS;
  const p = cfg.hfCheckoutProvider === undefined ? d.provider : String(cfg.hfCheckoutProvider);
  const provider: HfCheckoutProvider = p === "none" ? "none" : (HF_CHECKOUT_PROVIDERS as readonly string[]).includes(p) ? (p as HfCheckoutProvider) : "none";
  const ver = typeof cfg.hfPricingVersion === "string" ? cfg.hfPricingVersion : d.pricingVersion;
  const pkg = typeof cfg.hfPlayPackageId === "string" ? cfg.hfPlayPackageId : d.playPackageId;
  return {
    enabled: cfg.hfTokensEnabled === true,
    provider,
    pricingVersion: VERSION_RE.test(ver) ? ver : d.pricingVersion,
    callCostPaisePerMin: boundedInt(cfg.hfCallCostPaisePerMin, 0, 100_000, d.callCostPaisePerMin),
    hostShareBps: boundedInt(cfg.hfHostShareBps, 0, 10_000, d.hostShareBps),
    playPackageId: PACKAGE_RE.test(pkg) && pkg.length <= 150 ? pkg : d.playPackageId,
  };
}

// ── [HF-STD-PLAN-1] Standard calling plan + GST-inclusive top-ups ───────────────────────────────────────────

export interface HfStdPlan extends StdPlanConfig { enabled: boolean; gstBps: number; gstInclusive: boolean; tariff: Tariff }
type RawStd = Record<string, unknown>;

/** Sanitised Standard plan config. Invalid economics fall back to approved defaults; rollout stays off unless every readiness gate is armed. */
export function readHfStdPlan(cfg: RawStd): HfStdPlan {
  const d = STD_PLAN_DEFAULTS;
  const n = (k: string, min: number, max: number, fb: number) => boundedInt(cfg[k], min, max, fb);
  let tier1EndMin = n("hfStdTier1EndMin", 1, 1440, d.tier1EndMin);
  let tier2EndMin = n("hfStdTier2EndMin", 1, 1440, d.tier2EndMin);
  if (tier2EndMin <= tier1EndMin) { tier1EndMin = d.tier1EndMin; tier2EndMin = d.tier2EndMin; }
  const c: StdPlanConfig = {
    tier1PaisePerMin: n("hfStdTier1PaisePerMin", 1, 100_000, d.tier1PaisePerMin),
    tier2PaisePerMin: n("hfStdTier2PaisePerMin", 1, 100_000, d.tier2PaisePerMin),
    tier3PaisePerMin: n("hfStdTier3PaisePerMin", 1, 100_000, d.tier3PaisePerMin),
    tier1EndMin, tier2EndMin,
    hostPaisePerMin: n("hfStdHostPaisePerMin", 1, 100_000, d.hostPaisePerMin),
    phoneCostPaisePerMin: n("hfStdPhoneCostPaisePerMin", 1, 100_000, d.phoneCostPaisePerMin),
  };
  let tariff = stdTariff(c);
  const declining = c.tier1PaisePerMin >= c.tier2PaisePerMin && c.tier2PaisePerMin >= c.tier3PaisePerMin;
  const economicsSafe = c.hostPaisePerMin + c.phoneCostPaisePerMin <= c.tier3PaisePerMin;
  if (!validTariff(tariff) || !declining || !economicsSafe) { Object.assign(c, d); tariff = stdTariff(d); }
  return {
    ...c, tariff,
    enabled: cfg.hfStdPlanEnabled === true
      && cfg.hfTokensEnabled === true
      && boundedInt(cfg.hfAppMinBuild, 0, 100_000_000, 0) >= HF_STD_PLAN_MIN_COMPAT_BUILD,
    gstBps: boundedInt(cfg.hfTopupGstBps, 0, 5000, 1800),
    gstInclusive: cfg.hfTopupGstInclusive === undefined ? true : cfg.hfTopupGstInclusive === true,
  };
}

/** What the app and website may see: the rate card and the GST note. Never host pay, phone cost or margins. */
export function hfStdPlanPublic(cfg: RawStd): {
  enabled: boolean; tiers: Array<{ fromMin: number; toMin: number | null; paisePerMin: number; rupeesPerMin: string }>;
  startPaisePerMin: number; gstBps: number; gstInclusive: boolean; minCompatibleBuild: number; influencerSetsRate: boolean;
} {
  const p = readHfStdPlan(cfg);
  const t = p.tariff.tiers;
  return {
    enabled: p.enabled,
    tiers: t.map((b, i) => ({ fromMin: b.fromSec / 60, toMin: i + 1 < t.length ? t[i + 1].fromSec / 60 : null, paisePerMin: b.paisePerMin, rupeesPerMin: (b.paisePerMin / 100).toFixed(2) })),
    startPaisePerMin: t[0].paisePerMin, gstBps: p.gstBps, gstInclusive: p.gstInclusive, minCompatibleBuild: HF_STD_PLAN_MIN_COMPAT_BUILD,
    influencerSetsRate: cfg.hfInfluencerSetsRate === true, // [HF-WIRE-18] HF-REEL-37: clients stop showing the one-rate card for influencers
  };
}
