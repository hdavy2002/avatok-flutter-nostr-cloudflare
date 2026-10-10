// [HF-TOK-LEDGER-1] HF token-lot ledger on D1 (DB_META). Spec: section 11 of the HF Android app spec (11.3 data model, 11.4 maths).
// Tables: hf_token_lots (one per purchase / test grant, frozen value per token), hf_token_ledger (append-only, UNIQUE op_id),
// hf_token_debts (amount owed after a refund of spent tokens). Maths (planSpend, microForValue, applyRefund) is in hf_token_math.ts.
//
// Rules this file keeps:
//  - Units: tokens are MICRO-tokens (1 token = 1_000_000), rupees are PAISE. Integers only.
//  - Every mutation is ONE D1 batch and idempotent through the UNIQUE ledger op_id. The "gate" row (op_id) is inserted with a nonce
//    and ONLY when every guard in the same statement still holds; every later statement of the batch is conditional on that nonce.
//    So a batch either applies completely or not at all, and two concurrent callers cannot both pass the same guard.
//  - On a lost race the plan is recomputed ONCE from fresh lots, then we fail closed ({ ok:false, reason:"conflict" }).
//  - Lots are used OLDEST FIRST and never revalued. Reservations are held INSIDE tokens_left (available = left - reserved).
//  - Gate rows carry delta_micro 0 (kind decides the meaning); the per-lot rows carry the amounts, so SUMs never double count.
import type { Env } from "../types";
import { planSpend, microForValue, applyRefund, PRICING_GP_V1, MICRO, type Lot } from "./hf_token_math";

export const resOpId = (callId: string) => `hftres:${callId}`;
export const relOpId = (callId: string) => `hftrel:${callId}`;
export const setOpId = (callId: string) => `hftset:${callId}`;
const sub = (base: string, lotId: string) => `${base}:${lotId}`;

export type LotKind = "purchase" | "test" | "adjustment";
export interface TokenLot {
  id: string; uid: string; kind: LotKind; pricingVersion: string; valuePaisePerToken: number;
  grantedMicro: number; leftMicro: number; reservedMicro: number; paidPaise: number;
  provider: string | null; providerRef: string | null; createdAt: number; status: "active" | "revoked";
}
interface LotRow {
  id: string; uid: string; kind: string; pricing_version: string; redemption_paise_per_token: number;
  tokens_granted_micro: number; tokens_left_micro: number; tokens_reserved_micro: number; paid_paise: number;
  provider: string | null; provider_ref: string | null; created_at: number; status: string;
}
const toLot = (r: LotRow): TokenLot => ({
  id: r.id, uid: r.uid, kind: r.kind as LotKind, pricingVersion: r.pricing_version, valuePaisePerToken: Number(r.redemption_paise_per_token),
  grantedMicro: Number(r.tokens_granted_micro), leftMicro: Number(r.tokens_left_micro), reservedMicro: Number(r.tokens_reserved_micro),
  paidPaise: Number(r.paid_paise), provider: r.provider, providerRef: r.provider_ref, createdAt: Number(r.created_at), status: r.status === "revoked" ? "revoked" : "active",
});

const BI = (n: number) => BigInt(Math.max(0, Math.trunc(n)));
/** Rupee value of micro-tokens at a lot's value, rounded half up (display / ledger only; the call split uses planSpend values). */
export function valuePaiseOfMicro(micro: number, valuePaisePerToken: number): number {
  return Number((2n * BI(micro) * BI(valuePaisePerToken) + BigInt(MICRO)) / (2n * BigInt(MICRO)));
}
/** Paise a lot with `micro` tokens left can absorb (floor), same boundary planSpend uses. */
const capPaise = (micro: number, v: number): number => Number((BI(micro) * BI(v)) / BigInt(MICRO));

// ── reads ───────────────────────────────────────────────────────────────────

