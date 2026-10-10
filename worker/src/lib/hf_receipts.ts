// [HF-WALLET-LIMITS-1] HF payment receipts and (when a GSTIN is configured) monthly GST tax invoices. Rule HF-PAY-16.
//  * Every paid top-up gets a plain RECEIPT "<prefix>/R/<FY>/<seq>" (a top-up is money into the caller's own wallet, not a supply).
//  * Once `hfGstin` is set, a TAX INVOICE "<prefix>/I/<short FY>/<seq>" is issued per caller per month for the PLATFORM SHARE of the paid calls
//    (18% GST is INCLUDED in that share, HF-PAY-6): taxable = share / 1.18. Switching is config-only: hfGstin, hfLegalName, hfLegalAddress,
//    hfStateCode, hfInvoicePrefix. Empty GSTIN = no invoices, receipts only.
// [HF-TOK-EXIT-1] With hfTokensEnabled: every Google Play purchase lot gets a "Purchase record - paid via Google Play" (source 'play_purchase': order id,
// tokens, rupees paid, value per token, NO GST: tax_mode none_unregistered). Monthly tax invoices add the PLATFORM share (hf_calls.platform_paise,
// the part that came from purchase lots) of token-era calls; calls made before tokens keep the old per-minute path. No new GST rules.
// Numbers are gapless per series and idempotent per (kind, source, source_id): one D1 batch (atomic) inserts the row and bumps the counter only if it landed.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { financialYear, istMonthStart, istMonthStr, istNextMonthStart, istPrevMonthStart, IST_OFFSET_MS } from "./hf_limits";

export type DocKind = "receipt" | "tax_invoice";
export interface Supplier { gstin: string; legalName: string; address: string; stateCode: string; prefix: string }

export function supplierFrom(cfg: Record<string, unknown>): Supplier {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const prefix = s(cfg.hfInvoicePrefix).replace(/[^A-Za-z0-9]/g, "").slice(0, 4) || "HF";
  return { gstin: s(cfg.hfGstin).toUpperCase(), legalName: s(cfg.hfLegalName).slice(0, 200), address: s(cfg.hfLegalAddress).slice(0, 400), stateCode: s(cfg.hfStateCode).slice(0, 2), prefix };
}
export const invoicingOn = (s: Supplier): boolean => s.gstin.length > 0;

// ── numbering + GST math (pure) ──────────────────────────────────────────────
/** Receipts carry the long financial year ("HF/R/2026-27/12"); tax invoices the short one ("HF/I/26-27/12") so they stay within GST's 16-character limit. */
export function docSeries(kind: DocKind, ms: number): string {
  const fy = financialYear(ms);
  return kind === "receipt" ? `R/${fy.label}` : `I/${fy.short}`;
}
export const docNumberPrefix = (prefix: string, kind: DocKind, ms: number): string => `${prefix}/${docSeries(kind, ms)}/`;

export interface GstSplit { grossPaise: number; taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; intraState: boolean }
/**
 * GST is INCLUDED in the gross (HF-PAY-6): taxable = gross / 1.18 (rounded to the paisa), tax = the rest. Intra-state: CGST + SGST half each
 * (CGST rounds down, SGST takes the odd paisa); inter-state: all IGST. A caller whose state is unknown is treated as intra-state.
 */
export function gstSplit(grossPaise: number, callerState: string | null, supplierState: string): GstSplit {
  const gross = Math.max(0, Math.trunc(grossPaise));
  const taxable = Math.round((gross * 100) / 118);
  const gst = gross - taxable;
  const intra = !callerState || !supplierState || callerState === supplierState;
  const cgst = intra ? Math.floor(gst / 2) : 0;
  const sgst = intra ? gst - cgst : 0;
  return { grossPaise: gross, taxablePaise: taxable, gstPaise: gst, cgstPaise: cgst, sgstPaise: sgst, igstPaise: intra ? 0 : gst, intraState: intra };
}
/** Platform share of paid calls in paise: what the caller paid with real money minus the host's paid share (whole rupees on both sides). */
export function platformSharePaise(calls: Array<{ paid_rupees: number | null; host_paid_rupees: number | null }>): number {
  let t = 0;
  for (const c of calls) {
    const paid = Math.max(0, Math.trunc(Number(c.paid_rupees ?? 0)));
    if (paid <= 0) continue;
    t += Math.max(0, paid - Math.max(0, Math.trunc(Number(c.host_paid_rupees ?? 0)))) * 100;
  }
  return t;
}

