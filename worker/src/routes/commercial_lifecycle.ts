// Phase 2E commercial money lifecycle.
// Cancellation/refund and consultation reschedule authority deliberately use
// the immutable commercial policy snapshot. Legacy calendar rules are not
// consulted for a commercial order.

import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { metaDb } from "../db/shard";
import { escrowBalance, refund } from "../ledger";
import { commercialEvent } from "../lib/commercial_telemetry";
import { json } from "../util";
import { claimBlock, releaseBlocks } from "../cal/engine";
import { notifyCommercialUsers } from "../lib/commercial_notifications";
import { claimCommercialMoney, completeCommercialMoneyClaim } from "../commercial_money_claim";

type Kind = "live_event" | "consult_1to1";
type Action = "buyer_cancel" | "creator_cancel" | "creator_no_show" | "provider_outage" | "insufficient_delivery_evidence";

type Authority = {
  order_id: string; listing_id: string; booking_id: string | null;
  buyer_id: string; creator_id: string; kind: Kind;
  order_amount: number; order_status: string;
  policy_snapshot_id: string; currency: string;
  cancellation_policy_json: string;
  creator_fee_pct: number; platform_fee_amount: number; creator_amount: number;
  event_starts_at: number | null;
  buyer_entitlement_id: string | null;
  booking_starts_at: number | null; booking_ends_at: number | null; booking_status: string | null;
  session_id: string | null; session_state: string | null; session_settlement_state: string | null;
};

type LifecycleOperation = {
  operation_id: string; operation_type: "cancel" | "reschedule" | "calendar";
  account_id: string; order_id: string; request_sha256: string;
  state: "started" | "completed" | "failed" | "review_pending"; response_json: string | null;
};

function path(req: Request): { kind: Kind; id: string; action: "cancel" | "reschedule" | "calendar" } | null {
  const m = new URL(req.url).pathname.match(
    /^\/api\/commercial\/(live|consult)\/([A-Za-z0-9-]{1,96})\/(cancel|reschedule|calendar)$/,
  );
  if (!m || (m[3] === "reschedule" && m[1] !== "consult")) return null;
  return { kind: m[1] === "live" ? "live_event" : "consult_1to1", id: m[2], action: m[3] as "cancel" | "reschedule" | "calendar" };
}

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function schemaReady(env: Env): Promise<boolean> {
  try {
    await metaDb(env).prepare(
      `SELECT operation_id,operation_type,account_id,order_id,request_sha256,state,response_json
       FROM commercial_lifecycle_operations LIMIT 1`,
    ).first<LifecycleOperation>();
    await metaDb(env).prepare(
      `SELECT refund_receipt_id,order_id,refunded_amount,remaining_amount,settlement_state
       FROM commercial_refund_receipts LIMIT 1`,
    ).first<Record<string, unknown>>();
    await metaDb(env).prepare(
      `SELECT order_id,claim_type,claim_id,state
       FROM commercial_money_claims LIMIT 1`,
    ).first<Record<string, unknown>>();
    return true;
  } catch { return false; }
}

async function loadAuthorities(env: Env, args: { kind: Kind; id: string; uid: string }): Promise<Authority[]> {
  const where = args.kind === "live_event"
    ? "o.kind='live_event' AND o.listing_id=?1 AND o.booking_id IS NULL AND (o.buyer_id=?2 OR o.creator_id=?2)"
    : "o.kind='consult_1to1' AND o.booking_id=?1 AND (o.buyer_id=?2 OR o.creator_id=?2)";
  const rows = await metaDb(env).prepare(
    `SELECT o.id order_id,o.listing_id,o.booking_id,o.buyer_id,o.creator_id,o.kind,
        o.amount order_amount,o.status order_status,
        p.policy_snapshot_id,p.currency,p.cancellation_policy_json,p.creator_fee_pct,
        p.platform_fee_amount,p.creator_amount,l.starts_at event_starts_at,
        (SELECT e.entitlement_id FROM commercial_entitlements e
          WHERE e.order_id=o.id AND e.account_id=o.buyer_id
            AND e.state IN ('reserved','held','active','consumed') LIMIT 1) buyer_entitlement_id,
        b.starts_at booking_starts_at,b.ends_at booking_ends_at,b.status booking_status,
        s.commercial_session_id session_id,s.state session_state,s.settlement_state session_settlement_state
     FROM orders o
     JOIN listings l ON l.id=o.listing_id
     JOIN commercial_policy_snapshots p ON p.order_id=o.id
     LEFT JOIN bookings b ON b.id=o.booking_id
     LEFT JOIN commercial_sessions s ON s.commercial_session_id=(
       SELECT s2.commercial_session_id FROM commercial_sessions s2
        WHERE s2.kind=o.kind AND s2.listing_id=o.listing_id
          AND COALESCE(s2.booking_id,'')=COALESCE(o.booking_id,'')
        ORDER BY s2.session_version DESC,s2.updated_at DESC LIMIT 1
     )
     WHERE ${where}`,
  ).bind(args.id, args.uid).all<Authority>();
  return rows.results ?? [];
}

