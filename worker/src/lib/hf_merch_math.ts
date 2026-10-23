// [HF-MERCH-CORE-1 2026-10-23] Pure money maths for the influencer merch shop (Specs/SPEC-2026-10-23-HF-MERCH.md section 1).
// NO I/O, no imports. Everything is integer PAISE. The split is computed once, at checkout, and frozen into shop_orders.merch_json;
// later setting changes never touch an old order. The platform ABSORBS the Cashfree fee and GST: the two estimates are report-only
// and NEVER change what the influencer earns.

export type MerchCfg = {
  /** Platform share of the markup, basis points (default 4000 = 40%). The influencer gets the rest. */
  platformShareBps: number;
  minMarkupRupees: number;
  /** Added to the partner's cost to make the base price shown to influencers. */
  baseBufferRupees: number;
  /** Report-only estimate of the Cashfree fee on the whole amount, basis points (default 350). */
  cashfreeFeeBps: number;
  /** Report-only estimate of GST on the platform share, basis points (default 1800). */
  gstBps: number;
  /** Days after delivery before the influencer's earning is withdrawable (default 7). */
  holdDays: number;
};

export const MERCH_DEFAULT_CFG: MerchCfg = {
  platformShareBps: 4000, minMarkupRupees: 10, baseBufferRupees: 0, cashfreeFeeBps: 350, gstBps: 1800, holdDays: 7,
};
export const MAX_MARKUP_RUPEES = 5000;
export const MAX_QTY = 3;
export const DAY_MS = 86_400_000;

/** ONE range table for the merch settings: the admin PUT validates against it and readMerchCfg clamps to it. [min, max] inclusive, keyed by the config key. */
export const MERCH_CFG_RANGES = {
  hfMerchPlatformShareBps: [0, 9000],
  hfMerchMinMarkupRupees: [0, MAX_MARKUP_RUPEES],
  hfMerchBaseBufferRupees: [0, 2000],
  hfMerchCashfreeFeeBps: [0, 1000],
  hfMerchGstBps: [0, 2800],
  hfMerchHoldDays: [0, 60],
} as const satisfies Record<string, readonly [number, number]>;
const R = MERCH_CFG_RANGES;

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && Math.trunc(n) === n && n >= min && n <= max ? n : fallback;
};

/** Read the ten-flag config block (config.ts DEFAULTS layered with KV overrides) into a safe MerchCfg. A bad value falls back to the default. */
export function readMerchCfg(cfg: Record<string, unknown> | null | undefined): MerchCfg {
  const c = cfg ?? {};
  const d = MERCH_DEFAULT_CFG;
  return {
    platformShareBps: int(c.hfMerchPlatformShareBps, d.platformShareBps, R.hfMerchPlatformShareBps[0], R.hfMerchPlatformShareBps[1]),
    minMarkupRupees: int(c.hfMerchMinMarkupRupees, d.minMarkupRupees, R.hfMerchMinMarkupRupees[0], R.hfMerchMinMarkupRupees[1]),
    baseBufferRupees: int(c.hfMerchBaseBufferRupees, d.baseBufferRupees, R.hfMerchBaseBufferRupees[0], R.hfMerchBaseBufferRupees[1]),
    cashfreeFeeBps: int(c.hfMerchCashfreeFeeBps, d.cashfreeFeeBps, R.hfMerchCashfreeFeeBps[0], R.hfMerchCashfreeFeeBps[1]),
    gstBps: int(c.hfMerchGstBps, d.gstBps, R.hfMerchGstBps[0], R.hfMerchGstBps[1]),
    holdDays: int(c.hfMerchHoldDays, d.holdDays, R.hfMerchHoldDays[0], R.hfMerchHoldDays[1]),
  };
}

/** Integer round-half-up of (a * bps) / 10000 for non-negative a. */
export const bpsOf = (a: number, bps: number): number => Math.floor((2 * Math.max(0, Math.trunc(a)) * Math.max(0, Math.trunc(bps)) + 10_000) / 20_000);
/** Integer floor of (a * bps) / 10000 for non-negative a. */
export const bpsFloor = (a: number, bps: number): number => Math.floor((Math.max(0, Math.trunc(a)) * Math.max(0, Math.trunc(bps))) / 10_000);

/**
 * Base price (paise, WHOLE rupees, rounded UP) for one unit: the partner's print + shipping cost in rupees (may carry paise) plus the
 * admin buffer. Returns null when the partner gave no price (the product cannot be sold without knowing its cost).
 */
export function baseUnitPaise(partnerCostRupees: number | null | undefined, bufferRupees: number): number | null {
  if (partnerCostRupees == null || !Number.isFinite(partnerCostRupees) || partnerCostRupees <= 0) return null;
  const cents = Math.round(partnerCostRupees * 100); // the partner quotes to the paisa; work on integers from here
  return Math.ceil(cents / 100) * 100 + Math.max(0, Math.trunc(bufferRupees)) * 100;
}