/** Active lots with tokens left, OLDEST first. */
export async function getLots(env: Env, uid: string): Promise<TokenLot[]> {
  const r = await env.DB_META.prepare(
    "SELECT * FROM hf_token_lots WHERE uid=?1 AND status='active' AND tokens_left_micro>0 ORDER BY created_at ASC, rowid ASC",
  ).bind(uid).all<LotRow>();
  return (r.results ?? []).map(toLot);
}

/** Lots as the maths wants them: leftMicro = what is free to spend (left - reserved). */
export async function availableLots(env: Env, uid: string): Promise<Lot[]> {
  return (await getLots(env, uid))
    .map((l) => ({ id: l.id, valuePaisePerToken: l.valuePaisePerToken, leftMicro: Math.max(0, l.leftMicro - l.reservedMicro) }))
    .filter((l) => l.leftMicro > 0);
}

export interface BalanceSummary {
  /** All tokens held, including those reserved for a call in progress. */
  totalMicro: number;
  /** Tokens free to spend right now. */
  availableMicro: number;
  /** Free-to-spend tokens grouped by redemption value, in order of first use (oldest lot first). */
  byValue: Array<{ valuePaisePerToken: number; micro: number }>;
  debtMicro: number;
  debtValuePaise: number;
}
export async function balanceSummary(env: Env, uid: string): Promise<BalanceSummary> {
  const lots = await getLots(env, uid);
  let total = 0, avail = 0;
  const by = new Map<number, number>();
  for (const l of lots) {
    total += l.leftMicro;
    const a = Math.max(0, l.leftMicro - l.reservedMicro);
    avail += a;
    if (a > 0) by.set(l.valuePaisePerToken, (by.get(l.valuePaisePerToken) ?? 0) + a);
  }
  const d = await env.DB_META.prepare("SELECT COALESCE(SUM(amount_micro),0) AS m, COALESCE(SUM(value_paise),0) AS p FROM hf_token_debts WHERE uid=?1 AND status='open'")
    .bind(uid).first<{ m: number; p: number }>();
  return {
    totalMicro: total, availableMicro: avail,
    byValue: [...by.entries()].map(([valuePaisePerToken, micro]) => ({ valuePaisePerToken, micro })),
    debtMicro: Number(d?.m ?? 0), debtValuePaise: Number(d?.p ?? 0),
  };
}

export async function hasOpenDebt(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_debts WHERE uid=?1 AND status='open' LIMIT 1").bind(uid).first();
  return !!r;
}

export interface PricingRow { id: string; provider: string; purchasePaisePerToken: number; redemptionPaisePerToken: number; providerFeeBps: number }
/** The pricing version row by id; gp-v1 falls back to the built-in constants when the seed is not applied. Null = unknown version. */
export async function getPricingVersion(env: Env, id: string): Promise<PricingRow | null> {
  const r = await env.DB_META.prepare(
    "SELECT id, provider, purchase_paise_per_token AS p, redemption_paise_per_token AS v, provider_fee_bps AS f FROM hf_pricing_versions WHERE id=?1",
  ).bind(id).first<{ id: string; provider: string; p: number; v: number; f: number }>().catch(() => null);
  if (r) return { id: r.id, provider: r.provider, purchasePaisePerToken: Number(r.p), redemptionPaisePerToken: Number(r.v), providerFeeBps: Number(r.f) };
  if (id === PRICING_GP_V1.id) {
    return { id, provider: PRICING_GP_V1.provider, purchasePaisePerToken: PRICING_GP_V1.purchasePaisePerToken, redemptionPaisePerToken: PRICING_GP_V1.redemptionPaisePerToken, providerFeeBps: PRICING_GP_V1.providerFeeBps };
  }
  return null;
}

// ── credit ──────────────────────────────────────────────────────────────────

export interface CreditArgs {
  kind: LotKind; pricingVersion: string; valuePaisePerToken: number; micro: number; paidPaise: number;
  provider: string | null; providerRef: string | null; note?: string;
}
export type CreditResult = { applied: boolean; lotId: string | null };

