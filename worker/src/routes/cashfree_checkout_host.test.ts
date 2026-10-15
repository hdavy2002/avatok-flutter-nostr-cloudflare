// [HF-CASHFREE-CHECKOUT-HOST-1] avatok.ai/pay/cashfree* serves the hand-off page and the return redirect; every other host/path falls through.
import { describe, it, expect } from "vitest";
import { cashfreeCheckoutHost, cashfreeCheckoutUrl, cashfreeReturnUrl } from "./cashfree_checkout_host";

const env = { CASHFREE_SECRET_KEY: "cfsk_ma_prod_x" } as any;
const T = "hftop_" + "a".repeat(24);
const S = "session_abcDEF123_-xyz789payment";
const get = (u: string) => cashfreeCheckoutHost(new Request(u), env);

describe("cashfree checkout host", () => {
  it("builds the hand-off and return URLs on avatok.ai", () => {
    expect(cashfreeCheckoutUrl(S, T)).toBe(`https://avatok.ai/pay/cashfree?s=${S}&t=${T}`);
    expect(cashfreeReturnUrl()).toBe("https://avatok.ai/pay/cashfree/done?t={order_id}");
  });

  it("serves the checkout page in production mode for a valid session", async () => {
    const r = get(`https://avatok.ai/pay/cashfree?s=${S}&t=${T}`)!;
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("sdk.cashfree.com/js/v3/cashfree.js");
    expect(html).toContain('"production"');
    expect(html).toContain(JSON.stringify(S));
  });

  it("done redirects to the wallet with the top-up id; bad input goes to /wallet", () => {
    const d = get(`https://avatok.ai/pay/cashfree/done?t=${T}`)!;
    expect(d.status).toBe(302);
    expect(d.headers.get("location")).toMatch(new RegExp(`/wallet\\?topup=${T}$`));
    const bad = get(`https://avatok.ai/pay/cashfree?s=<script>&t=${T}`)!;
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/\/wallet$/);
  });

  it("ignores other hosts and paths", () => {
    expect(get(`https://api.hellofraands.com/pay/cashfree?s=${S}&t=${T}`)).toBeNull();
    expect(get("https://avatok.ai/")).toBeNull();
  });
});
