// Call escrow / refund / per-minute settlement engine (WP2, plan §3B / §11 /
// §15.3 of Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// REUSES the existing money infrastructure — does NOT duplicate it:
//   - ledger.ts:  hold() / refund() / escrowBalance() / acctUser() / acctEscrow()
//   - routes/wallet.ts: walletOp() (WalletDO op with op_id dedup + Q_WALLET audit)
//   - do/wallet.ts (WalletDO): per-uid atomic balance, idempotent on op_id
//   - lib/call_events.ts: emitCallEvent / ReasonCode / newTraceId / withSpan
//   - lib/call_snapshot.ts: CallSnapshot (rate/fees frozen at call_created —
//     ALL money math below reads the snapshot, never live config, per §15.3)
//
// The ONLY new money-moving primitive here is `settlePartial` — a per-minute,
// multi-way split (callee net + platform fee + optional service-number line
// fee) that ledger.ts's release() cannot do (release() is hardcoded 80/20).
// settlePartial is built on the EXACT SAME primitives ledger.ts uses internally
// (walletOp for the user-account leg, a Q_WALLET ledger-only message for
// escrow→platform legs — mirroring ledger.ts's private sendLedgerRow) so the
// D1 audit trail and WalletDO truth stay in lock-step exactly like every other
// money path. ledger.ts itself is NOT modified.
//
// IDEMPOTENCY (plan §11 "every hold/settle/refund carries the call_id + minute
// index so a retry can never double-charge or double-refund"):
//   - hold      op_id = `hold:call:<call_id>`            (one hold per call)
//   - agent A   op_id = `hold:agentA:<call_id>`           (one hold per call)
//   - settle    op_id = `settle:call:<call_id>:m<minute>[:callee|:platform|:linefee]`
//               (one settle per delivered minute; each leg of the split gets
//               its own suffixed op_id so a retry can safely re-run the whole
//               minute — every leg is independently a WalletDO/D1 PK no-op)
//   - refund    op_id = `refund:call:<call_id>`           (one refund per call)
// All idempotency is enforced at the AUTHORITY (WalletDO op_id dedup for
// user-account legs; D1 `wallet_ledger` PK=id for ledger-only legs) — never by
// this module trying to remember what it already did.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { walletOp } from "../routes/wallet";
import { hold, refund, escrowBalance, acctUser, acctEscrow, ACCT_PLATFORM_FEES } from "../ledger";
import type { CallSnapshot } from "./call_snapshot";
import { emitCallEvent, EVENT_SCHEMA_VERSION, newTraceId, type CallEvent, type ReasonCode } from "./call_events";

const orderIdFor = (callId: string): string => `call:${callId}`;

export interface CallBillingResult {
  ok: boolean;
  held: number;
  reason?: ReasonCode;
}

/** Shared ctx every billing call needs to stamp events correctly. */
interface EventCtx {
  call_id: string;
  trace_id?: string;
  caller_id: string;
  callee_id: string;
  billing_mode?: "A" | "B";
  call_mode?: CallEvent["call_mode"];
}

async function emit(env: Env, ctx: EventCtx, event: string, reason: ReasonCode | undefined, props: Record<string, unknown>): Promise<void> {
  await emitCallEvent(env, {
    event,
    call_id: ctx.call_id,
    trace_id: ctx.trace_id ?? newTraceId(),
    caller_id: ctx.caller_id,
    callee_id: ctx.callee_id,
    call_mode: ctx.call_mode ?? "business",
    billing_mode: ctx.billing_mode,
    reason,
    ts: Date.now(),
    event_schema_version: EVENT_SCHEMA_VERSION,
    props,
  });
}

