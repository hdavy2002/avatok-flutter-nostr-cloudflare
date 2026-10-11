// [HF-STD-PLAN-1] Explicit balance migration to rupee lots. Owner decision: people KEEP what they already got; this is NOT a relabel.
//
// A "rupee lot" is value 100 paise per unit with a whole number of paise (tokens_left_micro % 10_000 == 0). Everything else (gp-v1 lots at
// value 82, or any lot holding a fraction of a paisa) is converted once:
//   spendable paise = floor(left_micro x value / 1e6)   (the exact boundary planSpend / balanceSummary already use: balances do not change)
//   old lot  -> status 'migrated', tokens_left_micro 0, ledger row `hfmig:<lotId>` (kind admin_adjust, delta -left, rupee_value = paise)
//   new lot  -> gp-r2, value 100, micro = paise x 10_000, same kind, paid_paise / gst_paise / provider / provider_ref carried over,
//               source_lot_id = old lot id, ledger row `hfmigcr:<lotId>` (created through creditLot, then recorded as admin_adjust so the
//               wallet history never shows a second top-up).
//
// WHY status 'migrated' (a NEW value) and not 'revoked': every reader filters status='active' (getLots, debts, reserve, spend, refund
// lookup), so a closed lot is invisible to money paths either way. 'revoked' means "a Google refund removed this lot" and the refund code and
// reports key on that meaning; reusing it would make a migrated lot look like a refund. Nothing compares against 'migrated', and toLot()
// maps any non-'revoked' status to "active" only on rows that were already selected as active, so the new value cannot leak into a balance.
//
// Safety: lots with a reservation (a call in progress) are skipped and reported. Each lot is two idempotent steps: (1) close the old lot
// behind a guarded gate row, (2) credit/repair the new lot under its own op id, (3) write hfmigdone only after every invariant validates.
// A crash anywhere before finalization is healed on the next run. Re-running changes nothing. Dry run (default) writes nothing.
import type { Env } from "../types";
import { creditLot } from "./hf_token_ledger";
import { MICRO, MICRO_PER_PAISA, PRICING_GP_R2, RUPEE_LOT_VALUE_PAISE, paiseToMicro } from "./hf_token_math";

export const MIGRATED_STATUS = "migrated";
export const migOpId = (lotId: string) => `hfmig:${lotId}`;
export const migCreditOpId = (lotId: string) => `hfmigcr:${lotId}`;
export const migDoneOpId = (lotId: string) => `hfmigdone:${lotId}`;

interface LotRow {
  row_id: number;
  id: string; uid: string; kind: string; pricing_version: string; redemption_paise_per_token: number;
  tokens_granted_micro: number; tokens_left_micro: number; tokens_reserved_micro: number; paid_paise: number;
  provider: string | null; provider_ref: string | null; gst_paise: number | null; created_at: number;
}
const COLS = "id, uid, kind, pricing_version, redemption_paise_per_token, tokens_granted_micro, tokens_left_micro, tokens_reserved_micro, paid_paise, provider, provider_ref, gst_paise, created_at";

/** Pure: does this lot need converting? (rupee-exact lots are left alone.) */
export function needsRupeeMigration(l: { redemption_paise_per_token: number; tokens_left_micro: number }): boolean {
  return Number(l.redemption_paise_per_token) !== RUPEE_LOT_VALUE_PAISE || Number(l.tokens_left_micro) % MICRO_PER_PAISA !== 0;
}
/** Pure: spendable paise of a lot (floor), the same boundary the balance uses. */
export function spendablePaise(leftMicro: number, valuePaisePerToken: number): number {
  return Number((BigInt(Math.max(0, Math.trunc(leftMicro))) * BigInt(Math.max(0, Math.trunc(valuePaisePerToken)))) / BigInt(MICRO));
}

