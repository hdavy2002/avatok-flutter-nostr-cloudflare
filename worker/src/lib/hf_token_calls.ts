// [HF-TOK-CALLS-1] Calls on token lots (flag hfTokensEnabled). Spec section 11.4 / 11.5. Everything here is idempotent and testable without the
// call Durable Object: the DO only decides WHEN a call ends; it hands the connected seconds to settleTokenCall and gets the numbers back.
// Maths: hf_token_math.ts. Lots: hf_token_ledger.ts. Host money: hf_host_ledger.ts (paise, hosts never see tokens).
import type { Env } from "../types";
import {
  availableLots, hasOpenDebt, reserveForCall, release, settleCall, getPricingVersion, type SettleLotUse,
} from "./hf_token_ledger";
import { creditCallEarning } from "./hf_host_ledger";
import {
  callSplit, canStart, planSpend, microForValue, tokensPerMinuteMicro, formatTokens, formatDuration, MAX_CALL_SECONDS, START_RESERVE_MINUTES,
  PRICING_GP_V1, type Lot,
} from "./hf_token_math";
import type { HfTokenConfig } from "./hf_token_config";

export const SPLIT_RULE = "split-v1"; // C prorated, H floored, P remainder (hf_token_math.callSplit)
export const DEBT_MESSAGE = "Please clear the amount owed before calling";

const snapshotVersion = (tk: HfTokenConfig) => `${tk.pricingVersion}/${SPLIT_RULE}`;

// ── start ───────────────────────────────────────────────────────────────────

export type StartCheck =
  | { ok: true; maxSeconds: number; limitReason: "balance" | "time_limit"; secondsCovered: number; snapshot: CallSnapshot }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };

/** What is frozen on the hf_calls row at start. A config change later never alters a running call (HF-TOK-D3/D4). */
export interface CallSnapshot { ratePaise: number; callCostPaisePerMin: number; hostShareBps: number; taxMode: string; splitRuleVersion: string }

export function snapshotFor(ratePaise: number, tk: HfTokenConfig): CallSnapshot {
  return { ratePaise, callCostPaisePerMin: tk.callCostPaisePerMin, hostShareBps: tk.hostShareBps, taxMode: "none_unregistered", splitRuleVersion: snapshotVersion(tk) };
}

/** Value (paise per token) a NEW token would have: used to say how many tokens a top-up must add. */
async function activeValue(env: Env, tk: HfTokenConfig): Promise<number> {
  return (await getPricingVersion(env, tk.pricingVersion))?.redemptionPaisePerToken ?? PRICING_GP_V1.redemptionPaisePerToken;
}

/** Tokens short of a 2-minute start, valued at the active pricing version. */
export async function startShortfall(env: Env, tk: HfTokenConfig, lots: Lot[], ratePaise: number): Promise<{ shortfallMicro: number; shortfallPaise: number }> {
  const needPaise = Math.round((ratePaise * START_RESERVE_MINUTES * 60) / 60);
  // What the lots can absorb in rupees (floor per lot, same boundary the lot walk uses), NOT what a short call would take.
  let have = 0n;
  for (const l of lots) have += (BigInt(Math.max(0, Math.trunc(l.leftMicro))) * BigInt(Math.trunc(l.valuePaisePerToken))) / 1_000_000n;
  const shortfallPaise = Math.max(0, needPaise - Number(have));
  return { shortfallPaise, shortfallMicro: shortfallPaise > 0 ? microForValue(shortfallPaise, await activeValue(env, tk)) : 0 };
}

/**
 * Start gate for a token call: open debt blocks, the balance must cover 2 whole minutes (shortfall reported in tokens), then the lots are
 * reserved for up to 60 minutes (or what they can pay for). On refusal nothing stays reserved.
 */
