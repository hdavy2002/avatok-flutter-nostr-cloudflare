// Two upload paths + AvaLibrary + ICE. Reads are served by blossom.avatok.ai
// (public R2 bucket) — never through this Worker. Worker handles WRITES only.
import type { Env } from "../types";
import { json, sha256Hex, CORS } from "../util";
import { mediaSession, moderationSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { walletOp } from "./wallet";
import { checkUploadAllowed, afterRegisterFile } from "../storage";

// POST /upload/public — plaintext media (posts). sha256 → blocklist check →
// R2 PUT (status 'pending') → enqueue Workers-AI scan (Phase 4 consumer flips
// to 'live' or deletes). AI is async per Rulebook; blocklist is a cheap sync gate.
export async function uploadPublic(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);                  // content id (moderation/blocklist/dedup)
  const r2Key = userKey(ctx.uid, "public", hash);    // per-user storage path → clear ownership
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(ct, hash);
  const app = (req.headers.get("x-app") || "avatweet").toLowerCase();
  // Optional: drop the upload straight into a user folder (AvaLibrary "+ Upload").
  const folderId = req.headers.get("x-folder") || null;

  // Cheap synchronous blocklist gate (known-bad sha256 — content-level, cross-user).
  const blocked = await moderationSession(env)
    .prepare("SELECT 1 FROM blocked_media_hashes WHERE hash_value=?1 LIMIT 1").bind(hash).first();
  if (blocked) return json({ error: "rejected", reason: "blocked content" }, 403);

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id, moderation_status FROM user_media WHERE key=?1").bind(r2Key).first<any>();
  let id: string | undefined = existing?.id;
  if (!existing) {
    // Phase 4 quota gate: would-exceed 5 GB + empty wallet ⇒ 413, read_only.
    const gate = await checkUploadAllowed(env, ctx.uid, bytes.byteLength, false);
    if (!gate.ok) return gate.resp;
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });
    id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, folder_id)
       VALUES (?1,?2,?3,'blossom','public',0,?4,?5,?6,?7,?8,?9,'pending',?10,?11,'sent',?12)`,
    ).bind(id, ctx.uid, mediaType(ct), r2Key, url, ct, bytes.byteLength, app, Date.now(), categoryOf(ct), fileName, folderId).run();
    // async moderation — content hash for scan/blocklist, r2_key for fetch/delete.
    exec.waitUntil(env.Q_MODERATION.send({ type: "image", hash, uid: ctx.uid, media_id: id, r2_key: r2Key }));
    // AvaBrain learns from public uploads (metadata only — no DM media here).
    exec.waitUntil(env.Q_BRAIN.send({ uid: ctx.uid, event_type: "upload_completed", source_app: app, payload: { hash, mime: ct, size: bytes.byteLength } }));
    // AvaBrain CONTENT ingestion of the public file itself (caption/OCR/text → embed),
    // gated on the user's consent toggles. Private uploads never reach this path.
    exec.waitUntil(maybeEmitLibraryBrain(env, ctx.uid, app, { media_id: id, key: r2Key, mime: ct, size: bytes.byteLength, name: fileName, category: categoryOf(ct), visibility: "public" }));
    // Phase 4: refresh the storage summary + live-push it over the InboxDO socket.
    exec.waitUntil(afterRegisterFile(env, ctx.uid, { kind: categoryOf(ct), bytes: bytes.byteLength, source_app: app, dedup: false }));
  } else if (folderId) {
    // Re-upload of identical content while sitting in a folder → place it there.
    await mdb.prepare("UPDATE user_media SET folder_id=?3 WHERE id=?1 AND uid=?2").bind(existing.id, ctx.uid, folderId).run();
  }
  return json({ hash, key: r2Key, url, status: "pending", id });
}

// POST /upload/private — client-side AES-GCM ciphertext (DM attachments).
// No scan (unscannable by design). Same public bucket — ciphertext is safe to
// serve; the AES key travels inside the encrypted DM.
export async function uploadPrivate(req: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);
  const r2Key = userKey(ctx.uid, "dm", hash);   // per-user path (ciphertext owned by sender)
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = "application/octet-stream"; // ciphertext
  // The real content type/name travel in headers (the bytes themselves are
  // opaque ciphertext). Used only to categorise the Library entry — never to scan.
  const realMime = req.headers.get("x-real-mime") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(realMime, hash);
  const app = (req.headers.get("x-app") || "avachat").toLowerCase();

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1").bind(r2Key).first();
  if (!existing) {
    // Phase 4 quota gate (same pool as public — ciphertext bytes count too).
    const gate = await checkUploadAllowed(env, ctx.uid, bytes.byteLength, false);
    if (!gate.ok) return gate.resp;
  }
  const head = await env.BLOBS.head(r2Key);
  if (!head) await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });

  if (!existing) {
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,?3,'blossom','private',1,?4,?5,?6,?7,?8,?9,'skipped',?10,?11,'sent')`,
    ).bind(crypto.randomUUID(), ctx.uid, mediaType(realMime), r2Key, url, ct, bytes.byteLength, app, Date.now(), categoryOf(realMime), fileName).run();
    const reg = afterRegisterFile(env, ctx.uid, { kind: categoryOf(realMime), bytes: bytes.byteLength, source_app: app, dedup: false });
    if (exec) exec.waitUntil(reg); else await reg.catch(() => { /* best-effort */ });
  }
  return json({ hash, key: r2Key, url, status: "live" });
}