export interface MigratedLot {
  lotId: string; newLotId: string | null; uid: string; kind: string; fromPricingVersion: string; fromValuePaisePerToken: number;
  leftMicroBefore: number; beforePaise: number; afterPaise: number; /** closed but the new lot was created on a later step / run */ resumed: boolean;
}
export interface SkippedLot { lotId: string; uid: string; reason: "reserved" | "conflict" | "credit_failed" | "dust_purchase"; reservedMicro: number; beforePaise: number }
export interface MigrationReport {
  dryRun: boolean;
  batches: number;
  scanned: number;
  migrated: MigratedLot[];
  skipped: SkippedLot[];
  perUser: Array<{ uid: string; lots: number; beforePaise: number; afterPaise: number; skippedLots: number }>;
  totals: { lots: number; beforePaise: number; afterPaise: number; skippedLots: number };
  /** Previously closed rows repaired/finalized in this run; unfinished migratable rows after this run; done iff remaining is zero. */
  repaired: number; remaining: number; done: boolean;
}

async function creditNew(env: Env, old: LotRow, paise: number): Promise<{ lotId: string | null; ok: boolean }> {
  const db = env.DB_META;
  if (paise <= 0) {
    await db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id,uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,purchase_id,op_id,note,created_at)
       VALUES (?1,?2,'admin_adjust',?3,0,0,NULL,?4,?5,'hf_std_migration',?6)`,
    ).bind(crypto.randomUUID(), old.uid, old.id, old.provider_ref, migDoneOpId(old.id), Date.now()).run();
    return { lotId: null, ok: true }; // nothing spendable: the old lot is simply closed
  }
  const r = await creditLot(env, old.uid, {
    kind: old.kind as "purchase" | "test" | "adjustment", pricingVersion: PRICING_GP_R2.id, valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(paise),
    paidPaise: Number(old.paid_paise), gstPaise: Number(old.gst_paise ?? 0), provider: old.provider, providerRef: old.provider_ref,
    note: "hf_std_migration", sourceLotId: old.id,
  }, migCreditOpId(old.id));
  if (!r.lotId) return { lotId: null, ok: false };
  // The new lot keeps the OLD lot's history in rupee terms: granted = what the old lot was granted (floor, at its own value) and the old
  // purchase date. Without this a partly spent purchase looked untouched (granted == left): the refund share paid x left / granted became the
  // WHOLE price (and "whole order" sent it to Google's full refund), a Google void created no debt for the spent part, and the 180-day refund
  // window restarted on migration day.
  const grantedPaise = Math.max(paise, spendablePaise(Number(old.tokens_granted_micro), Number(old.redemption_paise_per_token)));
  await db.prepare(
    `UPDATE hf_token_lots SET uid=?2, kind=?3, pricing_version=?4, redemption_paise_per_token=?5, tokens_granted_micro=?6,
       paid_paise=?7, provider=?8, provider_ref=?9, created_at=?10, status='active', gst_paise=?11, source_lot_id=?12
     WHERE id=?1`,
  ).bind(r.lotId, old.uid, old.kind, PRICING_GP_R2.id, RUPEE_LOT_VALUE_PAISE, paiseToMicro(grantedPaise), Number(old.paid_paise), old.provider,
    old.provider_ref, Number(old.created_at), Number(old.gst_paise ?? 0), old.id).run();
  // Repair the idempotent credit row too: it is migration history (not a second top-up), and must retain the old purchase linkage/date.
  await db.prepare(
    `UPDATE hf_token_ledger SET uid=?2,kind='admin_adjust',lot_id=?3,delta_micro=?4,rupee_value_paise=?5,call_id=NULL,
       purchase_id=?6,note='hf_std_migration',created_at=?7 WHERE op_id=?1`,
  ).bind(migCreditOpId(old.id), old.uid, r.lotId, paiseToMicro(paise), paise, old.provider_ref, Number(old.created_at)).run();
  // The Google purchase record follows the live lot, so a later Google refund removes the money that is still there.
  await db.prepare("UPDATE hf_play_purchases SET lot_id=?2 WHERE lot_id=?1").bind(old.id, r.lotId).run().catch(() => undefined);
  // Validate the complete repaired state before writing the final marker. The live balance may have been spent after a crash, so left/reserved
  // are range-checked rather than reset; immutable grant/provenance/history fields must match exactly and no purchase may still point at old.
  const lot = await db.prepare(
    `SELECT uid,kind,pricing_version,redemption_paise_per_token,tokens_granted_micro,tokens_left_micro,tokens_reserved_micro,paid_paise,
            provider,provider_ref,created_at,status,gst_paise,source_lot_id FROM hf_token_lots WHERE id=?1`,
  ).bind(r.lotId).first<any>().catch(() => null);
  const led = await db.prepare("SELECT uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,purchase_id,note,created_at FROM hf_token_ledger WHERE op_id=?1")
    .bind(migCreditOpId(old.id)).first<any>().catch(() => null);
  const oldLinks = Number((await db.prepare("SELECT COUNT(*) AS n FROM hf_play_purchases WHERE lot_id=?1").bind(old.id).first<{ n: number }>().catch(() => null))?.n ?? 0);
  const exact = !!lot && lot.uid === old.uid && lot.kind === old.kind && lot.pricing_version === PRICING_GP_R2.id
    && Number(lot.redemption_paise_per_token) === RUPEE_LOT_VALUE_PAISE && Number(lot.tokens_granted_micro) === paiseToMicro(grantedPaise)
    && Number(lot.tokens_left_micro) >= 0 && Number(lot.tokens_left_micro) <= Number(lot.tokens_granted_micro)
    && Number(lot.tokens_reserved_micro) >= 0 && Number(lot.tokens_reserved_micro) <= Number(lot.tokens_left_micro)
    && Number(lot.paid_paise) === Number(old.paid_paise) && (lot.provider ?? null) === old.provider && (lot.provider_ref ?? null) === old.provider_ref
    && Number(lot.created_at) === Number(old.created_at) && lot.status === "active" && Number(lot.gst_paise ?? 0) === Number(old.gst_paise ?? 0)
    && lot.source_lot_id === old.id && !!led && led.uid === old.uid && led.kind === "admin_adjust" && led.lot_id === r.lotId
    && Number(led.delta_micro) === paiseToMicro(paise) && Number(led.rupee_value_paise) === paise && (led.purchase_id ?? null) === old.provider_ref
    && led.call_id == null && led.note === "hf_std_migration" && Number(led.created_at) === Number(old.created_at)
    && oldLinks === 0;
  if (!exact) return { lotId: r.lotId, ok: false };
  await db.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id,uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,purchase_id,op_id,note,created_at)
     VALUES (?1,?2,'admin_adjust',?3,0,?4,NULL,?5,?6,'hf_std_migration',?7)`,
  ).bind(crypto.randomUUID(), old.uid, r.lotId, paise, old.provider_ref, migDoneOpId(old.id), Date.now()).run();
  return { lotId: r.lotId, ok: true };
}

