
// [HF-TOK-EXIT-1] Account closing with hfTokensEnabled on. Rulebook: HF-PAY-14 (pay-out-first). Leaf helpers for lib/hf_exit.ts (which owns the flow).
//   * Callers: no WalletDO. Unspent PURCHASE lots become one 'play_refund' request each (hf_play_refunds.ts). Test lots are removed. Open debts
//     (an amount owed after a Google refund of spent tokens) are written off, recorded in the ledger. A user on a call cannot close.
//   * Hosts: INR from hf_host_ledger is paid out first (a closure payout: the Rs 500 minimum and the weekly cap are waived), after the 7-day hold,
//     the same pattern as the WalletDO path.
// Whole rupees only are paid out; the sub-rupee rest is retired from the wallet and recorded when the account closes (retireClosureRounding, HF-CLOSE-UPI-1).
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { track, trackException } from "../hooks";
import { tryDecryptPii } from "./pii_crypto";
import { verifiedWhatsAppNumber } from "./whatsapp_notify"; // [HF-CLOSE-UPI-1] the same WhatsApp helpers payouts and refunds already use
import { sendWhatsAppText } from "./whatsapp_send";
import { formatRupees } from "./hf_token_math";
import { readHfTokenConfig } from "./hf_token_config";
import { hostSummary, reservePayout, cancelPayoutReserve, hostLedgerRef, isHostLedgerRef, wholeRupees } from "./hf_host_ledger";
import { hostPayoutReadiness } from "./hf_payouts";
import { retireLot, OPEN_PLAY_STATUSES } from "./hf_play_refunds";
import { valuePaiseOfMicro, balanceSummary, hasOpenDebt } from "./hf_token_ledger";
import { fanPurchasePaise, takeFanPayout, returnFanPayout, fanPayoutRef, isFanPayoutRef } from "./hf_fan_payout"; // [HF-FIX-CLOSE-ACCOUNT-1]
import { brandUrl, BRAND } from "./brand";
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
  /** [HF-FIX-CLOSE-ACCOUNT-1] Always 0 now: closing no longer refunds to the original payment (kept so older pages still parse). */
  refundPaise: number; refundLots: number; partialLots: number; partialPaise: number;
  testValuePaise: number; debtValuePaise: number; availablePaise: number; pendingPaise: number;
  /** [HF-FIX-CLOSE-ACCOUNT-1] The wallet's paid balance exactly as GET /api/hf/wallet shows it (net of GST, test credits excluded). */
  walletPaise: number;
  /** The part of it a closure pays out to the person's UPI: whole rupees (the sub-rupee rest is retired and recorded at deletion). */
  walletPayoutPaise: number;
  /** [HF-CLOSE-UPI-1] The sub-rupee rest of the wallet that is NOT paid out: it is retired from the wallet when the account is deleted and recorded (finishTokenExit). */
  roundingPaise: number;
  /** One-time UPI + ID check state for the payout (same rule as the Payout button). */
  upiOk: boolean; kycOk: boolean; payoutReady: boolean;
  /** An open debt sits beside real wallet money: nothing is paid out until support settles it. */
  debtBlocked: boolean;
}

