// [HF-WIRE-20] The wallet top-up order the Cashfree adapter sends: real customer details, app vs web return URL.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cashfreeAdapter } from "./cashfree_adapter";

const env = { CASHFREE_APP_ID: "id", CASHFREE_SECRET_KEY: "cfsk_ma_prod_s" } as any;
const T = "hftop_" + "b".repeat(24);
afterEach(() => vi.unstubAllGlobals());
const stub = () => {
  const sent: any[] = [];
  vi.stubGlobal("fetch", async (_u: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ order_id: T, payment_session_id: "session_abcdefghij12", order_status: "ACTIVE" }), { status: 200 });
  });
  return sent;
};
const base = { orderId: T, amountPaise: 1000, currency: "INR", uid: "u1", listingId: "", kind: "wallet_topup" as const };

describe("cashfree adapter, wallet top-up", () => {
  it("app orders return to the app page, carry the real phone/email, and never the 999 placeholder", async () => {
    const sent = stub();
    const o = await cashfreeAdapter.createOrder(env, { ...base, client: "app", customer: { phone: "9876543210", email: "fan@example.com" } });
    expect("error" in o).toBe(false);
    expect(sent[0].order_meta.return_url).toBe("https://avatok.ai/pay/cashfree/return?t={order_id}");
    expect(sent[0].order_meta.notify_url).toMatch(/\/api\/hf\/wallet\/topup\/webhook\/cashfree$/);
    expect(sent[0].customer_details.customer_phone).toBe("9876543210");
    expect(sent[0].customer_details.customer_email).toBe("fan@example.com");
    expect(JSON.stringify(sent[0])).not.toContain("9999999999");
  });

  it("web orders keep the website return", async () => {
    const sent = stub();
    await cashfreeAdapter.createOrder(env, { ...base, client: "web", customer: { phone: "9876543210", email: null } });
    expect(sent[0].order_meta.return_url).toBe("https://avatok.ai/pay/cashfree/done?t={order_id}");
    expect(sent[0].customer_details).not.toHaveProperty("customer_email");
  });

  it("CASHFREE_APP_RETURN_URL overrides the app return; the website's CASHFREE_RETURN_URL does not touch app orders", async () => {
    const sent = stub();
    await cashfreeAdapter.createOrder({ ...env, CASHFREE_RETURN_URL: "https://site.test/x", CASHFREE_APP_RETURN_URL: "https://ret.test/r?t={order_id}" }, { ...base, client: "app", customer: { phone: "9876543210", email: null } });
    await cashfreeAdapter.createOrder({ ...env, CASHFREE_RETURN_URL: "https://site.test/x" }, { ...base, client: "app", customer: { phone: "9876543210", email: null } });
    expect(sent[0].order_meta.return_url).toBe("https://ret.test/r?t={order_id}");
    expect(sent[1].order_meta.return_url).toBe("https://avatok.ai/pay/cashfree/return?t={order_id}");
  });

  it("no number: refused, nothing sent", async () => {
    const sent = stub();
    const o = await cashfreeAdapter.createOrder(env, { ...base, client: "app", customer: { phone: null, email: "fan@example.com" } });
    expect(o).toEqual({ error: "customer_phone_required", status: 422 });
    expect(sent).toHaveLength(0);
  });
});
