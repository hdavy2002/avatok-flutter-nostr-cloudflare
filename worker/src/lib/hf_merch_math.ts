// [HF-MERCH-GST-1 2026-10-23] GST MODEL (rule HF-MERCH-17): the PLATFORM is the seller of every product. The fan price (base + markup) is GST-INCLUSIVE at the
// product's CATEGORY rate (lib/hf_merch_gst.ts: clothing 5% up to Rs 2,500 a piece, other categories as set in admin, default 18%; flat hfMerchGstRateBps is only the fallback),
// frozen per product and per order; we claim back the GST Printrove charges us on the item + print (input credit, at Printrove's own rate per variant);
// the influencer earns a design ROYALTY (60% of the markup, unchanged). Output GST = fan total x r/(1+r); input credit = printing x g/(100+g), g = Printrove's GST %; net GST = output - input.
// The old "18% GST on our share" estimate is gone for new orders; its fields stay readable on old snapshots (see merchGstOf).
// [HF-MERCH-CORE-1 2026-10-23] Pure money maths for the influencer merch shop (Specs/SPEC-2026-10-23-HF-MERCH.md section 1).
// NO I/O (one pure import). Everything is integer PAISE. The split is computed once, at checkout, and frozen into shop_orders.merch_json;
// later setting changes never touch an old order. The platform ABSORBS the Cashfree fee and GST: the two estimates are report-only
// and NEVER change what the influencer earns.

import { gstRowFor, parseGstTable, DEFAULT_GST_TABLE, type FrozenGst, type GstTable } from "./hf_merch_gst";

export type MerchCfg = {
  /** Platform share of the markup, basis points (default 4000 = 40%). The influencer gets the rest. */
  platformShareBps: number;
  minMarkupRupees: number;
  /** Added to the partner's cost to make the base price shown to influencers. */
  baseBufferRupees: number;
  /** Report-only estimate of the Cashfree fee on the whole amount, basis points (default 350). */
  cashfreeFeeBps: number;
  /** LEGACY (pre HF-MERCH-GST-1): report-only estimate of GST on the platform share. No longer used by the maths; kept so the settings table stays stable. */
  gstBps: number;
  /** [HF-MERCH-GST-1] FALLBACK GST rate INCLUDED in the fan price, basis points (default 500 = 5%): used for a category the table does not list and for products made before the table existed. */
  gstRateBps: number;
  /** [HF-MERCH-GST-1] Per-category rate / HSN / cap-applies (setting hfMerchGstTable, defaults in hf_merch_gst.ts). */
  gstTable: GstTable;
  /** [HF-MERCH-GST-1] The most one piece (any size) may cost the fan, in paise (default Rs 2,500), in categories where the table says the cap applies (clothing), so the 5% rate always applies. */
  priceCapPaise: number;
  /** [HF-MERCH-GST-1] FALLBACK HSN printed on the invoice (default 6109, T-shirts). */
  hsn: string;
  /** Days after delivery before the influencer's earning is withdrawable (default 7). */
  holdDays: number;
};

export const MERCH_DEFAULT_CFG: MerchCfg = {
  platformShareBps: 4000, minMarkupRupees: 10, baseBufferRupees: 0, cashfreeFeeBps: 350, gstBps: 1800, gstRateBps: 500, gstTable: DEFAULT_GST_TABLE, priceCapPaise: 250_000, hsn: "6109", holdDays: 7,
};
/** Default for the GST Printrove charges us (used when its catalogue reports none): 5%. It is already inside the printing figure, so credit = printing x g/(100+g). */
export const PRINTROVE_GST_BPS = 500;
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
  hfMerchGstRateBps: [0, 2800],
  hfMerchPriceCapRupees: [1, 100_000],
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
    gstRateBps: int(c.hfMerchGstRateBps, d.gstRateBps, R.hfMerchGstRateBps[0], R.hfMerchGstRateBps[1]),
    gstTable: parseGstTable(c.hfMerchGstTable),
    priceCapPaise: int(c.hfMerchPriceCapRupees, d.priceCapPaise / 100, R.hfMerchPriceCapRupees[0], R.hfMerchPriceCapRupees[1]) * 100,
    hsn: typeof c.hfMerchHsn === "string" && /^\d{4,8}$/.test(c.hfMerchHsn.trim()) ? c.hfMerchHsn.trim() : d.hsn,
    holdDays: int(c.hfMerchHoldDays, d.holdDays, R.hfMerchHoldDays[0], R.hfMerchHoldDays[1]),
  };
}

