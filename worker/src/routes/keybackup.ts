// Account key escrow — durable backup/restore (Specs/ARCH-REMOVE-NOSTR-ABLY-AND-DATA-DURABILITY.md, Part C).
//
// Makes the client's Account Encryption Key (aek) RECOVERABLE from the Clerk
// account, so a reinstall / new phone restores the user's encrypted vault
// (contacts, prefs — already stored uid-keyed in `user_vault`) instead of losing
// it. The client generates a random 32-byte aek and escrows it here; we store it
// WRAPPED (AES-GCM) under a per-account key derived from the KEY_WRAP_MASTER
// secret via HKDF-SHA256, so a D1 dump alone never exposes a usable key. On
// restore, the authed account fetches its aek back and every uid-keyed vault blob
// decrypts again.
//
// Model: server-escrow (NOT zero-knowledge) — consistent with the already
// server-readable chats, and it means users just sign in and their data returns
// (no recovery passphrase to forget). All access is Clerk-session gated and
// rate-limited per uid.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";

const WRAP_INFO = "avatok-aek-wrap-v1";
const enc = new TextEncoder();

/** Self-creating table (matches the codebase's lazy-DDL pattern). */
async function ensureTable(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS key_backup (
       uid        TEXT PRIMARY KEY,
       wrapped    TEXT NOT NULL,
       alg        TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ).run();
}

/** HKDF-SHA256(KEY_WRAP_MASTER, salt=uid, info) → a per-account AES-GCM key. */
async function accountWrapKey(env: Env, uid: string): Promise<CryptoKey> {
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

async function wrap(env: Env, uid: string, aek: Uint8Array): Promise<string> {
  const key = await accountWrapKey(env, uid);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, aek));
  return `v1.${b64(nonce)}.${b64(ct)}`;
}

async function unwrap(env: Env, uid: string, blob: string): Promise<string | null> {
  try {
    const p = blob.split(".");
    if (p.length !== 3 || p[0] !== "v1") return null;
    const key = await accountWrapKey(env, uid);
    const clear = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p[1]) }, key, unb64(p[2])),
    );
    return b64(clear); // base64 aek
  } catch {
    return null;
  }
}

/** GET /api/keybackup → { found, aek? } for the signed-in Clerk account. */
export async function keyBackupGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `keybk_get:${ctx.uid}`, 60, 3600);
  if (limited) return limited;
  await ensureTable(env);
  const row = await env.DB_META
    .prepare("SELECT wrapped FROM key_backup WHERE uid=?1")
    .bind(ctx.uid)
    .first<{ wrapped: string }>();
  if (!row) return json({ found: false });
  const aek = await unwrap(env, ctx.uid, row.wrapped);
  if (!aek) return json({ found: false, error: "unwrap_failed" }, 500);
  return json({ found: true, aek });
}

/** POST /api/keybackup { aek } — escrow the account key (idempotent upsert).
 *  aek is base64 of exactly 32 random bytes, generated + held on the device. */
export async function keyBackupPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `keybk_put:${ctx.uid}`, 30, 3600);
  if (limited) return limited;
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const aekB64 = String(b?.aek ?? "");
  let bytes: Uint8Array;
  try { bytes = unb64(aekB64); } catch { return json({ error: "bad aek encoding" }, 400); }
  if (bytes.length !== 32) return json({ error: "aek must be 32 bytes" }, 400);
  await ensureTable(env);
  const now = Date.now();
  const wrapped = await wrap(env, ctx.uid, bytes);
  await env.DB_META
    .prepare(
      `INSERT INTO key_backup (uid, wrapped, alg, created_at, updated_at)
       VALUES (?1, ?2, 'v1', ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET wrapped=?2, updated_at=?3`,
    )
    .bind(ctx.uid, wrapped, now)
    .run();
  return json({ ok: true });
}
