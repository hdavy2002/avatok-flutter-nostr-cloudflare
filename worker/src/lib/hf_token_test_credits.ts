// [HF-TOK-LEDGER-1] Admin test credits as token lots (HF-TOK-D10): kind "test", worth the ACTIVE pricing version's redemption value
// (gp-r1: 1 unit = Rs 1 = 100 paise), spend-only, never withdrawable. The amount an admin types is in units = RUPEES under gp-r1.
// Also the one-off helper that turns the old hf_credits test balance (rupees) into test lots worth the SAME RUPEES at the active value
// (owner: test credits are valued "same as Play"; gp-r1: Rs 1 of test credit = Rs 1 in the wallet = 1 unit).
import type { Env } from "../types";
import { creditLot, getPricingVersion, balanceSummary } from "./hf_token_ledger";
import { MICRO, microForValue } from "./hf_token_math";

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

/** tokens is the (fractional) token count, micro the exact micro-tokens, rupees the old whole-rupee balance. */
export interface MigrationRow { uid: string; rupees: number; tokens: number; micro: number; alreadyMigrated: boolean; migrated: boolean }
/**
 * hf_credits.test_balance (whole rupees) -> a `test` lot that keeps the RUPEE value: rupees / redemption value units (gp-r1 value Rs 1: Rs 100 -> 100 units; any other value would convert the same way),
 * rounded up to the micro-token like every other conversion. Idempotent per uid (op hftmig:<uid>). hf_credits rows are NOT deleted or zeroed.
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
    const rupees = Math.max(0, Math.trunc(Number(r.test_balance)));
    const micro = microForValue(rupees * 100, pv.redemptionPaisePerToken);
    const tokens = micro / MICRO;
    const op = `hftmig:${r.uid}`;
    const already = !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(op).first());
    let migrated = false;
    if (!o.dryRun && !already && micro > 0) {
      const c = await creditLot(env, r.uid, {
        kind: "test", pricingVersion: pv.id, valuePaisePerToken: pv.redemptionPaisePerToken, micro, paidPaise: 0,
        provider: "admin", providerRef: null, note: "migrated from test credits",
      }, op);
      migrated = c.applied;
    }
    if (!already) total += tokens;
    out.push({ uid: r.uid, rupees, tokens, micro, alreadyMigrated: already, migrated });
  }
  return { rows: out, totalTokens: total };
}