/** [HF-MERCH-PRICE-LABELS-1] The parts of a base price. printing = garment + print + partner GST (unrounded paise); shipping = reference delivery; buffer = admin buffer.
 *  basePaise = ceil(printing + shipping) to a whole rupee + buffer, so printing + shipping + buffer is within one rupee below basePaise (the round-up). */
export type BaseParts = { printingPaise: number; shippingPaise: number; bufferPaise: number; baseUnitPaise: number };
/** totalRupees is the partner's printing + shipping total (computeSizeCosts.total_rupees); shippingRupees is the shipping inside it (null = none). */
export function splitBase(totalRupees: number | null | undefined, shippingRupees: number | null | undefined, bufferRupees: number): BaseParts | null {
  const base = baseUnitPaise(totalRupees, bufferRupees);
  if (base == null) return null;
  const shippingPaise = Math.max(0, Math.round((shippingRupees ?? 0) * 100));
  const printingPaise = Math.max(0, Math.round((totalRupees as number) * 100) - shippingPaise);
  return { printingPaise, shippingPaise, bufferPaise: Math.max(0, Math.trunc(bufferRupees)) * 100, baseUnitPaise: base };
}

/** The breakdown for a product's frozen size. Frozen parts are used as stored; a product made before the breakdown existed gets shipping from today's
 *  reference quote and printing = base - shipping - buffer (never negative) and is flagged estimated. */
export function sizeBreakdown(
  s: { baseUnitPaise: number; printingPaise?: number; shippingPaise?: number; bufferPaise?: number }, fallbackShippingPaise: number, fallbackBufferPaise: number,
): { printingPaise: number; shippingPaise: number; bufferPaise: number; estimated: boolean } {
  if (typeof s.printingPaise === "number" && typeof s.shippingPaise === "number" && typeof s.bufferPaise === "number") {
    return { printingPaise: s.printingPaise, shippingPaise: s.shippingPaise, bufferPaise: s.bufferPaise, estimated: false };
  }
  const shippingPaise = Math.max(0, Math.min(s.baseUnitPaise, Math.trunc(fallbackShippingPaise)));
  const bufferPaise = Math.max(0, Math.min(s.baseUnitPaise - shippingPaise, Math.trunc(fallbackBufferPaise)));
  return { printingPaise: Math.max(0, s.baseUnitPaise - shippingPaise - bufferPaise), shippingPaise, bufferPaise, estimated: true };
}

export type MarkupCheck = { ok: true; markupRupees: number } | { ok: false; error: "invalid_markup" | "markup_too_low" | "markup_too_high"; message: string };
export function checkMarkup(raw: unknown, cfg: Pick<MerchCfg, "minMarkupRupees">): MarkupCheck {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || Math.trunc(n) !== n) return { ok: false, error: "invalid_markup", message: "Enter your markup as a whole number of rupees." };
  if (n < cfg.minMarkupRupees) return { ok: false, error: "markup_too_low", message: `Your markup must be at least Rs ${cfg.minMarkupRupees}.` };
  if (n > MAX_MARKUP_RUPEES) return { ok: false, error: "markup_too_high", message: `Your markup can be at most Rs ${MAX_MARKUP_RUPEES}.` };
  return { ok: true, markupRupees: n };
}

/** What the influencer earns on ONE unit with this markup (the same floor rule the order split uses). */
export const youEarnUnitPaise = (markupUnitPaise: number, platformShareBps: number): number => bpsFloor(markupUnitPaise, 10_000 - platformShareBps);

export type PayMethod = "wallet" | "cashfree";

/** The frozen money block of one order (shop_orders.merch_json.money). Totals are for the whole order (qty units). */
export type MerchMoney = {
  qty: number;
  baseUnitPaise: number;
  markupUnitPaise: number;
  /** What one unit costs the fan (base + markup). */
  unitPaise: number;
  /** base x qty: what the partner is paid. */
  basePaise: number;
  /** markup x qty. */
  markupPaise: number;
  /** What the fan pays. */
  totalPaise: number;
  /** floor(markup x (10000 - share) / 10000). */
  influencerPaise: number;
  /** markup - influencer. */
  platformPaise: number;
  shareBps: number;
  payMethod: PayMethod;
  /** Estimates only; 0 when paid from the wallet (no gateway fee). */
  cashfreeFeeBps: number;
  cashfreeFeeEstPaise: number;
  gstBps: number;
  gstEstPaise: number;
  /** platform - cashfree fee estimate - gst estimate. May go negative. */
  platformNetPaise: number;
};

