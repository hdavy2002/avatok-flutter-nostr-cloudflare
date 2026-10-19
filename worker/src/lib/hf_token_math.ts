// [HF-TOK-MATH-1] Pure token + money maths for HF (spec: Specs/SPEC-2026-10-10-HF-ANDROID-APP.md section 11.4). No I/O, no Env.
// Units: rupees are PAISE (integers); tokens are MICRO-TOKENS (1 token = 1_000_000 micro). No floats touch money: every product that
// could pass 2^53 is done in BigInt, and results are returned as plain numbers (they are small once divided).
// NOTHING imports this yet: it is the tested base for HF-TOK-LEDGER-1 / HF-TOK-CALLS-1.

export const MICRO = 1_000_000;
const MICRO_N = 1_000_000n;

export const DEFAULT_CALL_COST_PAISE_PER_MIN = 200;
export const DEFAULT_HOST_SHARE_BPS = 6000;
export const MAX_CALL_SECONDS = 3600;
export const START_RESERVE_MINUTES = 2;

// ── integer helpers (BigInt inside, number outside) ─────────────────────────

function nat(n: number): bigint {
  if (!Number.isFinite(n)) throw new RangeError(`hf_token_math: not a finite number: ${n}`);
  const t = Math.trunc(n);
  return BigInt(t < 0 ? 0 : t);
}
function posValue(v: number): bigint {
  const t = Math.trunc(v);
  if (!Number.isFinite(v) || t <= 0) throw new RangeError(`hf_token_math: valuePaisePerToken must be a positive integer, got ${v}`);
  return BigInt(t);
}
function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }
function roundHalfUpDiv(a: bigint, b: bigint): bigint { return (2n * a + b) / (2n * b); }
const num = (b: bigint): number => Number(b);

// ── display helpers ─────────────────────────────────────────────────────────

/** Micro-tokens a host's minute costs at a token value, rounded UP to the micro. Rs20 @ Rs0.82 -> 24_390_244 (24.390244 tokens); Rs10 @ Rs1.00 (gp-r1) -> 10_000_000. */
export function tokensPerMinuteMicro(ratePaise: number, valuePaisePerToken: number): number {
  return num(ceilDiv(nat(ratePaise) * MICRO_N, posValue(valuePaisePerToken)));
}

/** "24.39". Rounds half up at the requested decimals; the full micro precision is kept by callers, this is display only. */
export function formatTokens(micro: number, decimals = 2): string {
  const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const neg = micro < 0;
  const m = BigInt(Math.trunc(Math.abs(micro)));
  const unit = 10n ** BigInt(6 - d); // micro per displayed step
  const steps = (m + unit / 2n) / unit; // half up
  const scale = 10n ** BigInt(d);
  const whole = steps / scale;
  const frac = steps % scale;
  const body = d === 0 ? `${whole}` : `${whole}.${frac.toString().padStart(d, "0")}`;
  return neg && steps > 0n ? `-${body}` : body;
}

/** "4 min 6 s", "1 min", "45 s", "0 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.trunc(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} s`;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

// ── core money ──────────────────────────────────────────────────────────────

// ── [HF-STD-PLAN-1] tariffs: a flat host rate (old) or the Standard plan's progressive tiers ─────────────────

/** One price band: from `fromSec` connected seconds (inclusive) onward, `paisePerMin` until the next band starts. */
export interface TariffTier { fromSec: number; paisePerMin: number }
/** Bands sorted by fromSec, the first starting at 0. A flat rate is one band. */
export interface Tariff { tiers: TariffTier[] }
/** Either a flat rate in paise per minute (old host-priced calls) or a tariff. */
export type Price = number | Tariff;

export const flatTariff = (ratePaise: number): Tariff => ({ tiers: [{ fromSec: 0, paisePerMin: Math.max(0, Math.trunc(ratePaise)) }] });
export const asTariff = (p: Price): Tariff => (typeof p === "number" ? flatTariff(p) : p);

