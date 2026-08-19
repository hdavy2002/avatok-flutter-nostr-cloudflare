// [AVA-MKT-ENTITLEMENTS-2] Authoritative marketplace listing fee and entitlement
// boundary. Shared by classic and AI-compose publish.
//
// Product contract:
//   * five free 30-day listing entitlements per account;
//   * each additional 30-day period costs 100 paid wallet tokens;
//   * daily free/bonus AI tokens can never fund a marketplace fee;
//   * (listing, period) and the WalletDO operation id are deterministic;
//   * the operation row survives a successful wallet debit when the following D1
//     entitlement write is interrupted, so a retry can finish without charging again.

import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { chargeFeature } from "../feature_pricing";
import { walletOp } from "../routes/wallet";
import { readConfig } from "../routes/config";

export const FREE_LISTING_QUOTA = 5;
export const LISTING_PERIOD_MS = 30 * 86_400_000;
export const LISTING_FEE_AMOUNT = 100;
export const LISTING_FUNDING_POLICY = "paid_only" as const;
// A free-slot reservation only protects an in-flight publish. If the request
// disappears before materializing its entitlement, a later publish may reclaim
// the abandoned row instead of hiding one of the account's five slots for the
// full 30-day listing period.
export const FREE_RESERVATION_LEASE_MS = 15 * 60_000;

let billingSchemaReady = false;

/**
 * Runtime safety net matching the canonical migrations. Production deployment
 * credentials do not always have D1 query permission, while the bound Worker
 * does. Keeping this idempotent guard prevents deploy-before-migration outages;
 * the dated SQL files remain the canonical audit trail.
 */
