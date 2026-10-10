
// [HF-TOK-EXIT-1] Account closing with hfTokensEnabled on. Rulebook: HF-PAY-14 (pay-out-first). Leaf helpers for lib/hf_exit.ts (which owns the flow).
//   * Callers: no WalletDO. Unspent PURCHASE lots become one 'play_refund' request each (hf_play_refunds.ts). Test lots are removed. Open debts
//     (an amount owed after a Google refund of spent tokens) are written off, recorded in the ledger. A user on a call cannot close.
//   * Hosts: INR from hf_host_ledger is paid out first (a closure payout: the Rs 500 minimum and the weekly cap are waived), after the 7-day hold,
//     the same pattern as the WalletDO path.
// Whole rupees only are paid out; a leftover under Re 1 is dropped with the account.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { track } from "../hooks";
import { tryDecryptPii } from "./pii_crypto";
import { readHfTokenConfig } from "./hf_token_config";
import { hostSummary, reservePayout, cancelPayoutReserve, hostLedgerRef, wholeRupees } from "./hf_host_ledger";
import { hostPayoutReadiness } from "./hf_payouts";
import { refundableLots, retireLot, OPEN_PLAY_STATUSES } from "./hf_play_refunds";
import { valuePaiseOfMicro } from "./hf_token_ledger";
import type { ExitSummary } from "./hf_exit";

const APP = "hfpayout";

export async function hfTokensOn(env: Env): Promise<boolean> {
  try { return readHfTokenConfig((await readConfig(env)) as unknown as Record<string, unknown>).enabled; } catch { return false; }
}

export const refundIdsOf = (s: string | null | undefined): string[] => {
  try { const j = JSON.parse(s || "[]"); return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

async function exists(env: Env, sql: string, uid: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare(sql).bind(uid).first()); } catch { return false; }
}

export interface TokenExitExtra {
  mode: "tokens";
  refundPaise: number; refundLots: number; partialLots: number; partialPaise: number;
  testValuePaise: number; debtValuePaise: number; availablePaise: number; pendingPaise: number;
}

/**
 * The ExitSummary for a user when tokens are on: same shape the /account/close page already reads (rupees), computed from lots and the host
 * ledger. `empty` is hf_exit's blank summary (it already carries the exit row), `isHf` its footprint check.
 */
export async function tokenExitSummary(env: Env, uid: string, now: number, empty: ExitSummary, isHf: boolean): Promise<ExitSummary & { tokensInfo: TokenExitExtra }> {
  const db = env.DB_META;
  const footprint = isHf
    || await exists(env, "SELECT 1 FROM hf_token_lots WHERE uid=?1 LIMIT 1", uid)
    || await exists(env, "SELECT 1 FROM hf_host_ledger WHERE host_uid=?1 LIMIT 1", uid);
  const blank: TokenExitExtra = { mode: "tokens", refundPaise: 0, refundLots: 0, partialLots: 0, partialPaise: 0, testValuePaise: 0, debtValuePaise: 0, availablePaise: 0, pendingPaise: 0 };
  if (!footprint) return { ...empty, tokensInfo: blank };
  const [lots, host, ready, tests, debt, op, orf, rel] = await Promise.all([
    refundableLots(env, uid, null, now),
    hostSummary(env, uid, now),
    hostPayoutReadiness(env, uid),
    db.prepare("SELECT redemption_paise_per_token AS v, tokens_left_micro AS m FROM hf_token_lots WHERE uid=?1 AND kind='test' AND status='active' AND tokens_left_micro>0").bind(uid).all<{ v: number; m: number }>().then((r) => r.results ?? []),
    db.prepare("SELECT COALESCE(SUM(value_paise),0) AS s FROM hf_token_debts WHERE uid=?1 AND status='open'").bind(uid).first<{ s: number }>().catch(() => null),
    db.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved')").bind(uid).first<{ n: number }>().catch(() => null),
    db.prepare(`SELECT COUNT(*) AS n FROM hf_refund_requests WHERE uid=?1 AND status IN (${OPEN_PLAY_STATUSES.map((s) => `'${s}'`).join(",")})`).bind(uid).first<{ n: number }>().catch(() => null),
    db.prepare("SELECT MAX(available_at) AS t FROM hf_host_ledger WHERE host_uid=?1 AND kind='call_earning' AND available_at>?2").bind(uid, now).first<{ t: number | null }>().catch(() => null),
  ]);
  const refundPaise = lots.reduce((t, l) => t + l.sharePaise, 0);
  const partial = lots.filter((l) => !l.wholeOrder);
  const partialPaise = partial.reduce((t, l) => t + l.sharePaise, 0);
  const testValuePaise = tests.reduce((t, x) => t + valuePaiseOfMicro(Number(x.m), Number(x.v)), 0);
  const hostRupees = wholeRupees(host.availablePaise) + wholeRupees(host.pendingPaise);
  const forfeitRupees = ready.bankOk ? 0 : hostRupees;
  const openPayouts = Number(op?.n ?? 0), openRefunds = Number(orf?.n ?? 0);
  const rupees = (p: number) => p / 100;
  const extra: TokenExitExtra = {
    mode: "tokens", refundPaise, refundLots: lots.length, partialLots: partial.length, partialPaise, testValuePaise,
    debtValuePaise: Number(debt?.s ?? 0), availablePaise: host.availablePaise, pendingPaise: host.pendingPaise,
  };
  return {
    ...empty,
    isHfUser: true,
    // Everything the person would be paid: unused tokens (refunded through Google) + earnings (withdrawn), in rupees.
    paidBalance: rupees(refundPaise) + rupees(host.availablePaise + host.pendingPaise),
    withdrawable: wholeRupees(host.availablePaise),
    held: host.pendingPaise >= 100 ? wholeRupees(host.pendingPaise) : 0,
    heldReleaseAt: host.pendingPaise > 0 && rel?.t ? Number(rel.t) : null,
    refundable: rupees(refundPaise),
    manualRefund: 0,
    forfeitRupees,
    bankOk: ready.bankOk,
    testCredits: rupees(testValuePaise),
    testEarnings: rupees(host.testPaise),
    openPayouts, openRefunds,
    hasMoney: refundPaise > 0 || hostRupees > 0 || openPayouts > 0 || openRefunds > 0,
    tokensInfo: extra,
  };
}