async function loadOperation(env: Env, operationId: string): Promise<LifecycleOperation | null> {
  return await metaDb(env).prepare(
    `SELECT operation_id,operation_type,account_id,order_id,request_sha256,state,response_json
       FROM commercial_lifecycle_operations WHERE operation_id=?1`,
  ).bind(operationId).first<LifecycleOperation>();
}

async function finishOperation(env: Env, operationId: string, state: LifecycleOperation["state"], response: Record<string, unknown>): Promise<void> {
  await metaDb(env).prepare(
    "UPDATE commercial_lifecycle_operations SET state=?2,response_json=?3,updated_at=?4 WHERE operation_id=?1",
  ).bind(operationId, state, JSON.stringify(response), Date.now()).run();
}

function cancellationDecision(authority: Authority, action: Action, now: number):
  { state: "refund"; reason: string } | { state: "review_pending"; reason: string } {
  const policy = safeJson(authority.cancellation_policy_json);
  if (!policy) return { state: "review_pending", reason: "invalid_policy_snapshot" };
  if (action === "insufficient_delivery_evidence") return { state: "review_pending", reason: "insufficient_delivery_evidence" };

  // Creator cancellation/no-show and provider outage require an explicit
  // snapshot decision. Older commercial snapshots do not contain one, so the
  // safe result is review_pending rather than borrowing legacy rules.
  if (action === "creator_cancel" || action === "creator_no_show" || action === "provider_outage") {
    const pct = Number(policy.creator_cancel_refund_pct ?? policy.provider_failure_refund_pct);
    return pct === 100 ? { state: "refund", reason: action } : { state: "review_pending", reason: `${action}_policy_missing` };
  }

  const startsAt = authority.booking_starts_at ?? authority.event_starts_at ?? null;
  if (startsAt === null) return { state: "review_pending", reason: "schedule_missing" };
  const windowHours = authority.kind === "live_event"
    ? Number(policy.refund_window_hours)
    : Number(policy.cancellation_window_hours);
  if (!Number.isInteger(windowHours) || windowHours < 0) return { state: "review_pending", reason: "cancellation_window_missing" };
  if (now <= startsAt - windowHours * 3_600_000) return { state: "refund", reason: "buyer_cancel_within_policy_window" };
  const latePct = Number(policy.late_cancel_refund_pct);
  return latePct === 100 ? { state: "refund", reason: "late_cancel_policy_full_refund" } : { state: "review_pending", reason: "late_cancel_policy_missing" };
}

async function markReview(env: Env, authority: Authority, operationId: string, reason: string): Promise<Response> {
  if (authority.session_id) {
    await metaDb(env).batch([
      metaDb(env).prepare(
        `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
         WHERE commercial_session_id=?1 AND settlement_state NOT IN ('settled','refunded')`,
      ).bind(authority.session_id, Date.now()),
      metaDb(env).prepare(
        `UPDATE commercial_settlement_jobs SET state='review_pending',last_error=?2,updated_at=?3
         WHERE commercial_session_id=?1 AND state IN ('pending','processing')`,
      ).bind(authority.session_id, reason.slice(0, 500), Date.now()),
    ]);
  }
  const response = { ok: false, state: "review_pending", reason };
  await finishOperation(env, operationId, "review_pending", response);
  commercialEvent(env, "cancellation", null, { kind: authority.kind, outcome: "review_pending", reason });
  return json(response, 202);
}

