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

// Escrowed secret kinds. "aek" (default) = the Account Encryption Key for the
// uid-keyed vault (legacy `key_backup` table, unchanged wire format). "bk" =
// the BackupService passphrase that encrypts the Drive/R2 backup blobs
// (app/lib/features/ava_backup/backup_service.dart). Escrowing "bk" is what
// makes restore work on a REINSTALL / NEW PHONE: the blob sits in the user's
// own Drive, the wrapped key sits in our D1 — neither party alone can read the
// backup, and a Clerk sign-in is all the user needs to recover both.
const KINDS = ["aek", "bk"] as const;
type Kind = (typeof KINDS)[number];

function kindOf(req: Request): Kind | null {
  const k = (new URL(req.url).searchParams.get("kind") ?? "aek").trim();
  return (KINDS as readonly string[]).includes(k) ? (k as Kind) : null;
}

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

/** Kind-aware escrow table (kinds other than the legacy aek row). */
async function ensureKindTable(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS key_backup_kinds (
       uid        TEXT NOT NULL,
       kind       TEXT NOT NULL,
       wrapped    TEXT NOT NULL,
       alg        TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (uid, kind)
     )`,
  ).run();
}

/** HKDF-SHA256(KEY_WRAP_MASTER, salt=uid, info) → a per-account AES-GCM key.
 *  The info string is kind-specific so the aek wrap key can never decrypt a
 *  bk blob (and vice versa); kind "aek" keeps the original WRAP_INFO so all
 *  existing escrowed rows keep unwrapping unchanged. */
async function accountWrapKey(env: Env, uid: string, kind: Kind = "aek"): Promise<CryptoKey> {
  const master = env.KEY_WRAP_MASTER;
  if (!master) throw new Error("KEY_WRAP_MASTER unset");
  const info = kind === "aek" ? WRAP_INFO : `avatok-${kind}-wrap-v1`;
  const ikm = await crypto.subtle.importKey("raw", enc.encode(master), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(uid), info: enc.encode(info) },
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

async function wrap(env: Env, uid: string, aek: Uint8Array, kind: Kind = "aek"): Promise<string> {
  const key = await accountWrapKey(env, uid, kind);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, aek));
  return `v1.${b64(nonce)}.${b64(ct)}`;
}

async function unwrap(env: Env, uid: string, blob: string, kind: Kind = "aek"): Promise<string | null> {
  try {
    const p = blob.split(".");
    if (p.length !== 3 || p[0] !== "v1") return null;
    const key = await accountWrapKey(env, uid, kind);
    const clear = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p[1]) }, key, unb64(p[2])),
    );
    return b64(clear); // base64 aek
  } catch {
    return null;
  }
}

/** GET /api/keybackup[?kind=aek|bk] → { found, aek? } for the signed-in Clerk
 *  account. The recovered secret is always returned under the legacy `aek`
 *  field (base64 bytes) regardless of kind, so the client parser is shared. */
export async function keyBackupGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const kind = kindOf(req);
  if (!kind) return json({ error: "bad kind" }, 400);
  const limited = await rateLimit(env, `keybk_get:${ctx.uid}`, 60, 3600);
  if (limited) return limited;
  let row: { wrapped: string } | null;
  if (kind === "aek") {
    await ensureTable(env);
    row = await env.DB_META
      .prepare("SELECT wrapped FROM key_backup WHERE uid=?1")
      .bind(ctx.uid)
      .first<{ wrapped: string }>();
  } else {
    await ensureKindTable(env);
    row = await env.DB_META
      .prepare("SELECT wrapped FROM key_backup_kinds WHERE uid=?1 AND kind=?2")
      .bind(ctx.uid, kind)
      .first<{ wrapped: string }>();
  }
  if (!row) return json({ found: false });
  const aek = await unwrap(env, ctx.uid, row.wrapped, kind);
  if (!aek) return json({ found: false, error: "unwrap_failed" }, 500);
  return json({ found: true, aek });
}

/** POST /api/keybackup[?kind=aek|bk] { aek } — escrow a secret (idempotent
 *  upsert). The secret rides base64 in the legacy `aek` field for all kinds.
 *  kind=aek: exactly 32 random key bytes. kind=bk: the BackupService
 *  passphrase bytes (utf8 of the stored base64url string; 16–128 bytes). */
export async function keyBackupPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const kind = kindOf(req);
  if (!kind) return json({ error: "bad kind" }, 400);
  const limited = await rateLimit(env, `keybk_put:${ctx.uid}`, 30, 3600);
  if (limited) return limited;
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const aekB64 = String(b?.aek ?? "");
  let bytes: Uint8Array;
  try { bytes = unb64(aekB64); } catch { return json({ error: "bad aek encoding" }, 400); }
  if (kind === "aek" && bytes.length !== 32) return json({ error: "aek must be 32 bytes" }, 400);
  if (kind === "bk" && (bytes.length < 16 || bytes.length > 128)) {
    return json({ error: "bk secret must be 16-128 bytes" }, 400);
  }
  const now = Date.now();
  const wrapped = await wrap(env, ctx.uid, bytes, kind);
  if (kind === "aek") {
    await ensureTable(env);
    await env.DB_META
      .prepare(
        `INSERT INTO key_backup (uid, wrapped, alg, created_at, updated_at)
         VALUES (?1, ?2, 'v1', ?3, ?3)
         ON CONFLICT(uid) DO UPDATE SET wrapped=?2, updated_at=?3`,
      )
      .bind(ctx.uid, wrapped, now)
      .run();
  } else {
    await ensureKindTable(env);
    // NEVER blindly overwrite an existing bk escrow: the escrowed passphrase is
    // the ONLY key to backups already sitting in the user's Drive. A fresh
    // install generates a NEW local passphrase before it learns about the old
    // one; if that new value replaced the escrow, every existing backup would
    // become permanently undecryptable. First write wins; the client recovers
    // the escrowed value and adopts it locally (see BackupService).
    await env.DB_META
      .prepare(
        `INSERT INTO key_backup_kinds (uid, kind, wrapped, alg, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'v1', ?4, ?4)
         ON CONFLICT(uid, kind) DO NOTHING`,
      )
      .bind(ctx.uid, kind, wrapped, now)
      .run();
  }
  return json({ ok: true });
}