export type MakePayout = { ok: true; id: string } | { ok: false; status: number; error: string; message: string };
/** The closure payout from the host's INR ledger: whole rupees, no minimum, no weekly cap, then the usual approve + UTR. */
export async function createExitPayoutTokens(env: Env, uid: string, now = Date.now()): Promise<MakePayout> {
  const no = (status: number, error: string, message: string): MakePayout => ({ ok: false, status, error, message });
  const [sum, ready] = await Promise.all([hostSummary(env, uid, now), hostPayoutReadiness(env, uid)]);
  if (!ready.bankOk) return no(409, "bank_required", "Add and verify your bank account first, or choose to give up your earnings.");
  const amount = wholeRupees(sum.availablePaise);
  if (amount <= 0) return no(409, "nothing_withdrawable", "No earnings are available to withdraw right now.");
  const bankRow = await env.DB_META.prepare("SELECT name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_at_bank_enc: string | null }>().catch(() => null);
  const name = await tryDecryptPii(env, bankRow?.name_at_bank_enc);
  const snapshot = JSON.stringify({ accountLast4: ready.accountLast4, ifsc: ready.ifsc, name });
  const id = crypto.randomUUID();
  await env.DB_META.prepare(
    `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, exit, created_at, updated_at)
     VALUES (?1,?2,?3,'requested',?4,?5,?6,1,?7,?7)`,
  ).bind(id, uid, amount, snapshot, hostLedgerRef(id), amount, now).run();
  // The balance check and the reserve are ONE statement in the host ledger, so two requests cannot both fit.
  const rr = await reservePayout(env, uid, id, amount * 100, now);
  if (!rr.ok) {
    await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', reject_reason='system:insufficient_withdrawable', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
    return no(402, "insufficient_withdrawable", "That amount is not available yet.");
  }
  void track(env, uid, "hf_payout_requested", APP, { amount, exit: true, mode: "inr_ledger" });
  return { ok: true, id };
}

export async function cancelExitPayoutTokens(env: Env, uid: string, id: string): Promise<boolean> {
  if (!(await cancelPayoutReserve(env, uid, id)).ok) return false;
  const up = await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='requested'").bind(id, Date.now()).run();
  return !!up.meta?.changes;
}

/** Test lots are not money: remove what is left in them (one idempotent ledger op per lot). Returns how many were removed now. */
export async function removeTestLots(env: Env, uid: string): Promise<number> {
  const rows = (await env.DB_META.prepare("SELECT id FROM hf_token_lots WHERE uid=?1 AND kind='test' AND status='active'").bind(uid).all<{ id: string }>().catch(() => ({ results: [] as { id: string }[] }))).results ?? [];
  let n = 0;
  for (const r of rows) if ((await retireLot(env, r.id, `hftexit:test:${r.id}`, "admin_adjust")).applied) n++;
  return n;
}

/** Open debts are written off when the account closes: the debt row becomes 'written_off' and a 'debt_writeoff' ledger row records it. Idempotent. */
export async function writeOffDebts(env: Env, uid: string): Promise<{ count: number; valuePaise: number }> {
  const db = env.DB_META;
  const debts = (await db.prepare("SELECT id, amount_micro, value_paise FROM hf_token_debts WHERE uid=?1 AND status='open'").bind(uid).all<{ id: string; amount_micro: number; value_paise: number }>().catch(() => ({ results: [] as { id: string; amount_micro: number; value_paise: number }[] }))).results ?? [];
  let count = 0, valuePaise = 0;
  for (const d of debts) {
    const op = `hftwo:${d.id}`, now = Date.now(), nonce = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
         SELECT ?1,?2,'debt_writeoff',NULL,?3,?4,NULL,NULL,?5,?6,?7 WHERE EXISTS (SELECT 1 FROM hf_token_debts WHERE id=?8 AND status='open')`,
      ).bind(crypto.randomUUID(), uid, -Math.trunc(Number(d.amount_micro)), Math.trunc(Number(d.value_paise)), op, nonce, now, d.id),
      db.prepare("UPDATE hf_token_debts SET status='written_off', cleared_at=?1 WHERE id=?2 AND status='open' AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
        .bind(now, d.id, op, nonce),
    ]);
    const g = await db.prepare("SELECT note FROM hf_token_ledger WHERE op_id=?1").bind(op).first<{ note: string | null }>();
    if (g?.note === nonce) {
      await db.prepare("UPDATE hf_token_ledger SET note=NULL WHERE op_id=?1").bind(op).run();
      count++; valuePaise += Math.trunc(Number(d.value_paise));
    }
  }
  if (count > 0) void track(env, uid, "hf_token_debts_written_off", APP, { count, value_paise: valuePaise });
  return { count, valuePaise };
}

/** Last step before the account is deleted: test lots removed, debts written off. Both idempotent, safe to run on every cron tick. */
export async function finishTokenExit(env: Env, uid: string): Promise<{ testLots: number; debts: number }> {
  const testLots = await removeTestLots(env, uid);
  const w = await writeOffDebts(env, uid);
  return { testLots, debts: w.count };
}
