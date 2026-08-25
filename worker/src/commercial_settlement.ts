// Phase 2 commercial settlement executor.
//
// Signed terminal provider evidence creates one job per snapshotted order.
// This runner verifies escrow once, records that durable fact, then uses a
// stable WalletDO op_id so retries cannot duplicate creator earnings.

import type { Env } from "./types";
import { metaDb } from "./db/shard";
import { walletOp } from "./routes/wallet";
import { ACCT_PLATFORM_FEES, acctEscrow, acctUser, escrowBalance } from "./ledger";
import { commercialEvent } from "./lib/commercial_telemetry";
import { notifyCommercialUsers } from "./lib/commercial_notifications";
import { claimCommercialMoney, completeCommercialMoneyClaim } from "./commercial_money_claim";

type SettlementJob = {
  settlement_job_id: string;
  commercial_session_id: string;
  order_id: string;
  state: string;
  attempts: number;
  funds_verified_at: number | null;
};

type SettlementAuthority = {
  kind: "live_event" | "consult_1to1";
  listing_id: string;
  booking_id: string | null;
  creator_id: string;
  session_state: string;
  live_started_at: number | null;
  order_id: string;
  buyer_id: string;
  order_creator_id: string;
  order_amount: number;
  order_status: string;
  policy_snapshot_id: string;
  gross_amount: number;
  currency: string;
  creator_fee_pct: number;
  settlement_hold_hours: number;
  platform_fee_amount: number;
  creator_amount: number;
  cancellation_policy_json: string;
  conversion_snapshot_json: string | null;
  policy_version: string;
};

async function markReview(env: Env, jobId: string, reason: string): Promise<void> {
  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='review_pending',last_error=?2,
        attempts=attempts+1,updated_at=?3 WHERE settlement_job_id=?1`,
    ).bind(jobId, reason.slice(0, 500), now),
    metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
       WHERE commercial_session_id=(SELECT commercial_session_id FROM commercial_settlement_jobs WHERE settlement_job_id=?1)
         AND settlement_state NOT IN ('settled','refunded')`,
    ).bind(jobId, now),
  ]);
  commercialEvent(env, "settlement", null, { outcome: "review_pending", reason: reason.slice(0, 80) });
}

async function loadAuthority(env: Env, job: SettlementJob): Promise<SettlementAuthority | null> {
  return await metaDb(env).prepare(
    `SELECT s.kind,s.listing_id,s.booking_id,s.creator_id,s.state session_state,
      s.live_started_at,
      o.id order_id,o.buyer_id,o.creator_id order_creator_id,o.amount order_amount,
      o.status order_status,p.policy_snapshot_id,p.gross_amount,p.currency,
      p.creator_fee_pct,p.settlement_hold_hours,p.platform_fee_amount,p.creator_amount,
      p.cancellation_policy_json,p.conversion_snapshot_json,p.policy_version
     FROM commercial_sessions s
     JOIN commercial_policy_snapshots p ON p.order_id=?2
       AND p.listing_id=s.listing_id
       AND COALESCE(p.booking_id,'')=COALESCE(s.booking_id,'')
     JOIN orders o ON o.id=p.order_id
     WHERE s.commercial_session_id=?1
       AND NOT EXISTS (
         SELECT 1 FROM commercial_refund_receipts rr
          WHERE rr.order_id=o.id AND rr.settlement_state='refunded'
       )`,
  ).bind(job.commercial_session_id, job.order_id).first<SettlementAuthority>();
}