/** A usable tariff: starts at 0, strictly increasing band starts, non-negative integer prices, at least one band above 0. */
export function validTariff(t: Tariff | null | undefined): t is Tariff {
  if (!t || !Array.isArray(t.tiers) || t.tiers.length === 0 || t.tiers.length > 10) return false;
  let prev = -1;
  for (const b of t.tiers) {
    if (!Number.isInteger(b.fromSec) || !Number.isInteger(b.paisePerMin) || b.paisePerMin < 0 || b.paisePerMin > 100_000) return false;
    if (prev === -1 ? b.fromSec !== 0 : b.fromSec <= prev) return false;
    prev = b.fromSec;
  }
  return t.tiers.some((b) => b.paisePerMin > 0);
}
export const priceValid = (p: Price): boolean => validTariff(asTariff(p));

/**
 * Exact charge before rounding, in SIXTIETHS of a paisa (an integer): sum over bands of paisePerMin x seconds spent in that band.
 * Only time AFTER a band starts is priced at that band; earlier seconds keep their own price (no repricing).
 */
export function chargeSixtieths(p: Price, seconds: number): bigint {
  const tiers = asTariff(p).tiers;
  const s = nat(seconds);
  let total = 0n;
  for (let i = 0; i < tiers.length; i++) {
    const from = BigInt(tiers[i].fromSec);
    if (s <= from) break;
    const to = i + 1 < tiers.length ? BigInt(tiers[i + 1].fromSec) : s;
    const end = s < to ? s : to;
    total += nat(tiers[i].paisePerMin) * (end - from);
  }
  return total;
}

/** Cumulative charge for `seconds` of connected time, rounded ONCE, half up, to whole paise. Never rounded second by second. */
export function chargePaise(p: Price, seconds: number): number {
  return num(roundHalfUpDiv(chargeSixtieths(p, seconds), 60n));
}

/** The price per minute that applies at a given connected second (what the caller is paying "now"). */
export function rateAtSecond(p: Price, second: number): number {
  const tiers = asTariff(p).tiers;
  let r = tiers[0]?.paisePerMin ?? 0;
  for (const b of tiers) if (Math.trunc(second) >= b.fromSec) r = b.paisePerMin;
  return r;
}

/** V = round(R * s / 60) for a flat rate, or the tiered cumulative charge; half up, in paise. Same whichever lots pay for it. */
export function consumedValuePaise(ratePaise: Price, billableSeconds: number): number {
  return chargePaise(ratePaise, billableSeconds);
}

export interface CallSplit { valuePaise: number; callCostPaise: number; hostPaise: number; platformPaise: number }

/** V = C + H + P always. C prorated and capped at V; H floored (host never overpaid); P takes the odd paisa. */
export function callSplit(a: { ratePaise: number; billableSeconds: number; callCostPaisePerMin?: number; hostShareBps?: number }): CallSplit {
  const costPerMin = a.callCostPaisePerMin ?? DEFAULT_CALL_COST_PAISE_PER_MIN;
  const bps = Math.max(0, Math.min(10_000, Math.trunc(a.hostShareBps ?? DEFAULT_HOST_SHARE_BPS)));
  const s = nat(a.billableSeconds);
  const V = roundHalfUpDiv(nat(a.ratePaise) * s, 60n);
  const rawC = roundHalfUpDiv(nat(costPerMin) * s, 60n);
  const C = rawC < V ? rawC : V;
  const H = ((V - C) * BigInt(bps)) / 10_000n;
  const P = V - C - H;
  return { valuePaise: num(V), callCostPaise: num(C), hostPaise: num(H), platformPaise: num(P) };
}

/** Tokens needed from a lot worth v paise/token to cover x paise: ceil(x * 1e6 / v). The defined rounding boundary. */
export function microForValue(valuePaise: number, valuePaisePerToken: number): number {
  return num(ceilDiv(nat(valuePaise) * MICRO_N, posValue(valuePaisePerToken)));
}

/** Live metering total from the START of the call (never tick-by-tick, so no drift): floor(R * s * 1e6 / (60 * v)). Flat rate only. */
export function cumulativeMicro(ratePaise: number, seconds: number, valuePaisePerToken: number): number {
  return num((nat(ratePaise) * nat(seconds) * MICRO_N) / (60n * posValue(valuePaisePerToken)));
}

// ── lots ────────────────────────────────────────────────────────────────────

