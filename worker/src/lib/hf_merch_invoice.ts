// [HF-MERCH-GST-1 2026-10-23] Documents for a merch order. The PLATFORM is the seller (rule HF-MERCH-13): the fan gets a tax invoice at 5% GST (GST inside
// the price), HSN 6109, place of supply = the fan's state. Reuses the receipt machinery in hf_receipts.ts (gapless numbers, one document per source id):
//   * hfGstin set    -> a TAX INVOICE "<prefix>/I/<short FY>/<seq>", source 'merch_order', CGST 2.5% + SGST 2.5% when the fan's state == hfStateCode, else IGST 5%.
//   * hfGstin empty  -> a plain RECEIPT that says "GSTIN: applied for"; the GST split is still recorded in the document data. If a GSTIN is configured later
//                       the first look at the receipt issues the tax invoice (numbers stay gapless; the earlier receipt is kept).
// Everything here is best-effort for callers (issue* never throws); the PDF is drawn with pdf-lib and Helvetica only (no rupee glyph: "Rs.").
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { BRAND } from "./brand";
import { invoicingOn, issueDocument, supplierFrom, type ReceiptRow, type Supplier } from "./hf_receipts";
import { gstStateCode, gstStateName } from "./gst_states";
import { merchTaxSplit, readMerchCfg } from "./hf_merch_math";
import { parseJson, type MerchSnapshot } from "./hf_merch_types";
import type { ShopOrderRow } from "./shop_orders_logic";
import { formatIst, formatRupeesAscii, winAnsiSafe } from "./me_dashboard_logic";

export { merchTaxSplit, type MerchTaxSplit } from "./hf_merch_math";

