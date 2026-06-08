// Two upload paths + AvaLibrary + ICE. Reads are served by blossom.avatok.ai
// (public R2 bucket) — never through this Worker. Worker handles WRITES only.
import type { Env } from "../types";
import { json, sha256Hex, CORS } from "../util";
import { mediaSession, moderationSession } from "../db/shard";
import { authenticate, isErr } from "../auth";
import { walletOp } from "./wallet";

// POST /upload/public — plaintext media (posts). sha256 → blocklist check →
// R2 PUT (status 'pending') → enqueue Workers-AI scan (Phase 4 consumer flips
// to 'live' or deletes). AI is async per Rulebook; blocklist is a cheap sync gate.
export async function uploadPublic(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);                  // content id (moderation/blocklist/dedup)
  const r2Key = userKey(auth.npub, "public", hash);    // per-user storage path → clear ownership
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(ct, hash);
  const app = (req.headers.get("x-app") || "avatweet").toLowerCase();

  // Cheap synchronous blocklist gate (known-bad sha256 — content-level, cross-user).
  const blocked = await moderationSession(env)
    .prepare("SELECT 1 FROM blocked_media_hashes WHERE hash_value=?1 LIMIT 1").bind(hash).first();
  if (blocked) return json({ error: "rejected", reason: "blocked content" }, 403);

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id, moderation_status FROM user_media WHERE key=?1").bind(r2Key).first<any>();
  if (!existing) {
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });
    const id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,?3,'blossom','public',0,?4,?5,?6,?7,?8,?9,'pending',?10,?11,'sent')`,
    ).bind(id, auth.npub, mediaType(ct), r2Key, url, ct, bytes.byteLength, app, Date.now(), categoryOf(ct), fileName).run();
    // async moderation — content hash for scan/blocklist, r2_key for fetch/delete.
    ctx.waitUntil(env.Q_MODERATION.send({ type: "image", hash, npub: auth.npub, media_id: id, r2_key: r2Key }));
    // AvaBrain learns from public uploads (metadata only — no DM media here).
    ctx.waitUntil(env.Q_BRAIN.send({ npub: auth.npub, event_type: "upload_completed", source_app: app, payload: { hash, mime: ct, size: bytes.byteLength } }));
    // AvaBrain CONTENT ingestion of the public file itself (caption/OCR/text → embed),
    // gated on the user's consent toggles. Private uploads never reach this path.
    ctx.waitUntil(maybeEmitLibraryBrain(env, auth.npub, app, { media_id: id, key: r2Key, mime: ct, size: bytes.byteLength, name: fileName, category: categoryOf(ct), visibility: "public" }));
  }
  return json({ hash, key: r2Key, url, status: "pending" });
}

// POST /upload/private — client-side AES-GCM ciphertext (DM attachments).
// No scan (unscannable by design). Same public bucket — ciphertext is safe to
// serve; the AES key travels inside the encrypted DM.
export async function uploadPrivate(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);
  const r2Key = userKey(auth.npub, "dm", hash);   // per-user path (ciphertext owned by sender)
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = "application/octet-stream"; // ciphertext
  // The real content type/name travel in headers (the bytes themselves are
  // opaque ciphertext). Used only to categorise the Library entry — never to scan.
  const realMime = req.headers.get("x-real-mime") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(realMime, hash);
  const app = (req.headers.get("x-app") || "avachat").toLowerCase();

  const head = await env.BLOBS.head(r2Key);
  if (!head) await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1").bind(r2Key).first();
  if (!existing) {
    await mdb.prepare(
      `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,?3,'blossom','private',1,?4,?5,?6,?7,?8,?9,'skipped',?10,?11,'sent')`,
    ).bind(crypto.randomUUID(), auth.npub, mediaType(realMime), r2Key, url, ct, bytes.byteLength, app, Date.now(), categoryOf(realMime), fileName).run();
  }
  return json({ hash, key: r2Key, url, status: "live" });
}

// Per-user storage prefix with a type subfolder → everything a user owns lives
// under `u/<npub>/…`, so an account delete is one prefix wipe and nothing of
// another user's can be touched. `npub` is bech32 (safe charset).
//   u/<npub>/public/<hash>   public posts
//   u/<npub>/dm/<hash>       DM ciphertext
//   u/<npub>/video/…         (future) Bunny is separate, but keep the convention
//   u/<npub>/backups/…       account exports
function userKey(npub: string, kind: "public" | "dm", hash: string): string {
  return `u/${npub}/${kind}/${hash}`;
}

// GET /media/:hash — back-compat shim. Old app fetched bytes here; now we 301 to
// the public bucket. Removed entirely at Phase 5 once the app reads blossom directly.
export function mediaRedirect(path: string, env: Env): Response {
  const hash = path.split("/").pop();
  return new Response(null, { status: 301, headers: { ...CORS, location: `${env.BLOSSOM_BASE_URL}/${hash}` } });
}

// Columns every Library item view returns (kept stable for the client model).
const LIB_COLS =
  "id, media_type, category, key, display_url, thumbnail_url, mime_type, file_name, " +
  "size_bytes, visibility, original_app, folder_id, source_kind, enc_blob, created_at";

// GET /api/library?app=&category=&folder=&type=&cursor= — paginated file list for
// ONE view (an app→category bucket, or a user folder). Soft-deleted rows excluded.
// Back-compat: a bare ?type= still works (legacy chat library callers).
export async function getLibrary(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const sp = new URL(req.url).searchParams;
  const cursor = Number(sp.get("cursor") || Date.now());
  const app = sp.get("app");
  const category = sp.get("category") || sp.get("type");
  const folder = sp.get("folder");
  const where: string[] = ["npub=?1", "deleted_at IS NULL", "created_at < ?2"];
  const binds: any[] = [auth.npub, cursor];
  if (folder) { where.push(`folder_id=?${binds.length + 1}`); binds.push(folder); }
  else {
    // System (auto) folder view: files NOT placed in a user folder.
    where.push("folder_id IS NULL");
    if (app) { where.push(`original_app=?${binds.length + 1}`); binds.push(app); }
    if (category) { where.push(`(category=?${binds.length + 1} OR media_type=?${binds.length + 1})`); binds.push(category); }
  }
  const sql = `SELECT ${LIB_COLS} FROM user_media WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 30`;
  const rs = await mediaSession(env).prepare(sql).bind(...binds).all();
  const items = (rs.results ?? []) as any[];
  const next = items.length === 30 ? items[items.length - 1].created_at : null;
  return json({ items, cursor: next });
}

// GET /api/library/tree — the navigation skeleton: per-app totals + per-category
// counts (system folders) and the user's folders grouped by app. Cheap aggregates.
export async function getLibraryTree(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const mdb = mediaSession(env);
  const agg = await mdb.prepare(
    `SELECT COALESCE(original_app,'avatok') AS app, COALESCE(category,'other') AS category,
            COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
     FROM user_media WHERE npub=?1 AND deleted_at IS NULL
     GROUP BY app, category`,
  ).bind(auth.npub).all();
  const apps: Record<string, any> = {};
  for (const r of (agg.results ?? []) as any[]) {
    const a = (apps[r.app] ||= { app: r.app, total: 0, bytes: 0, by_category: {} });
    a.by_category[r.category] = { count: r.n, bytes: r.bytes };
    a.total += r.n; a.bytes += r.bytes;
  }
  const fr = await mdb.prepare(
    "SELECT id, app, name, parent_id, created_at FROM library_folders WHERE npub=?1 ORDER BY created_at ASC",
  ).bind(auth.npub).all();
  const foldersByApp: Record<string, any[]> = {};
  for (const f of (fr.results ?? []) as any[]) (foldersByApp[f.app] ||= []).push(f);
  return json({ apps: Object.values(apps), folders_by_app: foldersByApp });
}

// --- /api/library/folders — user-folder CRUD ---
// GET ?app=  list · POST create · PATCH rename · DELETE ?id= (reparents files).
export async function libraryFolders(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const mdb = mediaSession(env);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const app = url.searchParams.get("app");
    const rs = app
      ? await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE npub=?1 AND app=?2 ORDER BY created_at ASC").bind(auth.npub, app).all()
      : await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE npub=?1 ORDER BY created_at ASC").bind(auth.npub).all();
    return json({ folders: rs.results ?? [] });
  }

  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    const app = (b.app || "avatok").toString().toLowerCase();
    if (!name) return json({ error: "name required" }, 400);
    const id = crypto.randomUUID();
    await mdb.prepare(
      "INSERT INTO library_folders (id, npub, app, name, parent_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(id, auth.npub, app, name, b.parent_id ?? null, Date.now()).run();
    return json({ id, app, name, parent_id: b.parent_id ?? null });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    if (!b.id || !name) return json({ error: "id and name required" }, 400);
    await mdb.prepare("UPDATE library_folders SET name=?3 WHERE id=?1 AND npub=?2").bind(b.id, auth.npub, name).run();
    return json({ ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    // Don't orphan files: reparent them to the app auto folder (folder_id NULL).
    await mdb.batch([
      mdb.prepare("UPDATE user_media SET folder_id=NULL WHERE npub=?1 AND folder_id=?2").bind(auth.npub, id),
      mdb.prepare("UPDATE library_folders SET parent_id=NULL WHERE npub=?1 AND parent_id=?2").bind(auth.npub, id),
      mdb.prepare("DELETE FROM library_folders WHERE id=?1 AND npub=?2").bind(id, auth.npub),
    ]);
    return json({ ok: true });
  }
  return json({ error: "method" }, 405);
}

// POST /api/library/move {id, folder_id|null} — place a file in a user folder
// (or back to its system folder when folder_id is null).
export async function libraryMove(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  await mediaSession(env).prepare("UPDATE user_media SET folder_id=?3 WHERE id=?1 AND npub=?2")
    .bind(b.id, auth.npub, b.folder_id ?? null).run();
  return json({ ok: true });
}

// POST /api/library/copy {id, folder_id} — a shortcut: a NEW row pointing at the
// SAME content-addressed key. Storage counts distinct keys, so this is free bytes.
export async function libraryCopy(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const src = await mdb.prepare(`SELECT ${LIB_COLS}, media_type, storage, encrypted, moderation_status FROM user_media WHERE id=?1 AND npub=?2`)
    .bind(b.id, auth.npub).first<any>();
  if (!src) return json({ error: "not found" }, 404);
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, thumbnail_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, folder_id, source_kind, enc_blob)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
  ).bind(id, auth.npub, src.media_type, src.storage, src.visibility, src.encrypted, src.key, src.display_url, src.thumbnail_url ?? null,
    src.mime_type, src.size_bytes, src.original_app, Date.now(), src.moderation_status, src.category, src.file_name,
    b.folder_id ?? null, src.source_kind, src.enc_blob ?? null).run();
  return json({ id });
}

// POST /api/library/delete {id} — soft delete (storage recomputes; hard-delete of
// orphaned blobs runs via the erasure queue / account-deletion cascade).
export async function libraryDelete(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  await mediaSession(env).prepare("UPDATE user_media SET deleted_at=?3 WHERE id=?1 AND npub=?2")
    .bind(b.id, auth.npub, Date.now()).run();
  return json({ ok: true });
}

// POST /api/library/record — receiver-side Library entry for DM media the user
// RECEIVED. The blob is already content-addressed on R2 (uploaded by the sender);
// we store the recipient's reference + their decryption material ENCRYPTED TO THEM
// (enc_blob — Vault-style; the server never sees plaintext keys). Makes received
// media cross-device + (opt-in) brain-eligible without weakening E2E.
export async function libraryRecord(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const key = (b.key || "").toString();
  if (!key) return json({ error: "key required" }, 400);
  const mime = (b.mime || "application/octet-stream").toString();
  const app = (b.app || "avatok").toString().toLowerCase();
  const size = Number(b.size || 0);
  const name = (b.name || defaultName(mime, key)).toString();
  const encrypted = b.enc_blob ? 1 : 0;
  const display = (b.display_url || `${env.BLOSSOM_BASE_URL}/${key}`).toString();
  const mdb = mediaSession(env);
  // Idempotent per (npub, key, received): re-receiving the same blob is a no-op.
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE npub=?1 AND key=?2 AND source_kind='received'").bind(auth.npub, key).first<any>();
  if (existing) return json({ id: existing.id, deduped: true });
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, enc_blob)
     VALUES (?1,?2,?3,'blossom',?4,?5,?6,?7,?8,?9,?10,?11,'skipped',?12,?13,'received',?14)`,
  ).bind(id, auth.npub, mediaType(mime), encrypted ? "private" : "public", encrypted, key, display, mime, size, app, Date.now(),
    categoryOf(mime), name, b.enc_blob ?? null).run();
  // PUBLIC received media is brain-eligible server-side; private stays on-device.
  if (!encrypted && env.Q_BRAIN) {
    ctx.waitUntil(maybeEmitLibraryBrain(env, auth.npub, app, { media_id: id, key, mime, size, name, category: categoryOf(mime), visibility: "public" }));
  }
  return json({ id });
}

