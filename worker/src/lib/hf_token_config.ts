// [HF-TOK-MATH-1] Sanitised reader for the HF token flags (hfTokensEnabled, hfCheckoutProvider, hfPricingVersion, hfCallCostPaisePerMin,
// hfHostShareBps, hfPlayPackageId). Pure: no I/O, no Env, safe to import from config.ts. Nothing reads it yet (declared-only in this issue).
// Invalid values fall to the safe side: unknown provider -> "none", bad numbers -> defaults.

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