/** One purchase / test grant, ordered oldest first by the caller. */
export interface Lot { id: string; valuePaisePerToken: number; leftMicro: number }
export interface LotUse { lotId: string; micro: number; valuePaise: number }
export interface SpendPlan {
  uses: LotUse[];
  totalValuePaise: number;
  totalMicro: number;
  /** Whole seconds the lots can pay for (<= the requested billable seconds). */
  secondsCovered: number;
  /** True when the lots could not pay for every requested second. */
  shortfall: boolean;
}

/** Most paise a lot can absorb: floor(left * v / 1e6). */
function lotCapPaise(l: Lot): bigint {
  return (nat(l.leftMicro) * posValue(l.valuePaisePerToken)) / MICRO_N;
}

/**
 * Walk lots oldest first for the value of `valuePaise`. A lot that cannot cover the rest is drained completely and absorbs its
 * floor(left*v/1e6) paise; the remainder converts at the next lot's own value. The lot that finishes the job gives ceil(x*1e6/v).
 * Sum of per-lot valuePaise === valuePaise exactly (when feasible).
 */
function walk(lots: Lot[], valuePaise: bigint): { uses: LotUse[]; ok: boolean } {
  const uses: LotUse[] = [];
  let x = valuePaise;
  for (const l of lots) {
    if (x <= 0n) break;
    const cap = lotCapPaise(l);
    if (cap <= 0n) continue;
    if (x <= cap) {
      uses.push({ lotId: l.id, micro: num(ceilDiv(x * MICRO_N, posValue(l.valuePaisePerToken))), valuePaise: num(x) });
      x = 0n;
    } else {
      uses.push({ lotId: l.id, micro: Math.trunc(l.leftMicro), valuePaise: num(cap) });
      x -= cap;
    }
  }
  return { uses, ok: x === 0n };
}

/**
 * What a call of `billableSeconds` takes from the lots. If the lots run out, billing stops at the last WHOLE second they can pay
 * for (secondsCovered), never a partial second.
 */
export function planSpend(lots: Lot[], ratePaise: Price, billableSeconds: number): SpendPlan {
  const want = Math.trunc(Math.max(0, billableSeconds));
  let totalCap = 0n;
  for (const l of lots) totalCap += lotCapPaise(l);
  let covered = want;
  if (consumedValuePaise(ratePaise, want) > num(totalCap)) {
    let lo = 0; // V(0) = 0 always fits
    let hi = want; // V(want) does not fit
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (BigInt(consumedValuePaise(ratePaise, mid)) <= totalCap) lo = mid; else hi = mid;
    }
    covered = lo;
  }
  const value = BigInt(consumedValuePaise(ratePaise, covered));
  const { uses } = walk(lots, value);
  return {
    uses,
    totalValuePaise: num(value),
    totalMicro: uses.reduce((a, u) => a + u.micro, 0),
    secondsCovered: covered,
    shortfall: covered < want,
  };
}

/**
 * [HF-WIRE-13] A FIXED charge (rulebook HF-REEL-35 rule 3: a joined call that breaks inside the first minute costs exactly Rs 1, however long it
 * ran). Same lot walk as planSpend, but the value is given, not derived from the seconds. If the lots hold less than the fixed value the plan
 * takes what they hold and reports a shortfall. `billableSeconds` is only recorded (secondsCovered), it does not change the value.
 */
export function planFixedSpend(lots: Lot[], fixedValuePaise: number, billableSeconds: number): SpendPlan {
  const want = BigInt(Math.max(0, Math.trunc(fixedValuePaise)));
  let totalCap = 0n;
  for (const l of lots) totalCap += lotCapPaise(l);
  const value = want <= totalCap ? want : totalCap;
  const { uses } = walk(lots, value);
  return {
    uses,
    totalValuePaise: num(value),
    totalMicro: uses.reduce((a, u) => a + u.micro, 0),
    secondsCovered: Math.trunc(Math.max(0, billableSeconds)),
    shortfall: value < want,
  };
}

