// Contact-book backup/restore (owner request 2026-07-13) — the "don't rely on
// Gmail" lane. A user's AvaTOK contact book (their phone contacts merged with the
// extra details they add in AvaTOK — AvaTOK number, emails, LinkedIn, custom
// fields) is stored on AvaTOK's OWN servers so a lost Google account or SIM can
// never lock them out of their contacts.
//
//   POST /api/contacts/book         → contactBookPut     — store the caller's book
//   GET  /api/contacts/book         → contactBookGet     — return the caller's book
//   GET  /api/contacts/book/status  → contactBookStatus  — metadata only (count/updated)
//
// MODEL — server-side encrypted, NOT zero-knowledge (owner decision 2026-07-13:
// "easy restore with just an AvaTOK login"). The plaintext JSON arrives over TLS;
// we encrypt it at rest with AES-256-GCM under a per-account key derived from the
// KEY_WRAP_MASTER secret via HKDF-SHA256 (same scheme as routes/keybackup.ts), so
// a raw D1 dump never exposes contacts. On restore the authed account just signs
// in and pulls its book back — no recovery passphrase to forget. All access is
// Clerk-session gated (`requireUser`), uid-scoped, and rate-limited.
//
// FREE on purpose: this is a safety/lock-out-prevention feature, so unlike the
// premium R2 device-sync lane (routes/backup.ts) there is NO entitlement gate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";

const WRAP_INFO = "avatok-contacts-book-v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

// D1 TEXT comfortably holds a typical address book. Guardrail well under D1's
// statement limits; a book larger than this should chunk to R2 (future).
const MAX_BYTES = 2 * 1024 * 1024;

async function ensureTable(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS contact_book_backup (
       uid        TEXT PRIMARY KEY,
       wrapped    TEXT NOT NULL,
       count      INTEGER NOT NULL,
       alg        TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ).run();
}

/** HKDF-SHA256(KEY_WRAP_MASTER, salt=uid, info) → per-account AES-GCM key. */
async function accountKey(env: Env, uid: string): Promise<CryptoKey> {
  const master = env.KEY_WRAP_MASTER;
  if (!master) throw new Error("KEY_WRAP_MASTER unset");
  const ikm = await crypto.subtle.importKey("raw", enc.encode(master), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(uid), info: enc.encode(WRAP_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptJson(env: Env, uid: string, plaintext: string): Promise<string> {
  const key = await accountKey(env, uid);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, enc.encode(plaintext)),
  );
  return `v1.${b64(nonce)}.${b64(ct)}`;
}

async function decryptJson(env: Env, uid: string, blob: string): Promise<string | null> {
  try {
    const p = blob.split(".");
    if (p.length !== 3 || p[0] !== "v1") return null;
    const key = await accountKey(env, uid);
    const clear = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p[1]) }, key, unb64(p[2])),
    );
    return dec.decode(clear);
  } catch {
    return null;
  }
}

/** POST /api/contacts/book { contacts:[...] } — store the caller's contact book. */
export async function contactBookPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `cbook_put:${ctx.uid}`, 60, 3600);
  if (limited) return limited;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const contacts = Array.isArray(body?.contacts) ? body.contacts : null;
  if (!contacts) return json({ error: "contacts array required" }, 400);

  const plaintext = JSON.stringify(contacts);
  if (enc.encode(plaintext).byteLength > MAX_BYTES) {
    return json({ error: "contact book too large" }, 413);
  }

  const now = Date.now();
  const wrapped = await encryptJson(env, ctx.uid, plaintext);
  await ensureTable(env);
  await env.DB_META
    .prepare(
      `INSERT INTO contact_book_backup (uid, wrapped, count, alg, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'v1', ?4, ?4)
       ON CONFLICT(uid) DO UPDATE SET wrapped=?2, count=?3, updated_at=?4`,
    )
    .bind(ctx.uid, wrapped, contacts.length, now)
    .run();
  return json({ ok: true, count: contacts.length, updatedAt: now });
}

/** GET /api/contacts/book — return the caller's decrypted contact book. */
export async function contactBookGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `cbook_get:${ctx.uid}`, 60, 3600);
  if (limited) return limited;
  await ensureTable(env);
  const row = await env.DB_META
    .prepare("SELECT wrapped, count, updated_at FROM contact_book_backup WHERE uid=?1")
    .bind(ctx.uid)
    .first<{ wrapped: string; count: number; updated_at: number }>();
  if (!row) return json({ found: false, contacts: [] });
  const clear = await decryptJson(env, ctx.uid, row.wrapped);
  if (clear === null) return json({ found: false, error: "decrypt_failed" }, 500);
  let contacts: unknown = [];
  try { contacts = JSON.parse(clear); } catch { contacts = []; }
  return json({ found: true, contacts, count: row.count, updatedAt: row.updated_at });
}

/** GET /api/contacts/book/status — metadata only (no contact data). */
export async function contactBookStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);
  const row = await env.DB_META
    .prepare("SELECT count, updated_at FROM contact_book_backup WHERE uid=?1")
    .bind(ctx.uid)
    .first<{ count: number; updated_at: number }>();
  if (!row) return json({ found: false });
  return json({ found: true, count: row.count, updatedAt: row.updated_at });
}
