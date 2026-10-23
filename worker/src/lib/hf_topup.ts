// [HF-TOPUP-1] HF wallet top-up settlement. Gateway-agnostic: everything here talks to a GatewayAdapter, never to a gateway.
// The ONLY way money lands in a wallet is settleHfTopup(), reached from the webhook, the owner's status poll, or admin reconcile.
// Exactly-once is layered: the WalletDO dedupes the credit by op_id `hftop:<id>`, and the row only flips to paid+credited after
// that credit succeeded, so a crash between the two is healed by the next webhook/poll/reconcile (same op_id = no second credit).
import type { Env } from "../types";
import type { GatewayAdapter } from "./payments/types";
import { walletOp } from "../routes/wallet";
import { WALLET_APP } from "./hf_calls_store";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { noteGatewayRefund } from "./hf_refunds"; // [HF-WALLET-EXIT-1]
import { readConfig } from "../routes/config";
import { issueTopupReceipt } from "./hf_receipts"; // [HF-WALLET-LIMITS-1]
import { creditLot } from "./hf_token_ledger"; // [HF-CASHFREE-TOPUP-1]
import { topupSplitFloor as topupSplit, paiseToMicro, microToPaise, RUPEE_LOT_VALUE_PAISE, PRICING_CF_R1 } from "./hf_token_math";
import { readHfStdPlan } from "./hf_token_config";
import { notifyTopupCredited } from "./hf_topup_notify";
import { pokeLiveCall } from "./hf_call_funds"; // [HF-CALL-MODES-C]

/** [HF-CASHFREE-TOPUP-1] Pricing version stamped on the rupee lot of a website top-up, per gateway. Only Cashfree is live. */
const PRICING_BY_GATEWAY: Record<string, string> = { cashfree: PRICING_CF_R1.id };
const GATEWAY_LABEL: Record<string, string> = { cashfree: "Cashfree", razorpay: "Razorpay", paytm: "Paytm" };

export const TOPUP_PREFIX = "hftop_";
export const TOPUP_EXPIRE_MS = 24 * 3600_000;
export const topupOpId = (id: string) => `hftop:${id}`;
export const isHfTopupId = (id: string) => typeof id === "string" && id.startsWith(TOPUP_PREFIX);

