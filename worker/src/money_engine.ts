// Phase 7 — refund/settlement EXECUTOR. Builds a SessionCtx from D1, runs the
// pure rules engine (rules.ts), applies the actions through the Phase-2 ledger
// primitives (idempotent op_ids), sends Brevo emails + FCM pushes, and writes
// the settlement_log audit.
//
// Invoked from the Q_MONEY queue consumer (this worker consumes its own
// money-settlements queue: max_retries=5 → money-dlq). Producers: the session
// DO's alarms (precise timing) and the minute-cron sweep on avatok-consumers
// (catches missed alarms). All transitions idempotent — a cron re-run or queue
// retry can never double-refund (WalletDO op_id dedupe + settlement_log).
import type { Env } from "./types";
import { metaDb } from "./db/shard";
import { nowMs } from "./clock";
import { evaluate, type Action, type Phase, type RuleCfg, type SessionCtx } from "./rules";
import { refund, release, clerkEmail } from "./ledger";
import { settleTranslation } from "./routes/translate";
import { emailRefundIssued, emailSettlementPaid } from "./cal/emails";
import { notifyUser } from "./notify";
import { track } from "./hooks";
import { settleAffiliate } from "./routes/affiliate";

export interface MoneyMsg {
  type: "evaluate" | "cancel";
  sid: string;                          // listing id (live_event) | booking id (consult)
  kind: "live_event" | "consult";
  phase?: Phase;                        // evaluate: noshow|end
  orderId?: string;                     // cancel: which order
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

export async function loadRules(env: Env): Promise<RuleCfg[]> {
  const rs = await metaDb(env).prepare("SELECT id, params, enabled FROM refund_rules").all();
  return ((rs.results ?? []) as any[]).map((r) => {
    let params: Record<string, number> = {};
    try { params = JSON.parse(String(r.params)); } catch { /* defaults in engine */ }
    return { id: String(r.id), params, enabled: Number(r.enabled) === 1 };
  });
}

async function loadCtx(env: Env, sid: string, kind: "live_event" | "consult"): Promise<SessionCtx | null> {
  const db = metaDb(env);
  const now = await nowMs(env);
  const rules = await loadRules(env);

  if (kind === "consult") {
    const bk = await db.prepare(
      "SELECT b.id, b.creator_id, b.buyer_id, b.listing_id, b.starts_at, b.ends_at, b.host_marked_complete, l.title, l.capacity FROM bookings b LEFT JOIN listings l ON l.id=b.listing_id WHERE b.id=?1",
    ).bind(sid).first<any>();
    if (!bk) return null;
    const orders = await db.prepare(
      "SELECT id, buyer_id, amount, status, cancelled_by, cancelled_at FROM orders WHERE booking_id=?1 OR id=(SELECT order_id FROM bookings WHERE id=?1)",
    ).bind(sid).all();
    const att = await db.prepare(
      "SELECT user_id, role, joined_at, left_at FROM session_attendance WHERE session_id=?1",
    ).bind(sid).all();
    return {
      sid, kind, capacity: Number(bk.capacity ?? 1) || 1,
      startsAt: Number(bk.starts_at), endsAt: Number(bk.ends_at),
      hostId: String(bk.creator_id), title: String(bk.title ?? "Consultation"),
      hostMarkedComplete: Number(bk.host_marked_complete ?? 0) === 1,
      orders: (orders.results ?? []) as any[],
      attendance: (att.results ?? []) as any[],
      now, rules,
    };
  }

  // live_event — sid is the listing id; many orders.
  const l = await db.prepare(
    "SELECT id, creator_id, title, starts_at, duration_min, status FROM listings WHERE id=?1",
  ).bind(sid).first<any>();
  if (!l) return null;
  const ls = await db.prepare(
    "SELECT started_at, ended_at, downtime_ms, last_disconnect_at, state FROM live_sessions WHERE listing_id=?1",
  ).bind(sid).first<any>();
  const orders = await db.prepare(
    "SELECT id, buyer_id, amount, status, cancelled_by, cancelled_at FROM orders WHERE listing_id=?1",
  ).bind(sid).all();
  const att = await db.prepare(
    "SELECT user_id, role, joined_at, left_at FROM session_attendance WHERE session_id=?1",
  ).bind(sid).all();
  const startsAt = Number(l.starts_at);
  // R7: downtime_ms = longest CONTIGUOUS gap; an OPEN gap (creator never came
  // back) counts up to now.
  let downtime = Number(ls?.downtime_ms ?? 0);
  if (ls?.last_disconnect_at && !ls?.ended_at) downtime = Math.max(downtime, now - Number(ls.last_disconnect_at));
  return {
    sid, kind, capacity: 0,
    startsAt, endsAt: startsAt + Number(l.duration_min ?? 60) * 60_000,
    hostId: String(l.creator_id), title: String(l.title),
    liveStartedAt: ls?.started_at != null ? Number(ls.started_at) : null,
    liveEndedAt: ls?.ended_at != null ? Number(ls.ended_at) : null,
    hostMarkedComplete: ls?.state === "ended" || l.status === "completed",
    infraDowntimeMs: downtime,
    orders: (orders.results ?? []) as any[],
    attendance: (att.results ?? []) as any[],
    now, rules,
  };
}

// ---------------------------------------------------------------------------
// Action application
// ---------------------------------------------------------------------------

async function logRow(env: Env, id: string, sid: string, orderId: string | null, rule: string, action: string, amount: number | null): Promise<boolean> {
  const r = await metaDb(env).prepare(
    "INSERT INTO settlement_log (id, session_id, order_id, rule, action, amount, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO NOTHING",
  ).bind(id, sid, orderId, rule, action, amount, Date.now()).run();
  return (r.meta?.changes ?? 0) > 0; // false ⇒ already applied (idempotent skip)
}

async function applyAction(env: Env, ctx: SessionCtx, a: Action): Promise<void> {
  const db = metaDb(env);
  switch (a.kind) {
    case "refund": {
      // Money first (WalletDO op_id dedupe makes the op itself idempotent),
      // THEN the log row — so a crash between the two retries safely, and the
      // log row's freshness gates the one-time side effects (emails/push).
      const r = await refund(env, a.orderId, a.buyerId, a.amount, { opId: `refund:${a.orderId}:${a.rule}`, reason: a.reason, title: ctx.title });
      if (!r.ok && r.status !== 409) throw new Error(`refund failed ${a.orderId}: ${JSON.stringify(r.body)}`);
      const fresh = await logRow(env, `${ctx.sid}:${a.rule}:refund:${a.orderId}`, ctx.sid, a.orderId, a.rule, "refund", a.amount);
      if (!fresh) return;
      try { await emailRefundIssued(env, a.buyerId, { title: ctx.title, amount: a.amount, reason: a.reason }); } catch { /* best-effort */ }
      if (a.email === "no_show_buyer") {
        // R2 — the buyer also learns WHY only part came back; creator gets the wait pay note via settlement email.
        try { await notifyUser(env, a.buyerId, { type: "wallet", title: "You never showed up", body: `Partial refund issued for ${ctx.title}.`, data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
      } else {
        try { await notifyUser(env, a.buyerId, { type: "wallet", title: "Refund issued", body: `${ctx.title} — ${a.reason}`, data: { deeplink: "/wallet", amount: a.amount } }); } catch { /* best-effort */ }
      }
      track(env, a.buyerId, "refund_issued", "avawallet", { rule: a.rule, amount: a.amount, sid: ctx.sid });
      return;
    }
    case "release": {
      const o = ctx.orders.find((x) => x.id === a.orderId);
      const feeRate = ((o as any)?.fee_pct ?? 20) / 100;
      const r = await release(env, a.orderId, ctx.hostId, { title: ctx.title, app: ctx.kind === "live_event" ? "avalive" : "avaconsult", feeRate, gross: a.gross });
      if (!r.ok && r.status !== 409) throw new Error(`release failed ${a.orderId}: ${JSON.stringify(r.body)}`);
      // AvaAffiliate (§6): allowlisted kinds ONLY — AvaLive ticket/entry + AvaConsult
      // listing orders settle here (gifts use donation(), translation uses
      // settleTranslation — neither ever reaches this branch). Funded from the
      // platform fee; creator share untouched. Idempotent inside; never throws.
      if (r.ok && Number(r.body?.fee) > 0) {
        await settleAffiliate(env, {
          settlementId: `${ctx.sid}:${a.rule}:release:${a.orderId}`, orderId: a.orderId,
          app: ctx.kind === "live_event" ? "avalive" : "avaconsult",
          gross: Number(r.body.gross), platformCut: Number(r.body.fee), creatorId: ctx.hostId,
        });
      }
      const fresh = await logRow(env, `${ctx.sid}:${a.rule}:release:${a.orderId}`, ctx.sid, a.orderId, a.rule, "release", a.gross);
      if (!fresh) return;
      if (r.ok && a.email === "settlement_paid") {
        try { await emailSettlementPaid(env, ctx.hostId, { title: ctx.title, gross: r.body.gross, fee: r.body.fee, net: r.body.net }); } catch { /* best-effort */ }
        try { await notifyUser(env, ctx.hostId, { type: "wallet", title: `Earned ${r.body.net} Tokens`, body: `${ctx.title} settled (80/20). Available after the 7-day hold.`, data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
      }
      track(env, ctx.hostId, "escrow_settled", ctx.kind === "live_event" ? "avalive" : "avaconsult", { rule: a.rule, gross: a.gross, sid: ctx.sid });
      return;
    }
    case "set_status": {
      await db.prepare("UPDATE orders SET status=?2, updated_at=?3 WHERE id=?1 AND status IN ('held')").bind(a.orderId, a.status, Date.now()).run();
      const bkStatus = a.status === "settled" ? "completed" : (a.status === "cancelled" ? "cancelled_user" : "refunded");
      await db.prepare("UPDATE bookings SET status=?2, updated_at=?3 WHERE order_id=?1 AND status IN ('confirmed')").bind(a.orderId, bkStatus, Date.now()).run();
      return;
    }
    case "strike": {
      const fresh = await logRow(env, `${ctx.sid}:${a.rule}:strike`, ctx.sid, null, a.rule, "strike", null);
      if (!fresh) return;
      try {
        await db.prepare(
          "INSERT INTO account_strikes (id, uid, clerk_user_id, category, evidence_url, ai_confidence, source, action_taken, created_at) VALUES (?1,?2,?2,?3,?4,NULL,'refund_engine','strike',?5)",
        ).bind(crypto.randomUUID(), a.creatorId, `marketplace_${a.reason}`, ctx.sid, Date.now()).run();
      } catch (e) { console.warn("strike write skipped:", String(e)); }
      try { await notifyUser(env, a.creatorId, { type: "system", title: "Strike recorded", body: a.reason === "no_show" ? "You didn't show up for a paid session. Repeated strikes restrict your account." : "You cancelled a paid session.", data: { deeplink: "/verse" } }); } catch { /* best-effort */ }
      return;
    }
    case "cancel_event": {
      await db.batch([
        db.prepare("UPDATE listings SET status='cancelled', updated_at=?2 WHERE id=?1 AND status IN ('published','live')").bind(ctx.sid, Date.now()),
        db.prepare("UPDATE live_sessions SET state='ended', ended_at=COALESCE(ended_at,?2), updated_at=?2 WHERE listing_id=?1").bind(ctx.sid, Date.now()),
        db.prepare("UPDATE bookings SET status='cancelled_creator', updated_at=?2 WHERE (id=?1 OR listing_id=?1) AND status='confirmed'").bind(ctx.sid, Date.now()),
      ]);
      // "email both sides": refund emails already went to buyers; tell the creator.
      try {
        const email = await clerkEmail(env, ctx.hostId);
        if (email) await env.Q_EMAIL.send({ to: email, subject: `Event cancelled: ${ctx.title}`, html: `<p>Your session <b>${ctx.title}</b> was cancelled by the no-show rule (you never went live within the wait window). All buyers were refunded in full and a strike was recorded.</p>` });
      } catch { /* best-effort */ }
      return;
    }
    case "noop": return;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run one money job. Throws on real failure → queue retry → DLQ after 5. */
export async function runMoney(env: Env, msg: MoneyMsg): Promise<{ applied: number; actions: Action[] }> {
  const ctx = await loadCtx(env, msg.sid, msg.kind);
  if (!ctx) return { applied: 0, actions: [] };
  const phase: Phase = msg.type === "cancel" ? "cancel" : (msg.phase ?? "end");

  // Phase markers stop the sweep re-enqueueing decided sessions. A premature
  // noshow evaluation ("window not elapsed") must NOT mark — the alarm/sweep
  // will come back.
  const actions = evaluate(ctx, phase);
  const premature = actions.length === 1 && actions[0].kind === "noop" && (actions[0] as any).detail === "window not elapsed";
  let applied = 0;
  for (const a of actions) {
    await applyAction(env, ctx, a);
    if (a.kind !== "noop") applied++;
  }
  if (!premature && phase !== "cancel") {
    await logRow(env, `${msg.sid}:${phase}`, msg.sid, null, phase, "marker", null);
  }
  // Voice-translation prepay settles whenever the booking money is decided:
  // consumed minutes → platform:fees (100%, never the creator), unused minutes
  // refund to the buyer. Idempotent inside (settlement_log row per trl order).
  if (!premature && (phase === "end" || phase === "cancel")) {
    try { await settleTranslation(env, msg.sid, msg.kind); } catch (e) { console.error("translation settle failed:", String(e)); }
  }
  if (phase === "end" && msg.kind === "live_event") {
    await metaDb(env).prepare("UPDATE live_sessions SET state='settled', updated_at=?2 WHERE listing_id=?1 AND state IN ('ended','live')").bind(msg.sid, Date.now()).run();
    await metaDb(env).prepare("UPDATE listings SET status='completed', updated_at=?2 WHERE id=?1 AND status='live'").bind(msg.sid, Date.now()).run();
  }
  return { applied, actions };
}

/** DLQ consumer body — alert email + failed_settlements row for manual retry. */
export async function moneyDlq(env: Env, body: unknown, error?: string): Promise<void> {
  const id = crypto.randomUUID();
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO failed_settlements (id, payload, error, created_at, status) VALUES (?1,?2,?3,?4,'failed')",
    ).bind(id, JSON.stringify(body ?? {}), error ?? null, Date.now()).run();
  } catch (e) { console.error("failed_settlements write failed:", String(e)); }
  try {
    await env.Q_EMAIL.send({
      to: env.ALERT_EMAIL || "hdavy2005@gmail.com",
      subject: "[avatok] settlement job dead-lettered",
      html: `<p>A refund/settlement job exhausted its retries and landed in the DLQ.</p>
             <pre>${JSON.stringify(body ?? {}, null, 2)}</pre>
             <p>failed_settlements id: <b>${id}</b> — retry it from the admin money console.</p>`,
    });
  } catch (e) { console.error("DLQ alert email failed:", String(e)); }
}