/** Integer round-half-up of (a * bps) / 10000 for non-negative a. */
export const bpsOf = (a: number, bps: number): number => Math.floor((2 * Math.max(0, Math.trunc(a)) * Math.max(0, Math.trunc(bps)) + 10_000) / 20_000);
/** Integer floor of (a * bps) / 10000 for non-negative a. */
export const bpsFloor = (a: number, bps: number): number => Math.floor((Math.max(0, Math.trunc(a)) * Math.max(0, Math.trunc(bps))) / 10_000);

/**
 * [HF-MERCH-GST-1] Split a GST-INCLUSIVE total: gst = round(total x r / (10000 + r)), taxable = total - gst. 64,400 at 500 bps -> gst 3,067, taxable 61,333.
 */
export function gstInclusiveSplit(totalPaise: number, rateBps = 500): { taxablePaise: number; gstPaise: number } {
  const total = Math.max(0, Math.trunc(totalPaise));
  const r = Math.max(0, Math.trunc(rateBps));
  const gst = Math.floor((2 * total * r + (10_000 + r)) / (2 * (10_000 + r))); // round half up
  return { taxablePaise: total - gst, gstPaise: gst };
}
export interface MerchTaxSplit {
  totalPaise: number; taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  intraState: boolean; /** false when the fan's state could not be matched to a GST state code (treated as intra-state) */ stateKnown: boolean;
}
/**
 * GST is INCLUDED in the total. Intra-state (buyer state code == supplier state code): CGST + SGST half each (CGST rounds down, SGST takes the odd paisa).
 * Otherwise IGST. A buyer whose state cannot be matched is treated as intra-state and flagged (stateKnown false), as the other HF documents do.
 */
export function merchTaxSplit(totalPaise: number, rateBps: number, buyerStateCode: string | null, supplierStateCode: string): MerchTaxSplit {
  const { taxablePaise, gstPaise } = gstInclusiveSplit(totalPaise, rateBps);
  const intra = !supplierStateCode || !buyerStateCode || buyerStateCode === supplierStateCode;
  const cgst = intra ? Math.floor(gstPaise / 2) : 0;
  return {
    totalPaise: Math.max(0, Math.trunc(totalPaise)), taxablePaise, gstPaise, cgstPaise: cgst, sgstPaise: intra ? gstPaise - cgst : 0, igstPaise: intra ? 0 : gstPaise,
    intraState: intra, stateKnown: !!buyerStateCode,
  };
}

/** [HF-MERCH-GST-1] The frozen GST of a category (rate, HSN, cap-applies) from the settings table; unknown/absent category -> the flat fallback. */
export const gstForCategory = (cfg: Pick<MerchCfg, "gstTable" | "gstRateBps" | "hsn">, category: string | null | undefined): FrozenGst =>
  gstRowFor(cfg.gstTable, category, { rateBps: cfg.gstRateBps, hsn: cfg.hsn });
/** [HF-MERCH-GST-1] Input credit on `printingPaise` (the GST-inclusive item + print figure) at Printrove's rate (default 5%): printing x g/(100+g). 39,375 at 500 -> 1,875. */
export const printroveInputGstPaise = (printingPaise: number, partnerGstBps: number = PRINTROVE_GST_BPS): number => gstInclusiveSplit(printingPaise, partnerGstBps).gstPaise;