// ---------------------------------------------------------------------------
// 1. holdForCall — Mode B (caller-pays). Escrow the FULL chosen-duration cost
//    up front. Nobody connects until this succeeds (plan §3B step 4/5).
// ---------------------------------------------------------------------------
export async function holdForCall(
  env: Env,
  args: { call_id: string; caller_id: string; callee_id: string; snapshot: CallSnapshot; minutes: number; trace_id?: string },
): Promise<CallBillingResult> {
  const ctx: EventCtx = { call_id: args.call_id, trace_id: args.trace_id, caller_id: args.caller_id, callee_id: args.callee_id, billing_mode: "B", call_mode: "paid_human" };
  const cfg = await readConfig(env);
  const rate = args.snapshot.rate;
  if (rate == null || !(rate >= cfg.minServiceRate)) {
    await emit(env, ctx, "escrow_held", "VALIDATION", { rate, min_service_rate: cfg.minServiceRate, ok: false });
    return { ok: false, held: 0, reason: "VALIDATION" };
  }
  const minutes = Math.trunc(args.minutes);
  if (!(minutes > 0)) {
    await emit(env, ctx, "escrow_held", "VALIDATION", { minutes, ok: false });
    return { ok: false, held: 0, reason: "VALIDATION" };
  }
  const total = rate * minutes;
  const orderId = orderIdFor(args.call_id);
  const opId = `hold:${orderId}`;
  const r = await hold(env, args.caller_id, orderId, total, { opId, title: `Paid call ${args.call_id}`, app: "call_billing" });
  if (!r.ok) {
    const reason: ReasonCode = r.status === 402 ? "WALLET_INSUFFICIENT" : "VALIDATION";
    await emit(env, ctx, "escrow_held", reason, { rate, minutes, total, ok: false, status: r.status });
    return { ok: false, held: 0, reason };
  }
  await emit(env, ctx, "escrow_held", undefined, { rate, minutes, total, ok: true, mode: "B" });
  return { ok: true, held: total };
}

// ---------------------------------------------------------------------------
// 3. holdForAgentModeA — Mode A (callee-pays personal receptionist). Hold
//    30 tokens (agentRateAPerMin * agentMaxCallSec/60) from the CALLEE before
//    the agent answers (plan §15.3 "Mode A runs on the §11 escrow engine too").
//    Callee can't cover 1 minute → agent is treated as off → voicemail.
// ---------------------------------------------------------------------------
export async function holdForAgentModeA(
  env: Env,
  args: { call_id: string; caller_id: string; callee_id: string; trace_id?: string },
): Promise<CallBillingResult> {
  const ctx: EventCtx = { call_id: args.call_id, trace_id: args.trace_id, caller_id: args.caller_id, callee_id: args.callee_id, billing_mode: "A", call_mode: "business" };
  const cfg = await readConfig(env);
  const capMinutes = cfg.agentMaxCallSec / 60;
  const total = Math.round(cfg.agentRateAPerMin * capMinutes);
  const orderId = orderIdFor(args.call_id);
  const opId = `hold:agentA:${args.call_id}`;
  // §15.3: at least 1 minute (agentRateAPerMin tokens) must be coverable, else
  // the agent is treated as off. We still attempt the FULL cap hold (30
  // tokens) — a partial-cap wallet fails the hold and falls back to voicemail,
  // exactly like "wallet can't cover 1 minute" would (hold() is all-or-nothing).
  const r = await hold(env, args.callee_id, orderId, total, { opId, title: "Ava AI Agent (Mode A)", app: "call_billing" });
  if (!r.ok) {
    const reason: ReasonCode = r.status === 402 ? "WALLET_INSUFFICIENT" : "VALIDATION";
    await emit(env, ctx, "escrow_held", reason, { agent_rate_a_per_min: cfg.agentRateAPerMin, cap_minutes: capMinutes, total, ok: false, status: r.status });
    return { ok: false, held: 0, reason };
  }
  await emit(env, ctx, "escrow_held", undefined, { agent_rate_a_per_min: cfg.agentRateAPerMin, cap_minutes: capMinutes, total, ok: true, mode: "A" });
  return { ok: true, held: total };
}