type Addr = { name?: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
export interface MerchDocData {
  type: "merch_order"; orderId: string; orderNo: string; buyerName: string; buyerAddress: string[]; buyerState: string; buyerStateCode: string | null; placeOfSupply: string;
  hsn: string; description: string; qty: number; unitTaxablePaise: number; rateBps: number; taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  totalPaise: number; intraState: boolean; stateKnown: boolean; /** Printrove GST claimed back (internal) */ inputGstPaise: number; paidVia: string | null; paidAt: number | null;
}

/** Everything the document says, from the order row and the config. Pure. */
export function merchDocFacts(row: ShopOrderRow, cfg: Record<string, unknown>): MerchDocData {
  const snap = parseJson<Partial<MerchSnapshot>>(row.merch_json, {});
  const a = parseJson<Addr>(row.address_json, {});
  const mc = readMerchCfg(cfg);
  const rateBps = typeof snap.money?.gstRateBps === "number" ? snap.money.gstRateBps : mc.gstRateBps;
  const sup = supplierFrom(cfg);
  const code = gstStateCode(a.state);
  const split = merchTaxSplit(Number(row.amount_paise), rateBps, code, sup.stateCode);
  const qty = Math.max(1, Math.trunc(Number(snap.qty ?? 1)));
  const stateText = (a.state ?? "").trim();
  return {
    type: "merch_order", orderId: row.order_id, orderNo: row.order_no, buyerName: (row.contact_name || a.name || "").trim(),
    buyerAddress: [a.line1, a.line2, [a.city, a.pincode].filter(Boolean).join(" ")].filter((x): x is string => !!x && x.trim() !== ""),
    buyerState: stateText, buyerStateCode: code, placeOfSupply: code ? `${gstStateName(code) ?? stateText} (${code})` : stateText,
    hsn: mc.hsn, description: `${snap.title ?? "T-shirt"} - ${snap.colour ?? ""}${snap.size ? `, size ${snap.size}` : ""}`.replace(/\s+-\s*$/, ""), qty,
    unitTaxablePaise: Math.round(split.taxablePaise / qty), rateBps, taxablePaise: split.taxablePaise, gstPaise: split.gstPaise, cgstPaise: split.cgstPaise, sgstPaise: split.sgstPaise,
    igstPaise: split.igstPaise, totalPaise: split.totalPaise, intraState: split.intraState, stateKnown: split.stateKnown,
    inputGstPaise: Math.max(0, Math.trunc(Number(snap.money?.inputGstPaise ?? 0))), paidVia: row.pay_method ?? null, paidAt: row.confirmed_at ?? null,
  };
}

const isMerch = (row: Pick<ShopOrderRow, "seller_uid" | "merch_json">): boolean => !!row.seller_uid && !!row.merch_json;

/** Issue (or fetch) the document for a PAID merch order: a tax invoice when a GSTIN is set, else a receipt. Never throws; null when none can be issued. */
export async function issueMerchOrderDocument(env: Env, row: ShopOrderRow, cfgIn?: Record<string, unknown>): Promise<ReceiptRow | null> {
  try {
    if (!isMerch(row) || row.pay_status !== "confirmed") return null;
    const cfg = cfgIn ?? ((await readConfig(env)) as unknown as Record<string, unknown>);
    const sup = supplierFrom(cfg);
    const d = merchDocFacts(row, cfg);
    const on = invoicingOn(sup);
    return await issueDocument(env, {
      prefix: sup.prefix, kind: on ? "tax_invoice" : "receipt", uid: row.uid, source: "merch_order", sourceId: row.order_id, amountRupees: Math.round(d.totalPaise / 100),
      taxablePaise: d.taxablePaise, gstPaise: d.gstPaise, gstin: on ? sup.gstin : null, data: d, now: Number(row.confirmed_at) || Date.now(),
    });
  } catch (e) {
    console.warn("[hf-merch-invoice] issue failed", row.order_id, String(e));
    return null;
  }
}

/** The document to show: an existing tax invoice wins, else issue one if a GSTIN is set now, else the receipt. Rejected + refunded orders keep what they had. */
export async function getMerchOrderDocument(env: Env, row: ShopOrderRow, cfgIn?: Record<string, unknown>): Promise<ReceiptRow | null> {
  try {
    const cfg = cfgIn ?? ((await readConfig(env)) as unknown as Record<string, unknown>);
    const have = (await env.DB_META.prepare("SELECT id, number, uid, kind, source, source_id, amount_rupees, taxable_paise, gst_paise, gstin, issued_at, data FROM hf_receipts WHERE source='merch_order' AND source_id=?1")
      .bind(row.order_id).all<ReceiptRow>()).results ?? [];
    const inv = have.find((r) => r.kind === "tax_invoice");
    if (inv) return inv;
    if (row.approval_status === "rejected") return have[0] ?? null;
    if (!invoicingOn(supplierFrom(cfg)) && have[0]) return have[0];
    return await issueMerchOrderDocument(env, row, cfg);
  } catch (e) {
    console.warn("[hf-merch-invoice] get failed", row.order_id, String(e));
    return null;
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────────
export interface MerchPdfInput { doc: ReceiptRow; sup: Supplier; data: MerchDocData; buyerEmail: string | null }

export async function renderMerchDocumentPdf(i: MerchPdfInput): Promise<Uint8Array> {
  const { doc: r, sup, data: d } = i;
  const isInvoice = r.kind === "tax_invoice";
  const pdf = await PDFDocument.create();
  const title = isInvoice ? "Tax invoice" : "Payment receipt";
  pdf.setTitle(`${title} ${r.number}`);
  pdf.setAuthor(sup.legalName || BRAND.nameCompact);
  pdf.setCreator(BRAND.nameCompact);
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.12, 0.11), muted = rgb(0.42, 0.40, 0.38), line = rgb(0.85, 0.83, 0.80);
  const L = 48, R = 595.28 - 48;
  let y = 841.89 - 56;
  const text = (s: string, x: number, yy: number, size = 10, f = font, color = ink) => page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, xr: number, yy: number, size = 10, f = font, color = ink) => {
    const t = winAnsiSafe(s); page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness: 0.8, color: line });
  const wrap = (s: string, width: number, size: number, f = font, max = 3): string[] => {
    const out: string[] = []; let cur = "";
    for (const w of winAnsiSafe(s).split(" ")) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.slice(0, max);
  };

  // Header: supplier on the left, document on the right
  const legal = sup.legalName || BRAND.name;
  text(legal, L, y, 15, bold); right(title, R, y + 1, 16, bold);
  y -= 16;
  let ly = y;
  for (const l of wrap(sup.address, 270, 9, font, 3)) { text(l, L, ly, 9, font, muted); ly -= 12; }
  text(isInvoice && r.gstin ? `GSTIN: ${r.gstin}` : "GSTIN: applied for", L, ly, 9, bold); ly -= 12;
  right(`No. ${r.number}`, R, y, 10, bold); y -= 13;
  right(`Date: ${formatIst(r.issued_at).replace(/,.*$/, "")}`, R, y, 9, font, muted); y -= 12;
  right(`Order: ${d.orderNo}`, R, y, 9, font, muted);
  y = Math.min(y, ly) - 14; rule(y); y -= 20;

  // Buyer + place of supply
  text("BILLED TO", L, y, 8, bold, muted); text(isInvoice ? "PLACE OF SUPPLY" : "DELIVERED TO", 330, y, 8, bold, muted); y -= 14;
  const buyer = [d.buyerName, i.buyerEmail, ...d.buyerAddress, d.buyerState].filter((s): s is string => !!s && !!winAnsiSafe(s));
  let by = y;
  for (const b of buyer.slice(0, 7)) { text(b, L, by, 10); by -= 13; }
  text(d.placeOfSupply || d.buyerState || "-", 330, y, 10);
  y = Math.min(by, y - 13) - 8; rule(y); y -= 20;

  // Line item
  const cHsn = 300, cQty = 345, cRate = 420, cAmt = R;
  text("DESCRIPTION", L, y, 8, bold, muted); text("HSN", cHsn, y, 8, bold, muted); right("QTY", cQty + 18, y, 8, bold, muted);
  if (isInvoice) { right("RATE", cRate + 20, y, 8, bold, muted); right("TAXABLE", cAmt, y, 8, bold, muted); } else right("AMOUNT", cAmt, y, 8, bold, muted);
  y -= 16;
  const desc = wrap(d.description, cHsn - L - 10, 10, bold, 3);
  for (const [n, t] of desc.entries()) {
    text(t, L, y, 10, bold);
    if (n === 0) {
      text(d.hsn, cHsn, y, 10); right(String(d.qty), cQty + 18, y, 10);
      if (isInvoice) { right(formatRupeesAscii(d.unitTaxablePaise), cRate + 20, y, 10); right(formatRupeesAscii(d.taxablePaise), cAmt, y, 10); } else right(formatRupeesAscii(d.totalPaise), cAmt, y, 10);
    }
    y -= 14;
  }
  y -= 6; rule(y); y -= 18;

  if (isInvoice) {
    const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0).replace(/(\.\d)0$/, "$1")}%`;
    const row = (label: string, paise: number, f = font) => { text(label, 330, y, 10, f); right(formatRupeesAscii(paise), cAmt, y, 10, f); y -= 15; };
    row("Taxable value", d.taxablePaise);
    if (d.intraState) { row(`CGST @ ${pct(d.rateBps / 2)}`, d.cgstPaise); row(`SGST @ ${pct(d.rateBps / 2)}`, d.sgstPaise); } else row(`IGST @ ${pct(d.rateBps)}`, d.igstPaise);
    y -= 2; rule(y + 8); y -= 4;
    text("Total (inclusive of GST)", 330, y, 11, bold); right(formatRupeesAscii(d.totalPaise), cAmt, y, 11, bold); y -= 26;
  } else {
    text("Total paid", 330, y, 12, bold); right(formatRupeesAscii(d.totalPaise), cAmt, y, 12, bold); y -= 26;
  }

  // Payment + notes
  text("PAYMENT", L, y, 8, bold, muted); y -= 14;
  text(`Paid by ${d.paidVia === "wallet" ? "wallet" : "UPI / card (secure payment)"}${d.paidAt ? ` on ${formatIst(d.paidAt).replace(/,.*$/, "")}` : ""}`, L, y, 10); y -= 22;
  const notes = isInvoice
    ? ["The price you paid includes GST. This is a computer-generated tax invoice; no signature is needed.", `Sold and invoiced by ${legal}.`]
    : ["This is a payment receipt. GST is included in the price you paid; our GSTIN is applied for and a tax invoice is issued once it is active.", `Sold by ${legal}.`];
  for (const n of notes) for (const l of wrap(n, R - L, 9, font, 3)) { text(l, L, y, 9, font, muted); y -= 12; }
  text(`${BRAND.name} - ${BRAND.emails.support}`, L, 48, 9, font, muted);
  return pdf.save();
}

/** The PDF for a merch order (receipt or tax invoice), or null when no document could be issued (the caller falls back to the plain shop receipt). Never throws. */
export async function renderMerchOrderPdf(env: Env, row: ShopOrderRow, email: string | null): Promise<Uint8Array | null> {
  try {
    if (!isMerch(row)) return null;
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    const doc = await getMerchOrderDocument(env, row, cfg);
    if (!doc) return null;
    const stored = parseJson<Partial<MerchDocData> | null>(doc.data, null);
    const data = stored && stored.type === "merch_order" ? (stored as MerchDocData) : merchDocFacts(row, cfg);
    return await renderMerchDocumentPdf({ doc, sup: supplierFrom(cfg), data, buyerEmail: email });
  } catch (e) {
    console.warn("[hf-merch-invoice] render failed", row.order_id, String(e));
    return null;
  }
}
