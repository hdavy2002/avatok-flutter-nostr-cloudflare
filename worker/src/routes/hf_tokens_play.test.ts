// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-TOK-PLAY-1] Routes: products, prepare, verify (idempotent), RTDN (Google-signed JWT, 401 / 503 / handled).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = { uid: "u1", cfg: { hfTokensEnabled: true, hfCheckoutProvider: "google_play" } as any };
vi.mock("../authz", () => ({
  requireUser: async () => ({ uid: state.uid }),
  isFail: (u: any) => !!u?.error,
}));
vi.mock("./config", () => ({ readConfig: async () => state.cfg }));

import { hfTokensPlayRoute } from "./hf_tokens_play";
import { makePlayWorld, makeEnv, mintJwt, b64urlStr, PKG } from "../lib/hf_play_testkit";
import { _resetJwksCache, accountHashFor } from "../lib/hf_play";
import { getLots, hasOpenDebt } from "../lib/hf_token_ledger";

let world: any, env: any;
const AUD = "https://api.example.test/api/hf/tokens/play/rtdn", SA = "push@proj.iam.gserviceaccount.com";
const count = (sql: string) => env.DB_META._raw.prepare(sql).get().n;
const call = (path: string, body?: unknown, init: any = {}) =>
  hfTokensPlayRoute(new Request(`https://x.test${path}`, { method: body === undefined && !init.method ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(init.headers ?? {}) }, ...init }), env, path);
