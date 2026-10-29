// [SUPPORT-QUEUE-1] Queues carry IDs, never content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_MAX_BODY_BYTES, QueueMessageTooLargeError, queueBodyBytes, safeQueueSend } from "../src/lib/queue_guard";
import { enqueueEmail, recoverEmailOutbox } from "../src/lib/email_outbox";
import { enqueueWhatsApp, processWhatsAppJob, recoverWhatsAppQueue, waRetryDelaySeconds } from "../src/lib/whatsapp_queue";
import { handleEmailQueueMessage, retryDelaySeconds } from "../../consumers/src/email_job";

// ---------- fakes ----------

class FakeR2 {
  objects = new Map<string, string>();
  async put(key: string, value: string) { this.objects.set(key, value); }
  async get(key: string) { const v = this.objects.get(key); return v === undefined ? null : { text: async () => v }; }
  async delete(key: string) { this.objects.delete(key); }
}

function fakeQueue() {
  const sent: unknown[] = [];
  return { sent, send: vi.fn(async (body: unknown) => { sent.push(body); }) };
}

/** D1-shaped email_outbox: one superset row per outbox_key, enough SQL semantics for the code paths under test. */
class EmailDb {
  rows = new Map<string, Record<string, any>>();
  failAll = false;
  prepare(sql: string) {
    const db = this;
    let args: any[] = [];
    const st = {
      bind(...a: any[]) { args = a; return st; },
      async first() {
        if (db.failAll) throw new Error("D1_ERROR: no such column: body_r2_key");
        if (sql.includes("FROM email_outbox WHERE outbox_key")) { const r = db.rows.get(String(args[0])); return r ? { ...r } : null; }
        return null; // email_suppressions etc.
      },
      async run() {
        if (db.failAll) throw new Error("D1_ERROR: no such column: body_r2_key");
        if (sql.includes("INSERT OR IGNORE INTO email_outbox")) {
          if (db.rows.has(String(args[0]))) return { meta: { changes: 0 } };
          db.rows.set(String(args[0]), {
            outbox_key: args[0], kind: args[1], state: "pending", payload_json: args[2], delivery_status: "queued",
            recipient_id: args[3], order_id: args[4], message_version: args[5], attempts: 0, max_attempts: 5, next_attempt_at: args[7],
            outbox_id: args[8], to_email: args[9], subject: args[10], from_addr: args[11], reply_to_json: args[12],
            body_r2_key: args[13], attachments_json: args[14], lane: args[15],
          });
          return { meta: { changes: 1 } };
        }
        const row = db.rows.get(String(args[0]));
        if (!row) return { meta: { changes: 0 } };
        if (sql.includes("state='sending',delivery_status='sending'")) {
          if (!(row.delivery_status === "queued" || row.delivery_status === "failed")) return { meta: { changes: 0 } };
          row.delivery_status = "sending"; row.state = "sending"; row.attempts++;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("delivery_status='provider_accepted'")) { row.delivery_status = "provider_accepted"; row.state = "sent"; return { meta: { changes: 1 } }; }
        if (sql.includes("SET state='failed',delivery_status='failed'") && sql.includes("IN ('queued','failed')")) { row.delivery_status = "failed"; row.error_message = args[1]; return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      },
      async all() { return { results: [] }; },
    };
    return st;
  }
}

function emailEnv(over: Record<string, unknown> = {}) {
  const db = new EmailDb();
  const r2 = new FakeR2();
  const q = { legacy: fakeQueue(), priority: fakeQueue(), bulk: fakeQueue() };
  const env: any = {
    DB_META: db, BACKUP_R2: r2,
    Q_EMAIL: q.legacy, Q_EMAIL_PRIORITY: q.priority, Q_EMAIL_BULK: q.bulk,
    EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "test-key",
    ...over,
  };
  return { env, db, r2, q };
}

// ---------- 16 KB guard ----------

describe("safeQueueSend (16 KB guard)", () => {
  it("passes a small body through", async () => {
    const q = fakeQueue();
    await safeQueueSend(q as any, { job: "send", outboxId: "a", key: "b" });
    expect(q.sent).toHaveLength(1);
  });

  it("throws on a body over 16 KB and never calls queue.send", async () => {
    const q = fakeQueue();
    const big = { html: "x".repeat(QUEUE_MAX_BODY_BYTES + 1) };
    await expect(safeQueueSend(q as any, big)).rejects.toBeInstanceOf(QueueMessageTooLargeError);
    expect(q.send).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes, not characters", async () => {
    const q = fakeQueue();
    const body = { t: "₹".repeat(6000) }; // 6000 chars but 18000 bytes
    expect(queueBodyBytes(body)).toBeGreaterThan(QUEUE_MAX_BODY_BYTES);
    await expect(safeQueueSend(q as any, body)).rejects.toThrow(/limit/);
  });
});

// ---------- enqueueEmail ----------

describe("enqueueEmail: store then queue the id", () => {
  it("writes body + attachment to R2 and the row to D1, and queues only {job,outboxId,key}", async () => {
    const { env, db, r2, q } = emailEnv();
    const html = "<p>" + "statement row ".repeat(20_000) + "</p>"; // ~280 KB, would blow a 128 KB queue message
    const res = await enqueueEmail(env, {
      to: "buyer@example.test", subject: "Statement", html, outboxKey: "stmt:1", kind: "earnings_statement",
      from: "Saathum <noreply@example.test>", replyTo: { email: "help@example.test", name: "Help" },
      attachments: [{ name: "invite.ics", content: "QkVHSU4=" }],
    }, { lane: "bulk" });

    expect(res).toMatchObject({ outboxKey: "stmt:1", status: "queued", queued: true, durable: true });
    const row = db.rows.get("stmt:1")!;
    expect(row).toMatchObject({ to_email: "buyer@example.test", subject: "Statement", from_addr: "Saathum <noreply@example.test>", lane: "bulk", kind: "earnings_statement" });
    expect(JSON.parse(row.reply_to_json)).toEqual({ email: "help@example.test", name: "Help" });
    expect(row.payload_json).not.toContain("statement row"); // no content in D1 payload either
    expect(row.body_r2_key).toMatch(/^email-outbox\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/body\.html$/);
    expect(r2.objects.get(row.body_r2_key)).toBe(html);
    const atts = JSON.parse(row.attachments_json) as { name: string; key: string }[];
    expect(atts).toHaveLength(1);
    expect(r2.objects.get(atts[0].key)).toBe("QkVHSU4=");

    expect(q.bulk.sent).toHaveLength(1);
    expect(q.bulk.sent[0]).toEqual({ job: "send", outboxId: row.outbox_id, key: "stmt:1" });
    expect(queueBodyBytes(q.bulk.sent[0])).toBeLessThan(300);
    expect(q.priority.sent).toHaveLength(0);
    expect(q.legacy.sent).toHaveLength(0);
  });

  it("routes priority mail (OTP kind) to the priority queue by default", async () => {
    const { env, q } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Code", html: "<b>123456</b>", kind: "email_otp" });
    expect(q.priority.sent).toHaveLength(1);
    expect(q.bulk.sent).toHaveLength(0);
  });

  it("falls back to the legacy email queue when lane queues are not bound", async () => {
    const { env, q } = emailEnv({ Q_EMAIL_PRIORITY: undefined, Q_EMAIL_BULK: undefined });
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>" }, { lane: "bulk" });
    expect(q.legacy.sent).toHaveLength(1);
    expect(q.legacy.sent[0]).toMatchObject({ job: "send" });
    expect((q.legacy.sent[0] as any).html).toBeUndefined();
  });

  it("a duplicate key whose first send was accepted is skipped: nothing stored, nothing queued", async () => {
    const { env, db, r2, q } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "dup:1" }, { lane: "bulk" });
    db.rows.get("dup:1")!.delivery_status = "provider_accepted";
    const objectsBefore = r2.objects.size;
    const again = await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "dup:1" }, { lane: "bulk" });
    expect(again).toMatchObject({ status: "provider_accepted", queued: false });
    expect(q.bulk.sent).toHaveLength(1);
    expect(r2.objects.size).toBe(objectsBefore);
  });

  it("strict callers get a failure (and nothing is queued) when the outbox is unavailable", async () => {
    const { env, db, q } = emailEnv();
    db.failAll = true;
    const res = await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>" }, { lane: "bulk" });
    expect(res).toMatchObject({ status: "failed", queued: false, durable: false });
    expect(q.bulk.sent.length + q.legacy.sent.length).toBe(0);
  });

  it("inlineFallback sends the small legacy shape if the outbox is unavailable, but never an oversized one", async () => {
    const { env, db, q } = emailEnv();
    db.failAll = true;
    const ok = await enqueueEmail(env, { to: "a@example.test", subject: "Code", html: "<b>1</b>", kind: "email_otp" }, { lane: "priority", inlineFallback: true });
    expect(ok).toMatchObject({ queued: true, durable: false });
    expect(q.legacy.sent[0]).toMatchObject({ to: "a@example.test", html: "<b>1</b>" });

    const big = await enqueueEmail(env, { to: "a@example.test", subject: "Big", html: "x".repeat(20_000) }, { lane: "bulk", inlineFallback: true });
    expect(big).toMatchObject({ status: "failed", queued: false });
    expect(q.legacy.sent).toHaveLength(1);
  });

  it("recoverEmailOutbox re-sends only the id for rows already in R2", async () => {
    const { env, db, q } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "rec:1" }, { lane: "bulk" });
    const row = db.rows.get("rec:1")!;
    const rows = [{ outbox_key: "rec:1", payload_json: row.payload_json, delivery_status: "queued", outbox_id: row.outbox_id, body_r2_key: row.body_r2_key, lane: "bulk" }];
    const base = env.DB_META.prepare.bind(env.DB_META);
    env.DB_META.prepare = (sql: string) => {
      const st = base(sql);
      if (sql.startsWith("SELECT outbox_key,payload_json")) st.all = async () => ({ results: rows });
      return st;
    };
    expect(await recoverEmailOutbox(env)).toBe(1);
    expect(q.bulk.sent).toHaveLength(2);
    expect(q.bulk.sent[1]).toEqual({ job: "send", outboxId: row.outbox_id, key: "rec:1" });
  });
});