/** Whole seconds the lots can pay for at this rate, capped (60 min by default). */
export function affordableSeconds(lots: Lot[], ratePaise: Price, capSeconds = MAX_CALL_SECONDS): number {
  return planSpend(lots, ratePaise, capSeconds).secondsCovered;
}

/** Whole seconds the wallet can afford with no product time cap. Operational call ceilings must be applied separately. */
export function walletAffordableSeconds(lots: Lot[], ratePaise: Price): number {
  if (!lots.length || !priceValid(ratePaise)) return 0;
  let cap = 1;
  // Positive approved tariffs eventually exceed every finite D1 wallet. Doubling keeps this independent of the 24-hour call safety ceiling.
  while (cap < Number.MAX_SAFE_INTEGER / 2 && planSpend(lots, ratePaise, cap).secondsCovered === cap) cap *= 2;
  return planSpend(lots, ratePaise, Math.trunc(cap)).secondsCovered;
}

/** Start rule: the balance must cover `reserveMinutes` (default 2) whole minutes. */
export function canStart(lots: Lot[], ratePaise: Price, reserveMinutes = START_RESERVE_MINUTES): boolean {
  const need = Math.trunc(reserveMinutes * 60);
  return affordableSeconds(lots, ratePaise, need) >= need;
}

// ── pricing versions ────────────────────────────────────────────────────────

export type CheckoutProviderId = "google_play" | "paytm" | "razorpay" | "cashfree";
export type TaxMode = "none_unregistered";
export interface PricingVersion {
  id: string;
  provider: CheckoutProviderId;
  /** What the buyer pays per token, paise. */
  purchasePaisePerToken: number;
  /** What a token is worth in call time, paise. */
  redemptionPaisePerToken: number;
  /** Assumed provider fee, bps. Recorded for reconciliation only; never taken off again in the split. */
  providerFeeBps: number;
  taxMode: TaxMode;
}

/** Retired 2026-10-10 (packs were Rs 100 for 100 tokens, 1 token = Rs 0.82). Kept so old lots keep their own value and refunds still work. */
export const PRICING_GP_V1: PricingVersion = {
  id: "gp-v1", provider: "google_play", purchasePaisePerToken: 100, redemptionPaisePerToken: 82, providerFeeBps: 1500, taxMode: "none_unregistered",
};

/**
 * ACTIVE Google Play pricing [HF-WALLET-RUPEES]: no tokens for the user. The wallet holds rupees: 1 internal unit = Rs 1 of call value (value 100 paise).
 * Rs 120 pack -> Rs 102 in the wallet (102 units). purchasePaisePerToken (118 = about 120/102) is an APPROXIMATE fallback only, used when Play
 * reports no INR price; the real paid_paise always comes from Play's own price.
 */
export const PRICING_GP_R1: PricingVersion = {
  id: "gp-r1", provider: "google_play", purchasePaisePerToken: 118, redemptionPaisePerToken: 100, providerFeeBps: 1500, taxMode: "none_unregistered",
};

/** FUTURE example (tests only, wired nowhere): a Paytm version where a token is worth the full Re 1. */
export const PRICING_PT_V1_EXAMPLE: PricingVersion = {
  id: "pt-v1", provider: "paytm", purchasePaisePerToken: 100, redemptionPaisePerToken: 100, providerFeeBps: 0, taxMode: "none_unregistered",
};

// ── refunds (Google refund / revoke of a purchase lot) ──────────────────────

export interface RefundLot { grantedMicro: number; leftMicro: number; reservedMicro: number; valuePaisePerToken: number }
export interface RefundPlan {
  /** Unspent micro-tokens removed from the lot (tokens_left; any reservation is a part of it). */
  removeMicro: number;
  /** Reservation released with it (reserved is held inside left). */
  releaseReservedMicro: number;
  /** Spent micro-tokens: the buyer owes these. */
  debtMicro: number;
  /** Debt in rupee value at the lot's own value, rounded half up. */
  debtValuePaise: number;
}