/** [HF-MERCH-GST-1] Output / input / net GST of a snapshot's money block. Old snapshots only have the 18% estimate, which is reported as the net. */
export function merchGstOf(m: { outputGstPaise?: number; inputGstPaise?: number; netGstPaise?: number; gstEstPaise?: number } | null | undefined): { outputGstPaise: number; inputGstPaise: number; netGstPaise: number; legacy: boolean } {
  if (!m) return { outputGstPaise: 0, inputGstPaise: 0, netGstPaise: 0, legacy: true };
  if (typeof m.netGstPaise === "number") return { outputGstPaise: Number(m.outputGstPaise ?? 0), inputGstPaise: Number(m.inputGstPaise ?? 0), netGstPaise: m.netGstPaise, legacy: false };
  return { outputGstPaise: 0, inputGstPaise: 0, netGstPaise: Math.trunc(Number(m.gstEstPaise ?? 0)), legacy: true };
}

/**
 * [HF-MERCH-GST-1] The fan-price cap. Per size: the largest whole-rupee markup that keeps base + markup <= cap (never below 0). `maxMarkupRupees` of a
 * product is the smallest of its sizes.
 */
export const maxMarkupForBase = (baseUnitPaise: number, capPaise: number): number => Math.max(0, Math.floor((Math.trunc(capPaise) - Math.trunc(baseUnitPaise)) / 100));
export function checkPriceCap(sizes: Array<{ size: string; baseUnitPaise: number }>, markupRupees: number, capPaise: number | null): { ok: true } | { ok: false; maxMarkupRupees: number; capPaise: number; size: string } {
  if (capPaise == null) return { ok: true }; // [HF-MERCH-GST-1] the category has no cap
  const over = sizes.filter((s) => s.baseUnitPaise + Math.trunc(markupRupees) * 100 > capPaise);
  if (!over.length) return { ok: true };
  return { ok: false, maxMarkupRupees: Math.min(...sizes.map((s) => maxMarkupForBase(s.baseUnitPaise, capPaise))), capPaise, size: over[0].size };
}

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
  /** LEGACY name, kept readable: on a new order gstBps = gstRateBps and gstEstPaise = netGstPaise. */
  gstBps: number;
  gstEstPaise: number;
  /** [HF-MERCH-GST-1] absent on orders made before it shipped (use merchGstOf). */
  gstRateBps?: number;
  /** HSN frozen with the rate ("" = still to be confirmed by the CA). */
  hsn?: string;
  /** The GST % (basis points) Printrove charged, used for the input credit. */
  partnerGstBps?: number;
  /** Fan total without the GST inside it. */
  taxablePaise?: number;
  /** GST collected from the fan (inside the total). */
  outputGstPaise?: number;
  /** GST Printrove charged us on the item + print (claimed back). */
  inputGstPaise?: number;
  /** output - input: what we pay the government for this order. */
  netGstPaise?: number;
  /** platform share - cashfree fee estimate - net GST. May go negative. */
  platformNetPaise: number;
};

