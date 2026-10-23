import { describe, it, expect } from "vitest";
import { maskOrderForSeller, maskAddress, firstNameOf, assertNoSellerLeak, type MaskInput } from "./hf_merch_mask";
import { computeMerchMoney, MERCH_DEFAULT_CFG } from "./hf_merch_math";

const money = computeMerchMoney({ baseUnitPaise: 50_000, markupUnitPaise: 20_000, qty: 1, payMethod: "cashfree", cfg: MERCH_DEFAULT_CFG });
const row = (over: Record<string, unknown> = {}): MaskInput => ({
  order_id: "shp_abcdef0123456789abcd", order_no: "SHP-ABCDEF01", created_at: 1_700_000_000_000, pay_status: "confirmed", fulfil_status: "new",
  approval_status: "approved", refund_status: "none", printrove_order_ref: "PR-999",
  address_json: JSON.stringify({ name: "Asha Verma", phone: "9876543210", line1: "H-12 Rajpur Road", line2: "Near Clock Tower", city: "Dehradun", state: "Uttarakhand", pincode: "248001" }),
  merch_json: JSON.stringify({ v: 1, sellerUid: "u_seller", title: "Tiger tee", imageUrl: "https://x/y.png", colour: "Black", size: "M", qty: 1, money, holdDays: 7,
    payMethod: "cashfree", cfOrderId: "cf_secret_1", walletOpId: "op_secret_2", printFileUrl: "https://secret/print.png" }),
  courier: null, awb: null, tracking_url: null, delivered_at: null, earning_credited_at: null,
  uid: "u_buyer_secret", contact_name: "Asha Verma", utr: "UTR123456", payer_vpa: "asha@upi", payer_reference: "REF-1", cashfree_order_id: "cf_secret_1",
  wallet_op_id: "op_secret_2", phone: "9876543210", email: "asha@example.com",
  ...over,
});

describe("maskOrderForSeller", () => {
  it("no forbidden key and no forbidden value leaks", () => {
    const out = maskOrderForSeller(row());
    assertNoSellerLeak(out);
    const s = JSON.stringify(out);
    for (const secret of ["9876543210", "asha@example.com", "asha@upi", "UTR123456", "REF-1", "cf_secret_1", "op_secret_2", "u_buyer_secret", "Rajpur", "Clock Tower", "248001", "Verma", "secret/print.png", "u_seller"]) {
      expect(s).not.toContain(secret);
    }
  });
  it("shows first name, city, state and a masked address", () => {
    const out = maskOrderForSeller(row());
    expect(out.buyer).toEqual({ firstName: "Asha", city: "Dehradun", state: "Uttarakhand", addressMasked: "H-12 •••••, Dehradun 2480••" });
  });
  it("shows what the influencer earns and when it becomes available after delivery", () => {
    const d = 1_700_100_000_000;
    const out = maskOrderForSeller(row({ fulfil_status: "delivered", delivered_at: d }));
    expect(out.status).toBe("delivered");
    expect(out.money.youEarnPaise).toBe(12_000);
    expect(out.money.availableAt).toBe(d + 7 * 86_400_000);
    expect(out.money.credited).toBe(false);
  });
  it("a cancelled / rejected order earns nothing and has no availableAt", () => {
    const out = maskOrderForSeller(row({ approval_status: "rejected", fulfil_status: "new", delivered_at: null }));
    expect(out.status).toBe("cancelled");
    expect(out.money.youEarnPaise).toBe(0);
    expect(out.money.availableAt).toBeNull();
  });
  it("status mapping: unapproved is new, approved is processing", () => {
    expect(maskOrderForSeller(row({ approval_status: "pending" })).status).toBe("new");
    expect(maskOrderForSeller(row({ approval_status: "approved" })).status).toBe("processing");
    expect(maskOrderForSeller(row({ fulfil_status: "shipped", courier: "Delhivery", awb: "AWB1", tracking_url: "https://t/1" })).shipping).toEqual({ courier: "Delhivery", awb: "AWB1", trackingUrl: "https://t/1" });
  });
  it("survives junk json", () => {
    const out = maskOrderForSeller(row({ address_json: "not json", merch_json: null }));
    expect(out.buyer.firstName).toBe("Customer");
    expect(out.product.qty).toBe(1);
  });
  it("assertNoSellerLeak catches a nested forbidden key", () => {
    expect(() => assertNoSellerLeak({ a: [{ b: { phone: "1" } }] })).toThrow(/seller_leak:phone/);
  });
  it("helpers", () => {
    expect(firstNameOf("  Ravi Kumar")).toBe("Ravi");
    expect(firstNameOf("")).toBe("Customer");
    expect(maskAddress({ line1: "Flat 4B, Some Society", city: "Pune", pincode: "411001" })).toBe("•••••, Pune 4110••");
  });
});