async function deliveryError(
  env: Env,
  sessionId: string,
  authority: SettlementAuthority,
): Promise<string | null> {
  let policy: Record<string, unknown>;
  try { policy = JSON.parse(authority.cancellation_policy_json) as Record<string, unknown>; } catch {
    return "commercial policy snapshot is invalid";
  }
  if (policy.auto_release_on_provider_end !== true) {
    return "commercial policy requires settlement review";
  }
  const configuredMinimum = Number(policy.min_connected_ms);
  const minimumMs = Number.isFinite(configuredMinimum) && configuredMinimum >= 0
    ? Math.trunc(configuredMinimum)
    : 60_000;
  if (authority.kind === "live_event") {
    if (!authority.live_started_at) return "live event never reached provider-confirmed live state";
    const host = await metaDb(env).prepare(
      `SELECT COALESCE(SUM(i.connected_ms),0) total
       FROM commercial_participant_intervals i
       JOIN commercial_session_members m
         ON m.commercial_session_id=i.commercial_session_id AND m.account_id=i.account_id
       WHERE i.commercial_session_id=?1 AND m.role='host'
         AND i.reconciliation_state IN ('closed','reconciled')`,
    ).bind(sessionId).first<{ total: number }>();
    return Number(host?.total ?? 0) >= minimumMs ? null : "insufficient signed host delivery evidence";
  }
  const overlap = await metaDb(env).prepare(
    `SELECT COALESCE(MAX(
      MAX(0,MIN(c.left_at,b.left_at)-MAX(c.joined_at,b.joined_at))
    ),0) overlap_ms
     FROM commercial_participant_intervals c
     JOIN commercial_session_members cm
       ON cm.commercial_session_id=c.commercial_session_id AND cm.account_id=c.account_id
     JOIN commercial_participant_intervals b
       ON b.commercial_session_id=c.commercial_session_id
     JOIN commercial_session_members bm
       ON bm.commercial_session_id=b.commercial_session_id AND bm.account_id=b.account_id
     WHERE c.commercial_session_id=?1 AND cm.role='creator' AND bm.role='buyer'
       AND c.reconciliation_state IN ('closed','reconciled')
       AND b.reconciliation_state IN ('closed','reconciled')
       AND c.left_at IS NOT NULL AND b.left_at IS NOT NULL`,
  ).bind(sessionId).first<{ overlap_ms: number }>();
  let delivered = Number(overlap?.overlap_ms ?? 0);
  if (authority.policy_version.endsWith(":extension")) {
    let boundary: { base_ends_at?: number; extension_ends_at?: number } = {};
    try { boundary = JSON.parse(authority.conversion_snapshot_json ?? "{}"); } catch { return "extension delivery boundary unavailable"; }
    if (!Number.isSafeInteger(boundary.base_ends_at) || !Number.isSafeInteger(boundary.extension_ends_at)
      || Number(boundary.extension_ends_at) <= Number(boundary.base_ends_at)) return "extension delivery boundary invalid";
    const incremental = await metaDb(env).prepare(
      `SELECT COALESCE(MAX(MAX(0,MIN(c.left_at,b.left_at,?3)-MAX(c.joined_at,b.joined_at,?2))),0) overlap_ms
       FROM commercial_participant_intervals c
       JOIN commercial_session_members cm ON cm.commercial_session_id=c.commercial_session_id AND cm.account_id=c.account_id
       JOIN commercial_participant_intervals b ON b.commercial_session_id=c.commercial_session_id
       JOIN commercial_session_members bm ON bm.commercial_session_id=b.commercial_session_id AND bm.account_id=b.account_id
       WHERE c.commercial_session_id=?1 AND cm.role='creator' AND bm.role='buyer'
         AND c.reconciliation_state IN ('closed','reconciled') AND b.reconciliation_state IN ('closed','reconciled')
         AND c.left_at IS NOT NULL AND b.left_at IS NOT NULL
         AND c.left_at>?2 AND b.left_at>?2 AND c.joined_at<?3 AND b.joined_at<?3`,
    ).bind(sessionId, Number(boundary.base_ends_at), Number(boundary.extension_ends_at)).first<{ overlap_ms: number }>();
    delivered = Number(incremental?.overlap_ms ?? 0);
  }
  return delivered >= minimumMs
    ? null
    : "insufficient signed two-party delivery evidence";
}

function authorityError(value: SettlementAuthority): string | null {
  const gross = Math.trunc(Number(value.gross_amount));
  const creator = Math.trunc(Number(value.creator_amount));
  const platform = Math.trunc(Number(value.platform_fee_amount));
  const pct = Number(value.creator_fee_pct);
  const hold = Number(value.settlement_hold_hours);
  if (value.session_state !== "ended") return "session is not terminal";
  if (value.creator_id !== value.order_creator_id) return "creator authority mismatch";
  if (gross !== Math.trunc(Number(value.order_amount)) || gross < 0) return "gross snapshot mismatch";
  if (creator < 0 || platform < 0 || creator + platform !== gross) return "split snapshot mismatch";
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "creator percentage invalid";
  if (creator !== Math.round(gross * pct / 100)) return "creator amount does not match percentage";
  if (!Number.isFinite(hold) || hold < 0 || hold > 365 * 24) return "settlement hold invalid";
  if (!["held", "free", "settled"].includes(value.order_status)) return "order is not settleable";
  return null;
}