/**
 * Create a lot. Same opId twice = one lot (the second call returns applied:false and the first lot's id). A `purchase` lot then pays
 * any open debt first (clearDebtsFromLot, itself idempotent), also on a retry, so a crash between the two steps heals.
 */
export async function creditLot(env: Env, uid: string, a: CreditArgs, opId: string): Promise<CreditResult> {
  if (!Number.isInteger(a.micro) || a.micro <= 0) return { applied: false, lotId: null };
  if (!Number.isInteger(a.valuePaisePerToken) || a.valuePaisePerToken <= 0) return { applied: false, lotId: null };
  const paid = Math.max(0, Math.trunc(a.paidPaise));
  const now = Date.now(), nonce = crypto.randomUUID(), lotId = `lot_${crypto.randomUUID()}`;
  const db = env.DB_META;
  const ledgerKind = a.kind === "purchase" ? "purchase" : "admin_adjust";
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,?9,?10)`,
    ).bind(crypto.randomUUID(), uid, ledgerKind, lotId, a.micro, valuePaiseOfMicro(a.micro, a.valuePaisePerToken), a.providerRef, opId, nonce, now),
    db.prepare(
      `INSERT INTO hf_token_lots (id, uid, kind, pricing_version, redemption_paise_per_token, tokens_granted_micro, tokens_left_micro, tokens_reserved_micro, paid_paise, provider, provider_ref, created_at, status)
       SELECT ?1,?2,?3,?4,?5,?6,?6,0,?7,?8,?9,?10,'active' WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?11 AND note=?12)`,
    ).bind(lotId, uid, a.kind, a.pricingVersion, a.valuePaisePerToken, a.micro, paid, a.provider, a.providerRef, now, opId, nonce),
  ]);
  const row = await db.prepare("SELECT lot_id, note FROM hf_token_ledger WHERE op_id=?1").bind(opId).first<{ lot_id: string | null; note: string | null }>();
  const applied = row?.note === nonce;
  if (applied) await db.prepare("UPDATE hf_token_ledger SET note=?2 WHERE op_id=?1").bind(opId, (a.note ?? "").slice(0, 200) || null).run();
  const id = row?.lot_id ?? null;
  if (id && a.kind === "purchase") await clearDebtsFromLot(env, uid, id, opId);
  return { applied, lotId: id };
}

// ── debts ───────────────────────────────────────────────────────────────────

/** Record an amount owed. Idempotent per opId; the debt id is derived from it. */
export async function createDebt(
  env: Env, uid: string, a: { amountMicro: number; valuePaise: number; sourceOrderId: string | null }, opId: string,
): Promise<{ applied: boolean; debtId: string }> {
  const debtId = `d:${opId}`;
  if (!(a.amountMicro > 0) && !(a.valuePaise > 0)) return { applied: false, debtId };
  const now = Date.now(), nonce = crypto.randomUUID(), db = env.DB_META;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       VALUES (?1,?2,'debt_create',NULL,?3,?4,NULL,?5,?6,?7,?8)`,
    ).bind(crypto.randomUUID(), uid, Math.trunc(a.amountMicro), Math.trunc(a.valuePaise), a.sourceOrderId, opId, nonce, now),
    db.prepare(
      `INSERT INTO hf_token_debts (id, uid, amount_micro, value_paise, source_order_id, status, created_at)
       SELECT ?1,?2,?3,?4,?5,'open',?6 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?7 AND note=?8)`,
    ).bind(debtId, uid, Math.trunc(a.amountMicro), Math.trunc(a.valuePaise), a.sourceOrderId, now, opId, nonce),
  ]);
  const row = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(opId).first<{ note: string | null }>();
  const applied = row?.note === nonce;
  if (applied) await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(opId).run();
  return { applied, debtId };
}

