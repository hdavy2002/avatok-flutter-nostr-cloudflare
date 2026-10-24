// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-AUTH-WA-ONLY-1] Website sign-up: email code (hashed, 10 min, 5 tries, 60 s gap, rate limits, unique email)
// and the WhatsApp verify that creates the account only with a proven email; web sign-in never creates one.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
const events: any[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({
  track: async (_e: any, _u: string, name: string, _a: string, props: any) => { events.push({ name, ...props }); },
  trackUser: async () => {}, trackException: async () => {}, metric: () => {},
}));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
vi.mock("../lib/handles", () => ({ ensureHandle: async () => "h" }));
vi.mock("../lib/clerk_ticket", () => ({ mintClerkSignInTicket: async (_e: any, uid: string) => ({ ok: true, ticket: `tkt_${uid}` }) }));
vi.mock("../lib/clerk_verified_email", () => ({ attachVerifiedClerkEmail: async () => ({ ok: true }) }));
vi.mock("../lib/otp_sender", () => ({
  otpProvider: () => "wasender",
  sendOtp: async () => ({ ok: true, sessionId: "s1", provider: "wasender" }),
  checkOtp: async (_e: any, _s: any, _p: any, code: string) => (code === "123456" ? "match" : "mismatch"),
  sendFailMessage: () => "x",
  checkOnWhatsapp: async () => true,
}));

import { signupEmailSend, signupEmailVerify } from "./signup_email_otp";
import { whatsappAuthVerify } from "./whatsapp_auth";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>, mails: any[], clerkPosts: any[], clerkEmailOwner: boolean;
const PHONE = "+919876543210";
const EMAIL = "asha@example.com";

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, "0")).join("");
const post = (path: string, body: unknown, ip = "1.1.1.1") =>
  new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
const send = (email = EMAIL, ip?: string) => signupEmailSend(post("/api/auth/signup/email/send", { email }, ip), env);
const verifyEmail = (code: string, email = EMAIL) => signupEmailVerify(post("/api/auth/signup/email/verify", { email, code }), env);
const lastCode = () => /letter-spacing:8px[^>]*>(\d{6})</.exec(mails[mails.length - 1].html)![1];
/** Pretend the 60 s resend gap has passed. */
async function skipGap(email = EMAIL) {
  const k = `su_email_otp:${await sha(`su-email|${email}`)}`;
  const rec = JSON.parse(kv.get(k)!); rec.sent_at -= 61_000; kv.set(k, JSON.stringify(rec));
}

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE phone_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone_hash TEXT, e164 TEXT, session_id TEXT, status TEXT, attempts INTEGER, created_at INTEGER, verified_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT, phone_verified_at INTEGER, email_verified INTEGER, email_hash TEXT, email_verified_at INTEGER, updated_at INTEGER);
    CREATE TABLE deletion_requests (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE users (uid TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, created_via TEXT, phone_hash TEXT, private_number TEXT, show_private_number INTEGER, display_name TEXT, email_hash TEXT);
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
  kv = new Map(); mails = [];
  env = {
    DB_META: {
      prepare: (q: string) => stmt(q),
      batch: async (stmts: any[]) => { db.exec("BEGIN"); try { for (const s of stmts) s._sync(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
    },
    TOKENS: { put: async (k: string, v: string) => { kv.set(k, v); }, get: async (k: string) => kv.get(k) ?? null, delete: async (k: string) => { kv.delete(k); } },
    Q_EMAIL: { send: async (m: any) => { mails.push(m); } },
    CLERK_SECRET_KEY: "sk_test",
  };
}

beforeEach(() => {
  makeEnv(); cfg = {}; events.length = 0; clerkPosts = []; clerkEmailOwner = false;
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/users")) {
      const body = JSON.parse(init.body);
      clerkPosts.push(body);
      return new Response(JSON.stringify({ id: `user_${body.external_id}` }), { status: 200 });
    }
    if (u.includes("/users?email_address")) return new Response(JSON.stringify(clerkEmailOwner ? [{ id: "user_other" }] : []), { status: 200 });
    return new Response("[]", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("email code: send", () => {
  it("emails a 6-digit code and stores only its hash", async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, expires_in_s: 600, resend_after_s: 60 });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(EMAIL);
    const stored = [...kv.values()].join("|");
    expect(stored).not.toContain(lastCode());
    expect(events.map((e) => e.name)).toContain("email_otp_sent");
  });

  it("rejects a bad address and an email that already has an account (tells them to use WhatsApp)", async () => {
    expect((await send("nope")).status).toBe(400);
    clerkEmailOwner = true;
    const r = await send();
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.error).toBe("email_taken");
    expect(b.message).toMatch(/WhatsApp/);
    expect(mails).toHaveLength(0);
  });

  it("60 s resend cooldown, then 5 per hour per email", async () => {
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429); // inside the gap
    for (let i = 0; i < 4; i++) { await skipGap(); expect((await send()).status).toBe(200); }
    await skipGap();
    const r = await send();
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("rate_limited");
    expect(mails).toHaveLength(5);
  });

  it("10 per hour per IP across different emails", async () => {
    for (let i = 0; i < 10; i++) expect((await send(`u${i}@example.com`, "9.9.9.9")).status).toBe(200);
    expect((await send("u99@example.com", "9.9.9.9")).status).toBe(429);
    expect((await send("u99@example.com", "8.8.8.8")).status).toBe(200);
  });
});