export function computeMerchMoney(a: { baseUnitPaise: number; markupUnitPaise: number; qty: number; payMethod: PayMethod; cfg: MerchCfg; /** GST-inclusive item + print per unit; 0/absent = no input credit */ printingUnitPaise?: number;
  /** [HF-MERCH-GST-1] The product's FROZEN category GST (rate + HSN); absent = the flat cfg fallback. */ gst?: { rateBps: number; hsn?: string };
  /** Printrove's GST for this variant, basis points; absent = the category rate. */ partnerGstBps?: number }): MerchMoney {
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
  const rateBps = a.gst ? a.gst.rateBps : a.cfg.gstRateBps;
  const inBps = typeof a.partnerGstBps === "number" ? a.partnerGstBps : rateBps;
  const split = gstInclusiveSplit(total, rateBps);
  const inputGst = Math.min(split.gstPaise, printroveInputGstPaise(Math.max(0, Math.trunc(a.printingUnitPaise ?? 0)) * qty, inBps));
  const netGst = split.gstPaise - inputGst;
  return {
    qty, baseUnitPaise: baseUnit, markupUnitPaise: markupUnit, unitPaise: unit, basePaise: base, markupPaise: markup, totalPaise: total,
    influencerPaise: influencer, platformPaise: platform, shareBps: a.cfg.platformShareBps, payMethod: a.payMethod,
    cashfreeFeeBps: a.payMethod === "cashfree" ? a.cfg.cashfreeFeeBps : 0, cashfreeFeeEstPaise: cfFee, gstBps: rateBps, gstEstPaise: netGst,
    gstRateBps: rateBps, ...(a.gst?.hsn != null ? { hsn: a.gst.hsn } : {}), partnerGstBps: inBps, taxablePaise: split.taxablePaise, outputGstPaise: split.gstPaise, inputGstPaise: inputGst, netGstPaise: netGst,
    platformNetPaise: platform - cfFee - netGst,
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

/** Fan-facing price from the product's frozen per-size base price and the influencer's markup (whole rupees in, paise out). pricePaise is GST-inclusive. */
export function sizePrices(sizes: Array<{ size: string; baseUnitPaise: number }>, markupRupees: number, platformShareBps: number, capPaise?: number | null) {
  const markupUnit = Math.trunc(markupRupees) * 100;
  return sizes.map((s) => ({
    size: s.size, basePaise: s.baseUnitPaise, pricePaise: s.baseUnitPaise + markupUnit, youEarnPaise: youEarnUnitPaise(markupUnit, platformShareBps),
    ...(capPaise != null ? { maxMarkupRupees: maxMarkupForBase(s.baseUnitPaise, capPaise) } : {}),
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
  /** [HF-MERCH-GST-1] GST collected inside what the fan pays. */
  outputGstPaise: number;
  /** GST Printrove charged on item + print (claimed back). */
  inputGstPaise: number;
  /** output - input. */
  netGstPaise: number;
  /** LEGACY name for the GST line: equals netGstPaise (or the old 18% estimate when the legacy path is used). */
  gstEstPaise: number;
  /** Cashfree fee on what the fan pays; 0 when cashfreeFeeBps is 0 (wallet). */
  cashfreeEstPaise: number;
  platformAfterFeesPaise: number;
};

/** Pure: one row of the profit table. Reuses bpsOf, the same rounding the order split uses. */
export function profitRow(a: {
  size: string; printroveCostPaise: number; shippingPaise: number; fanPaysPaise: number; markupPaise: number; influencerPaise: number; cashfreeFeeBps: number;
  /** [HF-MERCH-GST-1] GST included in the fan price. Omit it (and pass legacyGstBps) only for an order made before HF-MERCH-GST-1. */
  gstRateBps?: number; legacyGstBps?: number;
  /** [HF-MERCH-GST-1] Printrove's GST (basis points) for the input credit; omitted = the same as gstRateBps. */ partnerGstBps?: number;
}): ProfitRow {
  const cost = Math.max(0, Math.trunc(a.printroveCostPaise)), ship = Math.max(0, Math.trunc(a.shippingPaise));
  const total = cost + ship;
  const fan = Math.trunc(a.fanPaysPaise), inf = Math.trunc(a.influencerPaise);
  const before = fan - inf - total;
  const cf = bpsOf(fan, a.cashfreeFeeBps);
  let out = 0, inp = 0, net: number;
  if (typeof a.gstRateBps === "number") {
    out = gstInclusiveSplit(fan, a.gstRateBps).gstPaise;
    inp = Math.min(out, printroveInputGstPaise(cost, typeof a.partnerGstBps === "number" ? a.partnerGstBps : a.gstRateBps));
    net = out - inp;
  } else net = bpsOf(Math.max(0, Math.trunc(a.markupPaise) - inf), a.legacyGstBps ?? 0); // old orders: 18% on the platform share
  return {
    size: a.size, printroveCostPaise: cost, shippingPaise: ship, printroveTotalPaise: total, fanPaysPaise: fan, influencerPaise: inf,
    platformBeforeFeesPaise: before, outputGstPaise: out, inputGstPaise: inp, netGstPaise: net, gstEstPaise: net, cashfreeEstPaise: cf, platformAfterFeesPaise: before - net - cf,
  };
}