/**
 * A new purchase lot pays open debts first, oldest debt first, at THIS lot's value. Partial when the lot is too small.
 * Op ids are per (credit op, debt) so a retry never charges the same debt twice. Returns the rupee value cleared.
 */
export async function clearDebtsFromLot(env: Env, uid: string, lotId: string, baseOpId: string): Promise<{ clearedValuePaise: number; microUsed: number }> {
  const db = env.DB_META;
  let clearedValue = 0, microUsed = 0;
  for (let guard = 0; guard < 20; guard++) {
    const debt = await db.prepare("SELECT id, amount_micro, value_paise FROM hf_token_debts WHERE uid=?1 AND status='open' ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .bind(uid).first<{ id: string; amount_micro: number; value_paise: number }>();
    if (!debt) break;
    const lot = await db.prepare("SELECT tokens_left_micro AS l, tokens_reserved_micro AS r, redemption_paise_per_token AS v, status FROM hf_token_lots WHERE id=?1")
      .bind(lotId).first<{ l: number; r: number; v: number; status: string }>();
    if (!lot || lot.status !== "active") break;
    const avail = Math.max(0, Number(lot.l) - Number(lot.r));
    const x = Math.min(Number(debt.value_paise), capPaise(avail, Number(lot.v)));
    if (x <= 0) break;
    const full = x === Number(debt.value_paise);
    const micro = Math.min(avail, microForValue(x, Number(lot.v)));
    const dm = full ? Number(debt.amount_micro) : Number((BI(Number(debt.amount_micro)) * BI(x)) / BI(Number(debt.value_paise)));
    const op = `hftdebt:${baseOpId}:${debt.id}`;
    const now = Date.now(), nonce = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'debt_clear',?3,?4,?5,NULL,NULL,?6,?7,?8
          WHERE EXISTS (SELECT 1 FROM hf_token_lots WHERE id=?3 AND status='active' AND tokens_left_micro - tokens_reserved_micro >= ?9)
            AND EXISTS (SELECT 1 FROM hf_token_debts WHERE id=?10 AND status='open' AND value_paise=?11)`,
      ).bind(crypto.randomUUID(), uid, lotId, -micro, x, op, nonce, now, micro, debt.id, Number(debt.value_paise)),
      db.prepare("UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro - ?1 WHERE id=?2 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
        .bind(micro, lotId, op, nonce),
      db.prepare(
        `UPDATE hf_token_debts SET value_paise = value_paise - ?1, amount_micro = MAX(0, amount_micro - ?2),
                status = CASE WHEN value_paise - ?1 <= 0 THEN 'cleared' ELSE 'open' END,
                cleared_at = CASE WHEN value_paise - ?1 <= 0 THEN ?3 ELSE cleared_at END
          WHERE id=?4 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?5 AND note=?6)`,
      ).bind(x, dm, now, debt.id, op, nonce),
    ]);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(op).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(op).run();
      clearedValue += x; microUsed += micro;
    } else if (g) {
      // The op exists from an earlier run but the debt still shows the old value: another worker is mid-way. Stop; a retry finishes.
      break;
    } else {
      break; // guard failed (lot or debt moved under us): the next credit/retry handles it
    }
  }
  return { clearedValuePaise: clearedValue, microUsed };
}

// ── refund / revoke (Google refund of a purchase lot) ───────────────────────

export interface RevokeResult { applied: boolean; found: boolean; removedMicro: number; debtMicro: number; debtValuePaise: number }
/**
 * Remove the unspent tokens of a lot (any reservation with them) and turn the spent part into a debt (applyRefund).
 * Host earnings are never touched. Idempotent per opId.
 */
export async function revokeLot(env: Env, lotId: string, opId: string): Promise<RevokeResult> {
  const db = env.DB_META;
  const none: RevokeResult = { applied: false, found: false, removedMicro: 0, debtMicro: 0, debtValuePaise: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const lot = await db.prepare("SELECT * FROM hf_token_lots WHERE id=?1").bind(lotId).first<LotRow>();
    if (!lot) return none;
    if (lot.status !== "active") {
      const prior = await db.prepare("SELECT delta_micro AS d FROM hf_token_ledger WHERE op_id=?1").bind(opId).first<{ d: number }>();
      return { ...none, found: true, removedMicro: prior ? -Number(prior.d) : 0 };
    }
    const l = toLot(lot);
    const plan = applyRefund({ grantedMicro: l.grantedMicro, leftMicro: l.leftMicro, reservedMicro: l.reservedMicro, valuePaisePerToken: l.valuePaisePerToken });
    const now = Date.now(), nonce = crypto.randomUUID();
    const stmts = [
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'refund_revoke',?3,?4,?5,NULL,?6,?7,?8,?9
          WHERE EXISTS (SELECT 1 FROM hf_token_lots WHERE id=?3 AND status='active' AND tokens_left_micro=?10 AND tokens_reserved_micro=?11)`,
      ).bind(crypto.randomUUID(), l.uid, lotId, -plan.removeMicro, valuePaiseOfMicro(plan.removeMicro, l.valuePaisePerToken), l.providerRef, opId, nonce, now, l.leftMicro, l.reservedMicro),
      db.prepare("UPDATE hf_token_lots SET tokens_left_micro=0, tokens_reserved_micro=0, status='revoked' WHERE id=?1 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?2 AND note=?3)")
        .bind(lotId, opId, nonce),
    ];
    if (plan.debtMicro > 0) {
      stmts.push(
        db.prepare(
          `INSERT INTO hf_token_debts (id, uid, amount_micro, value_paise, source_order_id, status, created_at)
           SELECT ?1,?2,?3,?4,?5,'open',?6 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?7 AND note=?8)`,
        ).bind(`d:${opId}`, l.uid, plan.debtMicro, plan.debtValuePaise, l.providerRef, now, opId, nonce),
        db.prepare(
          `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
           SELECT ?1,?2,'debt_create',?3,?4,?5,NULL,?6,?7,NULL,?8 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?9 AND note=?10)`,
        ).bind(crypto.randomUUID(), l.uid, lotId, plan.debtMicro, plan.debtValuePaise, l.providerRef, `${opId}:debt`, now, opId, nonce),
      );
    }
    await db.batch(stmts);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(opId).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(opId).run();
      return { applied: true, found: true, removedMicro: plan.removeMicro, debtMicro: plan.debtMicro, debtValuePaise: plan.debtValuePaise };
    }
    if (g) return { ...none, found: true }; // this opId was already applied: nothing to do
    // lot changed between read and write (a spend landed): re-read once
  }
  return { ...none, found: true }; // fail closed: caller retries
}

