// [HF-WIRE-13] Call money rules engine (owner decisions 2026-10-19, rulebook HF-REEL-35 and HF-REEL-36). ONE module so the call settlement,
// the booking no-show handling, the payout flow and the monitor cron all read the same rules and the same numbers.
//
//   Rule 1  A caller needs at least Rs 20 (config hfCallMinBalanceRupees) in the wallet to START a call. Below that = low balance.
//           A BOOKED call starts from the hold taken at booking time, so this gate never blocks it.
//   Rule 2  A call is "made" once Vobiz has dialled both people and joined them (hf_calls.connected_at is set only then).
//           The token path bills per SECOND of joined time (hf_token_math.chargePaise); the old rupee path bills per STARTED minute.
//   Rule 3  A joined call that breaks inside the first 60 s costs exactly hfFirstMinuteDropChargePaise (Rs 1); the rest of the hold goes back.
//   Rule 4  The influencer declines, cancels or does not answer (the call never joins): nothing is charged, the whole reserve is released.
//   Rule 5  A booked call the influencer does not pick up: the whole hold goes back to the wallet.
//   Rule 6  No other refunds for calls that were made.
//   Rule 7  Every refund is a credit to the WALLET, never to the card/UPI (config hfGatewayRefundsEnabled stays false).
//   Rule 8  Anyone can withdraw wallet money to UPI after KYC + UPI check (lib/hf_fan_payout.ts, routes/hf_payouts.ts). Test credits never.
//   Rule 9  lib/hf_money_monitor.ts re-checks recent calls and bookings against rules 1-7.
// Pure helpers first (no I/O, unit tested), then the config reader.
import type { Env } from "../types";
import type { Lot } from "./hf_token_math";
import { readConfig } from "../routes/config";

export const DEFAULT_MIN_BALANCE_RUPEES = 20;
export const DEFAULT_DROP_CHARGE_PAISE = 100;
export const DEFAULT_FAN_PAYOUT_MIN_RUPEES = 0; // [HF-WIRE-18] HF-REEL-38: no minimum withdrawal
/** A joined call shorter than this many whole seconds is a "first minute" break (rule 3). Exactly 60 s is billed normally. */
export const FIRST_MINUTE_SECONDS = 60;
/** Stored on hf_calls.money_rule when rule 3 set the charge. */
export const RULE_FIRST_MINUTE_DROP = "first_minute_drop";

export interface MoneyRules {
  minBalancePaise: number;
  dropChargePaise: number;
  fanPayoutMinRupees: number;
  gatewayRefundsEnabled: boolean;
  monitorEnabled: boolean;
  monitorAutoFix: boolean;
}

const wholeNonNeg = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

export function moneyRulesFrom(c: Record<string, unknown> | null | undefined): MoneyRules {
  const x = c ?? {};
  return {
    minBalancePaise: wholeNonNeg(x.hfCallMinBalanceRupees, DEFAULT_MIN_BALANCE_RUPEES) * 100,
    dropChargePaise: wholeNonNeg(x.hfFirstMinuteDropChargePaise, DEFAULT_DROP_CHARGE_PAISE),
    fanPayoutMinRupees: wholeNonNeg(x.hfFanPayoutMinRupees, DEFAULT_FAN_PAYOUT_MIN_RUPEES),
    gatewayRefundsEnabled: x.hfGatewayRefundsEnabled === true,
    monitorEnabled: x.hfMoneyMonitorEnabled !== false,
    monitorAutoFix: x.hfMoneyMonitorAutoFix !== false,
  };
}

/** Never throws: a config read failure answers with the owner's defaults. */
export async function readMoneyRules(env: Env): Promise<MoneyRules> {
  try { return moneyRulesFrom((await readConfig(env)) as unknown as Record<string, unknown>); }
  catch { return moneyRulesFrom({}); }
}

const rupeesText = (paise: number): string => {
  const r = Math.max(0, Math.trunc(paise)) / 100;
  return Number.isInteger(r) ? `₹${r}` : `₹${r.toFixed(2)}`;
};

/** The owner's low-balance wording (rule 1). The app shows the server's number, never its own. */
export function lowBalanceMessage(minBalancePaise: number): string {
  return `You need at least ${rupeesText(minBalancePaise)} in your wallet to call. Top up to keep going.`;
}

/** The owner's first-minute wording (rule 3), with the real charge. */
export function firstMinuteMessage(chargePaise: number): string {
  return `Call ended in the first minute. We charged ${rupeesText(chargePaise)} and returned the rest to your wallet.`;
}

/** Paise the caller can spend right now: what the available lots can absorb (floor per lot, the same boundary the lot walk uses). */
export function walletSpendablePaise(lots: Lot[]): number {
  let total = 0n;
  for (const l of lots) {
    const left = BigInt(Math.max(0, Math.trunc(l.leftMicro)));
    const v = BigInt(Math.max(0, Math.trunc(l.valuePaisePerToken)));
    total += (left * v) / 1_000_000n;
  }
  return Number(total);
}

/** Rule 1. */
export function meetsMinBalance(spendablePaise: number, minBalancePaise: number): boolean {
  return Math.max(0, Math.trunc(spendablePaise)) >= Math.max(0, Math.trunc(minBalancePaise));
}

export interface FirstMinuteDrop { applies: boolean; chargePaise: number }
/** Rule 3. `joined` = both people were put in the room (connected_at set). Not joined = rule 4 (no charge), never this. */
export function firstMinuteDrop(i: { joined: boolean; connectedSeconds: number; dropChargePaise: number }): FirstMinuteDrop {
  const charge = Math.max(0, Math.trunc(i.dropChargePaise));
  const secs = Math.max(0, Math.floor(i.connectedSeconds));
  if (!i.joined || charge <= 0 || secs >= FIRST_MINUTE_SECONDS) return { applies: false, chargePaise: 0 };
  return { applies: true, chargePaise: charge };
}

