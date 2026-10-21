// @ts-nocheck -- node:sqlite / worker_threads CI integration, not Worker runtime.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const mocks = vi.hoisted(() => ({ send: vi.fn(), check: vi.fn(), verify: vi.fn(), metric: vi.fn(async () => {}), audit: vi.fn(async () => {}) }));
vi.mock("../hooks", () => ({ track: mocks.metric, trackUser: mocks.audit, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async (r) => ({ uid: r.headers.get("x-test-uid") ?? "u1" }), isFail: () => false }));
vi.mock("./identity", () => ({ emailFor: async () => null }));
vi.mock("./otp_sender", () => ({ otpProvider: () => "wasender", sendOtp: mocks.send, checkOnWhatsapp: mocks.check,
  checkOtp: mocks.verify, sendFailMessage: () => "Please try again later." }));
import { OTP_RESERVE_SQL, reserveOtpSend, finishOtpSend, reserveAndSendOtp } from "./otp_send_reservation";
import { phoneOtpSend, phoneOtpVerify } from "../routes/phone_otp";
import { whatsappAuthSend, whatsappAuthVerify } from "../routes/whatsapp_auth";
import { mePhoneStart } from "../routes/me_dashboard";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const schema = readFileSync(new URL("../../migrations/phone_otp.sql", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const base = { uid: "u1", phoneHash: "h1", e164: "+919876543210", now,
  actorLimit: 5, phoneLimit: 5, globalLimit: 300, hourMs: 3600000, gapMs: 30000, cooldown: "account" };
let db, env;
function adapter(sqlite) {
  // Expand D1 numbered placeholders for node:sqlite's positional binding API.
  const query = (sql, args) => {
    const bound = [];
    const expanded = sql.replace(/\?(\d+)/g, (_, n) => { bound.push(args[Number(n) - 1]); return "?"; });
    return { statement: sqlite.prepare(expanded), bound };
  };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const q = query(sql, args); return q.statement.get(...q.bound) ?? null; },
    run: async () => { const q = query(sql, args); const r = q.statement.run(...q.bound); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => stmt(sql) };
}
function seed(uid, hash, time = now - 60000, status = "pending") {
  db.prepare("INSERT INTO phone_otp(uid,phone_hash,e164,status,created_at) VALUES(?,?,?,?,?)")
    .run(uid, hash, "+919876543210", status, time);
}
const post = (phone = base.e164, uid = "u1", ip = "192.0.2.1") => new Request("https://test/send", {
  method: "POST", headers: { "content-type": "application/json", "x-test-uid": uid, "cf-connecting-ip": ip }, body: JSON.stringify({ phone }),
});
beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec(schema);
  db.exec("CREATE TABLE contact_verification(uid TEXT, phone_hash TEXT, phone_verified INTEGER); CREATE TABLE deletion_requests(uid TEXT, status TEXT)");
  env = { DB_META: adapter(db) };
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.send.mockReset().mockResolvedValue({ ok: true, provider: "wasender", sessionId: "session" });
  mocks.check.mockReset().mockResolvedValue(true); mocks.verify.mockReset().mockResolvedValue("match"); mocks.metric.mockClear(); mocks.audit.mockClear();
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

describe("atomic OTP shared ledger", () => {
  it.each(["phone", "account", "ip", "global", "window"])("serializes simultaneous independent SQLite writers at the %s boundary", async (scope) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-reserve-"));
    const file = join(dir, "ledger.sqlite"); const disk = new DatabaseSync(file);
    const workers = [];
    try {
      disk.exec(schema); disk.exec("PRAGMA journal_mode=WAL");
      const cap = scope === "global" ? 300 : scope === "ip" ? 10 : scope === "window" ? 3 : 5;
      const insert = disk.prepare("INSERT INTO phone_otp(uid,phone_hash,e164,status,created_at) VALUES(?,?,?,'failed',?)");
      for (let i = 0; i < cap - 1; i++) insert.run(
        scope === "account" || scope === "ip" || scope === "window" ? "shared" : `seed${i}`,
        scope === "phone" ? "shared" : `seed${i}`, base.e164, now - 60000);
      const gate = new SharedArrayBuffer(4);
      const ready = [];
      const jobs = Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
        let readyResolve, readyReject;
        ready.push(new Promise((resolveReady, rejectReady) => {
          readyResolve = resolveReady; readyReject = rejectReady;
        }));
        const args = [scope === "account" || scope === "ip" || scope === "window" ? "shared" : `u${i}`,
          scope === "phone" ? "shared" : `p${i}`, base.e164, now, scope === "ip" ? 1 : 0,
          30000, 4, 3600000, scope === "ip" ? 9 : 4, 299, scope === "window" ? 2 : 0, scope === "window" ? 600000 : 0];
        const w = new Worker(`
          const { workerData: d, parentPort } = require('node:worker_threads');
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(d.file); db.exec('PRAGMA busy_timeout=15000');
          parentPort.postMessage('ready');
          Atomics.wait(new Int32Array(d.gate), 0, 0);
          const bound = [];
          const sql = d.sql.replace(/\\?(\\d+)/g, (_, n) => { bound.push(d.args[Number(n) - 1]); return '?'; });
          const result = db.prepare(sql).get(...bound);
          db.close(); parentPort.postMessage({ granted: !!result });
        `, { eval: true, workerData: { file, sql: OTP_RESERVE_SQL, args, gate } });
        workers.push(w);
        w.on("error", (error) => { readyReject(error); reject(error); });
        w.on("message", (v) => { if (v === "ready") readyResolve(); else resolve(v.granted); });
      }));
      // All threads share a release gate; competing statements use independent connections.
      const results = Promise.all(jobs);
      // Observe errors immediately even when a worker fails before the ready barrier.
      void results.catch(() => {});
      await Promise.all(ready);
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      expect((await results).filter(Boolean)).toHaveLength(1);
      expect(disk.prepare("SELECT COUNT(*) AS n FROM phone_otp").get().n).toBe(cap);
    } finally { await Promise.all(workers.map((w) => w.terminate())); disk.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  it("reports actual remaining cooldown and hourly budget, then ages out failed/pending attempts", async () => {
    for (let i = 0; i < 5; i++) seed("other" + i, "h1", now - 60000, i % 2 ? "failed" : "pending");
    expect(await reserveOtpSend(env.DB_META, base)).toEqual({ granted: false, retryAfter: 3540 });
    expect(await reserveOtpSend(env.DB_META, { ...base, now: now + 3540000 })).toMatchObject({ granted: true });
    expect(await reserveOtpSend(env.DB_META, { ...base, now: now + 3541000 })).toEqual({ granted: false, retryAfter: 29 });
  });

  it("finalizes only the granted pending row and cannot overwrite a finalized result", async () => {
    const a = await reserveOtpSend(env.DB_META, base);
    const b = await reserveOtpSend(env.DB_META, { ...base, uid: "u2", phoneHash: "h2" });
    await finishOtpSend(env.DB_META, a.id, "session-a"); await finishOtpSend(env.DB_META, a.id, null);
    expect(db.prepare("SELECT status,session_id FROM phone_otp WHERE id=?").get(a.id)).toMatchObject({ status: "sent", session_id: "session-a" });
    expect(db.prepare("SELECT status,session_id FROM phone_otp WHERE id=?").get(b.id)).toMatchObject({ status: "pending", session_id: null });
  });

  it("does not contact any provider when database reservation fails", async () => {
    env.DB_META.prepare = () => { throw new Error("unavailable"); };
    expect((await reserveAndSendOtp(env, base, 10, true)).status).toBe(503);
    expect(mocks.check).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });


  it("never retries a provider success when recording its result fails", async () => {
    const prepare = env.DB_META.prepare;
    env.DB_META.prepare = (sql) => {
      if (sql.startsWith("UPDATE phone_otp")) throw new Error("database offline");
      return prepare(sql);
    };
    expect((await reserveAndSendOtp(env, base, 10)).status).toBe(503);
    expect(db.prepare("SELECT status FROM phone_otp").get().status).toBe("pending");
    expect((await reserveAndSendOtp(env, base, 10)).status).toBe(429);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "timeout", "throw", "not_on_whatsapp"])("keeps %s counted and non-verifiable without retry", async (mode) => {
    if (mode === "throw") mocks.send.mockRejectedValue(new Error("private provider payload"));
    else if (mode === "not_on_whatsapp") mocks.check.mockResolvedValue(false);
    else mocks.send.mockResolvedValue({ ok: false, provider: "wasender", reason: "provider_error", detail: mode === "timeout" ? "no_response" : "private provider payload" });
    await reserveAndSendOtp(env, base, 10, true);
    expect(db.prepare("SELECT status FROM phone_otp").get().status).toBe(mode === "throw" ? "pending" : "failed");
    expect((await reserveAndSendOtp(env, base, 10, true)).status).toBe(429);
    expect(mocks.send).toHaveBeenCalledTimes(mode === "not_on_whatsapp" ? 0 : 1);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.metric.mock.calls)).not.toContain("private provider payload");
    expect(JSON.stringify(mocks.metric.mock.calls)).not.toContain(base.e164);
  });
});

