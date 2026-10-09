// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-LIMITS-1] Receipt numbering (sequential per FY, idempotent), GST split, monthly tax-invoice statements, printable HTML.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  issueDocument, issueTopupReceipt, backfillTopupReceipts, gstSplit, platformSharePaise, supplierFrom, invoicingOn, docNumberPrefix,
  runMonthlyStatements, renderReceiptHtml, listReceipts,
} from "./hf_receipts";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const T = (iso: string) => Date.parse(iso);

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, status TEXT, created_at INTEGER, ended_at INTEGER, billed_minutes INTEGER, paid_rupees INTEGER, test_rupees INTEGER, host_paid_rupees INTEGER);
           CREATE TABLE hf_topups (id TEXT PRIMARY KEY, uid TEXT, amount_rupees INTEGER, gateway TEXT, status TEXT, credited INTEGER, gateway_payment_id TEXT, paid_at INTEGER, created_at INTEGER);`);
  // the migration's last statement is an ALTER on hf_calls (needs the column absent): run all but that line
  const sql = readFileSync(new URL("../../migrations/2026-10-10-hf-wallet-limits.sql", import.meta.url), "utf8").replace(/^ALTER TABLE.*$/m, "");
  db.exec(sql);
  const stmt = (q: string, args: unknown[] = []) => ({
    q, args,
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  const batch = async (list: any[]) => {
    db.exec("BEGIN");
    try { for (const s of list) db.prepare(s.q).run(...s.args); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    return [];
  };
  return { db, env: { DB_META: { prepare: (q: string) => stmt(q), batch } } as any };
}

let h: ReturnType<typeof makeEnv>;
beforeEach(() => { h = makeEnv(); });

describe("numbering", () => {
  it("receipts are HF/R/<FY>/<seq>, tax invoices use the short FY so they fit 16 characters", () => {
    expect(docNumberPrefix("HF", "receipt", T("2026-10-10T00:00:00Z"))).toBe("HF/R/2026-27/");
    expect(docNumberPrefix("HF", "tax_invoice", T("2026-10-10T00:00:00Z"))).toBe("HF/I/26-27/");
    expect((docNumberPrefix("HF", "tax_invoice", T("2026-10-10T00:00:00Z")) + "12345").length).toBe(16);
  });
  it("sequential within a financial year and restarting in the next", async () => {
    const at = T("2026-10-10T06:30:00Z");
    const a = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t1", amountRupees: 100, now: at });
    const b = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u2", source: "topup", sourceId: "t2", amountRupees: 200, now: at + 1000 });
    const c = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t3", amountRupees: 300, now: at + 2000 });
    expect([a.number, b.number, c.number]).toEqual(["HF/R/2026-27/1", "HF/R/2026-27/2", "HF/R/2026-27/3"]);
    const next = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t4", amountRupees: 50, now: T("2027-04-01T00:00:00Z") });
    expect(next.number).toBe("HF/R/2027-28/1");
  });
  it("is idempotent per source: the same top-up never gets a second number and burns no number", async () => {
    const at = T("2026-10-10T06:30:00Z");
    const a = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t1", amountRupees: 100, now: at });
    const again = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t1", amountRupees: 100, now: at + 5000 });
    const par = await Promise.all([
      issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t2", amountRupees: 100, now: at }),
      issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t2", amountRupees: 100, now: at }),
    ]);
    expect(again.id).toBe(a.id);
    expect(par[0].number).toBe(par[1].number);
    const third = await issueDocument(h.env, { prefix: "HF", kind: "receipt", uid: "u1", source: "topup", sourceId: "t3", amountRupees: 100, now: at });
    expect([a.number, par[0].number, third.number]).toEqual(["HF/R/2026-27/1", "HF/R/2026-27/2", "HF/R/2026-27/3"]); // no gaps
  });
  it("issueTopupReceipt uses the configured prefix and the top-up's paid date", async () => {
    const r = await issueTopupReceipt(h.env, { hfInvoicePrefix: "ab" }, { id: "hftop_x", uid: "u1", amount_rupees: 500, gateway: "razorpay", gateway_payment_id: "pay_1", paid_at: T("2027-02-01T00:00:00Z") });
    expect(r.number).toBe("ab/R/2026-27/1");
    expect(JSON.parse(r.data)).toMatchObject({ gateway: "razorpay", gatewayPaymentId: "pay_1" });
  });
  it("backfill gives credited top-ups their receipt once", async () => {
    h.db.prepare("INSERT INTO hf_topups VALUES ('hftop_a','u1',200,'razorpay','paid',1,'p',?,?)").run(T("2026-10-01T00:00:00Z"), T("2026-10-01T00:00:00Z"));
    h.db.prepare("INSERT INTO hf_topups VALUES ('hftop_b','u1',200,'razorpay','created',0,NULL,NULL,?)").run(T("2026-10-02T00:00:00Z"));
    await backfillTopupReceipts(h.env, {}, "u1");
    await backfillTopupReceipts(h.env, {}, "u1");
    const list = await listReceipts(h.env, "u1");
    expect(list.map((r) => r.source_id)).toEqual(["hftop_a"]);
  });
});

describe("GST split (18% included in the platform share)", () => {
  it("intra-state: CGST 9 + SGST 9", () => {
    // Rs 118 gross -> taxable 100, tax 18
    expect(gstSplit(11800, "27", "27")).toEqual({ grossPaise: 11800, taxablePaise: 10000, gstPaise: 1800, cgstPaise: 900, sgstPaise: 900, igstPaise: 0, intraState: true });
  });
  it("inter-state: all IGST", () => {
    expect(gstSplit(11800, "29", "27")).toMatchObject({ taxablePaise: 10000, gstPaise: 1800, cgstPaise: 0, sgstPaise: 0, igstPaise: 1800, intraState: false });
  });
  it("unknown caller state is treated as intra-state", () => {
    expect(gstSplit(11800, null, "27").intraState).toBe(true);
  });
  it("odd paise: taxable + CGST + SGST always add back to the gross", () => {
    for (const gross of [100, 700, 1234, 9999, 100001]) {
      const s = gstSplit(gross, null, "27");
      expect(s.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(gross);
      expect(s.sgstPaise - s.cgstPaise).toBeLessThanOrEqual(1);
    }
  });
  it("platform share of paid calls: paid minus the host's paid share, test calls excluded", () => {
    // Rs10/min x 10 min: caller paid 100, host 48 -> platform 52
    expect(platformSharePaise([{ paid_rupees: 100, host_paid_rupees: 48 }, { paid_rupees: 0, host_paid_rupees: 0 }, { paid_rupees: null, host_paid_rupees: null }])).toBe(5200);
  });
});

describe("monthly statements", () => {
  const CFG = { hfGstin: "27ABCDE1234F1Z5", hfLegalName: "Example Pvt Ltd", hfLegalAddress: "1 Road, Mumbai", hfStateCode: "27", hfInvoicePrefix: "HF" };
  const call = (id, uid, at, paid, hostPaid) => h.db.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, status, created_at, ended_at, billed_minutes, paid_rupees, test_rupees, host_paid_rupees) VALUES (?,?,?,?,?,?,?,?,0,?)").run(id, uid, "h1", "completed", at, at, 5, paid, hostPaid);

  it("does nothing while hfGstin is empty: receipts only", async () => {
    expect(invoicingOn(supplierFrom({}))).toBe(false);
    call("c1", "u1", T("2026-09-10T00:00:00Z"), 100, 48);
    expect(await runMonthlyStatements(h.env, {}, T("2026-10-01T05:00:00Z"))).toBeNull();
    expect((await h.env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_receipts").first()).n).toBe(0);
  });
  it("with a GSTIN: one tax invoice per caller for last month, idempotent, other months untouched", async () => {
    call("c1", "u1", T("2026-09-10T00:00:00Z"), 100, 48);
    call("c2", "u1", T("2026-09-20T00:00:00Z"), 200, 108);
    call("c3", "u2", T("2026-09-21T00:00:00Z"), 50, 18);
    call("c4", "u1", T("2026-10-02T00:00:00Z"), 999, 0);       // this month: not in the September statement
    call("c5", "u3", T("2026-09-22T00:00:00Z"), 0, 0);         // test-credit call: nothing to invoice
    const now = T("2026-10-01T05:00:00Z");
    const r1 = await runMonthlyStatements(h.env, CFG, now);
    const r2 = await runMonthlyStatements(h.env, CFG, now + 3600_000);
    expect(r1).toEqual({ month: "2026-09", issued: 2, skipped: 0 });
    expect(r2.issued).toBe(0);
    const u1 = (await listReceipts(h.env, "u1"))[0];
    // u1 platform share = (100-48)+(200-108) = 144 rupees gross
    expect(u1).toMatchObject({ kind: "tax_invoice", amount_rupees: 144, gstin: "27ABCDE1234F1Z5", taxable_paise: Math.round(14400 * 100 / 118) });
    expect(u1.taxable_paise + u1.gst_paise).toBe(14400);
    expect(u1.number).toMatch(/^HF\/I\/26-27\/\d+$/);
    expect(JSON.parse(u1.data)).toMatchObject({ period: "2026-09", calls: 2, intraState: true });
  });
  it("catches up only in the first days of the month", async () => {
    call("c1", "u1", T("2026-09-10T00:00:00Z"), 100, 48);
    expect(await runMonthlyStatements(h.env, CFG, T("2026-10-20T05:00:00Z"))).toBeNull();
  });
});

describe("printable page", () => {
  const row = (kind, extra = {}) => ({ id: "hfr_x", number: "HF/R/2026-27/1", uid: "u1", kind, source: "topup", source_id: "t", amount_rupees: 500, taxable_paise: null, gst_paise: null, gstin: null, issued_at: T("2026-10-10T06:30:00Z"), data: JSON.stringify({ gateway: "razorpay" }), ...extra });
  it("says not a tax invoice when no GSTIN is set, and escapes names", () => {
    const html = renderReceiptHtml(row("receipt"), supplierFrom({ hfLegalName: "A & B" }), "<script>x</script>");
    expect(html).toContain("not a tax invoice");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("@media print");
  });
  it("tax invoice shows GSTIN, taxable value and CGST/SGST", () => {
    const s = gstSplit(14400, null, "27");
    const html = renderReceiptHtml(row("tax_invoice", { number: "HF/I/26-27/1", taxable_paise: s.taxablePaise, gst_paise: s.gstPaise, gstin: "27ABCDE1234F1Z5", data: JSON.stringify({ period: "2026-09", calls: 2, cgstPaise: s.cgstPaise, sgstPaise: s.sgstPaise, igstPaise: 0 }) }), supplierFrom({ hfGstin: "27ABCDE1234F1Z5", hfLegalName: "Ex" }), null);
    expect(html).toContain("Tax invoice");
    expect(html).toContain("GSTIN: 27ABCDE1234F1Z5");
    expect(html).toContain("CGST @ 9%");
    expect(html).toContain("SGST @ 9%");
  });
});