export async function prepareTokenStart(env: Env, a: { uid: string; callId: string; ratePaise: number; tk: HfTokenConfig }): Promise<StartCheck> {
  const { uid, callId, ratePaise, tk } = a;
  if (await hasOpenDebt(env, uid)) return { ok: false, status: 409, error: "debt_open", message: DEBT_MESSAGE, extra: { reason: "debt_open" } };
  const low = async (lots: Lot[]): Promise<StartCheck> => {
    const s = await startShortfall(env, tk, lots, ratePaise);
    return {
      ok: false, status: 402, error: "low_balance",
      message: `You need about ${formatTokens(s.shortfallMicro, 2)} more tokens to start this call.`,
      extra: { shortfallMicro: s.shortfallMicro, shortfallTokens: formatTokens(s.shortfallMicro, 2), shortfallPaise: s.shortfallPaise },
    };
  };
  const lots = await availableLots(env, uid);
  if (!canStart(lots, ratePaise)) return low(lots);
  const r = await reserveForCall(env, uid, callId, ratePaise, MAX_CALL_SECONDS);
  if (!r.ok) {
    if (r.reason === "conflict") return { ok: false, status: 503, error: "wallet_busy", message: "We couldn't check your balance. Please try again." };
    return low(await availableLots(env, uid));
  }
  if (r.secondsCovered < START_RESERVE_MINUTES * 60) {
    await release(env, callId).catch(() => undefined);
    return low(await availableLots(env, uid));
  }
  const maxSeconds = Math.min(MAX_CALL_SECONDS, r.secondsCovered);
  return { ok: true, maxSeconds, secondsCovered: r.secondsCovered, limitReason: maxSeconds >= MAX_CALL_SECONDS ? "time_limit" : "balance", snapshot: snapshotFor(ratePaise, tk) };
}

// ── settle ──────────────────────────────────────────────────────────────────

/** hostPaid = floor(H * paidValue / V): the host's share follows the VALUE that came from purchase lots; the remainder is test earnings. */
export function splitHostByKind(hostPaise: number, valuePaise: number, paidValuePaise: number): { paidPaise: number; testPaise: number } {
  const H = BigInt(Math.max(0, Math.trunc(hostPaise))), V = BigInt(Math.max(0, Math.trunc(valuePaise)));
  if (H === 0n) return { paidPaise: 0, testPaise: 0 };
  if (V === 0n) return { paidPaise: 0, testPaise: Number(H) };
  const p = BigInt(Math.max(0, Math.min(Number(V), Math.trunc(paidValuePaise))));
  const paid = (H * p) / V;
  return { paidPaise: Number(paid), testPaise: Number(H - paid) };
}

export interface TokenSettleInput {
  callId: string; callerUid: string; hostUid: string;
  /** From the hf_calls snapshot, never from live config. */
  ratePaise: number; callCostPaisePerMin: number; hostShareBps: number;
  /** Connected seconds (floored) and the call's own time limit; billable = min of the two, then cut to what the lots can pay for. */
  connectedSeconds: number; maxSeconds: number; endedAt: number;
}
export interface TokenSettleOutput {
  billableSeconds: number; billedMinutes: number; shortfall: boolean;
  consumedValuePaise: number; callCostPaise: number; hostPaise: number; platformPaise: number;
  hostPaidPaise: number; hostTestPaise: number; tokensSpentMicro: number; lots: SettleLotUse[];
}

/**
 * Settle a finished call on lots. Steps are individually idempotent (ledger op ids, host-ledger op ids, one UPDATE of the row), so the DO
 * can simply call it again until it returns. Throws when the ledger cannot settle (conflict) so the DO retries from its alarm.
 */