// ── what a finished call SHOULD have cost (used by the monitor) ──────────────────────────────────────────────────────────

export interface CallFacts {
  status: string;
  connectedAt: number | null;
  endedAt: number | null;
  /** What the caller was charged, paise (hf_calls.consumed_value_paise, else charged_paise). */
  chargedPaise: number;
  /** The per-second price of the joined time with no first-minute rule, from the frozen snapshot (null = cannot recompute). */
  normalChargePaise: number | null;
  hostEarningPaise: number;
  /** Seconds the call was joined (ended - connected, floored). */
  joinedSeconds: number;
  /** [HF-CALL-MODES-C] Seconds the chunk engine paid for (null = not a chunk-billed call). normalChargePaise is already priced at min(joined, funded). */
  fundedSeconds?: number | null;
  /** Did the money path run at all (settlement wrote its numbers)? A call still in a retry loop is skipped, not judged. */
  settled: boolean;
}

export type CallVerdict =
  | { kind: "ok" }
  /** Safe to put right: send `refundPaise` back to the caller's wallet (one correction per call, idempotent). */
  | { kind: "refund"; rule: string; refundPaise: number; expectedPaise: number; reason: string }
  /** Not safe to change automatically: an admin decides. */
  | { kind: "flag"; rule: string; expectedPaise: number | null; reason: string };

export const RULE_NOT_JOINED_CHARGED = "not_joined_charged";
export const RULE_FIRST_MINUTE_OVERCHARGE = "first_minute_overcharge";
export const RULE_FIRST_MINUTE_UNDERCHARGE = "first_minute_undercharge";
export const RULE_JOINED_CHARGE_MISMATCH = "joined_charge_mismatch";
export const RULE_HOST_PAID_NOT_JOINED = "host_paid_not_joined";

export function judgeCall(f: CallFacts, rules: Pick<MoneyRules, "dropChargePaise">): CallVerdict {
  if (!f.settled) return { kind: "ok" };
  const charged = Math.max(0, Math.trunc(f.chargedPaise));
  const joined = f.connectedAt != null;
  if (!joined) {
    // Rule 4 / 5: never joined = never charged.
    if (charged > 0) return { kind: "refund", rule: RULE_NOT_JOINED_CHARGED, refundPaise: charged, expectedPaise: 0, reason: "Call never joined but money was taken" };
    if (f.hostEarningPaise > 0) return { kind: "flag", rule: RULE_HOST_PAID_NOT_JOINED, expectedPaise: 0, reason: "Influencer earned from a call that never joined" };
    return { kind: "ok" };
  }
  const drop = firstMinuteDrop({ joined, connectedSeconds: f.joinedSeconds, dropChargePaise: rules.dropChargePaise });
  if (drop.applies) {
    if (charged > drop.chargePaise) return { kind: "refund", rule: RULE_FIRST_MINUTE_OVERCHARGE, refundPaise: charged - drop.chargePaise, expectedPaise: drop.chargePaise, reason: "Broke inside the first minute: only the first-minute charge applies" };
    if (charged < drop.chargePaise) return { kind: "flag", rule: RULE_FIRST_MINUTE_UNDERCHARGE, expectedPaise: drop.chargePaise, reason: "Broke inside the first minute but less than the first-minute charge was taken" };
    return { kind: "ok" };
  }
  // Rule 6: a made call keeps its charge. A difference from the frozen price is shown to an admin, never auto-refunded.
  if (f.normalChargePaise != null && charged !== f.normalChargePaise) {
    return { kind: "flag", rule: RULE_JOINED_CHARGE_MISMATCH, expectedPaise: f.normalChargePaise, reason: charged > f.normalChargePaise ? "Charged more than the frozen price" : "Charged less than the frozen price" };
  }
  return { kind: "ok" };
}

// ── payouts (rule 8) ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type PayoutSource = { lotsPaise: number; earningsPaise: number };
/**
 * Where a withdrawal comes from: wallet money first (the person's own top-ups), the rest from influencer earnings (which keep the 7-day
 * hold and are already limited to matured earnings in `earningsReadyPaise`). Whole rupees only. Null = not enough money.
 */
export function splitPayoutSources(amountRupees: number, lotsReadyPaise: number, earningsReadyPaise: number): PayoutSource | null {
  const want = Math.trunc(amountRupees) * 100;
  if (!(want > 0)) return null;
  const lots = Math.max(0, Math.floor(Math.max(0, lotsReadyPaise) / 100) * 100);
  const earn = Math.max(0, Math.floor(Math.max(0, earningsReadyPaise) / 100) * 100);
  if (want > lots + earn) return null;
  const fromLots = Math.min(want, lots);
  return { lotsPaise: fromLots, earningsPaise: want - fromLots };
}

/**
 * The smallest request: money that is only the person's own wallet uses the fan minimum (hfFanPayoutMinRupees, default 0 = no minimum, HF-REEL-38);
 * a request that touches influencer earnings keeps the earnings minimum (hfPayoutMinRupees, default 0 = no minimum, HF-REEL-38).
 */
export function payoutMinimumRupees(src: PayoutSource, fanMinRupees: number, earningsMinRupees: number): number {
  return Math.max(0, src.earningsPaise > 0 ? earningsMinRupees : fanMinRupees);
}