/** [HF-FIX-CLOSE-ACCOUNT-1] Same rule as POST /api/hf/payouts: a UPI ID, and the ID check once (skipped after a first paid payout). */
export async function payoutSetupState(env: Env, uid: string): Promise<{ upiOk: boolean; kycOk: boolean; payoutReady: boolean; bankOk: boolean; accountLast4: string | null; ifsc: string | null }> {
  const [ready, upi, paid] = await Promise.all([
    hostPayoutReadiness(env, uid),
    env.DB_META.prepare("SELECT upi_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ upi_enc: string | null }>().catch(() => null),
    env.DB_META.prepare("SELECT 1 AS x FROM hf_payout_requests WHERE host_uid=?1 AND status='paid' LIMIT 1").bind(uid).first().catch(() => null),
  ]);
  const upiOk = !!upi?.upi_enc;
  const kycOk = ready.kycOk || !!paid;
  return { upiOk, kycOk, payoutReady: upiOk && kycOk, bankOk: ready.bankOk, accountLast4: ready.accountLast4, ifsc: ready.ifsc };
}

export type SetupNextStep = { type: "upi" | "kyc"; title: string; url: string | null };
export function payoutSetupNextStep(upiOk: boolean): SetupNextStep {
  return upiOk
    // [HF-CLOSE-UPI-1] /verify/id is the ID check for everyone (fans too); /hosts/onboarding is the influencer wizard.
    ? { type: "kyc", title: "We check your ID once, before your first withdrawal.", url: brandUrl("/verify/id?next=%2Fdashboard%2Fclose") }
    : { type: "upi", title: "Add your UPI ID on the website (Wallet, Withdrawal setup) or in the app (Me, then Withdraw), and finish the one-time ID check.", url: brandUrl("/dashboard/wallet#payout") };
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
  const blank: TokenExitExtra = { mode: "tokens", refundPaise: 0, refundLots: 0, partialLots: 0, partialPaise: 0, testValuePaise: 0, debtValuePaise: 0, availablePaise: 0, pendingPaise: 0, walletPaise: 0, walletPayoutPaise: 0, roundingPaise: 0, upiOk: false, kycOk: false, payoutReady: false, debtBlocked: false };
  if (!footprint) return { ...empty, tokensInfo: blank };
  const [rawWallet, bal, debtOpen, host, ready, setup, tests, debt, op, orf, rel] = await Promise.all([
    fanPurchasePaise(env, uid),
    balanceSummary(env, uid),
    hasOpenDebt(env, uid),
    hostSummary(env, uid, now),
    hostPayoutReadiness(env, uid),
    payoutSetupState(env, uid),
    db.prepare("SELECT redemption_paise_per_token AS v, tokens_left_micro AS m FROM hf_token_lots WHERE uid=?1 AND kind='test' AND status='active' AND tokens_left_micro>0").bind(uid).all<{ v: number; m: number }>().then((r) => r.results ?? []),
    db.prepare("SELECT COALESCE(SUM(value_paise),0) AS s FROM hf_token_debts WHERE uid=?1 AND status='open'").bind(uid).first<{ s: number }>().catch(() => null),
    db.prepare("SELECT COUNT(*) AS n FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved')").bind(uid).first<{ n: number }>().catch(() => null),
    db.prepare(`SELECT COUNT(*) AS n FROM hf_refund_requests WHERE uid=?1 AND status IN (${OPEN_PLAY_STATUSES.map((s) => `'${s}'`).join(",")})`).bind(uid).first<{ n: number }>().catch(() => null),
    db.prepare("SELECT MAX(available_at) AS t FROM hf_host_ledger WHERE host_uid=?1 AND kind='call_earning' AND available_at>?2").bind(uid, now).first<{ t: number | null }>().catch(() => null),
  ]);
  // [HF-FIX-CLOSE-ACCOUNT-1] The wallet money is what the WALLET says it is (purchase lots at their redemption value, i.e. the rupees AFTER GST),
  // paid out in whole rupees to the person's own UPI. It is never the gross amount paid to the gateway.
  const walletPaise = bal.availablePaidPaise;
  const debtBlocked = debtOpen && rawWallet >= 100;
  const walletPayoutPaise = debtOpen ? 0 : Math.floor(Math.min(rawWallet, walletPaise) / 100) * 100;
  // [HF-CLOSE-UPI-1] what the person is told is NOT paid: the paise under Re 1 (all of the wallet when it is under Re 1). An open debt pays nothing, so nothing is "dropped".
  const roundingPaise = debtOpen ? 0 : Math.max(0, Math.min(rawWallet, walletPaise) - walletPayoutPaise);
  const testValuePaise = tests.reduce((t, x) => t + valuePaiseOfMicro(Number(x.m), Number(x.v)), 0);
  const hostRupees = wholeRupees(host.availablePaise) + wholeRupees(host.pendingPaise);
  const forfeitRupees = ready.bankOk || setup.payoutReady ? 0 : hostRupees;
  const openPayouts = Number(op?.n ?? 0), openRefunds = Number(orf?.n ?? 0);
  const rupees = (p: number) => p / 100;
  const extra: TokenExitExtra = {
    mode: "tokens", refundPaise: 0, refundLots: 0, partialLots: 0, partialPaise: 0, testValuePaise,
    debtValuePaise: Number(debt?.s ?? 0), availablePaise: host.availablePaise, pendingPaise: host.pendingPaise,
    walletPaise, walletPayoutPaise, roundingPaise, upiOk: setup.upiOk, kycOk: setup.kycOk, payoutReady: setup.payoutReady, debtBlocked,
  };
  return {
    ...empty,
    isHfUser: true,
    // Everything the person would be paid: the wallet's paid balance + earnings, in rupees.
    paidBalance: rupees(walletPaise) + rupees(host.availablePaise + host.pendingPaise),
    withdrawable: wholeRupees(host.availablePaise),
    held: host.pendingPaise >= 100 ? wholeRupees(host.pendingPaise) : 0,
    heldReleaseAt: host.pendingPaise > 0 && rel?.t ? Number(rel.t) : null,
    refundable: 0,
    manualRefund: 0,
    forfeitRupees,
    bankOk: ready.bankOk,
    testCredits: rupees(testValuePaise),
    testEarnings: rupees(host.testPaise),
    openPayouts, openRefunds,
    hasMoney: walletPayoutPaise > 0 || debtBlocked || hostRupees > 0 || openPayouts > 0 || openRefunds > 0,
    tokensInfo: extra,
  };
}

export type MakePayout = { ok: true; id: string } | { ok: false; status: number; error: string; message: string; nextStep?: SetupNextStep };

/** What ONE closure payout would carry right now: the wallet's paid money (to UPI) plus matured earnings. */
export async function exitPayoutPlan(env: Env, uid: string, now = Date.now()) {
  const [raw, debtOpen, sum, setup] = await Promise.all([fanPurchasePaise(env, uid), hasOpenDebt(env, uid), hostSummary(env, uid, now), payoutSetupState(env, uid)]);
  return {
    walletPaise: debtOpen ? 0 : Math.floor(raw / 100) * 100,
    debtBlocked: debtOpen && raw >= 100,
    earnRupees: wholeRupees(sum.availablePaise),
    setup,
    earnDestOk: setup.bankOk || setup.payoutReady,
  };
}

/**
 * [HF-FIX-CLOSE-ACCOUNT-1] The closure payout (owner 2026-10-23, HF-PAY-14): ONE request (exit=1) carrying the wallet's paid balance (taken from the
 * purchase lots, whole rupees, net of GST) and, for an influencer, the matured earnings. It goes to the person's OWN UPI after the one-time
 * ID + UPI check, exactly like Payout: whole rupees, no minimum, no weekly cap, then the usual admin approve + UTR.
 */
export async function createExitPayoutTokens(env: Env, uid: string, now = Date.now()): Promise<MakePayout> {
  const no = (status: number, error: string, message: string, nextStep?: SetupNextStep): MakePayout => ({ ok: false, status, error, message, ...(nextStep ? { nextStep } : {}) });
  const pl = await exitPayoutPlan(env, uid, now);
  if (pl.debtBlocked) return no(409, "debt_open", "There is an open balance on your account. Please write to us from the Support page and we will settle it with you.");
  if (pl.walletPaise > 0 && !pl.setup.payoutReady) {
    return pl.setup.upiOk
      ? no(409, "kyc_required", "We check your ID once, before your first withdrawal. Do that first, then close your account.", payoutSetupNextStep(true))
      : no(409, "upi_required", "Add your UPI ID first (Wallet, then Withdrawal setup on the website, or Me, then Withdraw in the app), then close your account.", payoutSetupNextStep(false));
  }
  const earnRupees = pl.earnDestOk ? pl.earnRupees : 0;
  if (pl.walletPaise <= 0 && earnRupees <= 0) {
    return pl.earnRupees > 0 ? no(409, "bank_required", "Add and verify your bank account first, or choose to give up your earnings.") : no(409, "nothing_withdrawable", "No money is available to pay out right now.");
  }
  const amount = pl.walletPaise / 100 + earnRupees;
  const bankRow = await env.DB_META.prepare("SELECT name_at_bank_enc FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_at_bank_enc: string | null }>().catch(() => null);
  const name = await tryDecryptPii(env, bankRow?.name_at_bank_enc);
  const snapshot = JSON.stringify({ accountLast4: pl.setup.accountLast4, ifsc: pl.setup.ifsc, name });
  const id = crypto.randomUUID();
  const ref = earnRupees > 0 ? hostLedgerRef(id) : fanPayoutRef(id);
  await env.DB_META.prepare(
    pl.walletPaise > 0 // only a request that takes wallet money touches the lots_paise column
      ? `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, exit, lots_paise, created_at, updated_at)
         VALUES (?1,?2,?3,'requested',?4,?5,?6,1,?8,?7,?7)`
      : `INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, bank_snapshot, wallet_ref, withdrawable_at_request, exit, created_at, updated_at)
         VALUES (?1,?2,?3,'requested',?4,?5,?6,1,?7,?7)`,
  ).bind(...(pl.walletPaise > 0 ? [id, uid, amount, snapshot, ref, amount, now, pl.walletPaise] : [id, uid, amount, snapshot, ref, amount, now])).run();
  const abort = async (code: string, status: number, message: string): Promise<MakePayout> => {
    if (pl.walletPaise > 0) await returnFanPayout(env, uid, id).catch(() => undefined); // wallet money goes straight back to the wallet
    await env.DB_META.prepare("UPDATE hf_payout_requests SET status='cancelled', reject_reason=?2, updated_at=?3 WHERE id=?1 AND status='requested'").bind(id, "system:" + code, Date.now()).run();
    return no(status, code, message);
  };
  if (pl.walletPaise > 0) {
    const tk = await takeFanPayout(env, uid, id, pl.walletPaise);
    if (!tk.ok) return abort("insufficient_withdrawable", 402, "That amount is not available right now. Please try again.");
  }
  // The balance check and the reserve are ONE statement in the host ledger, so two requests cannot both fit.
  if (earnRupees > 0) {
    const rr = await reservePayout(env, uid, id, earnRupees * 100, now);
    if (!rr.ok) return abort("insufficient_withdrawable", 402, "That amount is not available yet.");
  }
  void track(env, uid, "hf_payout_requested", APP, { amount, exit: true, mode: pl.walletPaise > 0 ? (earnRupees > 0 ? "wallet_and_earnings" : "wallet") : "inr_ledger" });
  return { ok: true, id };
}

/** Cancel a closure payout: earnings go back to the host ledger, wallet money back into the WALLET (never anywhere else). */
export async function cancelExitPayoutTokens(env: Env, uid: string, id: string): Promise<boolean> {
  const row = await env.DB_META.prepare("SELECT wallet_ref, lots_paise FROM hf_payout_requests WHERE id=?1 AND host_uid=?2").bind(id, uid)
    .first<{ wallet_ref: string | null; lots_paise: number | null }>().catch(() => null);
  if (!row || isHostLedgerRef(row.wallet_ref)) { if (!(await cancelPayoutReserve(env, uid, id)).ok) return false; }
  if (row && (Number(row.lots_paise ?? 0) > 0 || isFanPayoutRef(row.wallet_ref))) {
    const rr = await returnFanPayout(env, uid, id);
    if (!rr.ok && rr.reason !== "not_taken") return false;
  }
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

/** op_id of the ledger row that retires one lot's closure rounding (reconciliation counts these as "rounding kept on closure"). */
export const CLOSURE_ROUND_OP_PREFIX = "hftexit:round:";
export const closureRoundOpId = (lotId: string) => `${CLOSURE_ROUND_OP_PREFIX}${lotId}`;

/**
 * [HF-CLOSE-UPI-1] The sub-rupee rest of a wallet is never paid out (payouts are whole rupees). When the account closes, whatever purchase money is left
 * in the wallet and is under Re 1 is RETIRED: each lot's remaining tokens go to 0 and the lot is marked revoked, with ONE ledger row per lot
 * (kind admin_adjust, op_id hftexit:round:<lotId>, rupee value recorded). So the lot balance invariant still holds, reconciliation shows the amount as
 * "rounding kept on closure" instead of leaving it outstanding, it can never be paid out or spent again, and nothing is owed. Idempotent per lot.
 * A wallet of Re 1 or more (e.g. a rejected closure payout that was returned to the wallet) is left alone: that is real money, not rounding.
 */
export async function retireClosureRounding(env: Env, uid: string): Promise<{ lots: number; paise: number }> {
  const total = await fanPurchasePaise(env, uid);
  if (total >= 100) return { lots: 0, paise: 0 };
  const rows = (await env.DB_META.prepare(
    "SELECT id, tokens_left_micro AS m, redemption_paise_per_token AS v FROM hf_token_lots WHERE uid=?1 AND kind='purchase' AND status='active' AND tokens_left_micro>0 AND tokens_reserved_micro=0",
  ).bind(uid).all<{ id: string; m: number; v: number }>().catch(() => ({ results: [] as { id: string; m: number; v: number }[] }))).results ?? [];
  let lots = 0, paise = 0;
  for (const r of rows) {
    const rt = await retireLot(env, r.id, closureRoundOpId(r.id), "admin_adjust");
    if (rt.applied) { lots++; paise += valuePaiseOfMicro(Number(r.m), Number(r.v)); }
  }
  if (lots > 0) void track(env, uid, "hf_exit_rounding_retired", APP, { lots, value_paise: paise });
  return { lots, paise };
}

/** Last step before the account is deleted: test lots removed, debts written off, the sub-rupee wallet rest retired. All idempotent, safe to run on every cron tick. */
export async function finishTokenExit(env: Env, uid: string): Promise<{ testLots: number; debts: number; roundingLots: number; roundingPaise: number }> {
  const testLots = await removeTestLots(env, uid);
  const w = await writeOffDebts(env, uid);
  const r = await retireClosureRounding(env, uid);
  return { testLots, debts: w.count, roundingLots: r.lots, roundingPaise: r.paise };
}

const istLongDate = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });

/** Pure: the WhatsApp text sent when a closure starts. Says what is paid, and (when earnings are in the 7-day hold) why it waits and until when. */
export function closureStartedText(a: { walletPayoutPaise: number; roundingPaise: number; availableRupees: number; heldRupees: number; releaseAt: number | null }): string {
  const wallet = a.walletPayoutPaise, earn = a.availableRupees * 100, held = a.heldRupees * 100;
  const rest = a.roundingPaise > 0 ? ` The ${formatRupees(a.roundingPaise)} below ₹1 cannot be paid out and is not.` : "";
  if (held > 0) {
    const when = a.releaseAt ? ` which ends on ${istLongDate(a.releaseAt)}` : "";
    return `Your ${BRAND.name} account closure has started. ${formatRupees(held)} of your earnings are still in the 7-day hold${when}. `
      + `Your withdrawal to your UPI (${formatRupees(wallet + earn + held)} in all, wallet money included) is made together after the hold, and your account is deleted once it is paid.${rest}`;
  }
  return `Your ${BRAND.name} account closure has started. Your withdrawal of ${formatRupees(wallet + earn)} to your UPI is waiting for approval. Your account is deleted once it is paid.${rest}`;
}

/** Best-effort WhatsApp when a closure starts (the same helpers payouts and refunds use). Never throws. */
export async function notifyClosureStarted(env: Env, uid: string, a: Parameters<typeof closureStartedText>[0]): Promise<void> {
  try {
    const e164 = await verifiedWhatsAppNumber(env, uid);
    if (e164) await sendWhatsAppText(env, e164, closureStartedText(a));
  } catch (e) {
    await trackException(env, e, { uid, route: "hf_exit_tokens.notifyClosureStarted", handled: true, app_name: APP, extra: { area: "hf_exit" } });
  }
}