export async function settleTokenCall(env: Env, i: TokenSettleInput): Promise<TokenSettleOutput> {
  const want = Math.max(0, Math.min(Math.trunc(i.connectedSeconds), Math.trunc(i.maxSeconds)));
  const s = await settleCall(env, i.callerUid, i.callId, i.ratePaise, want);
  let billable = 0, lots: SettleLotUse[] = [], shortfall = false, micro = 0;
  if (s.ok) { billable = s.billableSeconds; lots = s.lots; shortfall = s.shortfall; micro = s.totalMicro; }
  else if (s.reason !== "released") throw new Error(`hf_token settle ${s.reason}`);
  // "released" = the reservation was given back before connect: nothing was consumed.
  const split = callSplit({ ratePaise: i.ratePaise, billableSeconds: billable, callCostPaisePerMin: i.callCostPaisePerMin, hostShareBps: i.hostShareBps });
  // Only purchase-lot value is withdrawable by the host; test and admin-adjustment lots become non-withdrawable test earnings.
  const paidValue = lots.filter((l) => l.kind === "purchase").reduce((t, l) => t + l.valuePaise, 0);
  const hs = splitHostByKind(split.hostPaise, split.valuePaise, paidValue);
  if (hs.paidPaise > 0) await creditCallEarning(env, i.hostUid, i.callId, hs.paidPaise, "call_earning", i.endedAt);
  if (hs.testPaise > 0) await creditCallEarning(env, i.hostUid, i.callId, hs.testPaise, "call_earning_test", i.endedAt);
  const billedMinutes = billable > 0 ? Math.max(1, Math.floor(billable / 60)) : 0;
  const out: TokenSettleOutput = {
    billableSeconds: billable, billedMinutes, shortfall, consumedValuePaise: split.valuePaise, callCostPaise: split.callCostPaise,
    hostPaise: split.hostPaise, platformPaise: split.platformPaise, hostPaidPaise: hs.paidPaise, hostTestPaise: hs.testPaise, tokensSpentMicro: micro, lots,
  };
  // billed_minutes / charged_paise / host_earning_paise stay filled for the screens that still read them (review gate, host dashboard).
  await env.DB_META.prepare(
    `UPDATE hf_calls SET billed_minutes=?1, charged_paise=?2, host_earning_paise=?3, billable_seconds=?4, consumed_value_paise=?5, call_cost_paise=?6,
            platform_paise=?7, tokens_spent_micro=?8, lots_used=?9 WHERE id=?10`,
  ).bind(billedMinutes, split.valuePaise, split.hostPaise, billable, split.valuePaise, split.callCostPaise, split.platformPaise, micro,
    JSON.stringify(lots.map((l) => ({ lotId: l.lotId, kind: l.kind, valuePaisePerToken: l.valuePaisePerToken, micro: l.micro, valuePaise: l.valuePaise }))), i.callId).run();
  await maybeNotifyLowBalance(env, i.callerUid, i.callId, i.ratePaise, billable); // [HF-TOK-EXIT-1]
  return out;
}

/**
 * [HF-TOK-EXIT-1] "Your balance is low" push, ONCE per call: when what the caller can still spend would not start another call with this host
 * (less than 2 minutes at that host's rate). A marker row in the token ledger (op `hftlow:<callId>`) makes a settle retry send nothing twice.
 * notifyLowBalance itself does nothing unless hfPushEnabled is on and the person has a registered device. Never throws, never touches money.
 */
export async function maybeNotifyLowBalance(env: Env, uid: string, callId: string, ratePaise: number, billableSeconds: number): Promise<boolean> {
  try {
    if (!(billableSeconds > 0) || !(ratePaise > 0)) return false;
    if (canStart(await availableLots(env, uid), ratePaise)) return false;
    const r = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       VALUES (?1,?2,'low_balance',NULL,0,0,?3,NULL,?4,NULL,?5)`,
    ).bind(crypto.randomUUID(), uid, callId, `hftlow:${callId}`, Date.now()).run();
    if (Number(r.meta?.changes ?? 0) !== 1) return false;
    const { notifyLowBalance } = await import("./hf_push");
    await notifyLowBalance(env, uid);
    return true;
  } catch (e) {
    console.warn("[hf-tok] low balance notice failed", callId, String(e));
    return false;
  }
}

// ── estimates for the caller ────────────────────────────────────────────────

export interface HostEstimate {
  tokensPerMinute: string; tokensPerMinuteMicro: number; ratePaise: number;
  /** Whole seconds the available lots pay for with this host (capped at 60 min). */
  affordableSeconds: number; aboutText: string; canStart: boolean;
}
/** tokens/min at the value of the lot that will be used first (or the active value with an empty balance), and "about N min M s". */
export function estimateForHost(lots: Lot[], ratePaise: number, fallbackValuePaisePerToken: number): HostEstimate {
  const v = lots[0]?.valuePaisePerToken ?? fallbackValuePaisePerToken;
  const perMin = tokensPerMinuteMicro(ratePaise, v);
  const secs = planSpend(lots, ratePaise, MAX_CALL_SECONDS).secondsCovered;
  return {
    tokensPerMinute: formatTokens(perMin, 2), tokensPerMinuteMicro: perMin, ratePaise, affordableSeconds: secs,
    aboutText: lots.length ? `about ${formatDuration(secs)}` : "add tokens to call", canStart: canStart(lots, ratePaise),
  };
}
export async function activeValuePaise(env: Env, tk: HfTokenConfig): Promise<number> { return activeValue(env, tk); }