export function computeMerchMoney(a: { baseUnitPaise: number; markupUnitPaise: number; qty: number; payMethod: PayMethod; cfg: MerchCfg }): MerchMoney {
  const qty = Math.max(1, Math.min(MAX_QTY, Math.trunc(a.qty)));
  const baseUnit = Math.max(0, Math.trunc(a.baseUnitPaise));
  const markupUnit = Math.max(0, Math.trunc(a.markupUnitPaise));
  const unit = baseUnit + markupUnit;
  const base = baseUnit * qty;
  const markup = markupUnit * qty;
  const total = unit * qty;
  const influencer = bpsFloor(markup, 10_000 - a.cfg.platformShareBps);
  const platform = markup - influencer;
  const cfFee = a.payMethod === "cashfree" ? bpsOf(total, a.cfg.cashfreeFeeBps) : 0;
  const gst = bpsOf(platform, a.cfg.gstBps);
  return {
    qty, baseUnitPaise: baseUnit, markupUnitPaise: markupUnit, unitPaise: unit, basePaise: base, markupPaise: markup, totalPaise: total,
    influencerPaise: influencer, platformPaise: platform, shareBps: a.cfg.platformShareBps, payMethod: a.payMethod,
    cashfreeFeeBps: a.payMethod === "cashfree" ? a.cfg.cashfreeFeeBps : 0, cashfreeFeeEstPaise: cfFee, gstBps: a.cfg.gstBps, gstEstPaise: gst,
    platformNetPaise: platform - cfFee - gst,
  };
}

export type CostQuote = { liveBasePaise: number; platformNetAfterPaise: number; costRose: boolean; canApprove: boolean; risePaise: number };

/**
 * Approval re-quote: the partner's LIVE per-unit base price against the frozen one. platform_net_after = platform_net - (live - frozen) x qty.
 * Below zero the platform would lose money: approve is refused (409 cost_rose) and the admin is offered reject + refund.
 * A live price BELOW the frozen one never adds money (the fan already paid base + markup; the saving is the platform's, shown as risePaise < 0).
 */
export function quoteAgainstLive(m: Pick<MerchMoney, "qty" | "baseUnitPaise" | "platformNetPaise">, liveBaseUnitPaise: number): CostQuote {
  const live = Math.max(0, Math.trunc(liveBaseUnitPaise));
  const rise = (live - m.baseUnitPaise) * m.qty;
  const after = m.platformNetPaise - rise;
  const costRose = after < 0;
  return { liveBasePaise: live * m.qty, platformNetAfterPaise: after, costRose, canApprove: !costRose, risePaise: rise };
}

/** When a delivered order's earning becomes withdrawable. */
export const earningAvailableAt = (deliveredAtMs: number, holdDays: number): number => deliveredAtMs + Math.max(0, Math.trunc(holdDays)) * DAY_MS;

/** Fan-facing price from the product's frozen per-size base price and the influencer's markup (whole rupees in, paise out). */
export function sizePrices(sizes: Array<{ size: string; baseUnitPaise: number }>, markupRupees: number, platformShareBps: number) {
  const markupUnit = Math.trunc(markupRupees) * 100;
  return sizes.map((s) => ({
    size: s.size, basePaise: s.baseUnitPaise, pricePaise: s.baseUnitPaise + markupUnit, youEarnPaise: youEarnUnitPaise(markupUnit, platformShareBps),
  }));
}

/** Format paise as "Rs 700" / "Rs 24.50" for messages. */
export function rupeesText(paise: number): string {
  const p = Math.trunc(paise);
  const whole = Math.trunc(Math.abs(p) / 100), frac = Math.abs(p) % 100;
  return `${p < 0 ? "-" : ""}Rs ${whole.toLocaleString("en-IN")}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}

// [HF-MERCH-PROFIT-VIEW-1] Admin money table: what the platform makes on one size of a product / one order.
export type ProfitRow = {
  size: string;
  /** Shirt + print + Printrove GST (what Printrove's dashboard shows), WITHOUT shipping. */
  printroveCostPaise: number;
  shippingPaise: number;
  printroveTotalPaise: number;
  fanPaysPaise: number;
  influencerPaise: number;
  /** fan pays - influencer - Printrove total. */
  platformBeforeFeesPaise: number;
  /** GST on the platform's markup share (markup - influencer). */
  gstEstPaise: number;
  /** Cashfree fee on what the fan pays; 0 when cashfreeFeeBps is 0 (wallet). */
  cashfreeEstPaise: number;
  platformAfterFeesPaise: number;
};

/** Pure: one row of the profit table. Reuses bpsOf, the same rounding the order split uses. */
export function profitRow(a: {
  size: string; printroveCostPaise: number; shippingPaise: number; fanPaysPaise: number; markupPaise: number; influencerPaise: number; gstBps: number; cashfreeFeeBps: number;
}): ProfitRow {
  const cost = Math.max(0, Math.trunc(a.printroveCostPaise)), ship = Math.max(0, Math.trunc(a.shippingPaise));
  const total = cost + ship;
  const fan = Math.trunc(a.fanPaysPaise), inf = Math.trunc(a.influencerPaise);
  const before = fan - inf - total;
  const share = Math.max(0, Math.trunc(a.markupPaise) - inf);
  const gst = bpsOf(share, a.gstBps);
  const cf = bpsOf(fan, a.cashfreeFeeBps);
  return {
    size: a.size, printroveCostPaise: cost, shippingPaise: ship, printroveTotalPaise: total, fanPaysPaise: fan, influencerPaise: inf,
    platformBeforeFeesPaise: before, gstEstPaise: gst, cashfreeEstPaise: cf, platformAfterFeesPaise: before - gst - cf,
  };
}