export async function ensureListingBillingSchema(env: Env): Promise<void> {
  if (billingSchemaReady) return;
  const db = metaDb(env);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS listing_entitlements (
      listing_id TEXT NOT NULL, period INTEGER NOT NULL DEFAULT 1, uid TEXT NOT NULL,
      source TEXT NOT NULL, charged INTEGER NOT NULL DEFAULT 0, op_id TEXT,
      period_start INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (listing_id, period)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS listing_entitlement_operations (
      listing_id TEXT NOT NULL, period INTEGER NOT NULL, uid TEXT NOT NULL, vertical TEXT,
      amount INTEGER NOT NULL DEFAULT 0, funding_policy TEXT NOT NULL DEFAULT 'paid_only',
      fee_enabled INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'free',
      wallet_op_id TEXT, state TEXT NOT NULL DEFAULT 'quoted', wallet_charged INTEGER NOT NULL DEFAULT 0,
      wallet_balance_after INTEGER, entitlement_expires_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (listing_id, period)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_le_uid_quota ON listing_entitlements(uid, source, expires_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_le_opid ON listing_entitlements(op_id) WHERE op_id IS NOT NULL"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_le_expires ON listing_entitlements(expires_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_leo_wallet_op ON listing_entitlement_operations(wallet_op_id) WHERE wallet_op_id IS NOT NULL"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leo_state_updated ON listing_entitlement_operations(state, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leo_uid_updated ON listing_entitlement_operations(uid, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leo_free_quota ON listing_entitlement_operations(uid, source, state, entitlement_expires_at)"),
  ]);
  billingSchemaReady = true;
}

type OperationState = "quoted" | "charging" | "charged" | "entitled" | "published" | "failed" | "refunded";

export type ListingFeeDecision = {
  source: "free" | "paid";
  amount: number;
  free_used: number;
  free_remaining: number;
  funding_policy: typeof LISTING_FUNDING_POLICY;
  period: number;
  expires_at: number;
};

export type ListingFeeQuote = ListingFeeDecision & {
  listing_id: string;
  fee_enabled: boolean;
  paid_balance: number | null;
};

export type ListingEntitlementOk = ListingFeeQuote & {
  ok: true;
  charged: number;
  balance: number | null;
};

export type ListingEntitlementErr =
  | { ok: false; error: "insufficient_funds"; needed: number; quote?: ListingFeeQuote }
  | { ok: false; error: "charge_failed"; quote?: ListingFeeQuote }
  | { ok: false; error: "recovery_required"; quote?: ListingFeeQuote };

export type ListingEntitlementResult = ListingEntitlementOk | ListingEntitlementErr;

/** Stable, namespaced wallet operation identity for one listing period. */
export function listingWalletOpId(listingId: string, period: number): string {
  return `listing:${listingId}:${Math.max(1, Math.trunc(Number(period) || 1))}`;
}

/**
 * Pure quota contract used by the D1 reservation statement and its tests.
 * `pendingReservations` counts free operations that have not materialized an
 * entitlement row yet; those operations already own a slot for concurrency
 * purposes and must be included in the five-slot limit.
 */
export function freeQuotaAvailable(freeUsed: number, pendingReservations = 0): boolean {
  return Math.max(0, Math.trunc(Number(freeUsed) || 0))
    + Math.max(0, Math.trunc(Number(pendingReservations) || 0)) < FREE_LISTING_QUOTA;
}

export function freeReservationActive(updatedAt: number, now: number): boolean {
  return Number(updatedAt) > Number(now) - FREE_RESERVATION_LEASE_MS;
}

/** Per-vertical fee key. Connect has its own key so pricing can diverge later. */
export function feeKeyFor(vertical: string | undefined): "listing_post" | "listing_post_connect" {
  return vertical === "connect" ? "listing_post_connect" : "listing_post";
}

/** Pure fee decision used by the route and focused tests. */
export function listingFeeDecision(args: {
  feeEnabled: boolean;
  freeUsed: number;
  period: number;
  now: number;
}): ListingFeeDecision {
  const freeUsed = Math.max(0, Math.trunc(Number(args.freeUsed) || 0));
  const period = Math.max(1, Math.trunc(Number(args.period) || 1));
  const freeRemaining = Math.max(0, FREE_LISTING_QUOTA - freeUsed);
  const paid = args.feeEnabled && !freeQuotaAvailable(freeUsed);
  return {
    source: paid ? "paid" : "free",
    amount: paid ? LISTING_FEE_AMOUNT : 0,
    free_used: freeUsed,
    free_remaining: freeRemaining,
    funding_policy: LISTING_FUNDING_POLICY,
    period,
    expires_at: args.now + LISTING_PERIOD_MS,
  };
}

async function feeEnabled(env: Env): Promise<boolean> {
  // An unreadable fee flag must not unexpectedly start charging users.
  try { return (await readConfig(env) as { listingFeeEnabled?: boolean }).listingFeeEnabled === true; }
  catch { return false; }
}

async function freeUsed(db: D1Database, uid: string, now: number): Promise<number> {
  const q = await db.prepare(
    "SELECT COUNT(*) AS n FROM listing_entitlements WHERE uid=?1 AND source='free' AND expires_at>?2",
  ).bind(uid, now).first<{ n: number }>();
  // Count free operations that are already reserving a slot but have not yet
  // written their entitlement. The NOT EXISTS clause prevents counting an
  // entitlement twice once the operation reaches `entitled`/`published`.
  const pending = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM listing_entitlement_operations o
      WHERE o.uid=?1 AND o.source='free' AND o.entitlement_expires_at>?2
        AND o.state IN ('quoted','charging','entitled','published')
        AND (o.state <> 'quoted' OR o.updated_at>?3)
        AND NOT EXISTS (
          SELECT 1 FROM listing_entitlements e
           WHERE e.listing_id=o.listing_id AND e.period=o.period
        )`,
  ).bind(uid, now, now - FREE_RESERVATION_LEASE_MS).first<{ n: number }>();
  return Number(q?.n ?? 0) + Number(pending?.n ?? 0);
}

async function latestPeriod(db: D1Database, listingId: string): Promise<number> {
  // A published operation is a completed period; a non-terminal operation is a
  // resumable charge/entitlement boundary after a request interruption.
  try {
    const op = await db.prepare(
      "SELECT period, state FROM listing_entitlement_operations WHERE listing_id=?1 ORDER BY period DESC LIMIT 1",
    ).bind(listingId).first<{ period: number; state: OperationState }>();
    if (op) return op.state === "published" ? Number(op.period) + 1 : Number(op.period);
  } catch { /* migration not present; use the existing entitlement audit */ }

  const ent = await db.prepare(
    "SELECT MAX(period) AS period FROM listing_entitlements WHERE listing_id=?1",
  ).bind(listingId).first<{ period: number | null }>();
  const prior = Number(ent?.period ?? 0);
  return prior > 0 ? prior + 1 : 1;
}

async function readEntitlement(db: D1Database, listingId: string, period: number): Promise<any | null> {
  return db.prepare(
    "SELECT uid, source, charged, expires_at FROM listing_entitlements WHERE listing_id=?1 AND period=?2",
  ).bind(listingId, period).first<any>();
}

async function readOperation(db: D1Database, listingId: string, period: number): Promise<any | null> {
  return db.prepare(
    `SELECT listing_id, period, uid, vertical, amount, funding_policy, fee_enabled, source,
            wallet_op_id, state, wallet_charged, wallet_balance_after, entitlement_expires_at,
            last_error, created_at, updated_at
       FROM listing_entitlement_operations WHERE listing_id=?1 AND period=?2`,
  ).bind(listingId, period).first<any>();
}

async function ensureOperation(db: D1Database, args: {
  listingId: string;
  period: number;
  uid: string;
  vertical?: string;
  decision: ListingFeeDecision;
  feeEnabled: boolean;
  now: number;
}): Promise<any> {
  const opId = listingWalletOpId(args.listingId, args.period);
  const insert = async (decision: ListingFeeDecision): Promise<void> => {
    await db.prepare(
    `INSERT OR IGNORE INTO listing_entitlement_operations
       (listing_id, period, uid, vertical, amount, funding_policy, fee_enabled, source,
        wallet_op_id, state, wallet_charged, entitlement_expires_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'quoted',0,?10,?11,?11)`,
    ).bind(
      args.listingId, args.period, args.uid, args.vertical ?? null, decision.amount,
      decision.funding_policy, args.feeEnabled ? 1 : 0, decision.source,
      decision.source === "paid" ? opId : null, decision.expires_at, args.now,
    ).run();
  };

  if (args.decision.source === "free" && args.feeEnabled) {
    // The quota check and reservation happen in one SQLite INSERT statement.
    // D1 serializes concurrent writers; INSERT OR IGNORE then lets the losing
    // request fall through to the paid operation. Reclaim only abandoned,
    // pre-entitlement free reservations. The delete and
    // replacement insert share one D1 transaction, so another concurrent
    // publisher cannot observe a temporarily released slot.
    const staleBefore = args.now - FREE_RESERVATION_LEASE_MS;
    await db.batch([
      db.prepare(
        `DELETE FROM listing_entitlement_operations
          WHERE source='free' AND state='quoted' AND updated_at<=?1 AND uid=?2
            AND NOT EXISTS (
              SELECT 1 FROM listing_entitlements e
               WHERE e.listing_id=listing_entitlement_operations.listing_id
                 AND e.period=listing_entitlement_operations.period
            )`,
      ).bind(staleBefore, args.uid),
      db.prepare(
      `INSERT OR IGNORE INTO listing_entitlement_operations
         (listing_id, period, uid, vertical, amount, funding_policy, fee_enabled, source,
          wallet_op_id, state, wallet_charged, entitlement_expires_at, created_at, updated_at)
       SELECT ?1,?2,?3,?4,0,?5,1,'free',NULL,'quoted',0,?6,?7,?7
         WHERE (
           SELECT COUNT(*) FROM listing_entitlements
            WHERE uid=?3 AND source='free' AND expires_at>?7
         ) + (
           SELECT COUNT(*) FROM listing_entitlement_operations o
            WHERE o.uid=?3 AND o.source='free' AND o.entitlement_expires_at>?7
              AND o.state IN ('quoted','charging','entitled','published')
              AND (o.state <> 'quoted' OR o.updated_at>?9)
              AND NOT EXISTS (
                SELECT 1 FROM listing_entitlements e
                 WHERE e.listing_id=o.listing_id AND e.period=o.period
              )
         ) < ?8`,
      ).bind(
      args.listingId, args.period, args.uid, args.vertical ?? null,
      args.decision.funding_policy, args.decision.expires_at, args.now,
      FREE_LISTING_QUOTA, staleBefore,
      ),
    ]);
  } else {
    await insert(args.decision);
  }

  const row = await readOperation(db, args.listingId, args.period);
  if (!row && args.feeEnabled) {
    // Another concurrent listing consumed the final free slot. Re-evaluate this
    // listing as paid, preserving its same listing/period operation identity.
    await insert({
      ...args.decision,
      source: "paid",
      amount: LISTING_FEE_AMOUNT,
      free_remaining: 0,
    });
  }
  const actual = row ?? await readOperation(db, args.listingId, args.period);
  if (!actual) throw new Error("listing entitlement operation was not created");
  if (String(actual.uid) !== args.uid) throw new Error("listing entitlement owner mismatch");
  return actual;
}

async function updateOperation(db: D1Database, listingId: string, period: number, patch: {
  state: OperationState;
  walletCharged?: number;
  walletBalanceAfter?: number | null;
  lastError?: string | null;
  now: number;
}): Promise<void> {
  await db.prepare(
    `UPDATE listing_entitlement_operations
        SET state=?3,
            wallet_charged=COALESCE(?4,wallet_charged),
            wallet_balance_after=COALESCE(?5,wallet_balance_after),
            last_error=?6,
            updated_at=?7
      WHERE listing_id=?1 AND period=?2`,
  ).bind(
    listingId, period, patch.state, patch.walletCharged ?? null,
    patch.walletBalanceAfter ?? null, patch.lastError ?? null, patch.now,
  ).run();
}

async function writeEntitlement(db: D1Database, args: {
  listingId: string;
  period: number;
  uid: string;
  source: "free" | "paid";
  charged: number;
  opId: string | null;
  periodStart: number;
  expiresAt: number;
}): Promise<any> {
  const existing = await readEntitlement(db, args.listingId, args.period);
  if (existing) {
    if (String(existing.uid) !== args.uid) throw new Error("listing entitlement owner mismatch");
    return existing;
  }
  await db.prepare(
    `INSERT OR IGNORE INTO listing_entitlements
       (listing_id, period, uid, source, charged, op_id, period_start, expires_at, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(
    args.listingId, args.period, args.uid, args.source, args.charged, args.opId,
    args.periodStart, args.expiresAt, args.periodStart,
  ).run();
  const row = await readEntitlement(db, args.listingId, args.period);
  if (!row || String(row.uid) !== args.uid) throw new Error("listing entitlement was not recorded");
  return row;
}

/**
 * Server-owned quote. This is intentionally a helper rather than a new route:
 * index.ts is outside this slice, so publish callers can expose the same answer
 * without inventing a second price calculation.
 */
export async function quoteListingEntitlement(
  env: Env,
  args: { uid: string; listingId: string; vertical?: string; period?: number; now?: number },
): Promise<ListingFeeQuote> {
  await ensureListingBillingSchema(env);
  const db = metaDb(env);
  const now = args.now ?? Date.now();
  const period = args.period ?? await latestPeriod(db, args.listingId);
  const used = await freeUsed(db, args.uid, now);
  const enabled = await feeEnabled(env);
  const decision = listingFeeDecision({
    feeEnabled: enabled, freeUsed: used, period, now,
  });
  let paidBalance: number | null = null;
  try {
    const balance = await walletOp(env, args.uid, { op: "balance", uid: args.uid });
    if (balance.status === 200 && balance.body?.balance != null) paidBalance = Number(balance.body.balance);
  } catch { /* price remains authoritative; balance is display-only */ }
  return {
    listing_id: args.listingId,
    fee_enabled: enabled,
    paid_balance: paidBalance,
    ...decision,
  };
}

/**
 * Consume one listing period. The operation row is written before a paid WalletDO
 * call and remains `charged` if the entitlement insert is interrupted. A retry sees
 * that state and materializes the entitlement without calling WalletDO again.
 */
export async function consumeListingEntitlement(
  env: Env,
  args: { uid: string; listingId: string; vertical?: string; period?: number; now?: number },
): Promise<ListingEntitlementResult> {
  try { await ensureListingBillingSchema(env); }
  catch { return { ok: false, error: "charge_failed" }; }
  const db = metaDb(env);
  const now = args.now ?? Date.now();
  let quote: ListingFeeQuote;
  try {
    quote = await quoteListingEntitlement(env, args);
  } catch {
    return { ok: false, error: "charge_failed" };
  }
  const period = quote.period;

  try {
    const existing = await readEntitlement(db, args.listingId, period);
    if (existing) {
      return {
        ok: true, ...quote,
        source: existing.source === "paid" ? "paid" : "free",
        amount: existing.source === "paid" ? quote.amount : 0,
        charged: Number(existing.charged ?? 0),
        expires_at: Number(existing.expires_at ?? quote.expires_at),
        balance: quote.paid_balance,
      };
    }

    const op = await ensureOperation(db, {
      listingId: args.listingId, period, uid: args.uid, vertical: args.vertical,
      decision: quote, feeEnabled: quote.fee_enabled, now,
    });
    const source = String(op.source) === "paid" ? "paid" : "free";
    const opExpires = Number(op.entitlement_expires_at) || quote.expires_at;
    const opId = source === "paid" ? String(op.wallet_op_id) : null;

    // A prior request charged successfully but died before writing the D1 grant.
    // Finish the grant from the durable operation; never call WalletDO again.
    if (source === "paid" && (op.state === "charged" || op.state === "entitled")) {
      const charged = Number(op.wallet_charged ?? op.amount ?? quote.amount);
      const row = await writeEntitlement(db, {
        listingId: args.listingId, period, uid: args.uid, source, charged,
        opId, periodStart: Number(op.created_at) || now, expiresAt: opExpires,
      });
      await updateOperation(db, args.listingId, period, { state: "entitled", now });
      return {
        ok: true, ...quote, source, amount: Number(op.amount ?? quote.amount), charged,
        expires_at: Number(row.expires_at),
        balance: op.wallet_balance_after == null ? quote.paid_balance : Number(op.wallet_balance_after),
      };
    }

    if (source === "free") {
      const row = await writeEntitlement(db, {
        listingId: args.listingId, period, uid: args.uid, source, charged: 0,
        opId: null, periodStart: Number(op.created_at) || now, expiresAt: opExpires,
      });
      await updateOperation(db, args.listingId, period, { state: "entitled", now });
      return { ok: true, ...quote, source, amount: 0, charged: 0, expires_at: Number(row.expires_at), balance: quote.paid_balance };
    }

    await updateOperation(db, args.listingId, period, { state: "charging", now, lastError: null });
    const feeKey = feeKeyFor(args.vertical);
    const charge = await chargeFeature(env, args.uid, feeKey, opId, {
      // Marketplace money is never funded by daily free/bonus AI tokens. forceMeter
      // keeps a global beta bypass from silently waiving a real listing fee; the
      // listingFeeEnabled flag still controls whether this path is paid at all.
      allowFree: false,
      forceMeter: true,
      meta: { category: "market", context: "Marketplace listing fee" },
    });
    if (!charge.ok) {
      await updateOperation(db, args.listingId, period, {
        state: "failed", now, lastError: String(charge.reason ?? "wallet_error"),
      });
      if (charge.reason === "insufficient") return { ok: false, error: "insufficient_funds", needed: Number(op.amount ?? quote.amount), quote };
      return { ok: false, error: "charge_failed", quote };
    }

    const charged = Number(charge.charged ?? op.amount ?? quote.amount);
    await updateOperation(db, args.listingId, period, {
      state: "charged", walletCharged: charged, walletBalanceAfter: charge.balance ?? null, now,
    });
    let row: any;
    try {
      row = await writeEntitlement(db, {
        listingId: args.listingId, period, uid: args.uid, source, charged,
        opId, periodStart: Number(op.created_at) || now, expiresAt: opExpires,
      });
    } catch {
      // The wallet debit is durable and the operation is intentionally left in
      // `charged`; the next publish retry materializes the entitlement.
      return { ok: false, error: "recovery_required", quote };
    }
    await updateOperation(db, args.listingId, period, { state: "entitled", now });
    return {
      ok: true, ...quote, source, charged, expires_at: Number(row.expires_at),
      balance: charge.balance == null ? quote.paid_balance : Number(charge.balance),
    };
  } catch {
    return { ok: false, error: "charge_failed", quote };
  }
}

/** Mark the latest completed entitlement as published after the listing status flip. */
export async function markListingEntitlementPublished(
  env: Env,
  args: { listingId: string; period?: number; now?: number },
): Promise<boolean> {
  try {
    await ensureListingBillingSchema(env);
    const db = metaDb(env);
    const period = args.period ?? Number((await db.prepare(
      "SELECT MAX(period) AS period FROM listing_entitlement_operations WHERE listing_id=?1",
    ).bind(args.listingId).first<any>())?.period ?? 0);
    if (!period) return false;
    const current = await readOperation(db, args.listingId, period);
    if (!current) return false;
    if (String(current.state) !== "published") {
      if (String(current.state) !== "entitled") return false;
      await updateOperation(db, args.listingId, period, { state: "published", now: args.now ?? Date.now() });
    }
    const verified = await readOperation(db, args.listingId, period);
    return String(verified?.state) === "published";
  } catch { return false; }
}

/**
 * Atomically finalize a classic listing publication and its entitlement
 * operation. The wallet debit happens before this boundary; the same D1 batch
 * makes it impossible for a successful call to leave only one half committed.
 */
export async function finalizeListingPublication(
  env: Env,
  args: { listingId: string; period: number; expiresAt: number; now?: number },
): Promise<boolean> {
  try {
    await ensureListingBillingSchema(env);
    const db = metaDb(env);
    const now = args.now ?? Date.now();
    const op = await readOperation(db, args.listingId, args.period);
    if (!op || !["entitled", "published"].includes(String(op.state))) return false;
    const listing = await db.prepare("SELECT status FROM listings WHERE id=?1").bind(args.listingId).first<any>();
    if (!listing || !["draft", "published"].includes(String(listing.status))) return false;

    await db.batch([
      db.prepare(
        "UPDATE listings SET status='published', expires_at=?2, updated_at=?3 WHERE id=?1 AND status IN ('draft','published')",
      ).bind(args.listingId, args.expiresAt, now),
      db.prepare(
        "UPDATE listing_entitlement_operations SET state='published', updated_at=?3 WHERE listing_id=?1 AND period=?2 AND state IN ('entitled','published')",
      ).bind(args.listingId, args.period, now),
    ]);

    const [publishedListing, publishedOp] = await Promise.all([
      db.prepare("SELECT status, expires_at FROM listings WHERE id=?1").bind(args.listingId).first<any>(),
      readOperation(db, args.listingId, args.period),
    ]);
    return String(publishedListing?.status) === "published"
      && Number(publishedListing?.expires_at) === args.expiresAt
      && String(publishedOp?.state) === "published";
  } catch { return false; }
}