// GET /api/storage — AvaStorage accounting for the bars UI. One universal pool per
// account. Bytes are summed over DISTINCT content keys (shortcuts/copies don't
// double-count), non-deleted only. Quota: free GB from config; over quota draws
// AvaCoins/GB/month from the AvaWallet — an empty wallet over quota = read-only.
export async function getStorage(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const mdb = mediaSession(env);
  // Distinct-key dedup: one physical copy per key, charged once. We pick a single
  // representative row per key (MIN(id)) then aggregate its category/app/bytes.
  const rs = await mdb.prepare(
    `WITH dedup AS (
       SELECT key, MIN(id) AS rep FROM user_media
       WHERE npub=?1 AND deleted_at IS NULL GROUP BY key
     )
     SELECT COALESCE(m.category,'other') AS category, COALESCE(m.original_app,'avatok') AS app, m.size_bytes AS size
     FROM dedup d JOIN user_media m ON m.id = d.rep`,
  ).bind(auth.npub).all();
  const byCategory: Record<string, number> = { image: 0, video: 0, document: 0, audio: 0, other: 0 };
  const byApp: Record<string, number> = {};
  let total = 0;
  for (const r of (rs.results ?? []) as any[]) {
    const sz = Number(r.size || 0);
    byCategory[r.category] = (byCategory[r.category] || 0) + sz;
    byApp[r.app] = (byApp[r.app] || 0) + sz;
    total += sz;
  }
  const freeGb = Number(env.STORAGE_FREE_GB || "5");
  const quota = freeGb * 1024 * 1024 * 1024;
  let state: "ok" | "read_only" = "ok";
  if (total > quota) {
    // Over the free quota — needs AvaCoins. Empty wallet → read-only (never delete).
    let coins = 0;
    try {
      const w = await walletOp(env, auth.npub, { op: "balance", npub: auth.npub });
      coins = Number(w.body?.balance ?? w.body?.coins ?? w.body?.available ?? 0);
    } catch { /* wallet optional → treat as 0 */ }
    if (coins <= 0) state = "read_only";
  }
  return json({ total_used: total, quota, by_category: byCategory, by_app: byApp, state, free_gb: freeGb });
}