/** reservedMicro is treated as a SUBSET of leftMicro (available = left - reserved). Host earnings are never touched by a refund. */
export function applyRefund(lot: RefundLot): RefundPlan {
  const granted = BigInt(Math.max(0, Math.trunc(lot.grantedMicro)));
  const leftRaw = BigInt(Math.max(0, Math.trunc(lot.leftMicro)));
  const left = leftRaw > granted ? granted : leftRaw;
  const reservedRaw = BigInt(Math.max(0, Math.trunc(lot.reservedMicro)));
  const reserved = reservedRaw > left ? left : reservedRaw;
  const debtMicro = granted - left;
  const debtValue = roundHalfUpDiv(debtMicro * posValue(lot.valuePaisePerToken), MICRO_N);
  return { removeMicro: num(left), releaseReservedMicro: num(reserved), debtMicro: num(debtMicro), debtValuePaise: num(debtValue) };
}

// ── [HF-STD-PLAN-1] Standard plan: rupee wallet in paise, progressive tiers, host per-minute pay ───────────────────────────

/**
 * Wallet lots created from 2026-10-11 hold RUPEES: value 100 paise per unit, so 1 paisa = 10_000 micro units exactly. Every posting
 * on such a lot (credit, reserve, spend, refund) is a whole number of paise because microForValue(x, 100) = x * 10_000.
 */
export const RUPEE_LOT_VALUE_PAISE = 100;
export const MICRO_PER_PAISA = MICRO / RUPEE_LOT_VALUE_PAISE; // 10_000
export const paiseToMicro = (paise: number): number => Math.max(0, Math.trunc(paise)) * MICRO_PER_PAISA;
/** Paise held by a micro amount on a rupee lot (floor: a fraction of a paisa is never spendable). */
export const microToPaise = (micro: number): number => Math.floor(Math.max(0, Math.trunc(micro)) / MICRO_PER_PAISA);

/** Pricing version for wallet credits made under the Standard plan (Google Play, GST-inclusive packs). */
export const PRICING_GP_R2: PricingVersion = {
  id: "gp-r2", provider: "google_play", purchasePaisePerToken: 100, redemptionPaisePerToken: RUPEE_LOT_VALUE_PAISE, providerFeeBps: 1500, taxMode: "none_unregistered",
};

/** [HF-CASHFREE-TOPUP-1] Rupee wallet credits bought on the website through Cashfree (any amount, GST-inclusive, credit = paid / 1.18).
 *  providerFeeBps is 0 here on purpose: the gateway fee is paid by the platform, it never reduces the buyer's credit. */
export const PRICING_CF_R1: PricingVersion = {
  id: "cf-r1", provider: "cashfree", purchasePaisePerToken: 100, redemptionPaisePerToken: RUPEE_LOT_VALUE_PAISE, providerFeeBps: 0, taxMode: "none_unregistered",
};

/**
 * Top-up with GST INCLUDED in the price: wallet = paid / (1 + gst), rounded half up to the paisa; GST = paid - wallet.
 * Rs 120.00 -> Rs 101.69 + GST Rs 18.31; Rs 118.00 -> Rs 100.00 + GST Rs 18.00. With gstInclusive=false nothing is deducted.
 */
export function topupSplit(paidPaise: number, gstBps: number, gstInclusive = true): { walletPaise: number; gstPaise: number } {
  const paid = nat(paidPaise);
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(Number.isFinite(gstBps) ? gstBps : 0))));
  if (!gstInclusive || bps === 0n) return { walletPaise: num(paid), gstPaise: 0 };
  const wallet = roundHalfUpDiv(paid * 10_000n, 10_000n + bps);
  return { walletPaise: num(wallet), gstPaise: num(paid - wallet) };
}

/** [HF-WIRE-6] Website/app Cashfree top-up (owner): wallet = FLOOR(paid / 1.18) to the paisa, GST = the rest. Rs 500 -> Rs 423.72 + GST Rs 76.28.
 *  Google Play packs keep topupSplit (half up) because their tested figures are fixed. */
export function topupSplitFloor(paidPaise: number, gstBps: number, gstInclusive = true): { walletPaise: number; gstPaise: number } {
  const paid = nat(paidPaise);
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(Number.isFinite(gstBps) ? gstBps : 0))));
  if (!gstInclusive || bps === 0n) return { walletPaise: num(paid), gstPaise: 0 };
  const wallet = (paid * 10_000n) / (10_000n + bps);
  return { walletPaise: num(wallet), gstPaise: num(paid - wallet) };
}

