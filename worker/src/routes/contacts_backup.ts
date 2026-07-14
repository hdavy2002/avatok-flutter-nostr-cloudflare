// Contact-book backup/restore (owner request 2026-07-13; scaled 2026-07-14) — the
// "don't rely on Gmail" lane. A user's AvaTOK contact book (their phone contacts
// merged with the extra details they add in AvaTOK — AvaTOK number, emails,
// LinkedIn, custom fields) is stored on AvaTOK's OWN servers so a lost Google
// account or SIM can never lock them out of their contacts.
//
//   POST /api/contacts/book              → contactBookPut     — store the caller's book
//   GET  /api/contacts/book              → contactBookGet     — full book (legacy) OR
//   GET  /api/contacts/book?offset&limit → contactBookGet     — one PAGE (new clients)
//   GET  /api/contacts/book/status       → contactBookStatus  — metadata only (count/updated/paged)
//
// GROUPS (2026-07-15, "circles") — POST also accepts an optional `groups` array
// of the caller's CUSTOM colour-group definitions ({id, name, color}). Each
// contact already carries an opaque groupId inline in the contacts blob (no work
// needed there); the small list of group DEFINITIONS has nowhere else to live, so
// it's stored as its OWN encrypted R2 object (same key/format, separate from the
// chunked contacts array) and returned alongside `contacts` on every GET.
//
// MODEL — server-side encrypted, NOT zero-knowledge (owner decision 2026-07-13:
// "easy restore with just an AvaTOK login"). The plaintext JSON arrives over TLS;
// we encrypt it at rest with AES-256-GCM under a per-account key derived from the
// KEY_WRAP_MASTER secret via HKDF-SHA256 (same scheme as routes/keybackup.ts), so
// a raw D1/R2 dump never exposes contacts. On restore the authed account just signs
// in and pulls its book back — no recovery passphrase to forget. All access is
// Clerk-session gated (`requireUser`), uid-scoped, and rate-limited.
//
// SCALE (2026-07-14, owner: "1M users, thousands of contacts each — robust queue").
// The single encrypted blob still lives in R2 (latest-wins). On write we ALSO kick
// a background CHUNKING job — via the CONTACTS queue when bound, else ctx.waitUntil
// (same "queue-first, waitUntil-fallback" pattern as liveness) — that splits the
// book into fixed-size ENCRYPTED PAGES in R2 plus a small D1 manifest. Paginated
// GET then serves a page by reading only the chunks it needs (no decrypting the
// whole 25MB per page), so restore streams "a few hundred at a time" and scales.
// Until the chunk job finishes (or when the paged flag is off) paged GET falls back
// to decrypt-and-slice of the full blob, so it is always correct, just less cheap.
//
// FREE on purpose: this is a safety/lock-out-prevention feature, so unlike the
// premium R2 device-sync lane (routes/backup.ts) there is NO entitlement gate.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { readConfig } from "./config";

const WRAP_INFO = "avatok-contacts-book-v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

// The encrypted blob lives in R2 (no D1 row-size limit), so a large address book
// backs up fine. This guardrail (25 MB plaintext ≈ tens of thousands of contacts)
// only exists to keep a single request sane; R2 itself would take far more.
const MAX_BYTES = 25 * 1024 * 1024;

// Contacts per on-disk chunk. GET's ?limit can differ; we read whichever chunks
// cover the requested [offset, offset+limit) window and slice.
const CHUNK_SIZE = 200;
// Safety cap on a single paged response so a giant ?limit can't blow memory.
const MAX_PAGE = 1000;

// R2 object key for a uid's full (latest-wins) encrypted contact book.
function r2Key(uid: string): string {
  return `contacts-book/${uid}`;
}
// R2 object key for one encrypted PAGE of a uid's book.
function chunkKey(uid: string, page: number): string {
  return `contacts-book/${uid}/p/${page}`;
}
// R2 object key for a uid's encrypted CUSTOM colour-group definitions.
function groupsKey(uid: string): string {
  return `contacts-book/${uid}/groups`;
}

// Metadata only in D1; the ciphertext blob lives in R2. `wrapped` is kept nullable
// for backward-compat with the earlier inline-blob shape (if a row was ever written
// before this migration, GET still reads it).
async function ensureTable(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS contact_book_backup (
       uid        TEXT PRIMARY KEY,
       wrapped    TEXT,
       count      INTEGER NOT NULL,
       alg        TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ).run();
}