// ── reserve / release / settle (calls) ──────────────────────────────────────

export interface ReservedLot { lotId: string; micro: number; valuePaise: number }
export type ReserveResult =
  | { ok: true; again: boolean; secondsCovered: number; reservedMicro: number; lots: ReservedLot[] }
  | { ok: false; reason: "insufficient" | "conflict" | "invalid" };

interface Reservation { uid: string; secondsCovered: number; lots: ReservedLot[] }
/** Reads what was reserved for a call from the ledger (gate row + per-lot rows). Null when this call never reserved. */
async function readReservation(env: Env, callId: string): Promise<Reservation | null> {
  const db = env.DB_META;
  const g = await db.prepare("SELECT uid, note FROM hf_token_ledger WHERE op_id=?1").bind(resOpId(callId)).first<{ uid: string; note: string | null }>();
  if (!g) return null;
  const rows = (await db.prepare(
    `SELECT l.lot_id AS lotId, l.delta_micro AS micro, l.rupee_value_paise AS valuePaise
       FROM hf_token_ledger l JOIN hf_token_lots t ON t.id = l.lot_id
      WHERE l.call_id=?1 AND l.kind='reserve' AND l.lot_id IS NOT NULL ORDER BY t.created_at ASC, t.rowid ASC`,
  ).bind(callId).all<ReservedLot>()).results ?? [];
  const m = /secs:(\d+)/.exec(g.note ?? "");
  return { uid: g.uid, secondsCovered: m ? Number(m[1]) : 0, lots: rows.map((r) => ({ lotId: r.lotId, micro: Number(r.micro), valuePaise: Number(r.valuePaise) })) };
}