describe("email code: verify", () => {
  it("right code returns a single-use proof and burns the code", async () => {
    await send();
    const r = await verifyEmail(lastCode());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.proof).toMatch(/^[0-9a-f]{48}$/);
    expect((await verifyEmail(lastCode())).status).toBe(410); // code is gone
    expect(events.map((e) => e.name)).toContain("email_otp_verified");
  });

  it("wrong code counts down, the 5th wrong try kills the code", async () => {
    await send();
    const real = lastCode();
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      const r = await verifyEmail(wrong);
      expect(r.status).toBe(400);
      expect((await r.json()).attempts_left).toBe(5 - i);
    }
    expect((await verifyEmail(wrong)).status).toBe(400);
    const dead = await verifyEmail(real);
    expect(dead.status).toBe(429);
    expect(events.filter((e) => e.name === "email_otp_failed" && e.reason === "wrong_code")).toHaveLength(5);
  });

  it("an expired code is 410", async () => {
    await send();
    const k = `su_email_otp:${await sha(`su-email|${EMAIL}`)}`;
    const rec = JSON.parse(kv.get(k)); rec.exp = Date.now() - 1; kv.set(k, JSON.stringify(rec));
    expect((await verifyEmail(lastCode())).status).toBe(410);
  });

  it("a code for one email does not verify another", async () => {
    await send();
    expect((await verifyEmail(lastCode(), "other@example.com")).status).toBe(410);
  });
});

describe("WhatsApp verify as the sign-up/sign-in step (client: web)", () => {
  async function seedCode() {
    db.prepare("INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at) VALUES ('anon:x',?,?,'s1','sent',0,?)")
      .run(await sha(PHONE), PHONE, Date.now());
  }
  async function proofFor(email = EMAIL) {
    await send(email); return (await (await verifyEmail(lastCode(), email)).json()).proof;
  }
  const wa = (extra: Record<string, unknown> = {}) =>
    whatsappAuthVerify(post("/api/auth/whatsapp/verify", { phone: PHONE, code: "123456", client: "web", ...extra }), env);

  it("sign-in with an unknown number answers no_account and creates nothing (even with the phone-only flag on)", async () => {
    cfg = { hfPhoneOnlySignupEnabled: true };
    await seedCode();
    const b = await (await wa()).json();
    expect(b).toMatchObject({ ok: true, status: "no_account" });
    expect(clerkPosts).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(0);
  });

  it("sign-up with a proven email + name creates the account with both stored, and burns the proof", async () => {
    const proof = await proofFor();
    await seedCode();
    const r = await wa({ age_confirmed: true, signup: { name: "Asha Rao", email_proof: proof } });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, status: "signed_in", isNew: true, needs18Plus: false });
    const c = clerkPosts[0];
    expect(c.email_address).toEqual([EMAIL]);
    expect(c).toMatchObject({ first_name: "Asha", last_name: "Rao" });
    expect(c.public_metadata.signup).toBe("whatsapp_email");
    const uid = `user_${c.external_id}`;
    expect(db.prepare("SELECT display_name, email_hash FROM users WHERE uid=?").get(uid)).toMatchObject({ display_name: "Asha Rao", email_hash: await sha(EMAIL) });
    expect(db.prepare("SELECT phone_verified, email_verified, email_hash FROM contact_verification WHERE uid=?").get(uid))
      .toMatchObject({ phone_verified: 1, email_verified: 1, email_hash: await sha(EMAIL) });
    // proof is single-use
    await seedCode();
    const again = await (await wa({ signup: { name: "Asha Rao", email_proof: proof } })).json();
    expect(again.error).toBe("email_proof_invalid");
  });

  it("a made-up or missing email proof is refused BEFORE the WhatsApp code is used", async () => {
    await seedCode();
    const r = await wa({ signup: { name: "Asha Rao", email_proof: "f".repeat(48) } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("email_proof_invalid");
    expect(db.prepare("SELECT attempts, status FROM phone_otp").get()).toMatchObject({ attempts: 0, status: "sent" });
    const noName = await wa({ signup: { name: " ", email_proof: "f".repeat(48) } });
    expect((await noName.json()).error).toBe("invalid_name");
  });

  it("a wrong WhatsApp code creates nothing and keeps the email proof usable for the retry", async () => {
    const proof = await proofFor();
    await seedCode();
    const bad = await wa({ code: "000000", signup: { name: "Asha Rao", email_proof: proof } });
    expect(bad.status).toBe(400);
    expect(clerkPosts).toHaveLength(0);
    const ok = await wa({ signup: { name: "Asha Rao", email_proof: proof } });
    expect((await ok.json()).status).toBe("signed_in");
  });

  it("if Clerk says the email is taken at creation time, answer 409 email_taken and leave the code usable", async () => {
    const proof = await proofFor();
    await seedCode();
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      if (init?.method === "POST" && String(url).endsWith("/users")) return new Response(JSON.stringify({ errors: [{ code: "form_identifier_exists" }] }), { status: 422 });
      return new Response("[]", { status: 200 });
    });
    const r = await wa({ signup: { name: "Asha Rao", email_proof: proof } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("email_taken");
    expect(db.prepare("SELECT COUNT(*) n FROM users").get().n).toBe(0);
    expect(db.prepare("SELECT status FROM phone_otp").get().status).toBe("sent");
  });

  it("an existing number just signs in, with or without a sign-up payload", async () => {
    db.prepare("INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at) VALUES ('u9',1,?,1,1)").run(await sha(PHONE));
    await seedCode();
    expect(await (await wa()).json()).toMatchObject({ status: "signed_in", ticket: "tkt_u9" });
  });
});