export interface ReceiptRow {
  id: string; number: string; uid: string; kind: DocKind; source: string; source_id: string; amount_rupees: number;
  taxable_paise: number | null; gst_paise: number | null; gstin: string | null; issued_at: number; data: string | null;
}
const RCOLS = "id, number, uid, kind, source, source_id, amount_rupees, taxable_paise, gst_paise, gstin, issued_at, data";

/**
 * Issue one document, exactly once per (kind, source, source_id). Returns the (new or existing) row.
 * Batch (atomic): ensure counter row -> insert the document with number = prefix + counter (only if not already issued) -> bump the counter
 * only if our document landed. No gaps, no duplicates, even when two settles race.
 */
export async function issueDocument(env: Env, a: {
  prefix: string; kind: DocKind; uid: string; source: string; sourceId: string; amountRupees: number;
  taxablePaise?: number | null; gstPaise?: number | null; gstin?: string | null; data?: unknown; now?: number;
}): Promise<ReceiptRow | null> {
  const db = env.DB_META;
  const now = a.now ?? Date.now();
  const existing = await db.prepare(`SELECT ${RCOLS} FROM hf_receipts WHERE kind=?1 AND source=?2 AND source_id=?3`).bind(a.kind, a.source, a.sourceId).first<ReceiptRow>();
  if (existing) return existing;
  const series = docSeries(a.kind, now);
  const id = `hfr_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO hf_doc_counters (series, next) VALUES (?1, 1)").bind(series),
    db.prepare(
      `INSERT OR IGNORE INTO hf_receipts (id, number, uid, kind, source, source_id, amount_rupees, taxable_paise, gst_paise, gstin, issued_at, data)
         SELECT ?1, ?2 || next, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 FROM hf_doc_counters
          WHERE series=?13 AND NOT EXISTS (SELECT 1 FROM hf_receipts WHERE kind=?4 AND source=?5 AND source_id=?6)`,
    ).bind(id, docNumberPrefix(a.prefix, a.kind, now), a.uid, a.kind, a.source, a.sourceId, Math.trunc(a.amountRupees), a.taxablePaise ?? null, a.gstPaise ?? null, a.gstin ?? null, now,
      a.data === undefined ? null : JSON.stringify(a.data), series),
    db.prepare("UPDATE hf_doc_counters SET next = next + 1 WHERE series=?1 AND EXISTS (SELECT 1 FROM hf_receipts WHERE id=?2)").bind(series, id),
  ]);
  return (await db.prepare(`SELECT ${RCOLS} FROM hf_receipts WHERE kind=?1 AND source=?2 AND source_id=?3`).bind(a.kind, a.source, a.sourceId).first<ReceiptRow>()) ?? null;
}

export interface TopupForReceipt { id: string; uid: string; amount_rupees: number; gateway: string; gateway_payment_id?: string | null; paid_at: number | null }

/** Called by settleHfTopup right after the wallet credit succeeded. Never throws (a receipt problem must not fail a credit). */
export async function issueTopupReceipt(env: Env, cfg: Record<string, unknown>, t: TopupForReceipt): Promise<ReceiptRow | null> {
  try {
    const sup = supplierFrom(cfg);
    return await issueDocument(env, {
      prefix: sup.prefix, kind: "receipt", uid: t.uid, source: "topup", sourceId: t.id, amountRupees: t.amount_rupees, now: t.paid_at ?? Date.now(),
      data: { topupId: t.id, gateway: t.gateway, gatewayPaymentId: t.gateway_payment_id ?? null, paidAt: t.paid_at ?? Date.now() },
    });
  } catch (e) {
    console.warn("[hf-receipt] issue failed", t.id, String(e));
    return null;
  }
}

/** Top-ups credited before this shipped (or whose receipt hook failed) get theirs the first time the caller looks. Bounded, idempotent. */
export async function backfillTopupReceipts(env: Env, cfg: Record<string, unknown>, uid: string): Promise<void> {
  try {
    const rows = (await env.DB_META.prepare(
      `SELECT t.id, t.uid, t.amount_rupees, t.gateway, t.gateway_payment_id, t.paid_at FROM hf_topups t
        WHERE t.uid=?1 AND t.status='paid' AND t.credited=1
          AND NOT EXISTS (SELECT 1 FROM hf_receipts r WHERE r.kind='receipt' AND r.source='topup' AND r.source_id=t.id)
        ORDER BY t.paid_at LIMIT 20`,
    ).bind(uid).all<TopupForReceipt>()).results ?? [];
    for (const r of rows) await issueTopupReceipt(env, cfg, r);
  } catch { /* receipts are best-effort */ }
}

export async function listReceipts(env: Env, uid: string, limit = 100): Promise<ReceiptRow[]> {
  return (await env.DB_META.prepare(`SELECT ${RCOLS} FROM hf_receipts WHERE uid=?1 ORDER BY issued_at DESC LIMIT ?2`).bind(uid, limit).all<ReceiptRow>().catch(() => ({ results: [] as ReceiptRow[] }))).results ?? [];
}
export async function getReceipt(env: Env, id: string): Promise<ReceiptRow | null> {
  return (await env.DB_META.prepare(`SELECT ${RCOLS} FROM hf_receipts WHERE id=?1`).bind(id).first<ReceiptRow>().catch(() => null)) ?? null;
}

// ── [HF-TOK-EXIT-1] Google Play purchase records ─────────────────────────────
const nzp = (n: unknown): number => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0);
export interface PurchaseLotForReceipt {
  id: string; uid: string; tokens_granted_micro: number; paid_paise: number; redemption_paise_per_token: number;
  provider_ref: string | null; created_at: number; pricing_version?: string | null;
}
/** One record per purchase lot, exactly once (source 'play_purchase', source id = the lot id). Never throws. */
export async function issuePurchaseRecord(env: Env, cfg: Record<string, unknown>, l: PurchaseLotForReceipt): Promise<ReceiptRow | null> {
  try {
    const sup = supplierFrom(cfg);
    return await issueDocument(env, {
      prefix: sup.prefix, kind: "receipt", uid: l.uid, source: "play_purchase", sourceId: l.id, amountRupees: Math.round(nzp(l.paid_paise) / 100), now: Number(l.created_at) || Date.now(),
      data: {
        type: "play_purchase", orderId: l.provider_ref, tokensMicro: nzp(l.tokens_granted_micro), paidPaise: nzp(l.paid_paise),
        valuePaisePerToken: nzp(l.redemption_paise_per_token), pricingVersion: l.pricing_version ?? null, taxMode: "none_unregistered", paidAt: Number(l.created_at) || Date.now(),
      },
    });
  } catch (e) {
    console.warn("[hf-receipt] purchase record failed", l.id, String(e));
    return null;
  }
}
/** Purchases credited before this shipped (or whose hook failed) get their record the first time the buyer looks. Bounded, idempotent. */
export async function backfillPurchaseRecords(env: Env, cfg: Record<string, unknown>, uid: string): Promise<void> {
  try {
    const rows = (await env.DB_META.prepare(
      `SELECT t.id, t.uid, t.tokens_granted_micro, t.paid_paise, t.redemption_paise_per_token, t.provider_ref, t.created_at, t.pricing_version FROM hf_token_lots t
        WHERE t.uid=?1 AND t.kind='purchase' AND t.provider='google_play'
          AND NOT EXISTS (SELECT 1 FROM hf_receipts r WHERE r.kind='receipt' AND r.source='play_purchase' AND r.source_id=t.id)
        ORDER BY t.created_at LIMIT 20`,
    ).bind(uid).all<PurchaseLotForReceipt>()).results ?? [];
    for (const r of rows) await issuePurchaseRecord(env, cfg, r);
  } catch { /* records are best-effort */ }
}

/** Platform share, in paise, of ONE token-era call that came from purchase lots (test-lot value is not billed to anyone). Pure. */
export function tokenCallPlatformPaise(c: { platform_paise: number | null; consumed_value_paise: number | null; lots_used: string | null }): number {
  const plat = nzp(c.platform_paise), cons = nzp(c.consumed_value_paise);
  if (plat <= 0 || cons <= 0) return 0;
  let paid = 0;
  try {
    const j = JSON.parse(c.lots_used ?? "[]");
    if (Array.isArray(j)) for (const u of j) if (u && u.kind === "purchase") paid += nzp(u.valuePaise);
  } catch { return 0; }
  paid = Math.min(paid, cons);
  return Number((BigInt(plat) * BigInt(paid)) / BigInt(cons));
}

// ── monthly tax-invoice statements ───────────────────────────────────────────
/** Cron ticks on IST days 1..5 generate the previous month's statements (re-runs are no-ops). */
export const STATEMENT_WINDOW_DAYS = 5;
export interface StatementResult { month: string; issued: number; skipped: number }
/**
 * Cron (any tick in the first days of the month, IST). With a GSTIN set, issues one tax invoice per caller for the PREVIOUS month covering the
 * platform share of their completed paid calls. Safe to run every tick: callers already invoiced are filtered out; at most `batch` per run.
 */
export async function runMonthlyStatements(env: Env, cfg: Record<string, unknown>, now = Date.now(), batch = 100): Promise<StatementResult | null> {
  const sup = supplierFrom(cfg);
  if (!invoicingOn(sup)) return null;
  if (new Date(now + IST_OFFSET_MS).getUTCDate() > STATEMENT_WINDOW_DAYS) return null; // only the first days of the month (catch-up for missed ticks)
  const from = istPrevMonthStart(now), to = istMonthStart(now);
  const month = istMonthStr(from);
  const rows = (await env.DB_META.prepare(
    `SELECT c.caller_uid AS uid, COUNT(*) AS n, SUM(c.paid_rupees) AS paid, SUM(c.paid_rupees - COALESCE(c.host_paid_rupees,0)) AS share
       FROM hf_calls c
      WHERE c.status='completed' AND COALESCE(c.paid_rupees,0)>0 AND COALESCE(c.ended_at, c.created_at)>=?1 AND COALESCE(c.ended_at, c.created_at)<?2
        AND NOT EXISTS (SELECT 1 FROM hf_receipts r WHERE r.kind='tax_invoice' AND r.source='statement' AND r.source_id = c.caller_uid || ':' || ?3)
      GROUP BY c.caller_uid HAVING SUM(c.paid_rupees - COALESCE(c.host_paid_rupees,0)) > 0 LIMIT ?4`,
  ).bind(from, to, month, batch).all<{ uid: string; n: number; paid: number; share: number }>()).results ?? [];
  // [HF-TOK-EXIT-1] token-era calls (lots_used set): their platform share comes from hf_calls.platform_paise, only the part paid for with purchase lots.
  // The old query above never sees them (paid_rupees is empty on those rows). A missing column (tokens never used) just means none.
  const byUid = new Map<string, { n: number; paid: number; sharePaise: number; tokenCalls: number; tokenPaise: number }>();
  for (const r of rows) byUid.set(r.uid, { n: Number(r.n), paid: Number(r.paid), sharePaise: Math.trunc(Number(r.share)) * 100, tokenCalls: 0, tokenPaise: 0 });
  try {
    const tc = (await env.DB_META.prepare(
      `SELECT c.caller_uid AS uid, c.platform_paise, c.consumed_value_paise, c.lots_used FROM hf_calls c
        WHERE c.status='completed' AND c.lots_used IS NOT NULL AND COALESCE(c.platform_paise,0)>0 AND COALESCE(c.ended_at, c.created_at)>=?1 AND COALESCE(c.ended_at, c.created_at)<?2
          AND NOT EXISTS (SELECT 1 FROM hf_receipts r WHERE r.kind='tax_invoice' AND r.source='statement' AND r.source_id = c.caller_uid || ':' || ?3)
        ORDER BY c.caller_uid LIMIT 5000`,
    ).bind(from, to, month).all<{ uid: string; platform_paise: number; consumed_value_paise: number; lots_used: string | null }>()).results ?? [];
    for (const c of tc) {
      const p = tokenCallPlatformPaise(c);
      if (p <= 0) continue;
      const e = byUid.get(c.uid) ?? { n: 0, paid: 0, sharePaise: 0, tokenCalls: 0, tokenPaise: 0 };
      e.n += 1; e.sharePaise += p; e.tokenCalls += 1; e.tokenPaise += p;
      byUid.set(c.uid, e);
    }
  } catch { /* no token columns: nothing to add */ }
  let issued = 0, skipped = 0;
  for (const [uid, r] of [...byUid.entries()].slice(0, batch)) {
    const split = gstSplit(r.sharePaise, null, sup.stateCode);
    const doc = await issueDocument(env, {
      prefix: sup.prefix, kind: "tax_invoice", uid, source: "statement", sourceId: `${uid}:${month}`, amountRupees: Math.round(r.sharePaise / 100),
      taxablePaise: split.taxablePaise, gstPaise: split.gstPaise, gstin: sup.gstin, now: istNextMonthStart(from) + 1, // dated the 1st of the following month
      data: {
        period: month, calls: r.n, paidByCallerRupees: r.paid, platformShareRupees: Math.round(r.sharePaise / 100), platformSharePaise: r.sharePaise, tokenCalls: r.tokenCalls, tokenPlatformPaise: r.tokenPaise,
        cgstPaise: split.cgstPaise, sgstPaise: split.sgstPaise, igstPaise: split.igstPaise, intraState: split.intraState,
        placeOfSupplyNote: "Customer's state is not collected; treated as intra-state (CGST + SGST).",
      },
    }).catch(() => null);
    if (doc) issued++; else skipped++;
  }
  return { month, issued, skipped };
}

// ── printable HTML ───────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const istDateTime = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16) + " IST";

export function renderReceiptHtml(r: ReceiptRow, sup: Supplier, customerName: string | null): string {
  const data = (() => { try { return JSON.parse(r.data ?? "{}") as Record<string, any>; } catch { return {} as Record<string, any>; } })();
  const isInvoice = r.kind === "tax_invoice";
  const legal = esc(sup.legalName || BRAND.name);
  const supplierBlock = `<p><strong>${legal}</strong><br>${esc(sup.address).replace(/\n/g, "<br>")}${isInvoice && r.gstin ? `<br>GSTIN: ${esc(r.gstin)}` : ""}</p>`;
  const title = isInvoice ? "Tax invoice" : (data as Record<string, unknown>).type === "play_purchase" ? "Purchase record — paid via Google Play" : "Payment receipt";
  const isPlay = !isInvoice && data.type === "play_purchase";
  let body: string;
  if (isPlay) {
    const micro = Number(data.tokensMicro ?? 0), paid = Number(data.paidPaise ?? 0), v = Number(data.valuePaisePerToken ?? 0);
    const tokens = (micro / 1_000_000).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    body = `<table><thead><tr><th>Description</th><th class="n">Detail</th></tr></thead><tbody>
      <tr><td>Google Play order</td><td class="n">${esc(data.orderId ?? "")}</td></tr>
      <tr><td>Tokens bought</td><td class="n">${esc(tokens)}</td></tr>
      <tr><td>Value of each token in call time</td><td class="n">${inr(v)}</td></tr>
      <tr class="t"><td>Paid</td><td class="n">${inr(paid)}</td></tr></tbody></table>
      <p class="muted">You paid through Google Play, which sends its own payment receipt. This is a record of your purchase, not a tax invoice.</p>`;
  } else if (isInvoice) {
    const cgst = Number(data.cgstPaise ?? 0), sgst = Number(data.sgstPaise ?? 0), igst = Number(data.igstPaise ?? 0);
    const taxable = Number(r.taxable_paise ?? 0), gst = Number(r.gst_paise ?? 0);
    body = `<table><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
      <tr><td>Platform service fee for calls in ${esc(data.period)} (${esc(data.calls)} calls)</td><td class="n">${inr(taxable)}</td></tr>
      ${igst > 0 ? `<tr><td>IGST @ 18%</td><td class="n">${inr(igst)}</td></tr>` : `<tr><td>CGST @ 9%</td><td class="n">${inr(cgst)}</td></tr><tr><td>SGST @ 9%</td><td class="n">${inr(sgst)}</td></tr>`}
      <tr class="t"><td>Total</td><td class="n">${inr(taxable + gst)}</td></tr></tbody></table>
      <p class="muted">GST is included in the platform fee you paid. Host charges are not part of this invoice. ${esc(data.placeOfSupplyNote ?? "")}</p>`;
  } else {
    body = `<table><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
      <tr><td>Money added to your ${esc(BRAND.name)} wallet${data.gateway ? ` (paid via ${esc(data.gateway)})` : ""}</td><td class="n">${inr(r.amount_rupees * 100)}</td></tr>
      <tr class="t"><td>Total received</td><td class="n">${inr(r.amount_rupees * 100)}</td></tr></tbody></table>
      ${data.gatewayPaymentId ? `<p class="muted">Payment reference: ${esc(data.gatewayPaymentId)}</p>` : ""}
      <p class="muted">${invoicingOn(sup) ? "This is a receipt for money added to your wallet. GST on the platform fee for your calls is shown on your monthly tax invoice." : "This is a payment receipt, not a tax invoice."}</p>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} ${esc(r.number)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1320;margin:0;padding:24px;background:#fff}
main{max-width:720px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}.muted{color:#5b4a60;font-size:14px}
.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:2px solid #1d1320;padding-bottom:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #d9cadd}.n{text-align:right;white-space:nowrap}
tr.t td{font-weight:700;border-top:2px solid #1d1320}.bar{margin-bottom:16px}button{font:inherit;min-height:44px;padding:0 20px;border-radius:10px;border:1px solid #1d1320;background:#fff;cursor:pointer}
@media print{.bar{display:none}body{padding:0}}
</style></head><body><main>
<div class="bar"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<div class="top"><div><h1>${esc(title)}</h1><div class="muted">No. ${esc(r.number)}<br>Date: ${esc(istDateTime(r.issued_at))}</div></div><div>${supplierBlock}</div></div>
<p><strong>Billed to</strong><br>${esc(customerName || "Account holder")}</p>
${body}
<p class="muted">${esc(BRAND.name)} · ${esc(BRAND.webOrigin)}</p>
</main></body></html>`;
}