// ---------- email consumer ----------

describe("email consumer: new id-only shape and legacy inline shape", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("loads the row + R2 objects for a {job:'send'} message and sends the stored body", async () => {
    const { env, db } = emailEnv();
    await enqueueEmail(env, {
      to: "buyer@example.test", subject: "Receipt", html: "<p>stored in r2</p>", outboxKey: "new:1", kind: "receipt",
      attachments: [{ name: "a.ics", content: "QkVHSU4=" }],
    }, { lane: "bulk" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "<m1>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const msg = { job: "send", outboxId: db.rows.get("new:1")!.outbox_id, key: "new:1" };
    await handleEmailQueueMessage(msg, env);

    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(sent.to).toEqual([{ email: "buyer@example.test" }]);
    expect(sent.htmlContent).toContain("stored in r2");
    expect(sent.attachment).toEqual([{ name: "a.ics", content: "QkVHSU4=" }]);
    expect(db.rows.get("new:1")!.delivery_status).toBe("provider_accepted");
  });

  it("still accepts a legacy message with the html inline (queued before the deploy)", async () => {
    const { env, db } = emailEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "<m2>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleEmailQueueMessage({ to: "old@example.test", subject: "Old", html: "<p>inline</p>", outboxKey: "legacy:1" }, env);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body)).htmlContent).toContain("inline");
    void db;
  });

  it("skips (acks) a job whose row is already provider_accepted: no R2 read, no provider call", async () => {
    const { env, db, r2 } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "dup:2" }, { lane: "bulk" });
    const row = db.rows.get("dup:2")!;
    row.delivery_status = "provider_accepted";
    const getSpy = vi.spyOn(r2, "get");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await handleEmailQueueMessage({ job: "send", outboxId: row.outbox_id, key: "dup:2" }, env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("two deliveries of the same job send once", async () => {
    const { env, db } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "twice:1" }, { lane: "bulk" });
    const msg = { job: "send", outboxId: db.rows.get("twice:1")!.outbox_id, key: "twice:1" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "<m3>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleEmailQueueMessage(msg, env);
    await handleEmailQueueMessage(msg, env);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws (so the queue retries) when the row is missing, and fails the row permanently when R2 lost the body", async () => {
    const { env, db, r2 } = emailEnv();
    await expect(handleEmailQueueMessage({ job: "send", outboxId: "x", key: "nope" }, env)).rejects.toThrow(/missing/);

    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "lost:1" }, { lane: "bulk" });
    const row = db.rows.get("lost:1")!;
    r2.objects.delete(row.body_r2_key);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await handleEmailQueueMessage({ job: "send", outboxId: row.outbox_id, key: "lost:1" }, env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.delivery_status).toBe("failed");
  });

  it("refuses an id that does not match the row", async () => {
    const { env } = emailEnv();
    await enqueueEmail(env, { to: "a@example.test", subject: "Hi", html: "<p>x</p>", outboxKey: "mismatch:1" }, { lane: "bulk" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await handleEmailQueueMessage({ job: "send", outboxId: "someone-elses-id", key: "mismatch:1" }, env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retry backoff is 30s, 2m, 10m, 1h, 6h and stays at 6h", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelaySeconds)).toEqual([30, 120, 600, 3600, 21600, 21600, 21600]);
    expect([1, 2, 3, 4, 5].map(waRetryDelaySeconds)).toEqual([30, 120, 600, 3600, 21600]);
  });
});

// ---------- WhatsApp ----------

class WaDb {
  rows = new Map<string, Record<string, any>>();
  interval = 1000;
  last = 0;
  prepare(sql: string) {
    const db = this;
    let args: any[] = [];
    const st = {
      bind(...a: any[]) { args = a; return st; },
      async first() {
        if (sql.includes("FROM whatsapp_queue_outbox")) { const r = db.rows.get(String(args[0])); return r ? { ...r } : null; }
        if (sql.includes("'whatsapp_min_interval_ms'")) return { value: db.interval };
        if (sql.includes("'whatsapp_last_send_at'")) return { value: db.last };
        return null;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO whatsapp_queue_outbox")) {
          if ([...db.rows.values()].some((r) => r.idem_key === args[1]) || db.rows.has(String(args[1]))) return { meta: { changes: 0 } };
          db.rows.set(String(args[1]), { id: args[0], idem_key: args[1], e164: args[2], message: args[3], kind: args[4], lane: args[5], status: "queued", attempts: 0, updated_at: args[6], queue_accepted_at: null });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE queue_settings")) {
          if (args[0] !== db.last) return { meta: { changes: 0 } };
          db.last = args[1];
          return { meta: { changes: 1 } };
        }
        const row = [...db.rows.values()].find((r) => r.id === args[0]);
        if (!row) return { meta: { changes: 0 } };
        if (sql.includes("queue_accepted_at=?2")) { row.queue_accepted_at = args[1]; return { meta: { changes: 1 } }; }
        if (sql.includes("status='sending',attempts=attempts+1")) {
          if (row.status !== "queued") return { meta: { changes: 0 } };
          row.status = "sending"; row.attempts++; return { meta: { changes: 1 } };
        }
        const m = /SET status='(\w+)'/.exec(sql);
        if (m) { row.status = m[1]; return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      },
      async all() {
        return { results: [...db.rows.values()].filter((r) => r.status === "queued" && r.queue_accepted_at == null) };
      },
    };
    return st;
  }
}

function waEnv() {
  const db = new WaDb();
  const priority = fakeQueue();
  const normal = fakeQueue();
  const env: any = { DB_META: db, Q_WA_PRIORITY: priority, Q_WA_NORMAL: normal, WASENDER_API_KEY: "k" };
  return { env, db, priority, normal };
}

describe("WhatsApp outbox + queues", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("enqueueWhatsApp stores the text in D1 and queues only ids on the right lane", async () => {
    const { env, db, priority, normal } = waEnv();
    const res = await enqueueWhatsApp(env, { to: "+919876543210", text: "Your code is 123456", kind: "otp", lane: "priority", key: "otp:1" });
    expect(res).toMatchObject({ status: "queued", queued: true });
    expect(db.rows.get("otp:1")).toMatchObject({ message: "Your code is 123456", e164: "+919876543210", lane: "priority" });
    expect(priority.sent).toEqual([{ job: "send", outboxId: res.outboxId, key: "otp:1" }]);
    expect(normal.sent).toHaveLength(0);
    expect(JSON.stringify(priority.sent[0])).not.toContain("123456");
  });

  it("rejects a bad number or an oversized text without touching D1 or the queue", async () => {
    const { env, db, normal } = waEnv();
    expect((await enqueueWhatsApp(env, { to: "98765", text: "x", kind: "k" })).status).toBe("invalid");
    expect((await enqueueWhatsApp(env, { to: "+919876543210", text: "x".repeat(5000), kind: "k" })).status).toBe("invalid");
    expect(db.rows.size).toBe(0);
    expect(normal.sent).toHaveLength(0);
  });

  it("a duplicate key is not queued twice once the first is sent", async () => {
    const { env, normal } = waEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    const first = await enqueueWhatsApp(env, { to: "+919876543210", text: "hello", kind: "note", key: "n:1" });
    await processWhatsAppJob(env, normal.sent[0], { sleep: async () => {} });
    const second = await enqueueWhatsApp(env, { to: "+919876543210", text: "hello", kind: "note", key: "n:1" });
    expect(second).toMatchObject({ status: "sent", queued: false, outboxId: first.outboxId });
    expect(normal.sent).toHaveLength(1);
  });

  it("sends once even if the same job is delivered twice", async () => {
    const { env, db, normal } = waEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await enqueueWhatsApp(env, { to: "+919876543210", text: "hello", kind: "note", key: "n:2" });
    const job = normal.sent[0];
    expect(await processWhatsAppJob(env, job, { sleep: async () => {} })).toEqual({ done: true });
    expect(await processWhatsAppJob(env, job, { sleep: async () => {} })).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.rows.get("n:2")!.status).toBe("sent");
  });

  it("paces sends: waits for the shared slot instead of bursting", async () => {
    const { env, db, normal } = waEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    await enqueueWhatsApp(env, { to: "+919876543210", text: "hello", kind: "note", key: "n:3" });
    db.last = Date.now(); // someone just sent
    const waits: number[] = [];
    await processWhatsAppJob(env, normal.sent[0], { sleep: async (ms) => { waits.push(ms); db.last -= 2000; } });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBeGreaterThan(0);
    expect(db.rows.get("n:3")!.status).toBe("sent");
  });

  it("rate_limited goes back to queued with backoff; provider_error is parked for a human and never replayed", async () => {
    const { env, db, normal } = waEnv();
    const sleep = async () => { db.last -= 5000; }; // pretend the pacing interval elapsed
    await enqueueWhatsApp(env, { to: "+919876543210", text: "a", kind: "note", key: "rl:1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "slow down" }), { status: 429 })));
    const out = await processWhatsAppJob(env, normal.sent[0], { sleep });
    expect(out).toEqual({ done: false, retryAfterS: 30 });
    expect(db.rows.get("rl:1")!.status).toBe("queued");

    await enqueueWhatsApp(env, { to: "+919876543210", text: "b", kind: "note", key: "pe:1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 500 })));
    await processWhatsAppJob(env, normal.sent[1], { sleep });
    expect(db.rows.get("pe:1")!.status).toBe("manual_reconcile");
    const fetchAfter = vi.fn();
    vi.stubGlobal("fetch", fetchAfter);
    await processWhatsAppJob(env, normal.sent[1], { sleep });
    expect(fetchAfter).not.toHaveBeenCalled();
  });

  it("recoverWhatsAppQueue queues ids for rows whose queue send never happened", async () => {
    const { env, db, normal } = waEnv();
    delete env.Q_WA_NORMAL; // queue not provisioned at enqueue time
    const res = await enqueueWhatsApp(env, { to: "+919876543210", text: "late", kind: "note", key: "rec:wa" });
    expect(res).toMatchObject({ status: "queued", queued: false });
    db.rows.get("rec:wa")!.created_at = Date.now() - 600_000;
    env.Q_WA_NORMAL = normal;
    const realNow = Date.now;
    expect(await recoverWhatsAppQueue(env)).toBe(1);
    expect(normal.sent[0]).toEqual({ job: "send", outboxId: res.outboxId, key: "rec:wa" });
    void realNow;
  });
});