export function newTopupId(): string {
  return TOPUP_PREFIX + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface HfTopupRow {
  id: string; uid: string; amount_rupees: number; gateway: string; gateway_order_id: string | null;
  status: "created" | "paid" | "failed" | "refunded" | "expired"; credited: number; raw_status: string | null;
  gateway_payment_id?: string | null; created_at: number; updated_at: number; paid_at: number | null;
  /** [HF-CASHFREE-TOPUP-1] Rupee-wallet top-ups only: paise that reached the wallet and the GST taken out (paid = wallet + GST). */
  wallet_paise?: number | null; gst_paise?: number | null;
}
const COLS = "id,uid,amount_rupees,gateway,gateway_order_id,status,credited,raw_status,gateway_payment_id,created_at,updated_at,paid_at,wallet_paise,gst_paise";

export async function getTopup(env: Env, id: string): Promise<HfTopupRow | null> {
  return (await env.DB_META.prepare(`SELECT ${COLS} FROM hf_topups WHERE id=?1`).bind(id).first<HfTopupRow>().catch(() => null)) ?? null;
}
export async function findTopup(env: Env, gateway: string, ourId: string, gatewayOrderId: string): Promise<HfTopupRow | null> {
  if (ourId) { const r = await getTopup(env, ourId); if (r && r.gateway === gateway) return r; }
  if (gatewayOrderId) {
    return (await env.DB_META.prepare(`SELECT ${COLS} FROM hf_topups WHERE gateway=?1 AND gateway_order_id=?2`).bind(gateway, gatewayOrderId).first<HfTopupRow>().catch(() => null)) ?? null;
  }
  return null;
}

/** Gateways speak different dialects for "money captured". Anything not on this list is NOT paid. */
export function isPaidStatus(s: string | null | undefined): boolean {
  return ["paid", "captured", "succeeded", "success", "txn_success"].includes(String(s ?? "").trim().toLowerCase());
}

export type SettleOutcome =
  | { result: "credited"; balanceAfter?: number }
  | { result: "duplicate" }
  | { result: "ignored"; reason: string }
  | { result: "failed" }
  | { result: "retry"; reason: string };

/**
 * Credit a top-up exactly once. `evidence` is what the gateway told us (webhook body or fetchOrder). We never trust the webhook alone:
 * the adapter's fetchOrder (server-to-server) must also say paid for the same amount before a rupee moves.
 */
export async function settleHfTopup(
  env: Env, adapter: GatewayAdapter, row: HfTopupRow,
  evidence: { status: "paid" | "failed" | "refunded" | "pending"; amountPaise: number; currency: string; gatewayPaymentId: string | null; gatewayOrderId: string },
): Promise<SettleOutcome> {
  const db = env.DB_META;
  const now = Date.now();
  if (row.status === "paid" && row.credited === 1) return { result: "duplicate" };
  if (row.status === "refunded") return { result: "duplicate" };

  if (evidence.status === "failed") {
    await db.prepare("UPDATE hf_topups SET status='failed', raw_status='failed', gateway_payment_id=COALESCE(?2,gateway_payment_id), updated_at=?3 WHERE id=?1 AND status='created'")
      .bind(row.id, evidence.gatewayPaymentId, now).run();
    return { result: "failed" };
  }
  if (evidence.status !== "paid") return { result: "ignored", reason: evidence.status };

  const expectedPaise = row.amount_rupees * 100;
  if (evidence.currency.toUpperCase() !== "INR") return { result: "ignored", reason: "currency_mismatch" };
  if (evidence.amountPaise !== expectedPaise) return { result: "ignored", reason: "amount_mismatch" };
  if (evidence.gatewayOrderId && row.gateway_order_id && evidence.gatewayOrderId !== row.gateway_order_id) return { result: "ignored", reason: "order_mismatch" };

  // Server-to-server read-back. Unreachable gateway -> ask the gateway to retry later; never credit on the webhook body alone.
  let truth: { status: string; amount_paise: number } | null = null;
  try { truth = await adapter.fetchOrder(env, row.gateway_order_id ?? evidence.gatewayOrderId); } catch { truth = null; }
  if (!truth) return { result: "retry", reason: "gateway_unreachable" };
  if (!isPaidStatus(truth.status) || truth.amount_paise !== expectedPaise) {
    await db.prepare("UPDATE hf_topups SET raw_status=?2, updated_at=?3 WHERE id=?1").bind(row.id, String(truth.status).slice(0, 40), now).run();
    return { result: "ignored", reason: isPaidStatus(truth.status) ? "amount_mismatch" : "not_paid_at_gateway" };
  }

  const cfg = (await readConfig(env).catch(() => ({}))) as Record<string, unknown>;

  // [HF-CASHFREE-TOPUP-1] With the rupee wallet on (hfTokensEnabled), the money goes into a rupee lot — the same wallet calls spend from
  // and Google Play top-ups land in — with GST taken out: wallet = paid / 1.18 to the paisa, GST = the rest (HF-PAY-1, owner 2026-10-15).
  // Idempotent by the ledger op id hftop:<id>. With the flag off, the legacy whole-rupee WalletDO credit below is unchanged.
  if (cfg.hfTokensEnabled === true) {
    const paidPaise = expectedPaise;
    const std = readHfStdPlan(cfg);
    const split = topupSplit(paidPaise, std.gstBps, std.gstInclusive);
    const micro = paiseToMicro(split.walletPaise);
    if (!Number.isSafeInteger(micro) || micro <= 0) return { result: "ignored", reason: "amount_too_small" };
    let credit: { applied: boolean; lotId: string | null };
    try {
      credit = await creditLot(env, row.uid, {
        kind: "purchase", pricingVersion: PRICING_BY_GATEWAY[row.gateway] ?? PRICING_CF_R1.id, valuePaisePerToken: RUPEE_LOT_VALUE_PAISE,
        micro, paidPaise, provider: row.gateway, providerRef: row.id, note: `topup:${row.gateway}`, gstPaise: split.gstPaise,
      }, topupOpId(row.id));
    } catch (e) {
      await trackException(env, e, { uid: row.uid, route: "hf_topup.settle", handled: true, app_name: WALLET_APP, extra: { topup: row.id, step: "credit_lot" } });
      return { result: "retry", reason: "wallet_error" };
    }
    if (!credit.lotId) return { result: "retry", reason: "wallet_error" };
    // A concurrent path may have credited first: record what the lot actually holds, never this run's numbers.
    const lot = await db.prepare("SELECT tokens_granted_micro AS m, gst_paise AS g FROM hf_token_lots WHERE id=?1").bind(credit.lotId).first<{ m: number; g: number }>().catch(() => null);
    const walletPaise = lot ? microToPaise(Number(lot.m)) : split.walletPaise;
    const gstPaise = lot ? Number(lot.g ?? 0) : split.gstPaise;
    await db.prepare("UPDATE hf_topups SET status='paid', credited=1, raw_status=?2, gateway_payment_id=COALESCE(?3,gateway_payment_id), paid_at=COALESCE(paid_at,?4), updated_at=?4, wallet_paise=?5, gst_paise=?6, lot_id=?7 WHERE id=?1")
      .bind(row.id, String(truth.status).slice(0, 40), evidence.gatewayPaymentId, now, walletPaise, gstPaise, credit.lotId).run();
    await pokeLiveCall(env, row.uid); // [HF-CALL-MODES-C] a call in progress reserves its next chunk now (idempotent, never throws, no-op with the chunk flag off)
    if (credit.applied) {
      let receiptNumber: string | null = null;
      try {
        const rec = await issueTopupReceipt(env, cfg, { id: row.id, uid: row.uid, amount_rupees: row.amount_rupees, gateway: row.gateway, gateway_payment_id: evidence.gatewayPaymentId ?? row.gateway_payment_id ?? null, paid_at: now, paid_paise: paidPaise, wallet_paise: walletPaise, gst_paise: gstPaise });
        receiptNumber = rec?.number ?? null;
      } catch { /* best-effort */ }
      try { await notifyTopupCredited(env, { uid: row.uid, orderId: row.id, paidPaise, creditPaise: walletPaise, gstPaise, receiptNumber, via: GATEWAY_LABEL[row.gateway] ?? row.gateway }); } catch { /* best-effort */ }
    }
    void track(env, row.uid, "hf_topup_paid", WALLET_APP, { area: "hf_topup", rupees: row.amount_rupees, gateway: row.gateway, paid_paise: paidPaise, wallet_paise: walletPaise, gst_paise: gstPaise, wallet: "rupee_lots", duplicate: !credit.applied }).catch(() => undefined);
    return credit.applied ? { result: "credited" } : { result: "duplicate" };
  }

  const r = await walletOp(env, row.uid, {
    op: "credit", uid: row.uid, amount: row.amount_rupees, type: "hf_topup", app_name: WALLET_APP,
    ref: topupOpId(row.id), op_id: topupOpId(row.id), category: "topup", context: `${BRAND.name} wallet top-up`,
  });
  if (r.status !== 200 || r.body?.ok !== true) {
    await trackException(env, new Error(`hf topup credit failed ${r.status}`), { uid: row.uid, route: "hf_topup.settle", handled: true, app_name: WALLET_APP, extra: { topup: row.id } });
    return { result: "retry", reason: "wallet_error" };
  }
  await db.prepare("UPDATE hf_topups SET status='paid', credited=1, raw_status=?2, gateway_payment_id=COALESCE(?3,gateway_payment_id), paid_at=COALESCE(paid_at,?4), updated_at=?4 WHERE id=?1")
    .bind(row.id, String(truth.status).slice(0, 40), evidence.gatewayPaymentId, now).run();
  // [HF-WALLET-LIMITS-1] Payment receipt (HF-PAY-16), idempotent by top-up id; never fails the credit. A miss is healed when the caller opens /wallet.
  try { await issueTopupReceipt(env, cfg, { id: row.id, uid: row.uid, amount_rupees: row.amount_rupees, gateway: row.gateway, gateway_payment_id: evidence.gatewayPaymentId ?? row.gateway_payment_id ?? null, paid_at: now }); } catch { /* best-effort */ }
  void track(env, row.uid, "hf_topup_paid", WALLET_APP, { area: "hf_topup", rupees: row.amount_rupees, gateway: row.gateway }).catch(() => undefined);
  return { result: "credited", balanceAfter: Math.trunc(Number(r.body?.balance ?? NaN)) || undefined };
}

/** Ask the gateway directly (poll / admin reconcile). Settles when it says paid. */
export async function reconcileHfTopup(env: Env, adapter: GatewayAdapter, row: HfTopupRow): Promise<SettleOutcome> {
  if (!row.gateway_order_id) return { result: "ignored", reason: "no_gateway_order" };
  if (row.status === "paid" && row.credited === 1) return { result: "duplicate" };
  let truth: { status: string; amount_paise: number } | null = null;
  try { truth = await adapter.fetchOrder(env, row.gateway_order_id); } catch { truth = null; }
  if (!truth) return { result: "retry", reason: "gateway_unreachable" };
  await env.DB_META.prepare("UPDATE hf_topups SET raw_status=?2, updated_at=?3 WHERE id=?1").bind(row.id, String(truth.status).slice(0, 40), Date.now()).run();
  if (!isPaidStatus(truth.status)) return { result: "ignored", reason: "not_paid_at_gateway" };
  return settleHfTopup(env, adapter, row, { status: "paid", amountPaise: truth.amount_paise, currency: "INR", gatewayPaymentId: null, gatewayOrderId: row.gateway_order_id });
}

/** Cron: a top-up nobody paid within 24 h is closed. A late webhook can still settle an 'expired' row via reconcile (credit is by op_id). */
export async function expireHfTopups(env: Env): Promise<number> {
  try {
    const r = await env.DB_META.prepare("UPDATE hf_topups SET status='expired', updated_at=?1 WHERE status='created' AND created_at < ?2")
      .bind(Date.now(), Date.now() - TOPUP_EXPIRE_MS).run();
    return Number(r.meta?.changes ?? 0);
  } catch (e) {
    await trackException(env, e, { route: "hf_topup.expire", handled: true, app_name: WALLET_APP, extra: { area: "hf_topup" } });
    return 0;
  }
}

/** Shared by POST /api/hf/wallet/topup/webhook/:gateway and the generic /api/pay/:gateway/webhook forward (same function, so whichever
 *  URL the owner pastes into the gateway dashboard works). Signature is already verified by the caller. 200 on anything we have
 *  handled or deliberately ignore (gateways retry non-2xx forever); 503 only when a retry can genuinely help. */
export async function settleParsedWebhook(
  env: Env, adapter: GatewayAdapter,
  parsed: { gateway_order_id: string; our_order_id: string; status: "paid" | "failed" | "refunded" | "pending"; amount_paise: number; currency: string; gateway_payment_id: string | null },
): Promise<Response> {
  const row = await findTopup(env, adapter.id, parsed.our_order_id, parsed.gateway_order_id);
  if (!row) { console.warn("[hf-topup] webhook for unknown top-up", adapter.id, parsed.our_order_id); return Response.json({ ok: true, ignored: "unknown_topup" }); }
  if (parsed.status === "refunded") {
    // [HF-WALLET-EXIT-1] A refund WE started (hf_refund_requests) was already debited once, at consume_reserved: never debit again here.
    // Anything else is a refund made in the gateway's dashboard: record it so admin sees it; the wallet is not touched.
    const who = await noteGatewayRefund(env, row.id);
    if (who === "external") console.warn("[hf-topup] refund webhook not started by us, needs manual review", row.id);
    return Response.json({ ok: true, ignored: who === "ours" ? "refund_confirmed" : "refund_manual" });
  }
  const out = await settleHfTopup(env, adapter, row, {
    status: parsed.status, amountPaise: parsed.amount_paise, currency: parsed.currency || "INR",
    gatewayPaymentId: parsed.gateway_payment_id, gatewayOrderId: parsed.gateway_order_id,
  });
  if (out.result === "retry") return Response.json({ ok: false, retry: out.reason }, { status: 503 });
  if (out.result === "ignored") console.warn("[hf-topup] webhook ignored", row.id, out.reason);
  return Response.json({ ok: true, ...(out.result === "credited" ? { credited: true } : out.result === "duplicate" ? { duplicate: true } : out.result === "ignored" ? { ignored: out.reason } : { status: out.result }) });
}