async function releaseSnapshot(
  env: Env,
  authority: SettlementAuthority,
): Promise<{ duplicate: boolean }> {
  const gross = Math.trunc(Number(authority.gross_amount));
  const creatorAmount = Math.trunc(Number(authority.creator_amount));
  const platformAmount = Math.trunc(Number(authority.platform_fee_amount));
  if (gross === 0) return { duplicate: false };

  const opId = `commercial:release:${authority.order_id}`;
  let duplicate = false;
  if (creatorAmount > 0) {
    const result = await walletOp(env, authority.creator_id, {
      op: "earn",
      uid: authority.creator_id,
      amount: creatorAmount,
      commission: platformAmount,
      hold_hours: Math.trunc(Number(authority.settlement_hold_hours)),
      app_name: authority.kind === "live_event" ? "avalive" : "avaconsult",
      ref: authority.order_id,
      op_id: opId,
      ledger: {
        debit: acctEscrow(authority.order_id),
        credit: acctUser(authority.creator_id),
        type: "commercial_escrow_release",
        ref: authority.order_id,
        meta: JSON.stringify({
          gross,
          creator_amount: creatorAmount,
          platform_fee_amount: platformAmount,
          creator_fee_pct: authority.creator_fee_pct,
          policy_snapshot_id: authority.policy_snapshot_id,
        }),
      },
    });
    if (result.status !== 200) throw new Error(`commercial creator release failed: ${result.status}`);
    duplicate = result.body?.duplicate === true;
  }
  if (platformAmount > 0) {
    await env.Q_WALLET.send({
      id: `commercial:fee:${authority.order_id}`,
      ts: Date.now(),
      amount: platformAmount,
      ledger: {
        debit: acctEscrow(authority.order_id),
        credit: ACCT_PLATFORM_FEES,
        type: "commercial_platform_fee",
        ref: authority.order_id,
        meta: JSON.stringify({
          gross,
          creator_fee_pct: authority.creator_fee_pct,
          policy_snapshot_id: authority.policy_snapshot_id,
        }),
      },
    });
  }
  return { duplicate };
}

async function connectedMs(env: Env, sessionId: string, buyerId: string): Promise<number> {
  const row = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(connected_ms),0) total FROM commercial_participant_intervals
     WHERE commercial_session_id=?1 AND account_id=?2
       AND reconciliation_state IN ('closed','reconciled')`,
  ).bind(sessionId, buyerId).first<{ total: number }>();
  return Math.max(0, Math.trunc(Number(row?.total ?? 0)));
}

async function finishSettlement(
  env: Env,
  job: SettlementJob,
  authority: SettlementAuthority,
): Promise<void> {
  const receiptId = `commercial:receipt:${authority.order_id}`;
  const duration = await connectedMs(env, job.commercial_session_id, authority.buyer_id);
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_receipts
       (receipt_id,commercial_session_id,order_id,listing_id,booking_id,buyer_id,
        creator_id,kind,gross_amount,platform_fee_amount,creator_amount,currency,
        settlement_state,connected_ms,policy_snapshot_id,issued_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'settled',?13,?14,?15)`,
  ).bind(
    receiptId, job.commercial_session_id, authority.order_id, authority.listing_id,
    authority.booking_id, authority.buyer_id, authority.creator_id, authority.kind,
    authority.gross_amount, authority.platform_fee_amount, authority.creator_amount,
    authority.currency, duration, authority.policy_snapshot_id, now,
  ).run();

  const receipt = await metaDb(env).prepare(
    `SELECT commercial_session_id,order_id,listing_id,booking_id,buyer_id,creator_id,
      kind,gross_amount,platform_fee_amount,creator_amount,currency,settlement_state,
      connected_ms,policy_snapshot_id FROM commercial_receipts WHERE receipt_id=?1`,
  ).bind(receiptId).first<Record<string, unknown>>();
  if (!receipt
    || receipt.commercial_session_id !== job.commercial_session_id
    || receipt.order_id !== authority.order_id
    || receipt.listing_id !== authority.listing_id
    || (receipt.booking_id ?? null) !== (authority.booking_id ?? null)
    || receipt.buyer_id !== authority.buyer_id
    || receipt.creator_id !== authority.creator_id
    || receipt.kind !== authority.kind
    || Number(receipt.gross_amount) !== Number(authority.gross_amount)
    || Number(receipt.platform_fee_amount) !== Number(authority.platform_fee_amount)
    || Number(receipt.creator_amount) !== Number(authority.creator_amount)
    || receipt.currency !== authority.currency
    || receipt.settlement_state !== "settled"
    || Number(receipt.connected_ms) !== duration
    || receipt.policy_snapshot_id !== authority.policy_snapshot_id) {
    throw new Error("commercial receipt immutable replay mismatch");
  }
  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE orders SET status='settled',updated_at=?2 WHERE id=?1 AND status IN ('held','free','settled')",
    ).bind(authority.order_id, now),
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='settled',ledger_confirmed_at=COALESCE(ledger_confirmed_at,?2),
        attempts=attempts+1,last_error=NULL,updated_at=?2 WHERE settlement_job_id=?1`,
    ).bind(job.settlement_job_id, now),
  ]);
  await completeCommercialMoneyClaim(env, {
    orderId: authority.order_id,
    claimType: "settlement",
    claimId: job.settlement_job_id,
  });

  const remaining = await metaDb(env).prepare(
    `SELECT COUNT(*) count FROM commercial_settlement_jobs
     WHERE commercial_session_id=?1 AND state NOT IN ('settled','refunded')`,
  ).bind(job.commercial_session_id).first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='settled',updated_at=?2
       WHERE commercial_session_id=?1 AND state='ended'`,
    ).bind(job.commercial_session_id, Date.now()).run();
  }
  await notifyCommercialUsers(env, [authority.buyer_id, authority.creator_id], {
    type: "commercial_receipt",
    eventId: receiptId,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    sessionId: job.commercial_session_id,
    title: "Commercial receipt ready",
    body: "Your commercial receipt is ready to view.",
  });
  commercialEvent(env, "settlement", null, { kind: authority.kind, outcome: "settled" });
}

