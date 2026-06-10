// Phase 7 — refund/settlement rules engine (PURE: no env, no I/O — unit-tested
// table-driven in test/refund_rules.test.ts). The executor (money_engine.ts)
// builds a SessionCtx from D1 and applies the returned actions through the
// Phase-2 ledger primitives. Thresholds come from the `refund_rules` table.
//
//  R1 creator no-show 20min            → 100% refund all, cancel event, strike
//  R2 buyer no-show, creator waited    → creator pro-rata (price×wait/duration), rest refunded (1:1)
//  R3 completed (≥50% or host-marked)  → release 80/20
//  R4 buyer cancels ≥24h               → 100% refund
//  R5 buyer cancels <24h               → 50% refund, 50% to creator (fee applies)
//  R6 creator cancels                  → 100% refund + strike
//  R7 platform failure ≥5min downtime  → 100% refund, no fee
//
// A momentary disconnect is NOT an absence: attendance intervals are merged
// when the gap is < BLIP_MS (A3 — both-sides drop never triggers R1/R2).

export const BLIP_MS = 90_000;

export interface RuleCfg { id: string; params: Record<string, number>; enabled: boolean }
export interface AttRow { user_id: string; role: "host" | "attendee"; joined_at: number; left_at: number | null }
export interface OrderRow {
  id: string; buyer_id: string; amount: number; status: string;
  cancelled_by?: "buyer" | "creator" | null; cancelled_at?: number | null;
}
export interface SessionCtx {
  sid: string;
  kind: "live_event" | "consult";
  capacity: number;                    // 1 = 1:1 consult
  startsAt: number;
  endsAt: number;
  hostId: string;
  title: string;
  liveStartedAt?: number | null;       // Stream Live evidence (live events)
  liveEndedAt?: number | null;
  hostMarkedComplete?: boolean;
  infraDowntimeMs?: number;            // R7 evidence (contiguous-gap accumulation)
  orders: OrderRow[];
  attendance: AttRow[];
  now: number;
  rules: RuleCfg[];
}

export type EmailId = "refund_issued" | "no_show_buyer" | "event_cancelled" | "settlement_paid" | "platform_failure";

export type Action =
  | { kind: "refund"; orderId: string; buyerId: string; amount: number; rule: string; reason: string; email: EmailId }
  | { kind: "release"; orderId: string; gross: number; rule: string; email: EmailId | null }
  | { kind: "set_status"; orderId: string; status: string }
  | { kind: "strike"; creatorId: string; rule: string; reason: string }
  | { kind: "cancel_event"; rule: string }
  | { kind: "noop"; rule: string; detail?: string };

export type Phase = "noshow" | "end" | "cancel";

// ---------------------------------------------------------------------------

function cfg(ctx: SessionCtx, id: string): Record<string, number> | null {
  const r = ctx.rules.find((x) => x.id === id);
  return r && r.enabled ? r.params : null;
}

/** Merge a user's attendance rows into intervals, bridging gaps < BLIP_MS. */
export function mergedIntervals(rows: AttRow[], uid: string, now: number): Array<{ s: number; e: number }> {
  const mine = rows
    .filter((r) => r.user_id === uid)
    .map((r) => ({ s: r.joined_at, e: r.left_at ?? now }))
    .sort((a, b) => a.s - b.s);
  const out: Array<{ s: number; e: number }> = [];
  for (const iv of mine) {
    const last = out[out.length - 1];
    if (last && iv.s - last.e < BLIP_MS) last.e = Math.max(last.e, iv.e);
    else out.push({ ...iv });
  }
  return out;
}

function overlapMs(ivs: Array<{ s: number; e: number }>, from: number, to: number): number {
  let sum = 0;
  for (const iv of ivs) sum += Math.max(0, Math.min(iv.e, to) - Math.max(iv.s, from));
  return sum;
}

function joinedWithin(ivs: Array<{ s: number; e: number }>, from: number, to: number): boolean {
  return ivs.some((iv) => iv.s <= to && iv.e >= from);
}