async function cancelOne(env: Env, authority: Authority, uid: string, idem: string, action: Action): Promise<Response> {
  const requestHash = await sha256(`${uid}:${authority.order_id}:${idem}:${action}`);
  const operationId = `commercial-cancel:${await sha256(`${authority.order_id}:${idem}:${action}`).then((v) => v.slice(0, 48))}`;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_lifecycle_operations
      (operation_id,operation_type,account_id,order_id,request_sha256,state,created_at,updated_at)
     VALUES (?1,'cancel',?2,?3,?4,'started',?5,?5)`,
  ).bind(operationId, uid, authority.order_id, requestHash, Date.now()).run();
  const operation = await loadOperation(env, operationId);
  if (!operation) {
    const claimed = await metaDb(env).prepare(
      `SELECT operation_id,state,response_json FROM commercial_lifecycle_operations
       WHERE operation_type='cancel' AND order_id=?1 ORDER BY created_at LIMIT 1`,
    ).bind(authority.order_id).first<{ operation_id: string; state: string; response_json: string | null }>();
    if (claimed) {
      return json({ error: claimed.state === "completed" ? "commercial order already cancelled" : "commercial cancellation already in progress" }, 409);
    }
  }
  if (!operation || operation.account_id !== uid || operation.order_id !== authority.order_id
    || operation.operation_type !== "cancel" || operation.request_sha256 !== requestHash) {
    return json({ error: "commercial cancellation authority mismatch" }, 409);
  }
  if (operation.state !== "started") {
    return json({ ...(safeJson(operation.response_json) ?? { state: operation.state }), idempotent_replay: true }, operation.state === "completed" ? 200 : 202);
  }
  const decision = cancellationDecision(authority, action, Date.now());
  if (decision.state === "review_pending") return await markReview(env, authority, operationId, decision.reason);
  if (!["held", "free"].includes(authority.order_status)) {
    return await markReview(env, authority, operationId, "order_not_refundable_from_escrow");
  }
  const gross = Math.max(0, Math.trunc(Number(authority.order_amount)));
  if (gross > 0 && (await escrowBalance(env, authority.order_id)) < gross) {
    return await markReview(env, authority, operationId, "escrow_balance_below_snapshot_gross");
  }
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id,
    claimType: "refund",
    claimId: operationId,
  });
  if (!claim.owned) {
    const owner = claim.existing
      ? `${claim.existing.claim_type}:${claim.existing.claim_id}`
      : "unknown";
    return await markReview(env, authority, operationId, `commercial money claim owned by ${owner}`);
  }
  if (gross > 0) {
    const money = await refund(env, authority.order_id, authority.buyer_id, gross, {
      opId: `commercial:refund:${authority.order_id}`,
      reason: decision.reason,
    });
    if (!money.ok) return await markReview(env, authority, operationId, "refund_ledger_failed");
  }
  const receiptId = `commercial-refund:${authority.order_id}`;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_refund_receipts
      (refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,creator_id,kind,
       gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,currency,
       settlement_state,reason,actor,policy_snapshot_id,issued_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,0,0,0,?10,'refunded',?11,?12,?13,?14)`,
  ).bind(receiptId, authority.order_id, authority.session_id, authority.listing_id, authority.booking_id,
    authority.buyer_id, authority.creator_id, authority.kind, gross, authority.currency, decision.reason,
    action === "buyer_cancel" ? "buyer" : action === "creator_cancel" || action === "creator_no_show" ? "creator" : action === "insufficient_delivery_evidence" ? "system" : "provider",
    authority.policy_snapshot_id, Date.now()).run();
  const receipt = await metaDb(env).prepare(
    `SELECT refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,creator_id,kind,
       gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,currency,
       settlement_state,reason,actor,policy_snapshot_id
     FROM commercial_refund_receipts WHERE refund_receipt_id=?1`,
  ).bind(receiptId).first<Record<string, unknown>>();
  if (!receipt || receipt.refund_receipt_id !== receiptId || receipt.order_id !== authority.order_id
    || (receipt.commercial_session_id ?? null) !== (authority.session_id ?? null)
    || receipt.listing_id !== authority.listing_id || (receipt.booking_id ?? null) !== (authority.booking_id ?? null)
    || receipt.buyer_id !== authority.buyer_id || receipt.creator_id !== authority.creator_id
    || receipt.kind !== authority.kind || Number(receipt.gross_amount) !== gross
    || Number(receipt.refunded_amount) !== gross || Number(receipt.remaining_amount) !== 0
    || Number(receipt.platform_fee_amount) !== 0 || Number(receipt.creator_amount) !== 0
    || receipt.currency !== authority.currency || receipt.reason !== decision.reason
    || receipt.actor !== (action === "buyer_cancel" ? "buyer" : action === "creator_cancel" || action === "creator_no_show" ? "creator" : action === "insufficient_delivery_evidence" ? "system" : "provider")
    || receipt.policy_snapshot_id !== authority.policy_snapshot_id || receipt.settlement_state !== "refunded") {
    return await markReview(env, authority, operationId, "refund_receipt_immutable_mismatch");
  }
  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `UPDATE orders SET status='refunded',cancelled_by=?2,cancelled_at=?3,updated_at=?3
       WHERE id=?1 AND status IN ('held','free')`,
    ).bind(authority.order_id, action === "buyer_cancel" ? "buyer" : "creator", now),
    authority.booking_id ? metaDb(env).prepare(
      "UPDATE bookings SET status='refunded',updated_at=?2 WHERE id=?1 AND status IN ('confirmed','completed')",
    ).bind(authority.booking_id, now) : metaDb(env).prepare("SELECT 1"),
    authority.booking_id ? metaDb(env).prepare(
      "UPDATE calendar_events SET status='cancelled' WHERE booking_id=?1 AND status='confirmed'",
    ).bind(authority.booking_id) : metaDb(env).prepare("SELECT 1"),
    metaDb(env).prepare(
      `UPDATE commercial_entitlements SET state='refunded',updated_at=?2
       WHERE order_id=?1 AND state IN ('reserved','held','active','consumed')`,
    ).bind(authority.order_id, now),
    authority.session_id ? metaDb(env).prepare(
      `UPDATE commercial_sessions SET state='cancelled',settlement_state='refunded',state_version=state_version+1,updated_at=?2
       WHERE commercial_session_id=?1 AND state NOT IN ('ended','cancelled')`,
    ).bind(authority.session_id, now) : metaDb(env).prepare("SELECT 1"),
    authority.session_id ? metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='refunded',last_error=?2,updated_at=?3
       WHERE commercial_session_id=?1 AND state IN ('pending','processing','review_pending')`,
    ).bind(authority.session_id, decision.reason, now) : metaDb(env).prepare("SELECT 1"),
  ]);
  await completeCommercialMoneyClaim(env, {
    orderId: authority.order_id,
    claimType: "refund",
    claimId: operationId,
  });
  if (authority.booking_id) {
    await releaseBlocks(env, "avaconsult", `commercial:${authority.booking_id}:creator`);
    await releaseBlocks(env, "avaconsult", `commercial:${authority.booking_id}:buyer`);
  }
  const calendarEntitlements = await metaDb(env).prepare(
    `SELECT entitlement_id FROM commercial_entitlements WHERE order_id=?1`,
  ).bind(authority.order_id).all<{ entitlement_id: string }>();
  for (const entitlement of calendarEntitlements.results ?? []) {
    await releaseBlocks(env, "avacommercial", `commercial-calendar:${entitlement.entitlement_id}`);
  }
  const response = { ok: true, state: "refunded", order_id: authority.order_id, refund_receipt_id: receiptId, refunded_amount: gross };
  await finishOperation(env, operationId, "completed", response);
  await notifyCommercialUsers(env, [authority.buyer_id, authority.creator_id], {
    type: "commercial_session_cancelled",
    eventId: receiptId,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    sessionId: authority.session_id,
    title: "Commercial session cancelled",
    body: "The commercial session was cancelled.",
  });
  await notifyCommercialUsers(env, [authority.buyer_id, authority.creator_id], {
    type: "commercial_refund",
    eventId: receiptId,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    sessionId: authority.session_id,
    title: "Commercial refund issued",
    body: "Your commercial order has been refunded.",
  });
  commercialEvent(env, "cancellation", uid, { kind: authority.kind, outcome: "refunded", reason: decision.reason });
  return json(response);
}

async function reschedule(env: Env, authority: Authority, uid: string, idem: string, start: number, end: number): Promise<Response> {
  const policy = safeJson(authority.cancellation_policy_json);
  if (authority.kind !== "consult_1to1" || !authority.booking_id || policy?.reschedule_allowed !== true) {
    return json({ error: "commercial reschedule not allowed by policy snapshot" }, 409);
  }
  if (authority.session_state && !["scheduled", "backstage"].includes(authority.session_state)) {
    return json({ error: "commercial session cannot be rescheduled" }, 409);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= Date.now() || end <= start) {
    return json({ error: "future consultation slot required" }, 400);
  }
  const oldDuration = Number(authority.booking_ends_at) - Number(authority.booking_starts_at);
  if (!Number.isFinite(oldDuration) || end - start !== oldDuration) return json({ error: "consultation duration is immutable" }, 409);
  const notice = Number(policy.booking_notice_hours);
  if (!Number.isInteger(notice) || start - Date.now() < notice * 3_600_000) return json({ error: "booking notice policy" }, 409);
  const conflict = await metaDb(env).prepare(
    `SELECT id FROM bookings WHERE kind='consult_1to1' AND status IN ('confirmed','completed')
       AND id<>?1 AND (creator_id=?2 OR buyer_id=?3)
       AND starts_at < ?5 AND ends_at > ?4 LIMIT 1`,
  ).bind(authority.booking_id, authority.creator_id, uid, start, end).first<{ id: string }>();
  if (conflict) return json({ error: "consultation slot already booked", conflictWith: conflict }, 409);
  for (const participant of [authority.creator_id, uid]) {
    const blockConflict = await metaDb(env).prepare(
      `SELECT source_app,title,starts_at,ends_at FROM calendar_blocks
       WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2
         AND source_ref NOT IN (?4,?5) LIMIT 1`,
    ).bind(participant, start, end, `commercial:${authority.booking_id}:creator`, `commercial:${authority.booking_id}:buyer`)
      .first<Record<string, unknown>>();
    if (blockConflict) return json({ error: "calendar conflict", conflictWith: blockConflict }, 409);
  }
  const requestHash = await sha256(`${uid}:${authority.order_id}:${idem}:${start}:${end}`);
  const operationId = `commercial-reschedule:${await sha256(`${authority.order_id}:${idem}:${start}:${end}`).then((v) => v.slice(0, 48))}`;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_lifecycle_operations
      (operation_id,operation_type,account_id,order_id,request_sha256,state,created_at,updated_at)
     VALUES (?1,'reschedule',?2,?3,?4,'started',?5,?5)`,
  ).bind(operationId, uid, authority.order_id, requestHash, Date.now()).run();
  const operation = await loadOperation(env, operationId);
  if (!operation || operation.operation_type !== "reschedule" || operation.account_id !== uid
    || operation.order_id !== authority.order_id || operation.request_sha256 !== requestHash) {
    return json({ error: "commercial reschedule authority mismatch" }, 409);
  }
  if (operation.state !== "started") return json({ ...(safeJson(operation.response_json) ?? {}), idempotent_replay: true }, operation.state === "completed" ? 200 : 409);
  const now = Date.now();
  const oldStart = Number(authority.booking_starts_at);
  const oldEnd = Number(authority.booking_ends_at);
  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE bookings SET starts_at=?2,ends_at=?3,updated_at=?4 WHERE id=?1 AND status='confirmed' AND starts_at=?5 AND ends_at=?6",
    ).bind(authority.booking_id, start, end, now, oldStart, oldEnd),
    metaDb(env).prepare(
      "UPDATE commercial_entitlements SET starts_at=?2,ends_at=?3,updated_at=?4 WHERE order_id=?1 AND booking_id=?5 AND state IN ('reserved','held','active') AND starts_at=?6 AND ends_at=?7",
    ).bind(authority.order_id, start, end, now, authority.booking_id, oldStart, oldEnd),
    metaDb(env).prepare(
      "UPDATE calendar_blocks SET starts_at=?2,ends_at=?3 WHERE source_app='avaconsult' AND source_ref IN (?1,?4) AND status='busy' AND starts_at=?5 AND ends_at=?6",
    ).bind(`commercial:${authority.booking_id}:creator`, start, end, `commercial:${authority.booking_id}:buyer`, oldStart, oldEnd),
    metaDb(env).prepare(
      "UPDATE calendar_events SET start_at=?2,end_at=?3,reminded_24=0,reminded_10=0 WHERE booking_id=?1 AND status='confirmed' AND start_at=?4 AND end_at=?5",
    ).bind(authority.booking_id, start, end, oldStart, oldEnd),
    authority.session_id ? metaDb(env).prepare(
      "UPDATE commercial_sessions SET scheduled_at=?2,updated_at=?3 WHERE commercial_session_id=?1 AND state IN ('scheduled','backstage') AND scheduled_at=?4",
    ).bind(authority.session_id, start, now, oldStart) : metaDb(env).prepare("SELECT 1"),
  ]);
  const updated = await metaDb(env).prepare(
    "SELECT starts_at,ends_at,status FROM bookings WHERE id=?1",
  ).bind(authority.booking_id).first<{ starts_at: number; ends_at: number; status: string }>();
  const entitlements = await metaDb(env).prepare(
    "SELECT starts_at,ends_at FROM commercial_entitlements WHERE order_id=?1 AND booking_id=?2 AND state IN ('reserved','held','active')",
  ).bind(authority.order_id, authority.booking_id).all<{ starts_at: number; ends_at: number }>();
  const blocks = await metaDb(env).prepare(
    `SELECT source_ref,starts_at,ends_at FROM calendar_blocks
      WHERE source_app='avaconsult' AND source_ref IN (?1,?2) AND status='busy'`,
  ).bind(`commercial:${authority.booking_id}:creator`, `commercial:${authority.booking_id}:buyer`).all<{ source_ref: string; starts_at: number; ends_at: number }>();
  const events = await metaDb(env).prepare(
    "SELECT start_at,end_at FROM calendar_events WHERE booking_id=?1 AND status='confirmed'",
  ).bind(authority.booking_id).all<{ start_at: number; end_at: number }>();
  const session = authority.session_id ? await metaDb(env).prepare(
    "SELECT scheduled_at,state FROM commercial_sessions WHERE commercial_session_id=?1",
  ).bind(authority.session_id).first<{ scheduled_at: number; state: string }>() : null;
  const allAt = (rows: Array<{ starts_at?: number; ends_at?: number; start_at?: number; end_at?: number }>, s: number, e: number): boolean =>
    rows.length > 0 && rows.every((row) => Number(row.starts_at ?? row.start_at) === s && Number(row.ends_at ?? row.end_at) === e);
  const allNew = Boolean(updated && updated.status === "confirmed"
    && Number(updated.starts_at) === start && Number(updated.ends_at) === end
    && allAt(entitlements.results ?? [], start, end)
    && (blocks.results ?? []).length === 2 && allAt(blocks.results ?? [], start, end)
    && (events.results ?? []).length === 2 && allAt(events.results ?? [], start, end)
    && (!authority.session_id || (session && Number(session.scheduled_at) === start && ["scheduled", "backstage"].includes(session.state))));
  if (!allNew) {
    const bookingStart = Number(updated?.starts_at);
    const bookingEnd = Number(updated?.ends_at);
    const allOld = Boolean(updated && updated.status === "confirmed" && bookingStart === oldStart && bookingEnd === oldEnd
      && allAt(entitlements.results ?? [], oldStart, oldEnd)
      && (blocks.results ?? []).length === 2 && allAt(blocks.results ?? [], oldStart, oldEnd)
      && (events.results ?? []).length === 2 && allAt(events.results ?? [], oldStart, oldEnd)
      && (!authority.session_id || (session && Number(session.scheduled_at) === oldStart)));
    if (allOld) {
      const response = { ok: false, error: "commercial reschedule lost a concurrent schedule claim", retryable: true };
      await finishOperation(env, operationId, "failed", response);
      return json(response, 409);
    }
    // A conditional update can only leave a partially moved authority if a
    // concurrent writer raced between statements. Reconcile every projection
    // to the booking's current schedule; never leave mixed old/new rows.
    if (updated && updated.status === "confirmed" && Number.isSafeInteger(bookingStart) && Number.isSafeInteger(bookingEnd) && bookingEnd > bookingStart) {
      await metaDb(env).batch([
        metaDb(env).prepare(
          "UPDATE commercial_entitlements SET starts_at=?2,ends_at=?3,updated_at=?4 WHERE order_id=?1 AND booking_id=?5 AND state IN ('reserved','held','active')",
        ).bind(authority.order_id, bookingStart, bookingEnd, Date.now(), authority.booking_id),
        metaDb(env).prepare(
          "UPDATE calendar_blocks SET starts_at=?2,ends_at=?3 WHERE source_app='avaconsult' AND source_ref IN (?1,?4) AND status='busy'",
        ).bind(`commercial:${authority.booking_id}:creator`, bookingStart, bookingEnd, `commercial:${authority.booking_id}:buyer`),
        metaDb(env).prepare(
          "UPDATE calendar_events SET start_at=?2,end_at=?3 WHERE booking_id=?1 AND status='confirmed'",
        ).bind(authority.booking_id, bookingStart, bookingEnd),
        authority.session_id ? metaDb(env).prepare(
          "UPDATE commercial_sessions SET scheduled_at=?2,updated_at=?3 WHERE commercial_session_id=?1 AND state IN ('scheduled','backstage')",
        ).bind(authority.session_id, bookingStart, Date.now()) : metaDb(env).prepare("SELECT 1"),
      ]);
    }
    return await finishOperation(env, operationId, "review_pending", { ok: false, state: "review_pending", reason: "reschedule_authority_mismatch" }).then(() => json({ ok: false, state: "review_pending" }, 202));
  }
  const response = { ok: true, state: "rescheduled", booking_id: authority.booking_id, starts_at: start, ends_at: end };
  await finishOperation(env, operationId, "completed", response);
  await notifyCommercialUsers(env, [authority.buyer_id, authority.creator_id], {
    type: "commercial_session_rescheduled",
    eventId: operationId,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    sessionId: authority.session_id,
    title: "Commercial session rescheduled",
    body: "The session time has changed. Open AvaTOK to see the new time.",
  });
  commercialEvent(env, "reschedule", uid, { kind: authority.kind, outcome: "authorized" });
  return json(response);
}

