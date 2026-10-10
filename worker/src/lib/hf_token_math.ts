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

/** Micro-tokens a host's minute costs at a token value, rounded UP to the micro. Rs20 @ Rs0.82 -> 24_390_244 (24.390244 tokens). */
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

/** V = round(R * s / 60), half up, in paise. Same whichever lots pay for it. */
export function consumedValuePaise(ratePaise: number, billableSeconds: number): number {
  return num(roundHalfUpDiv(nat(ratePaise) * nat(billableSeconds), 60n));
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

/** Live metering total from the START of the call (never tick-by-tick, so no drift): floor(R * s * 1e6 / (60 * v)). */
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
export function planSpend(lots: Lot[], ratePaise: number, billableSeconds: number): SpendPlan {
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

/** Whole seconds the lots can pay for at this rate, capped (60 min by default). */
export function affordableSeconds(lots: Lot[], ratePaise: number, capSeconds = MAX_CALL_SECONDS): number {
  return planSpend(lots, ratePaise, capSeconds).secondsCovered;
}

/** Start rule: the balance must cover `reserveMinutes` (default 2) whole minutes. */
export function canStart(lots: Lot[], ratePaise: number, reserveMinutes = START_RESERVE_MINUTES): boolean {
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

export const PRICING_GP_V1: PricingVersion = {
  id: "gp-v1", provider: "google_play", purchasePaisePerToken: 100, redemptionPaisePerToken: 82, providerFeeBps: 1500, taxMode: "none_unregistered",
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