// ---------------------------------------------------------------------------
// Additive helper — narrowly scoped, built on the SAME primitives ledger.ts
// uses (walletOp for the user leg, a raw Q_WALLET ledger-only message for a
// pure escrow→platform-bucket leg). Does NOT touch/duplicate ledger.ts's
// exported behaviour. Splits `amount` out of the call's escrow bucket into up
// to three legs: callee net credit + platform fee + service-number line fee.
// Every leg carries its OWN op_id, so a retry of the whole minute is safe —
// each leg is independently idempotent at its authority (WalletDO / D1 PK).
// ---------------------------------------------------------------------------
async function settlePartial(
  env: Env,
  orderId: string,
  baseOpId: string,
  legs: { calleeId?: string; calleeAmount: number; platformAmount: number; lineFeeAmount: number },
  meta: Record<string, unknown>,
): Promise<{ calleeCredited: number; platformFee: number; lineFee: number }> {
  const now = Date.now();
  let calleeCredited = 0;
  if (legs.calleeId && legs.calleeAmount > 0) {
    const r = await walletOp(env, legs.calleeId, {
      op: "credit",
      uid: legs.calleeId,
      amount: legs.calleeAmount,
      type: "minute_settle",
      app_name: "call_billing",
      ref: orderId,
      op_id: `${baseOpId}:callee`,
      ledger: { debit: acctEscrow(orderId), credit: acctUser(legs.calleeId), type: "minute_settle", ref: orderId, meta: JSON.stringify({ ...meta, leg: "callee" }) },
    });
    if (r.status === 200) calleeCredited = legs.calleeAmount;
  }
  // Ledger-only legs (escrow → platform bucket): no user-account side, so no
  // WalletDO op — sent straight to Q_WALLET exactly like ledger.ts's private
  // sendLedgerRow does. Idempotent: the consumer's wallet_ledger insert is
  // `ON CONFLICT(id) DO NOTHING`, keyed on this message's `id`.
  if (legs.platformAmount > 0) {
    await env.Q_WALLET.send({
      id: `${baseOpId}:platform`, ts: now, amount: legs.platformAmount,
      ledger: { debit: acctEscrow(orderId), credit: ACCT_PLATFORM_FEES, type: "minute_settle_platform_fee", ref: orderId, meta: JSON.stringify({ ...meta, leg: "platform" }) },
    });
  }
  if (legs.lineFeeAmount > 0) {
    await env.Q_WALLET.send({
      id: `${baseOpId}:linefee`, ts: now, amount: legs.lineFeeAmount,
      ledger: { debit: acctEscrow(orderId), credit: ACCT_PLATFORM_FEES, type: "minute_settle_line_fee", ref: orderId, meta: JSON.stringify({ ...meta, leg: "linefee" }) },
    });
  }
  return { calleeCredited, platformFee: legs.platformAmount, lineFee: legs.lineFeeAmount };
}