async function addToCalendar(env: Env, route: { kind: Kind; id: string }, uid: string, idem: string): Promise<Response> {
  const row = route.kind === "live_event"
    ? await metaDb(env).prepare(
      `SELECT e.entitlement_id,e.order_id,e.account_id,e.kind,e.listing_id,e.starts_at,e.ends_at,
          l.title,l.creator_id,e.role
       FROM commercial_entitlements e JOIN listings l ON l.id=e.listing_id
       WHERE e.kind='live_event' AND e.listing_id=?1 AND e.account_id=?2
         AND e.state IN ('reserved','held','active','consumed') LIMIT 1`,
    ).bind(route.id, uid).first<{ entitlement_id: string; order_id: string | null; account_id: string; kind: Kind; listing_id: string; starts_at: number; ends_at: number; title: string; creator_id: string; role: string }>()
    : await metaDb(env).prepare(
      `SELECT e.entitlement_id,e.order_id,e.account_id,e.kind,e.listing_id,
          b.starts_at,b.ends_at,l.title,l.creator_id,e.role
       FROM commercial_entitlements e
       JOIN bookings b ON b.id=e.booking_id JOIN listings l ON l.id=e.listing_id
       WHERE e.kind='consult_1to1' AND e.booking_id=?1 AND e.account_id=?2
         AND e.state IN ('reserved','held','active','consumed') LIMIT 1`,
    ).bind(route.id, uid).first<{ entitlement_id: string; order_id: string | null; account_id: string; kind: Kind; listing_id: string; starts_at: number; ends_at: number; title: string; creator_id: string; role: string }>();
  if (!row || !Number.isSafeInteger(Number(row.starts_at)) || !Number.isSafeInteger(Number(row.ends_at)) || Number(row.ends_at) <= Number(row.starts_at)) {
    return json({ error: "commercial entitlement unavailable" }, 404);
  }
  const sourceApp = row.kind === "consult_1to1" ? "avaconsult" : "avacommercial";
  const sourceRef = row.kind === "consult_1to1"
    ? `commercial:${route.id}:${row.role === "creator" ? "creator" : "buyer"}`
    : `commercial-calendar:${row.entitlement_id}`;
  const orderKey = row.order_id ?? row.entitlement_id;
  const requestHash = await sha256(`${uid}:${orderKey}:${idem}:calendar`);
  const operationId = `commercial-calendar:${await sha256(`${orderKey}:${uid}:${idem}`).then((v) => v.slice(0, 48))}`;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_lifecycle_operations
      (operation_id,operation_type,account_id,order_id,request_sha256,state,created_at,updated_at)
     VALUES (?1,'calendar',?2,?3,?4,'started',?5,?5)`,
  ).bind(operationId, uid, orderKey, requestHash, Date.now()).run();
  const operation = await loadOperation(env, operationId);
  if (!operation || operation.operation_type !== "calendar" || operation.account_id !== uid
    || operation.order_id !== orderKey || operation.request_sha256 !== requestHash) {
    return json({ error: "commercial calendar authority mismatch" }, 409);
  }
  if (operation.state !== "started") return json({ ...(safeJson(operation.response_json) ?? {}), idempotent_replay: true }, operation.state === "completed" ? 200 : 409);
  const existingBlock = await metaDb(env).prepare(
    `SELECT id,user_id,source_app,source_ref,starts_at,ends_at,title,status
       FROM calendar_blocks WHERE source_app=?1 AND source_ref=?2 AND user_id=?3 LIMIT 1`,
  ).bind(sourceApp, sourceRef, uid).first<Record<string, unknown>>();
  let claimed: { ok: true; id: string } | { ok: false; conflict: Record<string, unknown> };
  if (existingBlock && Number(existingBlock.starts_at) === Number(row.starts_at)
    && Number(existingBlock.ends_at) === Number(row.ends_at) && existingBlock.status === "busy") {
    claimed = { ok: true, id: String(existingBlock.id) };
  } else {
    const result = await claimBlock(env, {
      userId: uid, sourceApp, sourceRef,
      start: Number(row.starts_at), end: Number(row.ends_at), title: row.title,
    });
    claimed = result.ok ? { ok: true, id: result.id } : { ok: false, conflict: result.conflict as unknown as Record<string, unknown> };
  }
  if (!claimed.ok) {
    const response = { ok: false, error: "calendar conflict", conflictWith: claimed.conflict };
    await finishOperation(env, operationId, "failed", response);
    return json(response, 409);
  }
  const block = await metaDb(env).prepare(
    `SELECT id,user_id,source_app,source_ref,starts_at,ends_at,title,status
       FROM calendar_blocks WHERE source_ref=?1 AND user_id=?2 AND source_app=?3 LIMIT 1`,
  ).bind(sourceRef, uid, sourceApp).first<Record<string, unknown>>();
  if (!block || block.user_id !== uid || block.source_app !== sourceApp
    || block.source_ref !== sourceRef || Number(block.starts_at) !== Number(row.starts_at)
    || Number(block.ends_at) !== Number(row.ends_at) || block.status !== "busy") {
    await releaseBlocks(env, sourceApp, sourceRef);
    const response = { ok: false, state: "review_pending", reason: "calendar_block_immutable_mismatch" };
    await finishOperation(env, operationId, "review_pending", response);
    return json(response, 202);
  }
  const response = { ok: true, added: true, source_app: sourceApp, source_ref: sourceRef, starts_at: row.starts_at, ends_at: row.ends_at };
  await finishOperation(env, operationId, "completed", response);
  commercialEvent(env, "calendar", uid, { kind: row.kind, outcome: "added" });
  return json(response);
}

export async function commercialLifecycle(req: Request, env: Env): Promise<Response> {
  const route = path(req);
  if (!route) return json({ error: "bad commercial lifecycle path" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  if (!await schemaReady(env)) return json({ error: "commercial lifecycle unavailable" }, 503);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const idem = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idem)) return json({ error: "valid Idempotency-Key required" }, 400);
  if (route.action === "calendar") return await addToCalendar(env, route, auth.uid, idem);
  const authorities = await loadAuthorities(env, { kind: route.kind, id: route.id, uid: auth.uid });
  if (!authorities.length) return json({ error: "commercial order unavailable" }, 404);
  if (route.action === "reschedule") {
    const authority = authorities[0];
    const start = Math.trunc(Number(body.new_start ?? body.start_at));
    const end = Math.trunc(Number(body.new_end ?? body.end_at));
    return await reschedule(env, authority, auth.uid, idem, start, end);
  }
  // Public callers may only cancel as themselves. Provider/no-show/outage
  // reasons are reserved for signed provider processing or internal authority.
  const responses: Record<string, unknown>[] = [];
  for (const authority of authorities) {
    const action: Action = authority.creator_id === auth.uid ? "creator_cancel" : "buyer_cancel";
    const response = await cancelOne(env, authority, auth.uid, idem, action);
    const payload = await response.clone().json().catch(() => ({})) as Record<string, unknown>;
    responses.push(payload);
    if (!response.ok && authorities.length === 1) return response;
  }
  return json({ ok: responses.every((item) => item.ok === true), results: responses }, responses.every((item) => item.ok === true) ? 200 : 202);
}
