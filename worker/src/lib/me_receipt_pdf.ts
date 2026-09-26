// [DASH2-API 2026-09-25] "Payment receipt" PDF for Dashboard 2 (owner decision:
// a payment receipt, NOT a tax invoice; issuer "Saathum"; no GSTIN).
// Standard Helvetica only: WinAnsi has no ₹ glyph, so amounts print as "Rs." and any
// character Helvetica cannot draw is dropped (winAnsiSafe) rather than crashing pdf-lib.
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { formatIst, formatRupeesAscii, winAnsiSafe } from "./me_dashboard_logic";

export type ReceiptInput = {
  receiptNo: string;
  issuedAt: number;
  billedTo: { name: string | null; email: string | null; address: string[] };
  item: { title: string; startsAt: number | null; durationMin: number | null };
  amountPaise: number;
  paidAt: number | null;
  utr: string | null;
  payerVpa: string | null;
  paymentId: string;
  orderId: string | null;
  status: "PAID" | "REFUNDED";
  refund?: { amountPaise: number | null; utr: string | null; at: number | null } | null;
};

export async function renderReceiptPdf(r: ReceiptInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Payment receipt ${r.receiptNo}`);
  doc.setAuthor("Saathum");
  doc.setCreator("Saathum");
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.12, 0.11), muted = rgb(0.42, 0.40, 0.38), line = rgb(0.85, 0.83, 0.80);
  const L = 56, R = 595.28 - 56;
  let y = 841.89 - 64;
  const text = (s: string, x: number, yy: number, size = 10, f = font, color = ink) =>
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, yy: number, size = 10, f = font, color = ink) => {
    const t = winAnsiSafe(s); page.drawText(t, { x: R - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness: 0.8, color: line });
  const wrap = (s: string, width: number, size: number, f = font): string[] => {
    const words = winAnsiSafe(s).split(" "); const out: string[] = []; let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.slice(0, 4);
  };

  // Header
  text("Saathum", L, y, 22, bold);
  right("Payment receipt", y + 2, 16, bold);
  y -= 18;
  text("support@saathum.com", L, y, 10, font, muted);
  right(`Receipt no. ${r.receiptNo}`, y, 10, font, muted);
  y -= 14;
  right(`Date ${formatIst(r.issuedAt).replace(/,.*$/, "")}`, y, 10, font, muted);
  y -= 22; rule(y); y -= 26;

  // Billed to
  text("BILLED TO", L, y, 8, bold, muted); y -= 15;
  const billed = [r.billedTo.name, r.billedTo.email, ...r.billedTo.address].filter((s): s is string => !!s && !!winAnsiSafe(s));
  if (!billed.length) billed.push("Saathum customer");
  for (const b of billed.slice(0, 7)) { text(b, L, y, 10); y -= 14; }
  y -= 12; rule(y); y -= 22;

  // Line item
  text("DESCRIPTION", L, y, 8, bold, muted); right("AMOUNT", y, 8, bold, muted); y -= 18;
  const titleLines = wrap(r.item.title || "Saathum ritual booking", R - L - 140, 11, bold);
  for (const [i, t] of titleLines.entries()) { text(t, L, y, 11, bold); if (i === 0) right(formatRupeesAscii(r.amountPaise), y, 11, bold); y -= 15; }
  if (r.item.startsAt) {
    const dur = r.item.durationMin ? ` (${r.item.durationMin} min)` : "";
    text(`Live event: ${formatIst(r.item.startsAt)}${dur}`, L, y, 10, font, muted); y -= 14;
  }
  y -= 10; rule(y); y -= 20;
  text("Total paid", L, y, 12, bold); right(formatRupeesAscii(r.amountPaise), y, 12, bold); y -= 30;

  // Payment details
  text("PAYMENT DETAILS", L, y, 8, bold, muted); y -= 16;
  const rows: [string, string | null][] = [
    ["Method", "UPI"],
    ["Paid on", r.paidAt ? formatIst(r.paidAt) : null],
    ["UPI UTR", r.utr],
    ["Payer UPI id", r.payerVpa],
    ["Payment id", r.paymentId],
    ["Order id", r.orderId],
  ];
  if (r.status === "REFUNDED" && r.refund) {
    rows.push(["Refunded", r.refund.amountPaise != null ? formatRupeesAscii(r.refund.amountPaise) : null]);
    rows.push(["Refunded on", r.refund.at ? formatIst(r.refund.at) : null]);
    rows.push(["Refund UTR", r.refund.utr]);
  }
  for (const [k, v] of rows) {
    if (!v) continue;
    text(k, L, y, 10, font, muted); text(v, L + 120, y, 10); y -= 15;
  }

  // Stamp
  const stamp = r.status;
  const color = stamp === "PAID" ? rgb(0.12, 0.55, 0.30) : rgb(0.70, 0.20, 0.15);
  const size = 40, w = bold.widthOfTextAtSize(stamp, size);
  page.drawRectangle({ x: R - w - 40, y: 300, width: w + 28, height: 58, borderColor: color, borderWidth: 3, rotate: degrees(12), opacity: 0 , borderOpacity: 0.8 });
  page.drawText(stamp, { x: R - w - 26, y: 316, size, font: bold, color, rotate: degrees(12), opacity: 0.8 });

  // Footer
  const foot = 72;
  page.drawLine({ start: { x: L, y: foot + 26 }, end: { x: R, y: foot + 26 }, thickness: 0.8, color: line });
  text("This is a payment receipt, not a tax invoice.", L, foot + 8, 9, bold, muted);
  text("Issued by Saathum. Questions: support@saathum.com", L, foot - 6, 9, font, muted);

  return doc.save();
}

// [SAATHUM-CHECKOUT-API 2026-09-26] Sibling renderer for the Saa Thum checkout
// receipt: multiple line items (ticket, chadhava, dakshina, prasad) + a GST line,
// vs. the single-line-item receipt above. Same Helvetica-only constraints
// ("Rs." not the Rupee sign; winAnsiSafe drops anything Helvetica can't draw).
export type SaathumReceiptLine = { label: string; qty: number; unit_rupees: number; amount_rupees: number };
export type SaathumReceiptInput = {
  receiptNo: string;
  issuedAt: number;
  billedTo: { name: string | null; email: string | null; address: string[] };
  item: { title: string; startsAt: number | null; durationMin: number | null };
  lines: SaathumReceiptLine[];
  gstRatePct: number;
  gstRupees: number;
  subtotalRupees: number;
  totalRupees: number;
  paidAt: number | null;
  utr: string | null;
  paymentId: string;
  orderId: string | null;
};

const rupeesAscii = (n: number): string => `Rs. ${n.toLocaleString("en-IN")}`;

export async function renderSaathumReceiptPdf(r: SaathumReceiptInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Payment receipt ${r.receiptNo}`);
  doc.setAuthor("Saathum");
  doc.setCreator("Saathum");
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.12, 0.11), muted = rgb(0.42, 0.40, 0.38), line = rgb(0.85, 0.83, 0.80);
  const L = 56, R = 595.28 - 56;
  let y = 841.89 - 64;
  const text = (s: string, x: number, yy: number, size = 10, f = font, color = ink) =>
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, yy: number, size = 10, f = font, color = ink) => {
    const t = winAnsiSafe(s); page.drawText(t, { x: R - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness: 0.8, color: line });

  text("Saathum", L, y, 22, bold);
  right("Payment receipt", y + 2, 16, bold);
  y -= 18;
  text("support@saathum.com", L, y, 10, font, muted);
  right(`Receipt no. ${r.receiptNo}`, y, 10, font, muted);
  y -= 14;
  right(`Date ${formatIst(r.issuedAt).replace(/,.*$/, "")}`, y, 10, font, muted);
  y -= 22; rule(y); y -= 26;

  text("BILLED TO", L, y, 8, bold, muted); y -= 15;
  const billed = [r.billedTo.name, r.billedTo.email, ...r.billedTo.address].filter((s): s is string => !!s && !!winAnsiSafe(s));
  if (!billed.length) billed.push("Saathum customer");
  for (const b of billed.slice(0, 7)) { text(b, L, y, 10); y -= 14; }
  y -= 8;
  text(r.item.title || "Saathum ritual booking", L, y, 11, bold); y -= 14;
  if (r.item.startsAt) {
    const dur = r.item.durationMin ? ` (${r.item.durationMin} min)` : "";
    text(`Live event: ${formatIst(r.item.startsAt)}${dur}`, L, y, 10, font, muted); y -= 14;
  }
  y -= 8; rule(y); y -= 20;

  text("DESCRIPTION", L, y, 8, bold, muted);
  text("QTY", L + 280, y, 8, bold, muted);
  right("AMOUNT", y, 8, bold, muted);
  y -= 16;
  for (const l of r.lines) {
    text(l.label, L, y, 10); text(String(l.qty), L + 280, y, 10); right(rupeesAscii(l.amount_rupees), y, 10);
    y -= 15;
  }
  y -= 6; rule(y); y -= 18;
  text("Subtotal", L, y, 10, font, muted); right(rupeesAscii(r.subtotalRupees), y, 10); y -= 15;
  if (r.gstRatePct > 0 || r.gstRupees > 0) {
    text(`GST (${r.gstRatePct}%)`, L, y, 10, font, muted); right(rupeesAscii(r.gstRupees), y, 10); y -= 15;
  }
  y -= 6; rule(y); y -= 20;
  text("Total paid", L, y, 12, bold); right(rupeesAscii(r.totalRupees), y, 12, bold); y -= 30;

  text("PAYMENT DETAILS", L, y, 8, bold, muted); y -= 16;
  const rows: [string, string | null][] = [
    ["Method", "UPI"],
    ["Paid on", r.paidAt ? formatIst(r.paidAt) : null],
    ["UPI UTR", r.utr],
    ["Payment id", r.paymentId],
    ["Order id", r.orderId],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    text(k, L, y, 10, font, muted); text(v, L + 120, y, 10); y -= 15;
  }

  const stamp = "PAID";
  const color = rgb(0.12, 0.55, 0.30);
  const size = 40, w = bold.widthOfTextAtSize(stamp, size);
  page.drawRectangle({ x: R - w - 40, y: 220, width: w + 28, height: 58, borderColor: color, borderWidth: 3, rotate: degrees(12), opacity: 0, borderOpacity: 0.8 });
  page.drawText(stamp, { x: R - w - 26, y: 236, size, font: bold, color, rotate: degrees(12), opacity: 0.8 });

  const foot = 72;
  page.drawLine({ start: { x: L, y: foot + 26 }, end: { x: R, y: foot + 26 }, thickness: 0.8, color: line });
  text("This is a payment receipt, not a tax invoice.", L, foot + 8, 9, bold, muted);
  text("Issued by Saathum. Questions: support@saathum.com", L, foot - 6, 9, font, muted);

  return doc.save();
}