const claims = (o: any = {}) => ({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...o });
const pushBody = (n: any) => ({ message: { data: b64urlStr(JSON.stringify(n)), messageId: "1" }, subscription: "projects/p/subscriptions/s" });
const rtdn = async (n: any, jwt?: string) => call("/api/hf/tokens/play/rtdn", pushBody(n), { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
const TOK = "purchase-token-1-abcdefghij";

beforeEach(() => {
  world = makePlayWorld();
  env = makeEnv({ HF_RTDN_AUDIENCE: AUD, HF_RTDN_PUSH_SA: SA });
  state.uid = "u1"; state.cfg = { hfTokensEnabled: true, hfCheckoutProvider: "google_play" };
  _resetJwksCache();
  vi.stubGlobal("fetch", world.fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("products", () => {
  it("lists active packs with pricing, never a display price", async () => {
    const r = await call("/api/hf/tokens/products");
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.products.map((p: any) => p.productId)).toEqual(["hf_tokens_100", "hf_tokens_200", "hf_tokens_500", "hf_tokens_1000"]);
    expect(j.products[0]).toEqual({ productId: "hf_tokens_100", tokens: 102, pricingVersion: "gp-r1", redemptionPaisePerToken: 100, purchasePaisePerToken: 118, creditPaise: 10200 });
    expect(j.products.map((p: any) => p.tokens)).toEqual([102, 204, 510, 1020]); // Rs 120 / 240 / 600 / 1,200 packs add Rs 102 / 204 / 510 / 1,020
    expect(j.products.map((p: any) => p.creditPaise)).toEqual([10200, 20400, 51000, 102000]);
    expect(JSON.stringify(j)).not.toMatch(/price"|display|rupee/i);
  });
});

describe("prepare", () => {
  it("returns the HMAC account id, remembers it, and carries the confirm threshold", async () => {
    const r = await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_500" });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.obfuscatedAccountId).toBe(await accountHashFor(env, "u1"));
    expect(j.obfuscatedAccountId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(j.confirmAbovePaise).toBe(100_000);
    expect(env.DB_META._raw.prepare("SELECT uid FROM hf_play_accounts WHERE account_hash=?").get(j.obfuscatedAccountId).uid).toBe("u1");
    expect(env._events.some((e: any) => e.event === "hf_token_purchase_prepared")).toBe(true);
  });

  it("the account id is stable per user and different between users", async () => {
    const a = await (await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" })).json();
    const a2 = await (await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" })).json();
    state.uid = "u2";
    const b = await (await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" })).json();
    expect(a.obfuscatedAccountId).toBe(a2.obfuscatedAccountId);
    expect(a.obfuscatedAccountId).not.toBe(b.obfuscatedAccountId);
  });

  it("no spend limit: a big day of purchases never stops prepare (HF-NOLIMITS-1)", async () => {
    env.DB_META._raw.prepare("INSERT INTO hf_token_lots (id, uid, kind, pricing_version, redemption_paise_per_token, tokens_granted_micro, tokens_left_micro, tokens_reserved_micro, paid_paise, provider, provider_ref, created_at, status) VALUES ('l1','u1','purchase','gp-v1',82,1,1,0,150000,'google_play','o',?, 'active')").run(Date.now());
    const r = await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_1000" });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.dayRemainingPaise).toBeUndefined();
    expect(j.monthRemainingPaise).toBeUndefined();
  });

  it("refuses when tokens are off, for an unknown pack, and without the salt", async () => {
    state.cfg = { hfTokensEnabled: false };
    expect((await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" })).status).toBe(503);
    state.cfg = { hfTokensEnabled: true, hfCheckoutProvider: "google_play" };
    expect((await call("/api/hf/tokens/play/prepare", { productId: "nope_pack" })).status).toBe(400);
    delete env.HF_PLAY_ACCOUNT_SALT;
    expect((await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" })).status).toBe(503);
  });
});

describe("verify route", () => {
  it("credits once and answers the same on a retry, with a balance summary", async () => {
    const hash = await accountHashFor(env, "u1");
    world.buy(TOK, { obfuscated: hash });
    const body = { productId: "hf_tokens_100", purchaseToken: TOK };
    const a = await (await call("/api/hf/tokens/play/verify", body)).json();
    const b = await (await call("/api/hf/tokens/play/verify", body)).json();
    expect(a).toMatchObject({ ok: true, status: "consumed", duplicate: false, tokens: 102, paidPaise: 12000, consumed: true });
    expect(a.balance).toMatchObject({ totalTokens: 102, availableTokens: 102 });
    expect(b).toMatchObject({ ok: true, status: "consumed", duplicate: true, tokens: 102 });
    expect((await getLots(env, "u1")).length).toBe(1);
  });

  it("pending answers {status:'pending'}; another user's token is a 403", async () => {
    const hash = await accountHashFor(env, "u1");
    world.buy(TOK, { obfuscated: hash, purchaseState: 2, orderId: undefined });
    const j = await (await call("/api/hf/tokens/play/verify", { productId: "hf_tokens_100", purchaseToken: TOK })).json();
    expect(j).toMatchObject({ ok: true, status: "pending" });
    state.uid = "u2";
    const r = await call("/api/hf/tokens/play/verify", { productId: "hf_tokens_100", purchaseToken: TOK });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("account_mismatch");
  });

  it("rejects malformed bodies", async () => {
    expect((await call("/api/hf/tokens/play/verify", { productId: "hf_tokens_100", purchaseToken: "short" })).status).toBe(400);
    expect((await call("/api/hf/tokens/play/verify", { productId: "Bad Product!", purchaseToken: TOK })).status).toBe(400);
  });
});

describe("rtdn", () => {
  it("no or bad JWT is 401", async () => {
    expect((await rtdn({ testNotification: {} })).status).toBe(401);
    expect((await rtdn({ testNotification: {} }, "a.b.c")).status).toBe(401);
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const parts = jwt.split(".");
    expect((await rtdn({ testNotification: {} }, `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`)).status).toBe(401); // tampered signature
  });

  it("a JWT signed by a key Google does not publish is 401", async () => {
    const { jwt } = await mintJwt(claims());
    const other = await mintJwt(claims(), { kid: "other" });
    world.jwks.keys = [other.jwk];
    expect((await rtdn({ testNotification: {} }, jwt)).status).toBe(401);
  });

  it("wrong audience, wrong issuer, wrong email and expired are all 401", async () => {
    for (const bad of [{ aud: "https://elsewhere" }, { iss: "https://evil.example" }, { email: "other@x.iam.gserviceaccount.com" }, { exp: Math.floor(Date.now() / 1000) - 3600 }]) {
      const { jwt, jwk } = await mintJwt(claims(bad));
      world.jwks.keys = [jwk]; _resetJwksCache();
      expect((await rtdn({ testNotification: {} }, jwt)).status).toBe(401);
    }
  });

  it("unconfigured is 503 (fail closed), even with a plausible JWT", async () => {
    delete env.HF_RTDN_AUDIENCE;
    expect((await rtdn({ testNotification: {} }, "a.b.c")).status).toBe(503);
    env.HF_RTDN_AUDIENCE = AUD; delete env.HF_RTDN_PUSH_SA;
    expect((await rtdn({ testNotification: {} }, "a.b.c")).status).toBe(503);
  });

  it("a valid JWT with the test notification is 200 and ignored", async () => {
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const r = await rtdn({ packageName: PKG, testNotification: { version: "1.0" } }, jwt);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, handled: false, ignored: "test" });
  });

  it("PURCHASED credits through the account map (no session), once even when delivered twice", async () => {
    await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" }); // stores hash -> u1
    world.buy(TOK, { obfuscated: await accountHashFor(env, "u1") });
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const n = { packageName: PKG, oneTimeProductNotification: { version: "1.0", notificationType: 1, purchaseToken: TOK, sku: "hf_tokens_100" } };
    expect((await rtdn(n, jwt)).status).toBe(200);
    expect((await rtdn(n, jwt)).status).toBe(200);
    expect((await getLots(env, "u1")).length).toBe(1);
    expect(env.DB_META._raw.prepare("SELECT state FROM hf_play_purchases").get().state).toBe("consumed");
  });

  it("PURCHASED for an account we never prepared is ignored (200), nothing credited", async () => {
    world.buy(TOK, { obfuscated: "unknown-account-hash-0123456789abcdefghijklm" });
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const r = await rtdn({ packageName: PKG, oneTimeProductNotification: { notificationType: 1, purchaseToken: TOK, sku: "hf_tokens_100" } }, jwt);
    expect(r.status).toBe(200);
    expect((await r.json()).ignored).toBe("unknown_account");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
  });

  it("voidedPurchaseNotification refunds the lot; a repeat is a harmless 200", async () => {
    const hash = await accountHashFor(env, "u1");
    world.buy(TOK, { obfuscated: hash });
    await call("/api/hf/tokens/play/verify", { productId: "hf_tokens_100", purchaseToken: TOK });
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const n = { packageName: PKG, voidedPurchaseNotification: { purchaseToken: TOK, orderId: "GPA." + TOK, productType: 1, refundType: 1 } };
    expect((await rtdn(n, jwt)).status).toBe(200);
    expect((await rtdn(n, jwt)).status).toBe(200);
    expect(env.DB_META._raw.prepare("SELECT state FROM hf_play_purchases").get().state).toBe("refunded");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE kind='refund_revoke'")).toBe(1);
    expect(await hasOpenDebt(env, "u1")).toBe(false);
  });

  it("a notification for another package is ignored", async () => {
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const r = await rtdn({ packageName: "com.other.app", voidedPurchaseNotification: { purchaseToken: TOK, orderId: "X", productType: 1 } }, jwt);
    expect((await r.json()).ignored).toBe("other_package");
  });

  it("Play being down on a PURCHASED notification answers 503 so Pub/Sub retries", async () => {
    await call("/api/hf/tokens/play/prepare", { productId: "hf_tokens_100" });
    world.buy(TOK, { obfuscated: await accountHashFor(env, "u1") });
    world.flags.down = true;
    const { jwt, jwk } = await mintJwt(claims());
    world.jwks.keys = [jwk];
    const r = await rtdn({ packageName: PKG, oneTimeProductNotification: { notificationType: 1, purchaseToken: TOK, sku: "hf_tokens_100" } }, jwt);
    expect(r.status).toBe(503);
  });
});
