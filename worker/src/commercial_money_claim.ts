// One D1 row is the ownership boundary between commercial settlement and
// cancellation/refund. Wallet operations happen outside D1, so a status check
// on orders alone is not enough to keep those two money paths from racing.

import type { Env } from "./types";
import { metaDb } from "./db/shard";

export type CommercialMoneyClaimType = "settlement" | "refund";

export type CommercialMoneyClaim = {
  order_id: string;
  claim_type: CommercialMoneyClaimType;
  claim_id: string;
  state: "claimed" | "completed";
};

export async function claimCommercialMoney(
  env: Env,
  args: { orderId: string; claimType: CommercialMoneyClaimType; claimId: string },
): Promise<{ owned: boolean; existing: CommercialMoneyClaim | null }> {
  const db = metaDb(env);
  const now = Date.now();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO commercial_money_claims
      (order_id,claim_type,claim_id,state,created_at,updated_at)
     VALUES (?1,?2,?3,'claimed',?4,?4)`,
  ).bind(args.orderId, args.claimType, args.claimId, now).run();
  if ((inserted.meta?.changes ?? 0) === 1) return { owned: true, existing: null };
  const existing = await db.prepare(
    `SELECT order_id,claim_type,claim_id,state
       FROM commercial_money_claims WHERE order_id=?1`,
  ).bind(args.orderId).first<CommercialMoneyClaim>();
  return {
    owned: existing?.claim_type === args.claimType && existing.claim_id === args.claimId,
    existing: existing ?? null,
  };
}

export async function completeCommercialMoneyClaim(
  env: Env,
  args: { orderId: string; claimType: CommercialMoneyClaimType; claimId: string },
): Promise<void> {
  await metaDb(env).prepare(
    `UPDATE commercial_money_claims SET state='completed',updated_at=?4
       WHERE order_id=?1 AND claim_type=?2 AND claim_id=?3`,
  ).bind(args.orderId, args.claimType, args.claimId, Date.now()).run();
}
