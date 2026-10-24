// [HF-QA-WEB-1024] Receipt display: GST as a minus line between Paid and Added, title-cased billed-to name, split on website top-ups too.
import { describe, expect, it } from "vitest";
import { renderReceiptHtml, titleCaseName, type ReceiptRow } from "./hf_receipts";
import { receiptSplitOf } from "../routes/hf_wallet_limits";

const sup = { gstin: "", legalName: "", address: "", stateCode: "", prefix: "HF" };
const row = (data: object): ReceiptRow => ({ id: "hfr_x", number: "HF/R/2026-27/1", uid: "u", kind: "receipt", source: "topup", source_id: "t1", amount_rupees: 5000, taxable_paise: null, gst_paise: null, gstin: null, issued_at: 1, data: JSON.stringify(data) });

describe("receipt display", () => {
  it("shows GST as a minus line between Paid and Added to wallet", () => {
    const html = renderReceiptHtml(row({ paidPaise: 500000, walletPaise: 423729, gstPaise: 76271, topupId: "t1" }), sup, "ravi KUMAR");
    const a = html.indexOf("Paid (secure payment)"), b = html.indexOf("GST (18%)"), c = html.indexOf("Added to your wallet");
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b);
    expect(html).toContain("− ₹762.71");
    expect(html).toContain("Ravi Kumar");
  });
  it("title-cases for display only", () => { expect(titleCaseName("  asha  DEVI ")).toBe("Asha Devi"); expect(titleCaseName(null)).toBe(""); });
  it("list split is sent for website top-ups, not only Play purchases", () => {
    expect(receiptSplitOf({ source: "topup", data: JSON.stringify({ paidPaise: 500000, walletPaise: 423729, gstPaise: 76271 }) })).toEqual({ paidPaise: 500000, gstPaise: 76271, walletPaise: 423729 });
    expect(receiptSplitOf({ source: "topup", data: "{}" })).toEqual({});
  });
});
