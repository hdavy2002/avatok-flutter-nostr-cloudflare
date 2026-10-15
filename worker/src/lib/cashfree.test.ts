// [HF-CASHFREE-TOPUP-2] Environment from the key prefix, webhook secret defaults to the secret key (the worker has no room for more bindings).
import { describe, it, expect } from "vitest";
import { cashfreeIsProduction, cashfreeConfigured, verifyCashfreeSignature } from "./cashfree";

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
