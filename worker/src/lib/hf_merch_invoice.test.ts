import { describe, it, expect } from "vitest";
import { merchDocFacts, renderMerchDocumentPdf, type MerchDocData } from "./hf_merch_invoice";
import { supplierFrom, type ReceiptRow } from "./hf_receipts";
import type { ShopOrderRow } from "./shop_orders_logic";

const row = (state: string): ShopOrderRow => ({
  order_id: "shp_0123456789abcdef0123", order_no: "HF-M-1", uid: "u1", amount_paise: 64_400, contact_name: "Asha Rao", confirmed_at: 1_760_000_000_000, pay_method: "wallet", seller_uid: "s1",
  address_json: JSON.stringify({ name: "Asha Rao", line1: "12 MG Road", city: "Pune", state, pincode: "411001" }),
  merch_json: JSON.stringify({ title: "Om tee", colour: "Black", size: "M", qty: 1, money: { gstRateBps: 500, inputGstPaise: 1_875 } }),
} as unknown as ShopOrderRow);
const cfg = { hfGstin: "27ABCDE1234F1Z5", hfLegalName: "Novora Labs Pvt Ltd", hfLegalAddress: "Mumbai", hfStateCode: "27", hfInvoicePrefix: "HF" };

describe("[HF-MERCH-GST-1] merch document facts", () => {
  it("buyer in the supplier's state: CGST + SGST, place of supply is the buyer's state, HSN from the flag", () => {
    const d = merchDocFacts(row("Maharashtra"), cfg);
    expect(d).toMatchObject({ hsn: "6109", taxablePaise: 61_333, gstPaise: 3_067, cgstPaise: 1_533, sgstPaise: 1_534, igstPaise: 0, intraState: true, buyerStateCode: "27", totalPaise: 64_400, inputGstPaise: 1_875, qty: 1 });
    expect(d.placeOfSupply).toBe("Maharashtra (27)");
  });
  it("buyer in another state: IGST", () => {
    const d = merchDocFacts(row("Karnataka"), cfg);
    expect(d).toMatchObject({ igstPaise: 3_067, cgstPaise: 0, sgstPaise: 0, intraState: false, buyerStateCode: "29" });
  });
  it("state typed oddly still matches; an unknown state is flagged", () => {
    expect(merchDocFacts(row("  maharashtra "), cfg).buyerStateCode).toBe("27");
    expect(merchDocFacts(row("Narnia"), cfg)).toMatchObject({ buyerStateCode: null, stateKnown: false });
  });
});

describe("[HF-MERCH-GST-1] merch document PDF", () => {
  const doc = (kind: "tax_invoice" | "receipt"): ReceiptRow => ({ id: "hfr_1", number: kind === "tax_invoice" ? "HF/I/26-27/1" : "HF/R/2026-27/1", uid: "u1", kind, source: "merch_order", source_id: "shp_x",
    amount_rupees: 644, taxable_paise: 61_333, gst_paise: 3_067, gstin: kind === "tax_invoice" ? cfg.hfGstin : null, issued_at: 1_760_000_000_000, data: null });
  it("draws a tax invoice and a receipt as real PDFs", async () => {
    const data = merchDocFacts(row("Maharashtra"), cfg) as MerchDocData;
    for (const kind of ["tax_invoice", "receipt"] as const) {
      const bytes = await renderMerchDocumentPdf({ doc: doc(kind), sup: supplierFrom(kind === "tax_invoice" ? cfg : {}), data, buyerEmail: "a@example.com" });
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    }
  });
});