// Manifest for the chunked layout — one row per uid, written by the chunk job.
async function ensureManifest(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS contact_book_manifest (
       uid        TEXT PRIMARY KEY,
       total      INTEGER NOT NULL,
       page_size  INTEGER NOT NULL,
       pages      INTEGER NOT NULL,
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

// Best-effort operational metric (Analytics Engine) — same sink index the fetch
// handler uses. Never throws into the request path.
function metric(env: Env, op: string, uid: string, count: number, ms: number): void {
  try {
    env.ANALYTICS?.writeDataPoint({ blobs: [`contacts_${op}`, uid], doubles: [count, ms], indexes: ["contacts"] });
  } catch { /* best-effort */ }
}

// Rich PostHog event (batched via Q_ANALYTICS → avatok-consumers). uid-keyed so a
// user's contact-book journey is pullable by their account (and joins the client's
// avadial_contact_* events by clerk_uid). Never load-bearing. Mirrors the
// conversations2.ts/spam.ts server-analytics style.
function track(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try {
    void env.Q_ANALYTICS?.send({
      event,
      uid,
      ts: Date.now(),
      props: { ...props, account_id: uid, app_name: "avatok", service_name: "avatok-api", worker: true, feature: "contacts_book" },
    });
  } catch { /* telemetry is never load-bearing */ }
}

/** Read + decrypt the caller's FULL book into an array (or null if none/decrypt-fail). */
async function loadFullBook(env: Env, uid: string, inlineWrapped: string | null): Promise<unknown[] | null> {
  let blob = inlineWrapped;
  if (!blob) {
    const obj = await env.BACKUP_R2.get(r2Key(uid));
    if (!obj) return null;
    blob = await obj.text();
  }
  const clear = await decryptJson(env, uid, blob);
  if (clear === null) return null;
  try {
    const arr = JSON.parse(clear);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Read + decrypt the caller's custom colour groups (or [] when none/decrypt-fail). */
async function loadGroups(env: Env, uid: string): Promise<unknown[]> {
  try {
    const obj = await env.BACKUP_R2.get(groupsKey(uid));
    if (!obj) return [];
    const clear = await decryptJson(env, uid, await obj.text());
    if (clear === null) return [];
    const arr = JSON.parse(clear);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * CHUNK JOB — split the caller's current book into fixed-size encrypted R2 pages
 * plus a D1 manifest. Idempotent (latest-wins), safe to re-run, and cheap enough
 * to run inline in ctx.waitUntil OR from a queue consumer. Never throws to callers.
 */
export async function buildContactChunks(env: Env, uid: string): Promise<void> {
  const t0 = Date.now();
  try {
    const obj = await env.BACKUP_R2.get(r2Key(uid));
    if (!obj) return;
    const clear = await decryptJson(env, uid, await obj.text());
    if (clear === null) return;
    let arr: unknown[] = [];
    try { const p = JSON.parse(clear); arr = Array.isArray(p) ? p : []; } catch { arr = []; }

    const total = arr.length;
    const pages = Math.ceil(total / CHUNK_SIZE);
    for (let i = 0; i < pages; i++) {
      const slice = arr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const wrapped = await encryptJson(env, uid, JSON.stringify(slice));
      await env.BACKUP_R2.put(chunkKey(uid, i), wrapped, { httpMetadata: { contentType: "text/plain" } });
    }

    // Drop stale chunks left over from a previously larger book.
    await ensureManifest(env);
    const prev = await env.DB_META
      .prepare("SELECT pages FROM contact_book_manifest WHERE uid=?1")
      .bind(uid)
      .first<{ pages: number }>();
    if (prev && prev.pages > pages) {
      for (let i = pages; i < prev.pages; i++) {
        try { await env.BACKUP_R2.delete(chunkKey(uid, i)); } catch { /* best-effort */ }
      }
    }

    const now = Date.now();
    await env.DB_META
      .prepare(
        `INSERT INTO contact_book_manifest (uid, total, page_size, pages, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(uid) DO UPDATE SET total=?2, page_size=?3, pages=?4, updated_at=?5`,
      )
      .bind(uid, total, CHUNK_SIZE, pages, now)
      .run();
    const ms = Date.now() - t0;
    metric(env, "chunk", uid, total, ms);
    track(env, uid, "contacts_chunks_built", { total, pages, page_size: CHUNK_SIZE, ms });
  } catch (e) {
    console.error("[contacts] buildContactChunks failed:", String(e));
    track(env, uid, "contacts_chunks_failed", { error: String(e).slice(0, 160) });
  }
}

/** Queue consumer entry (dormant until a CONTACTS queue is bound). */
export async function contactsChunkConsume(env: Env, body: unknown): Promise<void> {
  const uid = (body as { uid?: string })?.uid;
  if (uid) await buildContactChunks(env, uid);
}

/** Kick the chunk job: prefer the queue when bound, else run inline via waitUntil. */
function scheduleChunk(env: Env, ctx: ExecutionContext, uid: string): void {
  const run = (async () => {
    if (env.Q_CONTACTS) {
      try { await env.Q_CONTACTS.send({ uid, updated: Date.now() }); return; } catch { /* fall through */ }
    }
    await buildContactChunks(env, uid);
  })();
  try { ctx.waitUntil(run); } catch { /* ctx absent → fire-and-forget */ void run; }
}

/** POST /api/contacts/book { contacts:[...] } — store the caller's contact book. */
export async function contactBookPut(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const cfg = await readConfig(env);
  if (cfg.contactsBookEnabled === false) return json({ error: "disabled", flag: "contactsBookEnabled" }, 503);
  const limited = await rateLimit(env, `cbook_put:${ctxUser.uid}`, 60, 3600);
  if (limited) return limited;

  const t0 = Date.now();
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const contacts = Array.isArray(body?.contacts) ? body.contacts : null;
  if (!contacts) return json({ error: "contacts array required" }, 400);
  // Custom colour-group definitions are optional and stored separately (a small
  // list, not the contacts array). null means "client didn't send any" — leave
  // whatever is already stored untouched (old-client compat).
  const groups = Array.isArray(body?.groups) ? body.groups : null;
  if (groups !== null && groups.length > 200) {
    return json({ error: "too many groups" }, 400);
  }

  const plaintext = JSON.stringify(contacts);
  if (enc.encode(plaintext).byteLength > MAX_BYTES) {
    return json({ error: "contact book too large" }, 413);
  }

  const now = Date.now();
  const wrapped = await encryptJson(env, ctxUser.uid, plaintext);
  // Store the (already-encrypted) blob in R2; keep only metadata in D1.
  await env.BACKUP_R2.put(r2Key(ctxUser.uid), wrapped, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { uid: ctxUser.uid, count: String(contacts.length), updated: String(now) },
  });
  if (groups !== null) {
    const groupsWrapped = await encryptJson(env, ctxUser.uid, JSON.stringify(groups));
    await env.BACKUP_R2.put(groupsKey(ctxUser.uid), groupsWrapped, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { uid: ctxUser.uid, count: String(groups.length), updated: String(now) },
    });
  }
  await ensureTable(env);
  await env.DB_META
    .prepare(
      `INSERT INTO contact_book_backup (uid, wrapped, count, alg, created_at, updated_at)
       VALUES (?1, NULL, ?2, 'v1r2', ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET wrapped=NULL, count=?2, alg='v1r2', updated_at=?3`,
    )
    .bind(ctxUser.uid, contacts.length, now)
    .run();

  // Background: (re)build the paginated chunks so restore can stream pages.
  if (cfg.contactsBookPaged !== false) scheduleChunk(env, ctx, ctxUser.uid);

  const ms = Date.now() - t0;
  metric(env, "put", ctxUser.uid, contacts.length, ms);
  track(env, ctxUser.uid, "contacts_backup_stored",
    { count: contacts.length, bytes: enc.encode(plaintext).byteLength, groups: groups?.length ?? -1, ms });
  return json({ ok: true, count: contacts.length, groups: groups?.length ?? 0, updatedAt: now });
}

/**
 * GET /api/contacts/book — return the caller's decrypted contact book.
 *  • no params → the FULL book (legacy clients).
 *  • ?offset&limit → one PAGE + {total, offset, nextOffset} (new clients).
 */
export async function contactBookGet(req: Request, env: Env): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const cfg = await readConfig(env);
  if (cfg.contactsBookEnabled === false) return json({ error: "disabled", flag: "contactsBookEnabled" }, 503);
  const limited = await rateLimit(env, `cbook_get:${ctxUser.uid}`, 120, 3600);
  if (limited) return limited;
  const t0 = Date.now();
  await ensureTable(env);
  const uid = ctxUser.uid;
  const row = await env.DB_META
    .prepare("SELECT wrapped, count, updated_at FROM contact_book_backup WHERE uid=?1")
    .bind(uid)
    .first<{ wrapped: string | null; count: number; updated_at: number }>();
  if (!row) return json({ found: false, contacts: [], groups: [] });

  // Custom colour-group definitions are tiny — load once and hand them back on
  // every page/response so a paginated restore can pick them up from any page.
  const groups = await loadGroups(env, uid);

  const sp = new URL(req.url).searchParams;
  const hasPaging = sp.has("offset") || sp.has("limit");

  if (hasPaging && cfg.contactsBookPaged !== false) {
    const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, parseInt(sp.get("limit") || "200", 10) || 200));

    // Fast path: serve from pre-built chunks when the manifest is ready.
    await ensureManifest(env);
    const man = await env.DB_META
      .prepare("SELECT total, page_size, pages FROM contact_book_manifest WHERE uid=?1")
      .bind(uid)
      .first<{ total: number; page_size: number; pages: number }>();

    if (man && man.page_size > 0) {
      const total = man.total;
      if (offset >= total) {
        metric(env, "get_page", uid, 0, Date.now() - t0);
        return json({ found: true, contacts: [], count: 0, total, offset, nextOffset: null, updatedAt: row.updated_at, groups });
      }
      const startChunk = Math.floor(offset / man.page_size);
      const endChunk = Math.floor((offset + limit - 1) / man.page_size);
      const acc: unknown[] = [];
      for (let i = startChunk; i <= endChunk && i < man.pages; i++) {
        const obj = await env.BACKUP_R2.get(chunkKey(uid, i));
        if (!obj) { acc.length = 0; break; } // a chunk is missing → fall back below
        const clear = await decryptJson(env, uid, await obj.text());
        if (clear === null) { acc.length = 0; break; }
        try { const p = JSON.parse(clear); if (Array.isArray(p)) acc.push(...p); } catch { /* skip */ }
      }
      if (acc.length > 0) {
        const localStart = offset - startChunk * man.page_size;
        const page = acc.slice(localStart, localStart + limit);
        const nextOffset = offset + page.length < total ? offset + page.length : null;
        const ms = Date.now() - t0;
        metric(env, "get_page", uid, page.length, ms);
        track(env, uid, "contacts_book_page", { count: page.length, total, offset, source: "chunks", ms });
        return json({ found: true, contacts: page, count: page.length, total, offset, nextOffset, updatedAt: row.updated_at, groups });
      }
      // else: chunks not usable yet → decrypt-and-slice fallback below.
    }

    // Fallback: decrypt the full blob and slice (correct, just not as cheap).
    const all = await loadFullBook(env, uid, row.wrapped);
    if (all === null) {
      track(env, uid, "contacts_decrypt_failed", { where: "get_page_fallback", offset });
      return json({ found: false, error: "decrypt_failed" }, 500);
    }
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length < total ? offset + page.length : null;
    const ms = Date.now() - t0;
    metric(env, "get_page_fallback", uid, page.length, ms);
    track(env, uid, "contacts_book_page", { count: page.length, total, offset, source: "blob_fallback", ms });
    return json({ found: true, contacts: page, count: page.length, total, offset, nextOffset, updatedAt: row.updated_at, groups });
  }

  // Legacy: full book in one response.
  const all = await loadFullBook(env, uid, row.wrapped);
  if (all === null) {
    track(env, uid, "contacts_decrypt_failed", { where: "get_full" });
    return json({ found: false, error: "decrypt_failed" }, 500);
  }
  const ms = Date.now() - t0;
  metric(env, "get_full", uid, all.length, ms);
  track(env, uid, "contacts_book_full", { count: all.length, ms });
  return json({ found: true, contacts: all, count: row.count, updatedAt: row.updated_at, groups });
}

/** GET /api/contacts/book/status — metadata only (no contact data). */
export async function contactBookStatus(req: Request, env: Env): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  await ensureTable(env);
  const row = await env.DB_META
    .prepare("SELECT count, updated_at FROM contact_book_backup WHERE uid=?1")
    .bind(ctxUser.uid)
    .first<{ count: number; updated_at: number }>();
  if (!row) return json({ found: false });
  let paged = false;
  let pageSize = CHUNK_SIZE;
  try {
    await ensureManifest(env);
    const man = await env.DB_META
      .prepare("SELECT page_size FROM contact_book_manifest WHERE uid=?1")
      .bind(ctxUser.uid)
      .first<{ page_size: number }>();
    if (man) { paged = true; pageSize = man.page_size; }
  } catch { /* manifest optional */ }
  return json({
    found: true,
    count: row.count,
    updatedAt: row.updated_at,
    paged,
    pageSize,
    groups: (await loadGroups(env, ctxUser.uid)).length,
  });
}