// Per-user storage prefix with a type subfolder → everything a user owns lives
// under `u/<uid>/…`, so an account delete is one prefix wipe and nothing of
// another user's can be touched. `uid` is bech32 (safe charset).
//   u/<uid>/public/<hash>   public posts
//   u/<uid>/dm/<hash>       DM ciphertext
//   u/<uid>/video/…         (future) Bunny is separate, but keep the convention
//   u/<uid>/backups/…       account exports
function userKey(uid: string, kind: "public" | "dm", hash: string): string {
  return `u/${uid}/${kind}/${hash}`;
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
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const sp = new URL(req.url).searchParams;
  const cursor = Number(sp.get("cursor") || Date.now());
  const app = sp.get("app");
  const category = sp.get("category") || sp.get("type");
  const folder = sp.get("folder");
  const q = (sp.get("q") || "").trim();
  const where: string[] = ["uid=?1", "deleted_at IS NULL", "created_at < ?2"];
  const binds: any[] = [ctx.uid, cursor];
  // Phase 4: server-side name search (file_name LIKE, escaped).
  if (q) { where.push(`file_name LIKE ?${binds.length + 1} ESCAPE '\\'`); binds.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
  if (folder) { where.push(`folder_id=?${binds.length + 1}`); binds.push(folder); }
  else {
    // System (auto) folder view: files NOT placed in a user folder. A name
    // search (?q=) spans user folders too — it's a find, not a folder view.
    if (!q) where.push("folder_id IS NULL");
    if (app) { where.push(`original_app=?${binds.length + 1}`); binds.push(app); }
    // PDFs are split out of the 'document' bucket; 'doc' = documents that aren't PDFs.
    if (category === "pdf") {
      where.push(`mime_type=?${binds.length + 1}`); binds.push("application/pdf");
    } else if (category === "doc") {
      where.push(`category='document' AND mime_type<>?${binds.length + 1}`); binds.push("application/pdf");
    } else if (category) {
      where.push(`(category=?${binds.length + 1} OR media_type=?${binds.length + 1})`); binds.push(category);
    }
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
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  // Split the 'document' bucket into pdf vs doc so the client root reads like a
  // clean file manager (Images/Videos/PDFs/Documents/Music/Other). Additive: the
  // client folds pdf/doc back into a single "Documents" folder if it ever sees a
  // legacy 'document'-only tree.
  const agg = await mdb.prepare(
    `SELECT COALESCE(original_app,'avatok') AS app,
            CASE
              WHEN mime_type='application/pdf' THEN 'pdf'
              WHEN COALESCE(category,'other')='document' THEN 'doc'
              ELSE COALESCE(category,'other')
            END AS category,
            COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
     FROM user_media WHERE uid=?1 AND deleted_at IS NULL
     GROUP BY app, category`,
  ).bind(ctx.uid).all();
  const apps: Record<string, any> = {};
  for (const r of (agg.results ?? []) as any[]) {
    const a = (apps[r.app] ||= { app: r.app, total: 0, bytes: 0, by_category: {} });
    a.by_category[r.category] = { count: r.n, bytes: r.bytes };
    a.total += r.n; a.bytes += r.bytes;
  }
  const fr = await mdb.prepare(
    "SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 ORDER BY created_at ASC",
  ).bind(ctx.uid).all();
  const foldersByApp: Record<string, any[]> = {};
  for (const f of (fr.results ?? []) as any[]) (foldersByApp[f.app] ||= []).push(f);
  return json({ apps: Object.values(apps), folders_by_app: foldersByApp });
}

// --- /api/library/folders — user-folder CRUD ---
// GET ?app=  list · POST create · PATCH rename · DELETE ?id= (reparents files).
export async function libraryFolders(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const app = url.searchParams.get("app");
    const rs = app
      ? await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 AND app=?2 ORDER BY created_at ASC").bind(ctx.uid, app).all()
      : await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 ORDER BY created_at ASC").bind(ctx.uid).all();
    return json({ folders: rs.results ?? [] });
  }

  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    const app = (b.app || "avatok").toString().toLowerCase();
    if (!name) return json({ error: "name required" }, 400);
    const id = crypto.randomUUID();
    await mdb.prepare(
      "INSERT INTO library_folders (id, uid, app, name, parent_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(id, ctx.uid, app, name, b.parent_id ?? null, Date.now()).run();
    return json({ id, app, name, parent_id: b.parent_id ?? null });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    if (!b.id || !name) return json({ error: "id and name required" }, 400);
    await mdb.prepare("UPDATE library_folders SET name=?3 WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid, name).run();
    return json({ ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    // Don't orphan files: reparent them to the app auto folder (folder_id NULL).
    await mdb.batch([
      mdb.prepare("UPDATE user_media SET folder_id=NULL WHERE uid=?1 AND folder_id=?2").bind(ctx.uid, id),
      mdb.prepare("UPDATE library_folders SET parent_id=NULL WHERE uid=?1 AND parent_id=?2").bind(ctx.uid, id),
      mdb.prepare("DELETE FROM library_folders WHERE id=?1 AND uid=?2").bind(id, ctx.uid),
    ]);
    return json({ ok: true });
  }
  return json({ error: "method" }, 405);
}

// POST /api/library/move {id, folder_id|null, app?} — place a file in a user
// folder (or back to its system folder when folder_id is null). Passing `app`
// moves it across app roots too (AvaLibrary lets files move anywhere).
export async function libraryMove(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  if (b.app) {
    await mdb.prepare("UPDATE user_media SET folder_id=?3, original_app=?4 WHERE id=?1 AND uid=?2")
      .bind(b.id, ctx.uid, b.folder_id ?? null, String(b.app).toLowerCase()).run();
  } else {
    await mdb.prepare("UPDATE user_media SET folder_id=?3 WHERE id=?1 AND uid=?2")
      .bind(b.id, ctx.uid, b.folder_id ?? null).run();
  }
  return json({ ok: true });
}

// POST /api/library/copy {id, folder_id, app?} — a shortcut: a NEW row pointing at
// the SAME content-addressed key. Storage counts distinct keys, so this is free
// bytes. Passing `app` lands the copy under another app root.
export async function libraryCopy(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const src = await mdb.prepare(`SELECT ${LIB_COLS}, media_type, storage, encrypted, moderation_status FROM user_media WHERE id=?1 AND uid=?2`)
    .bind(b.id, ctx.uid).first<any>();
  if (!src) return json({ error: "not found" }, 404);
  const id = await copyMediaRow(mdb, ctx.uid, src, b.folder_id ?? null, b.app ? String(b.app).toLowerCase() : src.original_app);
  return json({ id });
}

// Insert a duplicate of a media row (same content key → free storage) into a
// target folder/app. Shared by file-copy and folder-copy.
async function copyMediaRow(mdb: any, uid: string, src: any, folderId: string | null, app: string): Promise<string> {
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, thumbnail_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, folder_id, source_kind, enc_blob)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
  ).bind(id, uid, src.media_type, src.storage, src.visibility, src.encrypted, src.key, src.display_url, src.thumbnail_url ?? null,
    src.mime_type, src.size_bytes, app, Date.now(), src.moderation_status, src.category, src.file_name,
    folderId, src.source_kind, src.enc_blob ?? null).run();
  return id;
}

// Walk up the parent chain from `start` to check whether `ancestorId` is an
// ancestor (used to block moving/copying a folder into its own subtree).
async function isInSubtree(mdb: any, uid: string, start: string | null, ancestorId: string): Promise<boolean> {
  let cur = start;
  let hops = 0;
  while (cur && hops < 64) {
    if (cur === ancestorId) return true;
    const row = await mdb.prepare("SELECT parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(cur, uid).first();
    cur = (row as any)?.parent_id ?? null;
    hops++;
  }
  return false;
}

// POST /api/library/folders/move {id, app?, parent_id?} — re-home a whole folder:
// nest it under another folder (parent_id) and/or move it to another app root.
// Files inside travel with the folder; when the app changes they're re-stamped so
// the tree's per-app counts stay honest.
export async function libraryFolderMove(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const folder = await mdb.prepare("SELECT id, app, parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid).first<any>();
  if (!folder) return json({ error: "not found" }, 404);
  const newApp = b.app ? String(b.app).toLowerCase() : folder.app;
  const newParent = b.parent_id === undefined ? folder.parent_id : (b.parent_id ?? null);
  if (newParent && (newParent === b.id || await isInSubtree(mdb, ctx.uid, newParent, b.id))) {
    return json({ error: "cannot move a folder into itself" }, 400);
  }
  const stmts = [
    mdb.prepare("UPDATE library_folders SET app=?3, parent_id=?4 WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid, newApp, newParent),
  ];
  if (newApp !== folder.app) {
    stmts.push(mdb.prepare("UPDATE user_media SET original_app=?3 WHERE uid=?1 AND folder_id=?2").bind(ctx.uid, b.id, newApp));
  }
  await mdb.batch(stmts);
  return json({ ok: true, id: b.id, app: newApp, parent_id: newParent });
}

// POST /api/library/folders/copy {id, app?, parent_id?} — duplicate a folder and
// everything inside it (recursively). Files are copied as shortcuts (same content
// key → no extra storage). Returns the new top-level folder id.
export async function libraryFolderCopy(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const folder = await mdb.prepare("SELECT id, app, parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid).first<any>();
  if (!folder) return json({ error: "not found" }, 404);
  const destApp = b.app ? String(b.app).toLowerCase() : folder.app;
  const destParent = b.parent_id ?? null;
  if (destParent && (destParent === b.id || await isInSubtree(mdb, ctx.uid, destParent, b.id))) {
    return json({ error: "cannot copy a folder into itself" }, 400);
  }
  const newId = await copyFolderRec(mdb, ctx.uid, b.id, destApp, destParent);
  return json({ id: newId });
}

// Recursively duplicate a folder subtree (folder rows + their non-deleted files).
async function copyFolderRec(mdb: any, uid: string, srcId: string, destApp: string, destParent: string | null): Promise<string | null> {
  const src = (await mdb.prepare("SELECT id, name FROM library_folders WHERE id=?1 AND uid=?2").bind(srcId, uid).first()) as any;
  if (!src) return null;
  const newId = crypto.randomUUID();
  await mdb.prepare("INSERT INTO library_folders (id, uid, app, name, parent_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(newId, uid, destApp, src.name, destParent, Date.now()).run();
  const files = await mdb.prepare(
    `SELECT ${LIB_COLS}, media_type, storage, encrypted, moderation_status FROM user_media WHERE uid=?1 AND folder_id=?2 AND deleted_at IS NULL`,
  ).bind(uid, srcId).all();
  for (const f of (files.results ?? []) as any[]) {
    await copyMediaRow(mdb, uid, f, newId, destApp);
  }
  const kids = await mdb.prepare("SELECT id FROM library_folders WHERE uid=?1 AND parent_id=?2").bind(uid, srcId).all();
  for (const k of (kids.results ?? []) as any[]) {
    await copyFolderRec(mdb, uid, k.id, destApp, newId);
  }
  return newId;
}

// POST /api/library/delete {id} — soft delete (storage recomputes; hard-delete of
// orphaned blobs runs via the erasure queue / account-deletion cascade).
export async function libraryDelete(req: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  await mediaSession(env).prepare("UPDATE user_media SET deleted_at=?3 WHERE id=?1 AND uid=?2")
    .bind(b.id, ctx.uid, Date.now()).run();
  // Phase 4: quota frees when the LAST reference to a key goes (dedup recompute).
  const reg = afterRegisterFile(env, ctx.uid);
  if (exec) exec.waitUntil(reg); else await reg.catch(() => { /* best-effort */ });
  return json({ ok: true });
}

// POST /api/library/record — receiver-side Library entry for DM media the user
// RECEIVED. The blob is already content-addressed on R2 (uploaded by the sender);
// we store the recipient's reference + their decryption material ENCRYPTED TO THEM
// (enc_blob — Vault-style; the server never sees plaintext keys). Makes received
// media cross-device + (opt-in) brain-eligible without weakening E2E.
export async function libraryRecord(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
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
  // Idempotent per (uid, key, received): re-receiving the same blob is a no-op.
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE uid=?1 AND key=?2 AND source_kind='received'").bind(ctx.uid, key).first<any>();
  if (existing) return json({ id: existing.id, deduped: true });
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, enc_blob)
     VALUES (?1,?2,?3,'blossom',?4,?5,?6,?7,?8,?9,?10,?11,'skipped',?12,?13,'received',?14)`,
  ).bind(id, ctx.uid, mediaType(mime), encrypted ? "private" : "public", encrypted, key, display, mime, size, app, Date.now(),
    categoryOf(mime), name, b.enc_blob ?? null).run();
  // PUBLIC received media is brain-eligible server-side; private stays on-device.
  if (!encrypted && env.Q_BRAIN) {
    exec.waitUntil(maybeEmitLibraryBrain(env, ctx.uid, app, { media_id: id, key, mime, size, name, category: categoryOf(mime), visibility: "public" }));
  }
  // Phase 4: received files join the recipient's pool too → recompute + live push.
  exec.waitUntil(afterRegisterFile(env, ctx.uid, { kind: categoryOf(mime), bytes: size, source_app: app, dedup: false }));
  return json({ id });
}

// GET /api/storage — AvaStorage accounting for the bars UI. One universal pool per
// account. Bytes are summed over DISTINCT content keys (shortcuts/copies don't
// double-count), non-deleted only. Quota: free GB from config; over quota draws
// AvaCoins/GB/month from the AvaWallet — an empty wallet over quota = read-only.
export async function getStorage(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  // Distinct-key dedup: one physical copy per key, charged once. We pick a single
  // representative row per key (MIN(id)) then aggregate its category/app/bytes.
  const rs = await mdb.prepare(
    `WITH dedup AS (
       SELECT key, MIN(id) AS rep FROM user_media
       WHERE uid=?1 AND deleted_at IS NULL GROUP BY key
     )
     SELECT COALESCE(m.category,'other') AS category, COALESCE(m.original_app,'avatok') AS app, m.size_bytes AS size
     FROM dedup d JOIN user_media m ON m.id = d.rep`,
  ).bind(ctx.uid).all();
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
      const w = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
      coins = Number(w.body?.balance ?? w.body?.coins ?? w.body?.available ?? 0);
    } catch { /* wallet optional → treat as 0 */ }
    if (coins <= 0) state = "read_only";
  }
  return json({ total_used: total, quota, by_category: byCategory, by_app: byApp, state, free_gb: freeGb });
}

const STUN_FALLBACK = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * Mint short-lived STUN+TURN ICE servers from Cloudflare Calls. Returns the
 * `iceServers` value (array of RTCIceServer) — Cloudflare-STUN-only fallback when
 * TURN isn't configured or the call fails. Shared by GET /ice (1:1 + mesh) and
 * the group-conference token issue (so LiveKit clients can relay via Cloudflare
 * TURN). `ttl` seconds (default 24h). Never throws.
 */
export async function mintIceServers(env: Env, ttl = 86400): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_FALLBACK;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!r.ok) return STUN_FALLBACK;
    const data = (await r.json()) as any;
    const ice = data.iceServers ?? data;
    return Array.isArray(ice) ? ice : [ice];
  } catch {
    return STUN_FALLBACK;
  }
}

// GET /ice — short-lived STUN+TURN credentials from Cloudflare Calls.
export async function getIce(env: Env): Promise<Response> {
  return json({ iceServers: await mintIceServers(env) });
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
export async function brainConsentAllows(env: Env, uid: string, app: string): Promise<boolean> {
  try {
    const caps = [`master`, `${app}_files`];
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (?2,?3)`,
    ).bind(uid, caps[0], caps[1]).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (Number(r.enabled) === 0) return false; // explicit opt-out
    }
    return true; // default ON
  } catch { return false; } // [PRIV-CONSENT-1] D1 error → FAIL CLOSED: a brain_consent
                            // read failure must NOT ingest a possibly-opted-out user's
                            // private content. "Off = nothing captured" must hold even
                            // when the consent table is transiently unreadable (DPDP).
}

// Emit a library_file_added event for content ingestion, gated on consent.
export async function maybeEmitLibraryBrain(
  env: Env, uid: string, app: string,
  payload: { media_id: string; key: string; mime: string; size: number; name: string; category: string; visibility: string },
): Promise<void> {
  if (payload.visibility !== "public") return;            // server ingests PUBLIC only
  if (!(await brainConsentAllows(env, uid, app))) return; // user opted out
  // PAID-ONLY vector/transcribe/embed ingestion (owner decision 2026-06-20):
  // premium (topped-up wallet) users get their library files vectorised into the
  // server RAG so AvaChat can pull them; FREE users are indexed ON-DEVICE by the
  // client (AvaLocalIndex) and synced via their Drive backup — never here. Fail
  // closed: if the balance lookup errors we do NOT vectorise. Same source of
  // truth as lib/premium.ts isPremiumAI (wallet balance .premium === 1).
  try {
    const bal = await walletOp(env, uid, { op: "balance", uid });
    if (Number(bal.body?.premium ?? 0) !== 1) return;
  } catch { return; }
  await env.Q_BRAIN.send({ uid, event_type: "library_file_added", source_app: app, payload });
}

// A sensible display name when the client didn't send one. Extension from mime.
function defaultName(ct: string, hash: string): string {
  const ext = ({
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/aac": "m4a", "application/pdf": "pdf",
  } as Record<string, string>)[ct] || ct.split("/")[1] || "bin";
  return `${categoryOf(ct)}-${hash.slice(0, 8)}.${ext}`;
}