describe("all shared-ledger send routes", () => {
  it("mixed login/account/phone-change requests cannot exceed the common 300 budget", async () => {
    for (let i = 0; i < 299; i++) seed(`seed${i}`, `seed${i}`);
    const routes = [whatsappAuthSend, phoneOtpSend, mePhoneStart];
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      routes[i % 3](post(`+91987654${String(3200 + i)}`, `user${i}`, `192.0.2.${i + 1}`), env)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(14);
    for (const r of results.filter((r) => r.status === 429)) {
      const b = await r.json(); expect(b.error).toBe("rate_limited"); expect(Number(r.headers.get("retry-after"))).toBe(b.retry_after_s);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM phone_otp").get().n).toBe(300);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("reserves before WhatsApp presence preflight, and rejects racing calls without any provider work", async () => {
    mocks.check.mockImplementation(async () => {
      expect(db.prepare("SELECT status FROM phone_otp").get().status).toBe("pending");
      await new Promise((r) => setTimeout(r, 20)); return true;
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => whatsappAuthSend(post(), env)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(mocks.check).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("retains the phone-change 3 per 10 minute budget", async () => {
    for (let i = 0; i < 3; i++) seed("u1", `old${i}`);
    expect((await mePhoneStart(post(), env)).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(env, "u1", null, "dash2_phone_change", "saathum",
      expect.objectContaining({ step: "start", ok: false, outcome: "rate_limited" }));
  });


  it.each(["too_many_attempts", "code_expired"])("preserves the existing %s verification guard", async (reason) => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base.e164))), (x) => x.toString(16).padStart(2, "0")).join("");
    seed("u1", hash, reason === "code_expired" ? now - 600001 : now, "sent");
    if (reason === "too_many_attempts") db.exec("UPDATE phone_otp SET attempts=5");
    const req = new Request("https://test/verify", { method: "POST", body: JSON.stringify({ phone: base.e164, code: "123456" }) });
    expect((await (await phoneOtpVerify(req, env)).json()).error).toBe(reason);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed", "expired"])("verification never reads a %s attempt", async (status) => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base.e164))), (x) => x.toString(16).padStart(2, "0")).join("");
    seed("u1", hash, now, status);
    for (const route of [whatsappAuthVerify, phoneOtpVerify]) {
      const req = new Request("https://test/verify", { method: "POST", body: JSON.stringify({ phone: base.e164, code: "123456" }) });
      expect((await (await route(req, env)).json()).error).toBe("no_code");
    }
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
