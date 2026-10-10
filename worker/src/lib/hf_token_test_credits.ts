// [HF-TOK-LEDGER-1] Admin test credits as token lots (HF-TOK-D10): kind "test", worth the ACTIVE pricing version's redemption value
// (gp-v1: Rs 0.82 = 82 paise a token), spend-only, never withdrawable. The amount an admin types is in TOKENS.
// Also the one-off helper that turns the old hf_credits test balance into test lots (same NUMBER of tokens, no revaluation).
import type { Env } from "../types";
import { creditLot, getPricingVersion, balanceSummary } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

export const MAX_TEST_TOKENS = 2000;

export type GrantResult = { ok: true; applied: boolean; lotId: string | null; valuePaisePerToken: number; totalMicro: number } | { ok: false; reason: "invalid_amount" | "unknown_pricing_version" };

/** Op id convention: callers pass the key; this prefixes it so it can never collide with a purchase op. */
export async function grantTestLot(env: Env, uid: string, tokens: number, opKey: string, note: string, pricingVersionId: string): Promise<GrantResult> {
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_TEST_TOKENS) return { ok: false, reason: "invalid_amount" };
  const pv = await getPricingVersion(env, pricingVersionId);
  if (!pv) return { ok: false, reason: "unknown_pricing_version" };
  const r = await creditLot(env, uid, {
    kind: "test", pricingVersion: pv.id, valuePaisePerToken: pv.redemptionPaisePerToken, micro: tokens * MICRO, paidPaise: 0, provider: "admin", providerRef: null, note,
  }, `hftest:${opKey}`);
  return { ok: true, applied: r.applied, lotId: r.lotId, valuePaisePerToken: pv.redemptionPaisePerToken, totalMicro: (await balanceSummary(env, uid)).totalMicro };
}

export interface MigrationRow { uid: string; tokens: number; alreadyMigrated: boolean; migrated: boolean }
/**
 * hf_credits.test_balance (whole rupees, 1 old test token = Rs 1) -> a `test` lot of the SAME NUMBER of tokens at the active value.
 * Honest and simple: no rupee conversion. Idempotent per uid (op hftmig:<uid>). hf_credits rows are NOT deleted or zeroed.
 * Credits currently reserved by a call in progress (test_reserved) are not moved; run it when no HF call is open.
 */
export async function migrateTestCreditsToLots(env: Env, o: { dryRun: boolean; pricingVersionId: string; limit?: number }): Promise<{ rows: MigrationRow[]; totalTokens: number }> {
  const pv = await getPricingVersion(env, o.pricingVersionId);
  if (!pv) throw new Error("unknown pricing version");
  const rows = (await env.DB_META.prepare("SELECT uid, test_balance FROM hf_credits WHERE test_balance>0 ORDER BY uid LIMIT ?1")
    .bind(Math.max(1, Math.min(1000, Math.trunc(o.limit ?? 500)))).all<{ uid: string; test_balance: number }>()).results ?? [];
  const out: MigrationRow[] = [];
  let total = 0;
  for (const r of rows) {
    const tokens = Math.max(0, Math.trunc(Number(r.test_balance)));
    const op = `hftmig:${r.uid}`;
    const already = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(op).first());
    let migrated = false;
    if (!o.dryRun && !already && tokens > 0) {
      const c = await creditLot(env, r.uid, {
        kind: "test", pricingVersion: pv.id, valuePaisePerToken: pv.redemptionPaisePerToken, micro: tokens * MICRO, paidPaise: 0,
        provider: "admin", providerRef: null, note: "migrated from test credits",
      }, op);
      migrated = c.applied;
    }
    if (!already) total += tokens;
    out.push({ uid: r.uid, tokens, alreadyMigrated: already, migrated });
  }
  return { rows: out, totalTokens: total };
}