/**
 * Hold, oldest lot first, the tokens a call of up to `seconds` needs at `ratePaise` (paise per minute). Reserves what the lots can pay
 * for (secondsCovered may be less than asked; the caller decides whether that is enough to start). Idempotent per callId.
 */
export async function reserveForCall(env: Env, uid: string, callId: string, ratePaise: number, seconds: number): Promise<ReserveResult> {
  if (!(ratePaise > 0) || !(seconds > 0)) return { ok: false, reason: "invalid" };
  const db = env.DB_META;
  const again = async (): Promise<ReserveResult | null> => {
    const r = await readReservation(env, callId);
    return r ? { ok: true, again: true, secondsCovered: r.secondsCovered, reservedMicro: r.lots.reduce((t, x) => t + x.micro, 0), lots: r.lots } : null;
  };
  const prior = await again();
  if (prior) return prior;
  for (let attempt = 0; attempt < 2; attempt++) {
    const lots = await availableLots(env, uid);
    const plan = planSpend(lots, ratePaise, seconds);
    if (plan.secondsCovered <= 0 || plan.uses.length === 0) return { ok: false, reason: "insufficient" };
    const now = Date.now(), nonce = crypto.randomUUID(), gate = resOpId(callId);
    // Gate guard: EVERY lot still has what we planned to take. Params: ?1 id ?2 uid ?3 value ?4 call ?5 op ?6 nonce ?7 now, then per lot (lotId, micro).
    const params: unknown[] = [crypto.randomUUID(), uid, plan.totalValuePaise, callId, gate, nonce, now];
    const guards = plan.uses.map((u) => {
      const a = params.length + 1, b = params.length + 2;
      params.push(u.lotId, u.micro);
      return `(SELECT COUNT(*) FROM hf_token_lots WHERE id=?${a} AND uid=?2 AND status='active' AND tokens_left_micro - tokens_reserved_micro >= ?${b})=1`;
    });
    const stmts = [
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'reserve',NULL,0,?3,?4,NULL,?5,?6,?7 WHERE ${guards.join(" AND ")}`,
      ).bind(...params),
    ];
    for (const u of plan.uses) {
      stmts.push(
        db.prepare("UPDATE hf_token_lots SET tokens_reserved_micro = tokens_reserved_micro + ?1 WHERE id=?2 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
          .bind(u.micro, u.lotId, gate, nonce),
        db.prepare(
          `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
           SELECT ?1,?2,'reserve',?3,?4,?5,?6,NULL,?7,NULL,?8 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?9 AND note=?10)`,
        ).bind(crypto.randomUUID(), uid, u.lotId, u.micro, u.valuePaise, callId, sub(gate, u.lotId), now, gate, nonce),
      );
    }
    await db.batch(stmts);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(gate).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=?2 WHERE op_id=?1").bind(gate, `secs:${plan.secondsCovered}`).run();
      return { ok: true, again: false, secondsCovered: plan.secondsCovered, reservedMicro: plan.totalMicro, lots: plan.uses.map((u) => ({ lotId: u.lotId, micro: u.micro, valuePaise: u.valuePaise })) };
    }
    if (g) { const p = await again(); if (p) return p; }
    // else: a concurrent reserve took tokens first; recompute once from fresh lots
  }
  return { ok: false, reason: "conflict" };
}

export async function getReservation(env: Env, callId: string): Promise<{ secondsCovered: number; lots: ReservedLot[] } | null> {
  const r = await readReservation(env, callId);
  return r ? { secondsCovered: r.secondsCovered, lots: r.lots } : null;
}

/** Give back everything held for a call that never settled (cancelled, failed). Idempotent; a no-op after settle. */
export async function release(env: Env, callId: string): Promise<{ released: boolean }> {
  const db = env.DB_META;
  const r = await readReservation(env, callId);
  if (!r) return { released: false };
  const done = await db.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id IN (?1,?2) LIMIT 1").bind(setOpId(callId), relOpId(callId)).first();
  if (done) return { released: false };
  const now = Date.now(), nonce = crypto.randomUUID(), gate = relOpId(callId);
  const stmts = [
    db.prepare(
      `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
       SELECT ?1,?2,'release',NULL,0,0,?3,NULL,?4,?5,?6 WHERE NOT EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?7)`,
    ).bind(crypto.randomUUID(), r.uid, callId, gate, nonce, now, setOpId(callId)),
  ];
  for (const x of r.lots) {
    stmts.push(
      db.prepare("UPDATE hf_token_lots SET tokens_reserved_micro = MAX(0, tokens_reserved_micro - ?1) WHERE id=?2 AND status='active' AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
        .bind(x.micro, x.lotId, gate, nonce),
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'release',?3,?4,0,?5,NULL,?6,NULL,?7 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?8 AND note=?9)`,
      ).bind(crypto.randomUUID(), r.uid, x.lotId, -x.micro, callId, sub(gate, x.lotId), now, gate, nonce),
    );
  }
  await db.batch(stmts);
  const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(gate).first<{ note: string | null }>();
  const applied = g?.note === nonce;
  if (applied) await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(gate).run();
  return { released: applied };
}

