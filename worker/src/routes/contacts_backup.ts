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
// MERGE, NOT REPLACE (2026-07-15, owner: "you never cut from local and paste it in
// server or cut from server and paste it local… the copy on the server always
// remains with us. your main job is syncing"). POST now UNIONs the incoming book
// with the stored one by phone number; a contact we already hold survives even if
// the upload omits it. This was latest-wins until now, and that single property was
// the root of every data-loss hazard in this feature: a new phone uploading before
// the user restored, an empty book from a revoked permission, a sub-account
// uploading only its own contacts — each silently deleted a real backup. Merge
// removes the whole class rather than guarding each path.
//   • `mode:'replace'` (opt-in, default merge) restores the old behaviour for ONE
//     caller: the warned "Replace your backup" action, which exists so a book that
//     has accumulated contacts from a borrowed handset can be deliberately cleaned.
//   • ACCEPTED COST (owner's explicit choice): deletions do not propagate. Delete a
//     contact on the phone and it stays here, and returns on the next restore. The
//     alternative — tracking deliberate deletions ("tombstones"), so a delete is a
//     fact we sync rather than an absence we infer — was offered and declined.
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
//
// DAILY (2026-07-15, owner: "we need an auto backup everyday and manual backup as
// per users demand… it should run regardless of toggle"). The SERVER is unchanged
// in shape — it can't pull a book, only receive one, since the device is the
// source of truth. So "daily" is a CLIENT WorkManager job that POSTs here on its
// own ~24h (app/lib/features/avadial/contacts_daily_backup.dart); the opt-in
// switch was removed from the app in the same change. Server side that means two
// things: writes now carry a `source` tag ('manual' | 'auto_sync' | 'daily_bg')
// for telemetry, and `contactsDailyBackup` in routes/config.ts is the kill switch
// those background jobs poll before uploading. Note the rate limit below (60
// PUT/hour) already comfortably absorbs one extra write per user per day.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { readConfig } from "./config";
import { brainIngest } from "../lib/brain_ingest";

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
// [AVADIAL-BACKUP-OWNER] Set once the device_count column is known to exist on this
// isolate. Not persisted: a fresh isolate re-checks once, which costs one call per
// isolate instead of one per request.
let deviceCountMigrated = false;

