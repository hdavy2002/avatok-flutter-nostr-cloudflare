// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-AUTH-WA-1] WhatsApp-only sign-up: new-user creation, double-submit race, flag off unchanged, rate limits, 18+.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
let otpDelay = 0;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
vi.mock("../lib/handles", () => ({ ensureHandle: async () => "h" }));
vi.mock("../lib/clerk_ticket", () => ({ mintClerkSignInTicket: async (_e: any, uid: string) => ({ ok: true, ticket: `tkt_${uid}` }) }));
vi.mock("../lib/otp_sender", () => ({
  otpProvider: () => "wasender",
  sendOtp: async () => ({ ok: true, sessionId: "s1", provider: "wasender" }),
  checkOtp: async (_e: any, _s: any, _p: any, code: string) => { if (otpDelay) await new Promise((r) => setTimeout(r, otpDelay)); return code === "123456" ? "match" : "mismatch"; },
  sendFailMessage: () => "x",
  checkOnWhatsapp: async () => true,
}));

import { whatsappAuthSend, whatsappAuthVerify, hfAgeConfirm } from "./whatsapp_auth";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, clerkPosts: any[], clerkMode: "ok" | "fail_once" | "slow";
const PHONE = "+919876543210";

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT, status TEXT, attempts INTEGER, created_at INTEGER, verified_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT, phone_verified_at INTEGER, updated_at INTEGER);
    CREATE TABLE deletion_requests (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE users (uid TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, created_via TEXT, phone_hash TEXT, private_number TEXT, show_private_number INTEGER);
    CREATE TABLE hf_phone_signup (phone_hash TEXT PRIMARY KEY, ext_id TEXT NOT NULL, uid TEXT, state TEXT NOT NULL DEFAULT 'creating', lease_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE hf_age_confirm (uid TEXT PRIMARY KEY, confirmed_at INTEGER NOT NULL, source TEXT NOT NULL);
  `);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
    _sync: () => db.prepare(q).run(...args),
  });
  env = {
    DB_META: {
      prepare: (q: string) => stmt(q),
      batch: async (stmts: any[]) => { db.exec("BEGIN"); try { for (const s of stmts) s._sync(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
    },
    TOKENS: { put: async () => {}, get: async () => null, delete: async () => {} },
    CLERK_SECRET_KEY: "sk_test",
  };
}

let counter = 0;
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, "0")).join("");
async function seedCode(phone = PHONE, attempts = 0) {
  db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at) VALUES ('anon:x',?,?,?,'sent',?,?)")
    .run(await sha(phone), phone, `s${++counter}`, attempts, Date.now());
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const verify = (extra: Record<string, unknown> = {}, phone = PHONE) =>
  whatsappAuthVerify(post("/api/auth/whatsapp/verify", { phone, code: "123456", client: "android", ...extra }), env);

beforeEach(() => {
  makeEnv(); otpDelay = 0; cfg = { hfPhoneOnlySignupEnabled: true }; clerkPosts = []; clerkMode = "ok"; counter = 0;
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    if (init?.method === "POST" && String(url).endsWith("/users")) {
      const body = JSON.parse(init.body);
      clerkPosts.push(body);
      if (clerkMode === "slow") await new Promise((r) => setTimeout(r, 120));
      if (clerkMode === "fail_once") { clerkMode = "ok"; return new Response("boom", { status: 500 }); }
      return new Response(JSON.stringify({ id: `user_${body.external_id}` }), { status: 200 });
    }
    // GET /users?external_id=... (crash recovery lookup): nothing there
    return new Response("[]", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("phone-only sign-up (flag on)", () => {
  it("creates the Clerk user (external_id + username, no email/phone) and the app rows, returns a ticket", async () => {
    await seedCode();
    const r = await verify();
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, status: "signed_in", isNew: true, needs18Plus: true });
    expect(b.ticket).toMatch(/^tkt_user_hfwa_/);
    expect(clerkPosts).toHaveLength(1);
    const c = clerkPosts[0];
    expect(c.external_id).toMatch(/^hfwa_[0-9a-f]{24}$/);
    expect(c.username).toMatch(/^hf[0-9a-f]{24}$/);
    expect(c.email_address).toBeUndefined();
    expect(c.phone_number).toBeUndefined();
    expect(c.skip_password_requirement).toBe(true);
    const uid = `user_${c.external_id}`;
    const hash = await sha(PHONE);
    expect(db.prepare("SELECT created_via, phone_hash, private_number, show_private_number FROM users WHERE uid=?").get(uid)).toMatchObject({ created_via: "web", phone_hash: hash, private_number: PHONE, show_private_number: 0 });
    expect(db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?").get(uid)).toMatchObject({ phone_verified: 1, phone_hash: hash });
    expect(db.prepare("SELECT state, uid FROM hf_phone_signup WHERE phone_hash=?").get(hash)).toMatchObject({ state: "done", uid });
  });

  it("two verifies racing for one new number create exactly one Clerk user and one users row", async () => {
    clerkMode = "slow"; otpDelay = 20; // both requests read the same unconsumed code before either consumes it
    await seedCode();
    const [r1, r2] = await Promise.all([verify(), verify()]);
    const [b1, b2] = [await r1.json(), await r2.json()];
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(b1.ticket).toBe(b2.ticket);
    expect(clerkPosts).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM hf_phone_signup").get().n).toBe(1);
  });

  it("a second sign-in of the same number is an existing account (no second Clerk user); 18+ stays owed until confirmed", async () => {
    await seedCode();
    const first = await (await verify()).json();
    await seedCode();
    const again = await (await verify()).json();
    expect(clerkPosts).toHaveLength(1);
    expect(again).toMatchObject({ status: "signed_in", isNew: false, needs18Plus: true });
    expect(again.ticket).toBe(first.ticket);
    const uid = `user_${clerkPosts[0].external_id}`;
    const bad = await hfAgeConfirm(post("/api/hf/account/age-confirm", {}, { "x-test-uid": uid }), env);
    expect(bad.status).toBe(400);
    const ok = await hfAgeConfirm(post("/api/hf/account/age-confirm", { confirmed: true, client: "android" }, { "x-test-uid": uid }), env);
    expect(ok.status).toBe(200);
    await seedCode();
    expect(await (await verify()).json()).toMatchObject({ isNew: false, needs18Plus: false });
  });

  it("a purged account's leftover claim does not hand out its dead uid: the number signs up fresh", async () => {
    await seedCode();
    await verify();
    const hash = await sha(PHONE);
    db.prepare("DELETE FROM contact_verification").run(); db.prepare("DELETE FROM users").run(); // what a purge leaves behind
    await seedCode();
    const b = await (await verify()).json();
    expect(b.isNew).toBe(true);
    expect(clerkPosts).toHaveLength(2);
    expect(clerkPosts[1].external_id).not.toBe(clerkPosts[0].external_id);
    expect(db.prepare("SELECT state FROM hf_phone_signup WHERE phone_hash=?").get(hash).state).toBe("done");
  });

  it("age_confirmed:true in the verify body stores the confirmation and needs18Plus is false", async () => {
    await seedCode();
    const b = await (await verify({ age_confirmed: true })).json();
    expect(b).toMatchObject({ isNew: true, needs18Plus: false });
    expect(db.prepare("SELECT source FROM hf_age_confirm").get()).toMatchObject({ source: "android" });
  });

  it("a Clerk failure answers 502, releases the claim, and the retry succeeds", async () => {
    clerkMode = "fail_once";
    await seedCode();
    const r = await verify();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("signup_failed");
    expect(db.prepare("SELECT lease_at FROM hf_phone_signup").get().lease_at).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(0);
    const r2 = await verify();
    expect(r2.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(1);
  });
});

describe("flag off", () => {
  it("an unknown number still gets needs_email, with no Clerk call and no rows", async () => {
    cfg = {};
    await seedCode();
    const b = await (await verify()).json();
    expect(b).toMatchObject({ ok: true, status: "needs_email" });
    expect(b.proof).toBeTruthy();
    expect(clerkPosts).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM hf_phone_signup").get().n).toBe(0);
  });

  it("a known number gets the unchanged signed_in shape (no isNew / needs18Plus)", async () => {
    cfg = {};
    db.prepare("INSERT INTO contact_verification VALUES ('u9',1,?,1,1)").run(await sha(PHONE));
    await seedCode();
    const b = await (await verify()).json();
    expect(b).toEqual({ ok: true, status: "signed_in", ticket: "tkt_u9" });
  });
});

describe("rate limits stay", () => {
  it("send: a second code inside the 30 s resend gap is 429", async () => {
    const r1 = await whatsappAuthSend(post("/api/auth/whatsapp/send", { phone: PHONE, client: "android" }, { "cf-connecting-ip": "1.1.1.1" }), env);
    expect(r1.status).toBe(200);
    const r2 = await whatsappAuthSend(post("/api/auth/whatsapp/send", { phone: PHONE }, { "cf-connecting-ip": "1.1.1.1" }), env);
    expect(r2.status).toBe(429);
  });

  it("send: the 6th code in an hour for one number is 429", async () => {
    const h = await sha(PHONE);
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, status, attempts, created_at) VALUES ('anon:z',?,?,'sent',0,?)").run(h, PHONE, Date.now() - 120_000 + i);
    const r = await whatsappAuthSend(post("/api/auth/whatsapp/send", { phone: PHONE }, { "cf-connecting-ip": "2.2.2.2" }), env);
    expect(r.status).toBe(429);
  });

  it("verify: a code that has used its 5 attempts is 429 and creates nothing", async () => {
    await seedCode(PHONE, 5);
    const r = await verify();
    expect(r.status).toBe(429);
    expect(clerkPosts).toHaveLength(0);
  });

  it("verify: a wrong code never creates an account", async () => {
    await seedCode();
    const r = await verify({ code: "000000" });
    expect(r.status).toBe(400);
    expect(clerkPosts).toHaveLength(0);
  });
});
