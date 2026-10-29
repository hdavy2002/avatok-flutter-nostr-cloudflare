// @ts-nocheck -- test helper: uses node:sqlite (no types in the worker tsconfig). Not a test file itself.
// [HF-SUPPORT-1] Real migrations on an in-memory SQLite, fake R2 / Queue, stubs for the few tables owned by other features.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const mig = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

export class FakeR2 {
  store = new Map<string, { body: Uint8Array; meta: any; uploaded: Date }>();
  async put(key: string, value: any, opts: any = {}) {
    let body: Uint8Array;
    if (typeof value === "string") body = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) body = value;
    else if (value instanceof ArrayBuffer) body = new Uint8Array(value);
    else body = new Uint8Array(await new Response(value).arrayBuffer());
    this.store.set(key, { body, meta: opts, uploaded: new Date() });
  }
  async get(key: string) {
    const o = this.store.get(key);
    if (!o) return null;
    return { body: new Response(o.body).body, text: async () => new TextDecoder().decode(o.body), arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength), httpMetadata: o.meta.httpMetadata };
  }
  async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k); }
  async list({ prefix = "", cursor, limit = 1000 }: any = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    const slice = start === -1 ? [] : keys.slice(start, start + limit);
    const truncated = start !== -1 && start + limit < keys.length;
    return { objects: slice.map((key) => ({ key, uploaded: this.store.get(key)!.uploaded, size: this.store.get(key)!.body.length })), truncated, cursor: truncated ? slice[slice.length - 1] : undefined };
  }
  age(key: string, ms: number) { this.store.get(key)!.uploaded = new Date(Date.now() - ms); }
}

export class FakeQueue { sent: any[] = []; async send(body: any) { this.sent.push(body); } }

export interface TestEnv { env: any; db: any; r2: FakeR2; blobs: FakeR2; queues: Record<string, FakeQueue> }

export function makeEnv(extra: Record<string, unknown> = {}): TestEnv {
  const db = new DatabaseSync(":memory:");
  for (const f of [
    "2026-09-03-commercial-email-outbox.sql", "2026-09-09-commercial-email-delivery.sql", "2026-09-11-email-provider.sql",
    "2026-10-29-support-queue-1-email-outbox-r2.sql", "2026-10-29-support-queue-1-whatsapp-queue-outbox.sql",
    "2026-10-29-hf-support-tables.sql", "2026-10-29-hf-support-seed.sql", "2026-10-29-hf-support-fts.sql", "2026-10-29-hf-support-email-outbox-headers.sql",
  ]) db.exec(mig(f));
  // tables owned by other features, reduced to the columns the desk reads
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, handle TEXT, display_name TEXT, email_hash TEXT, private_number TEXT, created_at INTEGER);
    CREATE TABLE hf_user_email (uid TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, email_verified INTEGER, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (uid TEXT, phone_hash TEXT, e164 TEXT, status TEXT, verified_at INTEGER);
    CREATE TABLE hf_topups (id TEXT PRIMARY KEY, uid TEXT, amount_rupees INTEGER, status TEXT, created_at INTEGER, paid_at INTEGER);
    CREATE TABLE hf_payout_requests (id TEXT PRIMARY KEY, host_uid TEXT, amount_rupees INTEGER, status TEXT, created_at INTEGER);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, created_at INTEGER);
    CREATE TABLE hf_strikes (id TEXT PRIMARY KEY, uid TEXT, removed_at INTEGER, expires_at INTEGER);
  `);
  const stmt = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
    __sql: sql, __values: values,
  });
  const DB_META = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  const r2 = new FakeR2();
  const blobs = new FakeR2();
  const queues = { priority: new FakeQueue(), bulk: new FakeQueue(), email: new FakeQueue(), waP: new FakeQueue(), waN: new FakeQueue(), inbound: new FakeQueue() };
  const env = {
    DB_META, BACKUP_R2: r2, BLOBS: blobs, ADMIN_UIDS: "admin1",
    Q_EMAIL: queues.email, Q_EMAIL_PRIORITY: queues.priority, Q_EMAIL_BULK: queues.bulk, Q_WA_PRIORITY: queues.waP, Q_WA_NORMAL: queues.waN, Q_SUPPORT_INBOUND: queues.inbound,
    ...extra,
  };
  return { env, db, r2, blobs, queues };
}

/** A plain RFC 5322 message. */
export function rawMail(h: Record<string, string | string[]>, body: string): Uint8Array {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(h)) for (const val of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${val}`);
  return new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n" + body);
}

export async function putInbound(t: TestEnv, id: string, bytes: Uint8Array, envFrom?: string, envTo?: string) {
  const key = `support/inbound/2026/10/29/${id}.eml`;
  await t.r2.put(key, bytes);
  return { job: "inbound" as const, r2Key: key, envFrom, envTo };
}