async function processJob(env: Env, job: SettlementJob): Promise<void> {
  const authority = await loadAuthority(env, job);
  if (!authority) return await markReview(env, job.settlement_job_id, "missing immutable settlement authority");
  const invalid = authorityError(authority);
  if (invalid) return await markReview(env, job.settlement_job_id, invalid);
  const delivery = await deliveryError(env, job.commercial_session_id, authority);
  if (delivery) return await markReview(env, job.settlement_job_id, delivery);

  if (!job.funds_verified_at && Number(authority.gross_amount) > 0) {
    const available = await escrowBalance(env, authority.order_id);
    if (available < Number(authority.gross_amount)) {
      return await markReview(env, job.settlement_job_id, "escrow balance below immutable gross");
    }
    const verifiedAt = Date.now();
    await metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET funds_verified_at=?2,updated_at=?2
       WHERE settlement_job_id=?1 AND funds_verified_at IS NULL`,
    ).bind(job.settlement_job_id, verifiedAt).run();
    job.funds_verified_at = verifiedAt;
  }
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id,
    claimType: "settlement",
    claimId: job.settlement_job_id,
  });
  if (!claim.owned) {
    const owner = claim.existing
      ? `${claim.existing.claim_type}:${claim.existing.claim_id}`
      : "unknown";
    return await markReview(env, job.settlement_job_id, `commercial money claim owned by ${owner}`);
  }
  await releaseSnapshot(env, authority);
  await finishSettlement(env, job, authority);
}

export async function runCommercialSettlements(
  env: Env,
  limit = 10,
): Promise<{ scanned: number; settled: number; reviewPending: number }> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const stale = Date.now() - 60_000;
  const rows = await metaDb(env).prepare(
    `SELECT settlement_job_id,commercial_session_id,order_id,state,attempts,funds_verified_at
     FROM commercial_settlement_jobs
     WHERE state='pending' OR (state='processing' AND updated_at<?1)
     ORDER BY created_at LIMIT ?2`,
  ).bind(stale, safeLimit).all<SettlementJob>();
  let settled = 0;
  let reviewPending = 0;
  for (const job of rows.results ?? []) {
    const claimed = await metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='processing',updated_at=?2
       WHERE settlement_job_id=?1 AND (state='pending' OR (state='processing' AND updated_at<?3))`,
    ).bind(job.settlement_job_id, Date.now(), stale).run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    commercialEvent(env, "settlement", null, { outcome: "processing" });
    try {
      await processJob(env, job);
      const state = await metaDb(env).prepare(
        "SELECT state FROM commercial_settlement_jobs WHERE settlement_job_id=?1",
      ).bind(job.settlement_job_id).first<{ state: string }>();
      if (state?.state === "settled") settled++;
      if (state?.state === "review_pending") reviewPending++;
    } catch (error) {
      commercialEvent(env, "settlement", null, { outcome: "failed" });
      await metaDb(env).prepare(
        `UPDATE commercial_settlement_jobs SET last_error=?2,attempts=attempts+1,updated_at=?3
         WHERE settlement_job_id=?1 AND state='processing'`,
      ).bind(job.settlement_job_id, String(error).slice(0, 500), Date.now()).run();
    }
  }
  return { scanned: (rows.results ?? []).length, settled, reviewPending };
}