async function ensureTable(env: Env): Promise<void> {
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS contact_book_backup (
       uid          TEXT PRIMARY KEY,
       wrapped      TEXT,
       count        INTEGER NOT NULL,
       alg          TEXT NOT NULL,
       created_at   INTEGER NOT NULL,
       updated_at   INTEGER NOT NULL,
       device_count INTEGER
     )`,
  ).run();
  // [AVADIAL-BACKUP-OWNER] Additive migration for tables created before
  // device_count existed. NULLABLE on purpose, and the NULL is meaningful: it
  // marks a book written by a client that predates the master/sub rule, which by
  // definition contained the WHOLE phone book. The client reads NULL as "this
  // account owns a full book — never shrink it". Getting that backwards would
  // delete real backups, so the column must never be given a 0 default.
  // Isolate-level latch: without it this ALTER runs — and throws "duplicate column
  // name", and swallows it — on EVERY put/get/status call forever, which is a
  // wasted D1 round-trip per request on a hot endpoint plus permanent error noise
  // that would bury a real DB fault.
  if (deviceCountMigrated) return;
  try {
    await env.DB_META.prepare(
      `ALTER TABLE contact_book_backup ADD COLUMN device_count INTEGER`,
    ).run();
    deviceCountMigrated = true;
  } catch (e) {
    // The expected error on every deployment after the first. Anything else is a
    // real fault and must stay visible — the SELECT that needs this column would
    // otherwise fail with no clue why.
    if (String(e).includes("duplicate column")) {
      deviceCountMigrated = true;
    } else {
      console.error("[contacts] device_count migration failed:", String(e));
    }
  }
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

/**
 * [AVADIAL-BACKUP-MERGE] Match key for one contact — the SERVER's copy of the
 * client's `DeviceContacts.normKey` (app/lib/features/avadial/device_contacts.dart):
 * strip everything but digits, then keep the LAST 9. That collapses the same person
 * written as "+44 7700 900123", "07700900123" and "(0)7700-900123" onto one key.
 *
 * ⚠ THESE TWO IMPLEMENTATIONS MUST STAY IDENTICAL. The client dedupes its local book
 * with its version; the server merges with this one. If they ever disagree, merge
 * stops recognising a contact it already holds and stores it a second time — the
 * user watches their contacts silently double, and because merge never deletes,
 * nothing can undo it. Change one, change both.
 */
function mergeKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length === 0) return s.trim().toUpperCase();
  return digits.length <= 9 ? digits : digits.slice(-9);
}

/**
 * Is a [mergeKey] strong enough to declare two contacts the same person? Mirrors
 * the client's `DeviceContacts._usableKey` (device_contacts.dart) and its
 * `_minDigitKey = 6` floor.
 *
 * Without this the merge would treat every weak key as one identity: contacts with
 * a blank/missing number all key to `""` and would collapse into a SINGLE surviving
 * contact, and short codes ("611", "*123#") would swallow each other. The client
 * never matches on such keys, so the server must not either — merge never deletes,
 * so a contact collapsed away here can never come back.
 *
 * An alphanumeric sender id ("VODAFONE") has no digits and is treated as an exact
 * string — trusted as-is, same as the client.
 */
function usableMergeKey(key: string): boolean {
  if (key.length === 0) return false;
  const digits = key.replace(/[^0-9]/g, "");
  if (digits.length === 0) return true;
  return digits.length >= 6;
}

/**
 * Identity for a contact whose [mergeKey] is too weak to match on. Keyed by its raw
 * number + name so an unchanged contact re-uploaded every day dedupes against
 * itself (merge never deletes, so a non-deduping key would grow without bound),
 * while two genuinely different weak-key contacts stay distinct. The `\u0000w:`
 * prefix can never collide with a real mergeKey, which is digits or an uppercased
 * label.
 */
function weakKey(c: unknown): string {
  const o = (c ?? {}) as { number?: unknown; name?: unknown };
  const num = typeof o.number === "string" ? o.number.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  return `\u0000w:${num}|${name}`;
}

/** The key merge should file this contact under. */
function bookKey(c: unknown): string {
  const k = mergeKey((c as { number?: unknown } | null)?.number);
  return usableMergeKey(k) ? k : weakKey(c);
}

/**
 * [AVADIAL-BACKUP-MERGE] Union the stored book with an incoming one (owner decision
 * 2026-07-15: "you never cut from local and paste it in server… the copy on the
 * server always remains with us").
 *
 * Rules:
 *  • Every contact already stored SURVIVES, even if the upload omits it. This is the
 *    whole point: an upload can no longer delete anything, so a new phone, an empty
 *    book, a sub, or a half-synced device can never destroy a backup.
 *  • A contact present in BOTH is taken from the INCOMING copy — that's an edit
 *    (a fixed spelling, a new email), and the uploader is the fresher source.
 *  • Order: stored first, then contacts the upload adds. Keeps restore output stable.
 *
 * THE ACCEPTED COST (owner chose this with eyes open): deletions never propagate.
 * Delete a contact on the phone and it stays here, and comes back on the next
 * restore. The only way out is an explicit `mode:'replace'` upload, which the app
 * only sends from the warned "Replace your backup" action.
 *
 * INHERITED, NOT INTRODUCED: [mergeKey] matches on the last 9 digits, so two
 * genuinely different people whose numbers share them (say the same subscriber
 * digits behind +1 and +44) are treated as one, and the incoming copy wins. That is
 * this app's definition of contact identity everywhere — ContactOverrides is keyed
 * by the same normKey, so the client already cannot tell those two apart. Using a
 * different rule here would be worse: the server would then disagree with the
 * client about who is who, and merge would duplicate people on every upload.
 *
 * Returns {book, kept} where `kept` counts stored contacts the upload did NOT
 * contain — i.e. exactly what the old replace semantics would have deleted.
 */
function mergeBooks(stored: unknown[], incoming: unknown[]): { book: unknown[]; kept: number } {
  const byKey = new Map<string, unknown>();
  const order: string[] = [];
  for (const c of stored) {
    const k = bookKey(c);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, c);
  }
  const storedKeys = new Set(byKey.keys());
  const incomingKeys = new Set<string>();
  for (const c of incoming) {
    const k = bookKey(c);
    incomingKeys.add(k);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, c); // incoming wins — it's the more recent view of this contact
  }
  // Set difference, NOT `merged.length - incoming.length`: the incoming book can
  // contain its own key collisions, which makes the arithmetic version wrong (it
  // can even go negative).
  let kept = 0;
  for (const k of storedKeys) if (!incomingKeys.has(k)) kept++;
  return { book: order.map((k) => byKey.get(k)), kept };
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
  // [AVADIAL-BACKUP-DAILY] Which client surface produced this write: 'manual' (the
  // user tapped Back up now), 'auto_sync' (an edit on the Contacts tab), or
  // 'daily_bg' (the ~24h WorkManager job). Telemetry only — never trusted, never
  // load-bearing, and clamped since it lands in PostHog. It matters because the
  // daily job runs in a headless Flutter isolate where the client's own PostHog is
  // inert, so THIS server event is the only evidence those runs happened at all.
  const source = typeof body?.source === "string" ? body.source.slice(0, 24) : "unknown";

  // [AVADIAL-BACKUP-MERGE] MERGE is the default and the destructive modes must be
  // asked for BY NAME (owner decision 2026-07-15). Defaulting this way round is the
  // entire safety property: an upload from a client that has never heard of `mode`
  // — an old build still in the wild, a retry, a replayed request — merges, and so
  // cannot delete. Anything unrecognised also falls through to merge.
  //   • replace      — throw away the stored book, keep only what was sent.
  //   • prune_device — drop ONLY contacts that came from a handset's address book,
  //     keeping this account's own AvaTOK contacts (including ones from an older
  //     phone, which `replace` would discard). This is the retrofit for a shared
  //     handset: "I was borrowing that phone, get its contacts out of my backup."
  //     NEVER inferred from a sub role — pruning an account we merely GUESSED was a
  //     sub would delete a real owner's address book. Only an explicit tap sends it.
  const mode: "merge" | "replace" | "prune_device" =
    body?.mode === "replace" ? "replace" : body?.mode === "prune_device" ? "prune_device" : "merge";
  const replace = mode === "replace";

  // [AVADIAL-BACKUP-OWNER] Keys of the contacts on the caller's handset RIGHT NOW,
  // sent only with prune_device. This is what bounds the prune to "this phone" —
  // see the filter below. Absent/garbage ⇒ empty set ⇒ nothing is pruned, so a
  // client that doesn't send it cannot delete anything.
  const deviceKeys = new Set<string>(
    Array.isArray(body?.deviceKeys)
      ? (body.deviceKeys as unknown[]).filter((k): k is string => typeof k === "string")
      : [],
  );

  const plaintextIn = JSON.stringify(contacts);
  if (enc.encode(plaintextIn).byteLength > MAX_BYTES) {
    return json({ error: "contact book too large" }, 413);
  }

  // Union with what's already stored, unless this is a deliberate replace. Read
  // BEFORE the size check below, since merging can only grow the book.
  let merged: unknown[] = contacts;
  let mergedIn = 0;
  let pruned = 0;
  if (!replace) {
    // `row.wrapped` MUST be passed, exactly as both GET paths do. It holds the
    // pre-R2 INLINE ciphertext for any row written before the R2 migration (see the
    // header on ensureTable). Reading R2 alone would find nothing for those legacy
    // users, merge against an empty book, and then write `wrapped=NULL` below —
    // silently deleting their entire backup on their very first upload under the
    // new code, on the automatic path, which is precisely what merge exists to
    // prevent.
    await ensureTable(env);
    const prev = await env.DB_META
      .prepare("SELECT wrapped FROM contact_book_backup WHERE uid=?1")
      .bind(ctxUser.uid)
      .first<{ wrapped: string | null }>();
    const stored = await loadFullBook(env, ctxUser.uid, prev?.wrapped ?? null);
    if (
      stored === null &&
      (prev?.wrapped != null || (await env.BACKUP_R2.head(r2Key(ctxUser.uid))) !== null)
    ) {
      // A book exists but would not decrypt. Merging would silently drop every
      // stored contact and write the incoming set over the top — a replace wearing
      // a merge's clothes, and the user asked for that never to happen. Refuse.
      track(env, ctxUser.uid, "contacts_merge_blocked_decrypt", { source });
      return json({ error: "stored backup unreadable — not overwriting", retryable: false }, 409);
    }
    if (stored !== null && stored.length > 0) {
      // prune_device: drop THIS HANDSET's contacts from what we already hold, then
      // merge the caller's own book back over the remainder.
      //
      // TWO conditions, and the second is the one that matters. `source` says a
      // contact came from AN address book, never WHICH one — so filtering on it
      // alone would delete every device-origin contact the account has ever stored,
      // from ANY phone. The person most likely to tap prune is exactly who that
      // ruins: someone with thousands of contacts backed up from their OWN phone
      // who is now a sub on a borrowed one. So a contact is pruned only if it is
      // device-origin AND its key is in `deviceKeys` — i.e. it is demonstrably
      // sitting on the handset the user is holding as they tap. Anything from
      // another phone is untouchable here.
      //
      // No deviceKeys (an older client, a hand-rolled request) ⇒ empty set ⇒
      // nothing is pruned. Fails closed.
      const base =
        mode === "prune_device"
          ? stored.filter((c: unknown) => {
              const o = c as { source?: string; number?: unknown } | null;
              if (o?.source === "avatok") return true; // the caller's own — always keep
              return !deviceKeys.has(mergeKey(o?.number)); // keep unless on THIS handset
            })
          : stored;
      pruned = stored.length - base.length;
      const r = mergeBooks(base, contacts);
      merged = r.book;
      mergedIn = r.kept;
    }
  }

  // [AVADIAL-BACKUP-OWNER] How many of the STORED contacts came from a handset's own
  // address book (computed on the merged set — it's what actually gets written).
  // This is the ONLY thing that tells a client whether an account already owns a
  // full phone-book backup. Counted here, at write time, because the alternative
  // (decrypting the whole book on every status call) is far too expensive for a
  // metadata endpoint. `source` is set by the client on every contact
  // (AvaBookContact.toJson always emits it); anything not explicitly 'avatok' is
  // treated as device-owned, so an unknown/missing value errs toward "this book has
  // device contacts" — the safe direction, since that only ever protects a backup.
  const deviceCount = merged.filter(
    (c: unknown) => (c as { source?: string } | null)?.source !== "avatok",
  ).length;

  const plaintext = JSON.stringify(merged);
  if (enc.encode(plaintext).byteLength > MAX_BYTES) {
    // The merged book breached the cap. Do NOT fall back to storing the incoming
    // set alone — that would be a silent deletion of everything the merge just
    // preserved, which is precisely what merge exists to prevent. Fail loudly and
    // keep the stored copy exactly as it was.
    track(env, ctxUser.uid, "contacts_merge_too_large",
      { kept: mergedIn, incoming: contacts.length, merged: merged.length });
    return json({ error: "contact book too large", merged: merged.length }, 413);
  }

  const now = Date.now();
  const wrapped = await encryptJson(env, ctxUser.uid, plaintext);
  // Store the (already-encrypted) blob in R2; keep only metadata in D1.
  // NB: every count below is `merged.length`, NOT `contacts.length`. What's stored
  // is the merged book, so the metadata must describe the merged book — the client
  // reads `count` back to decide what it has, and a count that describes only the
  // upload would understate the backup on every merge.
  await env.BACKUP_R2.put(r2Key(ctxUser.uid), wrapped, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { uid: ctxUser.uid, count: String(merged.length), updated: String(now) },
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
      `INSERT INTO contact_book_backup (uid, wrapped, count, alg, created_at, updated_at, device_count)
       VALUES (?1, NULL, ?2, 'v1r2', ?3, ?3, ?4)
       ON CONFLICT(uid) DO UPDATE SET wrapped=NULL, count=?2, alg='v1r2', updated_at=?3, device_count=?4`,
    )
    .bind(ctxUser.uid, merged.length, now, deviceCount)
    .run();

  // Background: (re)build the paginated chunks so restore can stream pages.
  if (cfg.contactsBookPaged !== false) scheduleChunk(env, ctx, ctxUser.uid);

  const ms = Date.now() - t0;
  metric(env, "put", ctxUser.uid, merged.length, ms);
  track(env, ctxUser.uid, "contacts_backup_stored", {
    count: merged.length,
    sent: contacts.length,
    // How many stored contacts the upload did NOT contain but merge preserved.
    // Under the old replace semantics every one of these was a silent deletion, so
    // this is the number that shows the feature working.
    kept: mergedIn,
    mode,
    pruned,
    bytes: enc.encode(plaintext).byteLength,
    groups: groups?.length ?? -1,
    source,
    ms,
  });
  // [ONEBRAIN-B2] Brain ingest — a light contacts-sync SUMMARY only (never the
  // contact rows / no names / no numbers). Consent is enforced inside brainIngest
  // (domain 'contacts'); fire-and-forget so a brain hiccup never affects backup.
  void brainIngest(env, {
    uid: ctxUser.uid, domain: "contacts", kind: "contacts_synced",
    sourceId: `${ctxUser.uid}:contacts:${now}`,
    text: `Synced ${merged.length} contacts${mergedIn ? `, ${mergedIn} new` : ""}`,
    meta: { count: merged.length, sent: contacts.length, new: mergedIn, pruned, mode, source },
    ts: now,
  });
  return json({
    ok: true,
    count: merged.length,
    sent: contacts.length,
    kept: mergedIn,
    pruned,
    mode,
    groups: groups?.length ?? 0,
    updatedAt: now,
  });
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
    .prepare("SELECT count, updated_at, device_count FROM contact_book_backup WHERE uid=?1")
    .bind(ctxUser.uid)
    .first<{ count: number; updated_at: number; device_count: number | null }>();
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
    // [AVADIAL-BACKUP-OWNER] How many stored contacts came from a handset's own
    // address book. The client uses this — and ONLY this — to decide whether an
    // account already owns a full phone-book backup that must never be shrunk.
    // NULL (absent field) means "written before this rule existed", which the
    // client MUST read as "yes, full book". Sent explicitly rather than coerced to
    // 0, because 0 and null mean opposite things here: 0 authorises the client to
    // replace the stored book with a smaller one, null forbids it.
    deviceCount: row.device_count,
  });
}