/** Host showed up: live-input connected (live events) or host attendance. */
function hostEvidence(ctx: SessionCtx, windowEnd: number): boolean {
  if (ctx.kind === "live_event" && ctx.liveStartedAt && ctx.liveStartedAt <= windowEnd) return true;
  const ivs = mergedIntervals(ctx.attendance.filter((a) => a.role === "host"), ctx.hostId, ctx.now);
  return joinedWithin(ivs, ctx.startsAt - 15 * 60_000, windowEnd);
}

const durationMin = (ctx: SessionCtx) => Math.max(1, Math.round((ctx.endsAt - ctx.startsAt) / 60_000));

// ---------------------------------------------------------------------------

/**
 * Evaluate the rules for one session at a given phase. Only 'held' orders are
 * acted on — every action is idempotent downstream (op_id per rule+order).
 * `cancel` phase additionally needs the order(s) carrying cancelled_by/at.
 */
export function evaluate(ctx: SessionCtx, phase: Phase): Action[] {
  const held = ctx.orders.filter((o) => o.status === "held");
  if (phase === "cancel") return evalCancel(ctx, held);
  if (phase === "noshow") return evalNoShow(ctx, held);
  return evalEnd(ctx, held);
}

function evalNoShow(ctx: SessionCtx, held: OrderRow[]): Action[] {
  const r1 = cfg(ctx, "R1");
  const waitMs = (r1?.wait_min ?? 20) * 60_000;
  if (ctx.now < ctx.startsAt + waitMs) return [{ kind: "noop", rule: "R1", detail: "window not elapsed" }];

  // R1 — creator never went live / joined within the wait window.
  if (r1 && !hostEvidence(ctx, ctx.startsAt + waitMs)) {
    const out: Action[] = [];
    for (const o of held) {
      out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: o.amount, rule: "R1", reason: "creator no-show — event cancelled, full refund", email: "event_cancelled" });
      out.push({ kind: "set_status", orderId: o.id, status: "refunded_full" });
    }
    out.push({ kind: "cancel_event", rule: "R1" });
    out.push({ kind: "strike", creatorId: ctx.hostId, rule: "R1", reason: "no_show" });
    return out;
  }

  // R2 — 1:1 consult: creator present + waited, buyer never joined.
  const r2 = cfg(ctx, "R2");
  if (r2 && ctx.kind === "consult" && ctx.capacity === 1 && held.length === 1) {
    const o = held[0];
    const wait2 = (r2.wait_min ?? 20) * 60_000;
    if (ctx.now >= ctx.startsAt + wait2) {
      const hostIvs = mergedIntervals(ctx.attendance.filter((a) => a.role === "host"), ctx.hostId, ctx.now);
      const buyerIvs = mergedIntervals(ctx.attendance.filter((a) => a.role === "attendee"), o.buyer_id, ctx.now);
      const hostWaited = overlapMs(hostIvs, ctx.startsAt, ctx.startsAt + wait2) >= wait2 * ((r2.presence_pct ?? 75) / 100);
      const buyerJoined = joinedWithin(buyerIvs, ctx.startsAt - 15 * 60_000, ctx.startsAt + wait2);
      if (hostWaited && !buyerJoined) {
        const prorata = Math.min(o.amount, Math.round(o.amount * (r2.wait_min ?? 20) / durationMin(ctx)));
        const remainder = o.amount - prorata;
        const out: Action[] = [];
        if (prorata > 0) out.push({ kind: "release", orderId: o.id, gross: prorata, rule: "R2", email: "settlement_paid" });
        if (remainder > 0) out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: remainder, rule: "R2", reason: "you never showed up — creator paid for the 20-minute wait, remainder refunded", email: "no_show_buyer" });
        out.push({ kind: "set_status", orderId: o.id, status: remainder > 0 ? "refunded_partial" : "settled" });
        return out;
      }
    }
  }
  return [{ kind: "noop", rule: "noshow", detail: "no no-show condition met" }];
}