export interface SettleLotUse { lotId: string; kind: LotKind; valuePaisePerToken: number; micro: number; valuePaise: number }
export type SettleResult =
  | { ok: true; again: boolean; billableSeconds: number; shortfall: boolean; totalMicro: number; totalValuePaise: number; lots: SettleLotUse[] }
  | { ok: false; reason: "released" | "conflict" | "invalid" };

async function readSettlement(env: Env, callId: string): Promise<Extract<SettleResult, { ok: true }> | null> {
  const db = env.DB_META;
  const g = await db.prepare("SELECT note, rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(setOpId(callId)).first<{ note: string | null; v: number }>();
  if (!g) return null;
  const rows = (await db.prepare(
    `SELECT l.lot_id AS lotId, t.kind AS kind, t.redemption_paise_per_token AS valuePaisePerToken, -l.delta_micro AS micro, l.rupee_value_paise AS valuePaise
       FROM hf_token_ledger l JOIN hf_token_lots t ON t.id=l.lot_id
      WHERE l.call_id=?1 AND l.kind='spend' AND l.lot_id IS NOT NULL ORDER BY t.created_at ASC, t.rowid ASC`,
  ).bind(callId).all<SettleLotUse>()).results ?? [];
  const m = /secs:(\d+)(?:;short:(\d))?/.exec(g.note ?? "");
  const lots = rows.map((r) => ({ lotId: r.lotId, kind: r.kind as LotKind, valuePaisePerToken: Number(r.valuePaisePerToken), micro: Number(r.micro), valuePaise: Number(r.valuePaise) }));
  return { ok: true, again: true, billableSeconds: m ? Number(m[1]) : 0, shortfall: m?.[2] === "1", totalMicro: lots.reduce((t, x) => t + x.micro, 0), totalValuePaise: Number(g.v), lots };
}

/**
 * End of call. Spends `billableSeconds` (cut to the last whole second the lots can pay for) at `ratePaise` over the lots reserved for
 * this call, oldest first, plus further available lots if the reservation was too small; the unspent reservation is released. One batch.
 * Idempotent (op `hftset:<callId>`): a retry returns the first result. A call that never reserved can still settle from available lots.
 */
export async function settleCall(env: Env, uid: string, callId: string, ratePaise: number, billableSeconds: number): Promise<SettleResult> {
  if (!(ratePaise > 0) || !(billableSeconds >= 0)) return { ok: false, reason: "invalid" };
  const db = env.DB_META;
  const done = await readSettlement(env, callId);
  if (done) return done;
  if (await db.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(relOpId(callId)).first()) return { ok: false, reason: "released" };
  const gate = setOpId(callId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const rsv = await readReservation(env, callId);
    const held = new Map((rsv?.lots ?? []).map((x) => [x.lotId, x.micro]));
    const all = await getLots(env, uid);
    // Per lot: what the maths may spend = its reservation for this call + whatever is free beyond ALL reservations on it.
    const planLots: Lot[] = all
      .map((l) => ({ id: l.id, valuePaisePerToken: l.valuePaisePerToken, leftMicro: Math.min(l.leftMicro, (held.get(l.id) ?? 0) + Math.max(0, l.leftMicro - l.reservedMicro)) }))
      .filter((l) => l.leftMicro > 0);
    const plan = planSpend(planLots, ratePaise, Math.trunc(billableSeconds));
    const spend = new Map(plan.uses.map((u) => [u.lotId, u]));
    const touched = all.filter((l) => (held.get(l.id) ?? 0) > 0 || spend.has(l.id));
    const now = Date.now(), nonce = crypto.randomUUID();
    const finalNote = `secs:${plan.secondsCovered};short:${plan.shortfall ? 1 : 0}`;
    const params: unknown[] = [crypto.randomUUID(), uid, plan.totalValuePaise, callId, gate, nonce, now];
    const guards = touched.map((l) => {
      const id = params.length + 1;
      const u = spend.get(l.id)?.micro ?? 0, r = held.get(l.id) ?? 0;
      params.push(l.id, u, r);
      return `(SELECT COUNT(*) FROM hf_token_lots WHERE id=?${id} AND uid=?2 AND status='active' AND tokens_left_micro >= ?${id + 1} AND tokens_reserved_micro >= ?${id + 2} AND tokens_left_micro - ?${id + 1} >= tokens_reserved_micro - ?${id + 2})=1`;
    });
    const stmts = [
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'spend',NULL,0,?3,?4,NULL,?5,?6,?7 ${guards.length ? `WHERE ${guards.join(" AND ")}` : ""}`,
      ).bind(...params),
    ];
    for (const l of touched) {
      const u = spend.get(l.id), r = held.get(l.id) ?? 0, micro = u?.micro ?? 0;
      stmts.push(db.prepare(
        "UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro - ?1, tokens_reserved_micro = tokens_reserved_micro - ?2 WHERE id=?3 AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?4 AND note=?5)",
      ).bind(micro, r, l.id, gate, nonce));
      if (u && micro > 0) {
        stmts.push(db.prepare(
          `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
           SELECT ?1,?2,'spend',?3,?4,?5,?6,NULL,?7,NULL,?8 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?9 AND note=?10)`,
        ).bind(crypto.randomUUID(), uid, l.id, -micro, u.valuePaise, callId, sub(gate, l.id), now, gate, nonce));
      }
      if (r > micro) {
        stmts.push(db.prepare(
          `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
           SELECT ?1,?2,'release',?3,?4,0,?5,NULL,?6,NULL,?7 WHERE EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?8 AND note=?9)`,
        ).bind(crypto.randomUUID(), uid, l.id, -(r - micro), callId, `${sub(gate, l.id)}:rel`, now, gate, nonce));
      }
    }
    await db.batch(stmts);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(gate).first<{ note: string | null }>();
    if (g) {
      const applied = g.note === nonce;
      if (applied) await db.prepare("UPDATE hf_token_ledger SET note=?2 WHERE op_id=?1").bind(gate, finalNote).run();
      const res = await readSettlement(env, callId);
      if (res) return { ...res, again: !applied };
    }
    // guard failed (a refund or another call moved the lots): re-plan once
  }
  return { ok: false, reason: "conflict" };
}