// ---------------------------------------------------------------------------
// 2. settleCallMinute — per delivered minute, settle out of the call's escrow.
//    Mode B: platformFeePerMin → platform, serviceLineFeePerMin → platform
//            (only on a service number), remainder (rate−10 or rate−13) → callee.
//    Mode A: agentRateAPerMin → platform (Grok compute); nothing to the callee
//            (the callee is the one who funded the hold in Mode A).
//    Idempotent on `settle:call:<call_id>:m<minute_index>[:leg]` — a retry
//    NEVER double-settles (every leg is independently a no-op at its authority).
// ---------------------------------------------------------------------------
export async function settleCallMinute(
  env: Env,
  args: {
    call_id: string;
    caller_id: string;
    callee_id: string;
    minute_index: number;
    snapshot: CallSnapshot;
    is_service_number: boolean;
    billing_mode: "A" | "B";
    trace_id?: string;
  },
): Promise<{ ok: boolean; settled: number; callee_net: number; platform_fee: number; line_fee: number; reason?: ReasonCode }> {
  const ctx: EventCtx = { call_id: args.call_id, trace_id: args.trace_id, caller_id: args.caller_id, callee_id: args.callee_id, billing_mode: args.billing_mode, call_mode: args.billing_mode === "A" ? "business" : "paid_human" };
  const orderId = orderIdFor(args.call_id);
  const baseOpId = `settle:call:${args.call_id}:m${args.minute_index}`;
  const avail = await escrowBalance(env, orderId);

  let calleeAmount = 0, platformAmount = 0, lineFeeAmount = 0, wanted = 0;
  if (args.billing_mode === "A") {
    const cfg = await readConfig(env);
    wanted = cfg.agentRateAPerMin;
    platformAmount = Math.min(wanted, Math.max(0, avail));
  } else {
    const rate = args.snapshot.rate ?? 0;
    const platformFee = args.snapshot.platform_fee_per_min;
    const lineFee = args.is_service_number ? args.snapshot.line_fee_per_min : 0;
    wanted = rate;
    const clamped = Math.min(wanted, Math.max(0, avail));
    // Preserve the fee split proportionally if the escrow can't cover a full
    // minute (should not normally happen — the hold covers the whole chosen
    // duration up front — but never over-draw the bucket).
    if (clamped < wanted && wanted > 0) {
      platformAmount = Math.round((platformFee * clamped) / wanted);
      lineFeeAmount = Math.round((lineFee * clamped) / wanted);
      calleeAmount = Math.max(0, clamped - platformAmount - lineFeeAmount);
    } else {
      platformAmount = platformFee;
      lineFeeAmount = lineFee;
      calleeAmount = Math.max(0, rate - platformFee - lineFee);
    }
  }

  if (avail <= 0 || (calleeAmount + platformAmount + lineFeeAmount) <= 0) {
    await emit(env, ctx, "minute_settled", undefined, {
      minute_index: args.minute_index, settled: 0, callee_net: 0, platform_fee: 0, line_fee: 0,
      escrow_balance_before: avail, escrow_balance_after: avail, skipped: true,
    });
    return { ok: true, settled: 0, callee_net: 0, platform_fee: 0, line_fee: 0 };
  }

  const legs = await settlePartial(
    env, orderId, baseOpId,
    { calleeId: args.billing_mode === "B" ? args.callee_id : undefined, calleeAmount, platformAmount, lineFeeAmount },
    { call_id: args.call_id, minute_index: args.minute_index, billing_mode: args.billing_mode },
  );
  const settled = legs.calleeCredited + legs.platformFee + legs.lineFee;
  const balanceAfter = await escrowBalance(env, orderId).catch(() => avail - settled);
  await emit(env, ctx, "minute_settled", undefined, {
    minute_index: args.minute_index, settled, callee_net: legs.calleeCredited, platform_fee: legs.platformFee, line_fee: legs.lineFee,
    escrow_balance_before: avail, escrow_balance_after: balanceAfter, mode: args.billing_mode, is_service_number: args.is_service_number,
  });
  return { ok: true, settled, callee_net: legs.calleeCredited, platform_fee: legs.platformFee, line_fee: legs.lineFee };
}

// ---------------------------------------------------------------------------
// 4. refundUnused — release whatever's left in escrow back to whoever funded
//    the hold (caller in Mode B, callee in Mode A). Full refund matrix (§11):
//    never-connected = 100%; partial minute in progress = never charged in the
//    first place (settleCallMinute only ever settles COMPLETED minutes), so
//    "refund the remainder" here is just "refund whatever's still in escrow".
// ---------------------------------------------------------------------------
export async function refundUnused(
  env: Env,
  args: { call_id: string; caller_id: string; callee_id: string; caller_or_callee_id: string; reason: ReasonCode; billing_mode?: "A" | "B"; trace_id?: string },
): Promise<{ ok: boolean; refunded: number }> {
  const ctx: EventCtx = { call_id: args.call_id, trace_id: args.trace_id, caller_id: args.caller_id, callee_id: args.callee_id, billing_mode: args.billing_mode, call_mode: "business" };
  const orderId = orderIdFor(args.call_id);
  const avail = await escrowBalance(env, orderId);
  if (avail <= 0) {
    await emit(env, ctx, "refund_completed", args.reason, { refunded: 0, escrow_balance: 0 });
    return { ok: true, refunded: 0 };
  }
  const opId = `refund:${orderId}`;
  const r = await refund(env, orderId, args.caller_or_callee_id, avail, { opId, reason: args.reason, title: `Refund — call ${args.call_id}` });
  if (!r.ok) {
    await emit(env, ctx, "refund_completed", "VALIDATION", { refunded: 0, escrow_balance: avail, ok: false, status: r.status });
    return { ok: false, refunded: 0 };
  }
  await emit(env, ctx, "refund_completed", args.reason, { refunded: avail, escrow_balance: 0, refunded_to: args.caller_or_callee_id });
  return { ok: true, refunded: avail };
}