export interface StdPlanConfig {
  /** Paise per minute for each band. */ tier1PaisePerMin: number; tier2PaisePerMin: number; tier3PaisePerMin: number;
  /** Band ends in minutes of connected time. */ tier1EndMin: number; tier2EndMin: number;
  hostPaisePerMin: number; phoneCostPaisePerMin: number;
}
export const STD_PLAN_DEFAULTS: StdPlanConfig = {
  tier1PaisePerMin: 399, tier2PaisePerMin: 350, tier3PaisePerMin: 325, tier1EndMin: 30, tier2EndMin: 60, hostPaisePerMin: 200, phoneCostPaisePerMin: 100,
};
export const stdTariff = (c: StdPlanConfig = STD_PLAN_DEFAULTS): Tariff => ({
  tiers: [
    { fromSec: 0, paisePerMin: c.tier1PaisePerMin },
    { fromSec: c.tier1EndMin * 60, paisePerMin: c.tier2PaisePerMin },
    { fromSec: c.tier2EndMin * 60, paisePerMin: c.tier3PaisePerMin },
  ],
});

/**
 * Standard has no shorter commercial duration cap: hang-up or wallet exhaustion normally ends the call. This explicit 24-hour operational
 * safety ceiling bounds reservations, the DO alarm and the provider backstop even when a wallet could afford longer.
 */
export const STD_TECH_MAX_SECONDS = 24 * 3600;

export interface StdSplit { valuePaise: number; hostPaise: number; phoneCostPaise: number; platformPaise: number }
/**
 * Standard plan split. V = tiered charge (rounded once). H = host per-minute pay, floored to the paisa (never overpaid).
 * C = ESTIMATED phone cost, half up, capped at V - H. P = the remainder (estimated platform retention, before other costs).
 * V = H + C + P always. 60 min at defaults: V 22470, H 12000, C 6000, P 4470.
 */
export function stdSplit(a: { tariff: Tariff; billableSeconds: number; hostPaisePerMin: number; phoneCostPaisePerMin: number }): StdSplit {
  const s = nat(a.billableSeconds);
  const V = roundHalfUpDiv(chargeSixtieths(a.tariff, a.billableSeconds), 60n);
  const rawH = (nat(a.hostPaisePerMin) * s) / 60n;
  const H = rawH < V ? rawH : V;
  const rawC = roundHalfUpDiv(nat(a.phoneCostPaisePerMin) * s, 60n);
  const C = rawC < V - H ? rawC : V - H;
  return { valuePaise: num(V), hostPaise: num(H), phoneCostPaise: num(C), platformPaise: num(V - H - C) };
}

/** "₹101.69" from paise. Indian digit grouping for thousands ("₹1,016.95"). */
export function formatRupees(paise: number): string {
  const neg = paise < 0;
  const p = Math.abs(Math.trunc(paise));
  const whole = Math.floor(p / 100).toString();
  const frac = (p % 100).toString().padStart(2, "0");
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}₹${grouped}.${frac}`;
}

export interface TierLine { fromMin: number; toMin: number | null; paisePerMin: number; seconds: number; amountPaise: number }
/**
 * Per-band breakdown of a charge for receipts and the call summary. Each line's amount is the difference of the ROUNDED cumulative totals,
 * so the lines always add up exactly to chargePaise(p, seconds). Bands the call never reached are left out.
 */
export function tierBreakdown(p: Price, seconds: number): TierLine[] {
  const tiers = asTariff(p).tiers;
  const s = Math.max(0, Math.trunc(seconds));
  const out: TierLine[] = [];
  let prevRounded = 0;
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i].fromSec;
    if (s <= from) break;
    const to = i + 1 < tiers.length ? tiers[i + 1].fromSec : null;
    const end = to == null ? s : Math.min(s, to);
    const cum = chargePaise(p, end);
    out.push({ fromMin: from / 60, toMin: to == null ? null : to / 60, paisePerMin: tiers[i].paisePerMin, seconds: end - from, amountPaise: cum - prevRounded });
    prevRounded = cum;
  }
  return out;
}