/** Close the old lot behind a guarded gate row. true = closed by this call; false = guard failed (lot changed) or already closed. */
async function closeOld(env: Env, l: LotRow, paise: number): Promise<boolean> {
  const db = env.DB_META, now = Date.now(), nonce = crypto.randomUUID(), op = migOpId(l.id);
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       SELECT ?1,?2,'admin_adjust',?3,?4,?5,NULL,?6,?7,?8,?9
        WHERE EXISTS (SELECT 1 FROM hf_token_lots WHERE id=?3 AND status='active' AND tokens_left_micro=?10 AND tokens_reserved_micro=0)`,
    ).bind(crypto.randomUUID(), l.uid, l.id, -Number(l.tokens_left_micro), paise, l.provider_ref, op, nonce, now, Number(l.tokens_left_micro)),
    db.prepare(`UPDATE hf_token_lots SET tokens_left_micro=0, status='${MIGRATED_STATUS}' WHERE id=?1 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?2 AND note=?3)`)
      .bind(l.id, op, nonce),
  ]);
  const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(op).first<{ note: string | null }>();
  if (g?.note !== nonce) return false;
  await db.prepare("UPDATE hf_token_ledger SET note='hf_std_migration' WHERE op_id=?1").bind(op).run();
  return true;
}

export async function migrateLotsToRupees(env: Env, o: { dryRun?: boolean; batchSize?: number } = {}): Promise<MigrationReport> {
  const dryRun = o.dryRun !== false;
  const db = env.DB_META;
  const migrated: MigratedLot[] = [], skipped: SkippedLot[] = [];
  const BATCH = Number.isInteger(o.batchSize) ? Math.min(1000, Math.max(1, Number(o.batchSize))) : 250;
  let batches = 0;

  // (a) lots closed by an earlier run but not fully finalized. A credit marker alone is insufficient: reruns repair and validate every invariant.
  const pendingHighWater = Number((await db.prepare(
    `SELECT COALESCE(MAX(t.rowid),0) AS n FROM hf_token_lots t JOIN hf_token_ledger g ON g.op_id = 'hfmig:' || t.id
      WHERE t.status='${MIGRATED_STATUS}' AND NOT EXISTS (SELECT 1 FROM hf_token_ledger c WHERE c.op_id = 'hfmigdone:' || t.id)`,
  ).first<{ n: number }>().catch(() => null))?.n ?? 0);
  let pendingCursor = 0;
  while (pendingCursor < pendingHighWater) {
    const pending = (await db.prepare(
    `SELECT t.rowid AS row_id, ${COLS.split(", ").map((c) => `t.${c}`).join(", ")}, g.rupee_value_paise AS mig_paise FROM hf_token_lots t
       JOIN hf_token_ledger g ON g.op_id = 'hfmig:' || t.id
      WHERE t.status='${MIGRATED_STATUS}' AND t.rowid>?1 AND t.rowid<=?2
        AND NOT EXISTS (SELECT 1 FROM hf_token_ledger c WHERE c.op_id = 'hfmigdone:' || t.id)
      ORDER BY t.rowid LIMIT ${BATCH}`,
    ).bind(pendingCursor, pendingHighWater).all<LotRow & { mig_paise: number }>().catch(() => ({ results: [] as Array<LotRow & { mig_paise: number }> }))).results ?? [];
    if (!pending.length) break;
    batches++;
    for (const l of pending) {
      pendingCursor = Math.max(pendingCursor, Number(l.row_id));
      const paise = Math.max(0, Math.trunc(Number(l.mig_paise)));
      let newId: string | null = null;
      if (!dryRun) {
        const c = await creditNew(env, l, paise);
        if (!c.ok) { skipped.push({ lotId: l.id, uid: l.uid, reason: "credit_failed", reservedMicro: 0, beforePaise: paise }); continue; }
        newId = c.lotId;
      }
      migrated.push({ lotId: l.id, newLotId: newId, uid: l.uid, kind: l.kind, fromPricingVersion: l.pricing_version, fromValuePaisePerToken: Number(l.redemption_paise_per_token),
        leftMicroBefore: 0, beforePaise: paise, afterPaise: paise, resumed: true });
    }
  }

  // (b) active lots that are not rupee-exact. Cursor batches walk the complete start-of-run high-water mark; reserved/dust rows are reported
  // once and cannot trap a LIMIT query at the front forever. New legacy lots created concurrently belong to the next explicit run.
  const activeHighWater = Number((await db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM hf_token_lots").first<{ n: number }>())?.n ?? 0);
  let activeCursor = 0;
  while (activeCursor < activeHighWater) {
    const rows = (await db.prepare(
      `SELECT rowid AS row_id, ${COLS} FROM hf_token_lots WHERE rowid>?3 AND rowid<=?4 AND status='active' AND tokens_left_micro>0
          AND (redemption_paise_per_token != ?1 OR tokens_left_micro % ?2 != 0) ORDER BY rowid ASC LIMIT ${BATCH}`,
    ).bind(RUPEE_LOT_VALUE_PAISE, MICRO_PER_PAISA, activeCursor, activeHighWater).all<LotRow>()).results ?? [];
    if (!rows.length) break;
    batches++;
    for (const l of rows) {
      activeCursor = Math.max(activeCursor, Number(l.row_id));
      const paise = spendablePaise(Number(l.tokens_left_micro), Number(l.redemption_paise_per_token));
      if (Number(l.tokens_reserved_micro) > 0) {
        skipped.push({ lotId: l.id, uid: l.uid, reason: "reserved", reservedMicro: Number(l.tokens_reserved_micro), beforePaise: paise });
        continue;
      }
      if (l.kind === "purchase" && paise <= 0) {
        // Less than a paisa left: nothing to move. Closing it would orphan the Google purchase (hf_play_purchases still points here), so a later
        // Google void would retry forever and never record the debt for what was spent. It stays as it is (worth Rs 0.00 in every balance).
        skipped.push({ lotId: l.id, uid: l.uid, reason: "dust_purchase", reservedMicro: 0, beforePaise: 0 });
        continue;
      }
      let newId: string | null = null;
      if (!dryRun) {
        if (!(await closeOld(env, l, paise))) { skipped.push({ lotId: l.id, uid: l.uid, reason: "conflict", reservedMicro: 0, beforePaise: paise }); continue; }
        const c = await creditNew(env, l, paise);
        if (!c.ok) { skipped.push({ lotId: l.id, uid: l.uid, reason: "credit_failed", reservedMicro: 0, beforePaise: paise }); continue; }
        newId = c.lotId;
      }
      migrated.push({ lotId: l.id, newLotId: newId, uid: l.uid, kind: l.kind, fromPricingVersion: l.pricing_version, fromValuePaisePerToken: Number(l.redemption_paise_per_token),
        leftMicroBefore: Number(l.tokens_left_micro), beforePaise: paise, afterPaise: paise, resumed: false });
    }
  }

  const per = new Map<string, { uid: string; lots: number; beforePaise: number; afterPaise: number; skippedLots: number }>();
  const u = (uid: string) => { let x = per.get(uid); if (!x) { x = { uid, lots: 0, beforePaise: 0, afterPaise: 0, skippedLots: 0 }; per.set(uid, x); } return x; };
  for (const m of migrated) { const x = u(m.uid); x.lots++; x.beforePaise += m.beforePaise; x.afterPaise += m.afterPaise; }
  for (const s of skipped) { const x = u(s.uid); x.skippedLots++; }
  const pendingRemaining = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM hf_token_lots t JOIN hf_token_ledger g ON g.op_id='hfmig:' || t.id
      WHERE t.status='${MIGRATED_STATUS}' AND NOT EXISTS (SELECT 1 FROM hf_token_ledger d WHERE d.op_id='hfmigdone:' || t.id)`,
  ).first<{ n: number }>().catch(() => null))?.n ?? 0);
  const activeRemaining = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM hf_token_lots WHERE status='active' AND tokens_left_micro>0
       AND (redemption_paise_per_token != ?1 OR tokens_left_micro % ?2 != 0)
       AND NOT (kind='purchase' AND tokens_left_micro * redemption_paise_per_token < ?3)`,
  ).bind(RUPEE_LOT_VALUE_PAISE, MICRO_PER_PAISA, MICRO).first<{ n: number }>().catch(() => null))?.n ?? 0);
  const remaining = pendingRemaining + activeRemaining;
  return {
    dryRun, batches, scanned: migrated.length + skipped.length, migrated, skipped, perUser: [...per.values()],
    totals: {
      lots: migrated.length, beforePaise: migrated.reduce((t, m) => t + m.beforePaise, 0), afterPaise: migrated.reduce((t, m) => t + m.afterPaise, 0), skippedLots: skipped.length,
    },
    repaired: dryRun ? 0 : migrated.filter((m) => m.resumed).length, remaining, done: remaining === 0,
  };
}
