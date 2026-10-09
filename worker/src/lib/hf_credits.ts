
// [HF-WALLET-1] HF test credits (spend-only). Live in DB_META hf_credits, never in the WalletDO paid balance, so a host can never
// withdraw money that came from a free test call. Every mutation is one D1 batch (atomic) and idempotent through the UNIQUE
// hf_credit_ledger.op_id. Contract: Specs/HF-CALLS-CONTRACT.md (billing). Pure split math lives in hf_call_math.ts.
import type { Env } from "../types";

export const resOpId = (callId: string) => `hfres:${callId}`;
export const setOpId = (callId: string) => `hfset:${callId}`;

export async function getTestBalance(env: Env, uid: string): Promise<{ balance: number; reserved: number }> {
  const r = await env.DB_META.prepare("SELECT test_balance, test_reserved FROM hf_credits WHERE uid=?1").bind(uid).first<{ test_balance: number; test_reserved: number }>().catch(() => null);
  return { balance: Math.max(0, Math.trunc(Number(r?.test_balance ?? 0))), reserved: Math.max(0, Math.trunc(Number(r?.test_reserved ?? 0))) };
}

/** Add test credits. Same opId twice = one credit. Returns whether this call applied it, plus the new balance. */
export async function grantTestCredits(
  env: Env, uid: string, amount: number, opId: string, note: string, kind: "grant" | "migrate" = "grant",
): Promise<{ applied: boolean; balance: number }> {
  const amt = Math.trunc(amount);
  if (!(amt > 0)) return { applied: false, balance: (await getTestBalance(env, uid)).balance };
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const db = env.DB_META;
  // Ledger row first (guarded by the unique op_id), then the balance bump only if OUR row (nonce) is the one that landed.
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO hf_credit_ledger (id, uid, delta, kind, ref, op_id, note, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
      .bind(crypto.randomUUID(), uid, amt, kind, nonce, opId, `${note}`.slice(0, 200), now),
    db.prepare(
      `INSERT INTO hf_credits (uid, test_balance, test_reserved, updated_at)
         SELECT ?1, ?2, 0, ?3 WHERE EXISTS (SELECT 1 FROM hf_credit_ledger WHERE op_id=?4 AND ref=?5)
       ON CONFLICT(uid) DO UPDATE SET test_balance = test_balance + excluded.test_balance, updated_at = excluded.updated_at`,
    ).bind(uid, amt, now, opId, nonce),
  ]);
  const row = await db.prepare("SELECT ref FROM hf_credit_ledger WHERE op_id=?1").bind(opId).first<{ ref: string | null }>();
  const applied = row?.ref === nonce;
  if (applied) await db.prepare("UPDATE hf_credit_ledger SET ref=NULL WHERE op_id=?1").bind(opId).run().catch(() => undefined);
  return { applied, balance: (await getTestBalance(env, uid)).balance };
}

/**
 * Hold up to `max` of the caller's test credits for one call (all of `min(available, max)` in one step).
 * Idempotent per callId: a retry returns the amount already held.
 */
export async function reserveTestCredits(env: Env, uid: string, callId: string, max: number): Promise<number> {
  const cap = Math.max(0, Math.trunc(max));
  const db = env.DB_META;
  const opId = resOpId(callId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const prior = await db.prepare("SELECT delta FROM hf_credit_ledger WHERE op_id=?1").bind(opId).first<{ delta: number }>();
    if (prior) return Math.max(0, -Math.trunc(Number(prior.delta)));
    const { balance } = await getTestBalance(env, uid);
    const amount = Math.min(balance, cap);
    if (amount <= 0) return 0;
    const now = Date.now();
    const nonce = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO hf_credit_ledger (id, uid, delta, kind, ref, op_id, note, created_at)
           SELECT ?1, ?2, ?3, 'call_reserve', ?4, ?5, ?6, ?7 WHERE (SELECT test_balance FROM hf_credits WHERE uid=?2) >= ?8`,
      ).bind(crypto.randomUUID(), uid, -amount, callId, opId, nonce, now, amount),
      db.prepare("UPDATE hf_credits SET test_balance = test_balance - ?1, test_reserved = test_reserved + ?1, updated_at=?2 WHERE uid=?3 AND EXISTS (SELECT 1 FROM hf_credit_ledger WHERE op_id=?4 AND note=?5)")
        .bind(amount, now, uid, opId, nonce),
    ]);
    // loop: the next pass reads our row (or retries when the balance moved under us)
  }
  const last = await db.prepare("SELECT delta FROM hf_credit_ledger WHERE op_id=?1").bind(opId).first<{ delta: number }>();
  return last ? Math.max(0, -Math.trunc(Number(last.delta))) : 0;
}

/**
 * End of call: consume `spend` from what was held for this call and give the rest back. Idempotent (op `hfset:<callId>`).
 * Returns the amount actually consumed.
 */
export async function settleTestCredits(env: Env, uid: string, callId: string, spend: number): Promise<number> {
  const db = env.DB_META;
  const done = await db.prepare("SELECT delta FROM hf_credit_ledger WHERE op_id=?1").bind(setOpId(callId)).first<{ delta: number }>();
  if (done) return Math.max(0, -Math.trunc(Number(done.delta)));
  const held = await db.prepare("SELECT delta FROM hf_credit_ledger WHERE op_id=?1").bind(resOpId(callId)).first<{ delta: number }>();
  const reserved = held ? Math.max(0, -Math.trunc(Number(held.delta))) : 0;
  if (reserved === 0) return 0;
  const used = Math.min(reserved, Math.max(0, Math.trunc(spend)));
  const back = reserved - used;
  const now = Date.now();
  const nonce = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO hf_credit_ledger (id, uid, delta, kind, ref, op_id, note, created_at) VALUES (?1,?2,?3,'call_spend',?4,?5,?6,?7)")
      .bind(crypto.randomUUID(), uid, -used, callId, setOpId(callId), nonce, now),
    db.prepare("UPDATE hf_credits SET test_balance = test_balance + ?1, test_reserved = MAX(0, test_reserved - ?2), updated_at=?3 WHERE uid=?4 AND EXISTS (SELECT 1 FROM hf_credit_ledger WHERE op_id=?5 AND note=?6)")
      .bind(back, reserved, now, uid, setOpId(callId), nonce),
  ]);
  return used;
}
