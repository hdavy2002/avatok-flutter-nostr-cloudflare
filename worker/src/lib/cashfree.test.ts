// [HF-CASHFREE-TOPUP-2] Environment from the key prefix, webhook secret defaults to the secret key (the worker has no room for more bindings).
import { describe, it, expect, vi, afterEach } from "vitest";
import { cashfreeIsProduction, cashfreeConfigured, verifyCashfreeSignature, cashfreePhone, createCashfreeOrder } from "./cashfree";

const sign = async (secret: string, ts: string, body: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
};

describe("cashfree config", () => {
  it("production follows the key prefix unless CASHFREE_ENV says otherwise", () => {
    expect(cashfreeIsProduction({ CASHFREE_SECRET_KEY: "cfsk_ma_prod_abc" } as any)).toBe(true);
    expect(cashfreeIsProduction({ CASHFREE_SECRET_KEY: "cfsk_ma_test_abc" } as any)).toBe(false);
    expect(cashfreeIsProduction({ CASHFREE_SECRET_KEY: "cfsk_ma_prod_abc", CASHFREE_ENV: "sandbox" } as any)).toBe(false);
    expect(cashfreeIsProduction({ CASHFREE_SECRET_KEY: "x", CASHFREE_ENV: "production" } as any)).toBe(true);
  });

  it("configured with App ID + secret key alone; webhooks verify with the secret key", async () => {
    const env = { CASHFREE_APP_ID: "id", CASHFREE_SECRET_KEY: "cfsk_ma_prod_s" } as any;
    expect(cashfreeConfigured(env)).toBe(true);
    expect(cashfreeConfigured({ CASHFREE_APP_ID: "id" } as any)).toBe(false);
    const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}';
    expect(await verifyCashfreeSignature(env, body, await sign("cfsk_ma_prod_s", "1700", body), "1700")).toBe(true);
    expect(await verifyCashfreeSignature(env, body, await sign("other", "1700", body), "1700")).toBe(false);
  });
});

// [HF-WIRE-20] The order carries the payer's real number and email; HF top-ups are refused rather than sent with a made-up number.
describe("cashfree order body", () => {
  const env = { CASHFREE_APP_ID: "id", CASHFREE_SECRET_KEY: "cfsk_ma_prod_s" } as any;
  afterEach(() => vi.unstubAllGlobals());
  const stubFetch = () => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ order_id: "hftop_x", payment_session_id: "session_abc", order_status: "ACTIVE" }), { status: 200 });
    });
    return sent;
  };

  it("normalises Indian mobiles to 10 digits and rejects everything else", () => {
    expect(cashfreePhone("+91 98765 43210")).toBe("9876543210");
    expect(cashfreePhone("919876543210")).toBe("9876543210");
    expect(cashfreePhone("09876543210")).toBe("9876543210");
    expect(cashfreePhone("9876543210")).toBe("9876543210");
    expect(cashfreePhone("12345")).toBeNull();
    expect(cashfreePhone("1234567890")).toBeNull(); // does not start 6-9
    expect(cashfreePhone(null)).toBeNull();
  });

  it("sends the real phone, the real email and the given return_url, never 9999999999", async () => {
    const sent = stubFetch();
    const r = await createCashfreeOrder(env, {
      orderId: "hftop_x", amountPaise: 1000, customerId: "u1", customerPhone: "+91 98765 43210", customerEmail: "fan@example.com",
      returnUrl: "https://avatok.ai/pay/cashfree/return?t={order_id}", requirePhone: true,
    });
    expect("error" in r).toBe(false);
    expect(sent[0].customer_details).toEqual({ customer_id: "u1", customer_phone: "9876543210", customer_email: "fan@example.com" });
    expect(JSON.stringify(sent[0])).not.toContain("9999999999");
    expect(sent[0].order_meta.return_url).toBe("https://avatok.ai/pay/cashfree/return?t={order_id}");
  });

  it("requirePhone with no valid number: refused before any network call", async () => {
    const sent = stubFetch();
    for (const bad of [null, "", "99999", "+1 415 555 0100"]) {
      const r = await createCashfreeOrder(env, { orderId: "hftop_x", amountPaise: 1000, customerId: "u1", customerPhone: bad, requirePhone: true });
      expect(r).toEqual({ error: "customer_phone_required", status: 422 });
    }
    expect(sent).toHaveLength(0);
  });
});