// GET /ice — short-lived STUN+TURN credentials from Cloudflare Calls.
export async function getIce(env: Env): Promise<Response> {
  const stunOnly = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json(stunOnly);
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!r.ok) return json(stunOnly);
    const data = (await r.json()) as any;
    return json(data.iceServers ? data : { iceServers: data });
  } catch {
    return json(stunOnly);
  }
}

function mediaType(ct: string): string {
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "image";
}

// AvaLibrary category from a mime type. The library bucket the file lands in.
export function categoryOf(ct: string): string {
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (
    ct === "application/pdf" ||
    ct.startsWith("text/") ||
    ct.startsWith("application/msword") ||
    ct.startsWith("application/vnd.")
  ) return "document";
  return "other";
}

// --- AvaBrain consent gate (Golden Rule 15: default ON, opt-out) ---
// Ingestion producers must check the toggle BEFORE learning. Absence of a row =
// enabled (default ON). We require BOTH the master switch and the per-app "files"
// capability to be on. brain_consent lives in DB_BRAIN (server-readable booleans —
// not sensitive). Private/E2E plaintext never reaches this path regardless.
export async function brainConsentAllows(env: Env, npub: string, app: string): Promise<boolean> {
  try {
    const caps = [`master`, `${app}_files`];
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE npub=?1 AND capability IN (?2,?3)`,
    ).bind(npub, caps[0], caps[1]).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (Number(r.enabled) === 0) return false; // explicit opt-out
    }
    return true; // default ON
  } catch { return true; } // table missing → fail-open to default-ON
}

// Emit a library_file_added event for content ingestion, gated on consent.
export async function maybeEmitLibraryBrain(
  env: Env, npub: string, app: string,
  payload: { media_id: string; key: string; mime: string; size: number; name: string; category: string; visibility: string },
): Promise<void> {
  if (payload.visibility !== "public") return;            // server ingests PUBLIC only
  if (!(await brainConsentAllows(env, npub, app))) return; // user opted out
  await env.Q_BRAIN.send({ npub, event_type: "library_file_added", source_app: app, payload });
}

// A sensible display name when the client didn't send one. Extension from mime.
function defaultName(ct: string, hash: string): string {
  const ext = ({
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/aac": "m4a", "application/pdf": "pdf",
  } as Record<string, string>)[ct] || ct.split("/")[1] || "bin";
  return `${categoryOf(ct)}-${hash.slice(0, 8)}.${ext}`;
}