function evalEnd(ctx: SessionCtx, held: OrderRow[]): Action[] {
  if (!held.length) return [{ kind: "noop", rule: "end", detail: "no held orders" }];

  // R7 — platform failure: ≥N contiguous minutes of stream downtime.
  const r7 = cfg(ctx, "R7");
  if (r7 && (ctx.infraDowntimeMs ?? 0) >= (r7.downtime_min ?? 5) * 60_000) {
    const out: Action[] = [];
    for (const o of held) {
      out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: o.amount, rule: "R7", reason: "platform failure — full refund, no fee", email: "platform_failure" });
      out.push({ kind: "set_status", orderId: o.id, status: "refunded_full" });
    }
    return out;
  }

  // R3 — completed normally: host marked complete, or actual ≥ min_pct% of scheduled.
  const r3 = cfg(ctx, "R3");
  const scheduledMs = ctx.endsAt - ctx.startsAt;
  let actualMs = 0;
  if (ctx.kind === "live_event") {
    actualMs = ctx.liveStartedAt ? (ctx.liveEndedAt ?? ctx.now) - ctx.liveStartedAt : 0;
  } else {
    const hostIvs = mergedIntervals(ctx.attendance.filter((a) => a.role === "host"), ctx.hostId, ctx.now);
    actualMs = overlapMs(hostIvs, ctx.startsAt - 15 * 60_000, ctx.endsAt + 15 * 60_000);
  }
  const completed = ctx.hostMarkedComplete === true || (r3 ? actualMs >= scheduledMs * ((r3.min_pct ?? 50) / 100) : false);

  if (completed) {
    const out: Action[] = [];
    for (const o of held) {
      out.push({ kind: "release", orderId: o.id, gross: o.amount, rule: "R3", email: "settlement_paid" });
      out.push({ kind: "set_status", orderId: o.id, status: "settled" });
    }
    return out;
  }

  // Fallback — session never (sufficiently) delivered and no specific rule fired:
  // creator-fault full refund (conservative; mirrors R1 wording).
  const out: Action[] = [];
  for (const o of held) {
    out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: o.amount, rule: "FB", reason: "session was not delivered — full refund", email: "refund_issued" });
    out.push({ kind: "set_status", orderId: o.id, status: "refunded_full" });
  }
  return out;
}

function evalCancel(ctx: SessionCtx, held: OrderRow[]): Action[] {
  const out: Action[] = [];
  for (const o of held) {
    if (!o.cancelled_by) continue;
    if (o.cancelled_by === "creator") {
      // R6 — creator cancels: 100% refund + strike.
      if (!cfg(ctx, "R6")) continue;
      out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: o.amount, rule: "R6", reason: "creator cancelled — full refund", email: "refund_issued" });
      out.push({ kind: "set_status", orderId: o.id, status: "cancelled" });
      if (!out.some((a) => a.kind === "strike")) out.push({ kind: "strike", creatorId: ctx.hostId, rule: "R6", reason: "creator_cancel" });
      continue;
    }
    // Buyer cancel: R4 (≥24h) full refund, else R5 split.
    const at = o.cancelled_at ?? ctx.now;
    const r4 = cfg(ctx, "R4");
    const r5 = cfg(ctx, "R5");
    if (r4 && ctx.startsAt - at >= (r4.hours ?? 24) * 3_600_000) {
      out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: o.amount, rule: "R4", reason: "cancelled ≥24h before — full refund", email: "refund_issued" });
      out.push({ kind: "set_status", orderId: o.id, status: "cancelled" });
    } else if (r5) {
      const back = Math.round(o.amount * (r5.refund_pct ?? 50) / 100);
      const toCreator = o.amount - back;
      if (back > 0) out.push({ kind: "refund", orderId: o.id, buyerId: o.buyer_id, amount: back, rule: "R5", reason: "cancelled <24h before — 50% refund", email: "refund_issued" });
      if (toCreator > 0) out.push({ kind: "release", orderId: o.id, gross: toCreator, rule: "R5", email: "settlement_paid" });
      out.push({ kind: "set_status", orderId: o.id, status: "refunded_partial" });
    }
  }
  return out.length ? out : [{ kind: "noop", rule: "cancel", detail: "nothing cancellable" }];
}
