// [SAATHUM-FREEVIDEOS-API-1 2026-10-01] Free videos — a section separate from events.
// Spec: Specs/SPEC-2026-10-01-FREE-VIDEOS.md. Table: migrations/2026-10-01-free-videos.sql.
//
// Public (index.ts -> freeVideosRoute):
//   GET  /api/free-videos?limit=12&category=   published cards (never youtube id / source url)
//   GET  /api/free-videos/:id                  one published card
//   GET  /api/free-videos/:id/watch            signed-in (email only) -> the video id + crop
//   POST /api/free-videos/:id/view             signed-in; counts a view (60 s throttle)
// Admin (admin2 route table, ADMIN2_FREE_VIDEO_ROUTES):
//   GET/POST /api/admin/v2/free-videos, GET/PUT/DELETE /api/admin/v2/free-videos/:id
//
// Until the migration is applied the table is missing: the public list answers { items: [] }
// and every other route answers 503 free_videos_unavailable (reported, never a bare 500).
// The DB functions below take a D1Database so they are tested against real SQLite.
import type { Env } from "../types";
import { json } from "../util";
import { trackException, trackUser } from "../hooks";
import { requireUser, isFail } from "../authz";
import { emailFor } from "../lib/identity";
import { isAdminUid } from "../lib/admin_calendar_exempt";
import { parseYoutubeVideoId } from "../lib/me_dashboard_logic";
import { cropFromRow, isValidCrop, toCrop, type VideoCrop } from "../lib/video_crop";
import { isMissingColumnError, recordVideoView } from "../lib/freevid_compat";
import { requireAdmin } from "./admin_money";
import type { Admin2RouteDef } from "./admin2"; // type only: admin2.ts imports this file, a value import would be circular

// Same guard + error shape as admin2.ts adminGuard/admin2Err (copied, not imported: see above).
const admin2Err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
async function adminGuard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? admin2Err(403, "admin_only", "You don't have admin access.") : admin2Err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

const APP = "saathum";

export const FREE_VIDEO_CATEGORIES = ["satsang", "meditation", "sermon", "bhajan", "aarti", "festival"] as const;
export type FreeVideoCategory = (typeof FREE_VIDEO_CATEGORIES)[number];
export const FREE_VIDEO_CATEGORY_LABELS: Record<FreeVideoCategory, string> = {
  satsang: "Satsang", meditation: "Meditation", sermon: "Sermon", bhajan: "Bhajan", aarti: "Aarti", festival: "Festival",
};
export type FreeVideoStatus = "draft" | "published" | "archived";
const STATUSES: FreeVideoStatus[] = ["draft", "published", "archived"];

export interface FreeVideoRow {
  id: string; title: string; description: string; category: string; cover_url: string | null;
  youtube_video_id: string; source_url: string | null;
  crop_x: number | null; crop_y: number | null; crop_w: number | null; crop_h: number | null;
  status: string; sort_order: number; is_live: number; live_checked_at: number | null;
  created_at: number; updated_at: number; published_at: number | null; admin_uid: string | null;
}

export interface PublicCard {
  id: string; title: string; description: string; category: string; category_label: string;
  cover_url: string; is_live: boolean; published_at: number | null;
}

const COLS = `id, title, description, category, cover_url, youtube_video_id, source_url, crop_x, crop_y, crop_w, crop_h,
  status, sort_order, is_live, live_checked_at, created_at, updated_at, published_at, admin_uid`;

export const ytThumbnail = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

/** The public card. Deliberately built field by field: it must NEVER carry youtube_video_id or source_url. */
export function toCard(r: FreeVideoRow): PublicCard {
  const cat = r.category as FreeVideoCategory;
  return {
    id: r.id, title: r.title, description: r.description ?? "", category: r.category,
    category_label: FREE_VIDEO_CATEGORY_LABELS[cat] ?? r.category,
    cover_url: r.cover_url || ytThumbnail(r.youtube_video_id),
    is_live: Number(r.is_live) === 1, published_at: r.published_at ?? null,
  };
}

/** Admin shape: the card + everything the form needs. `cover_url` is the UPLOADED cover (null = thumbnail). */
export function toAdminShape(r: FreeVideoRow, views?: { viewers: number; plays: number }) {
  return {
    id: r.id, title: r.title, description: r.description ?? "", category: r.category,
    category_label: FREE_VIDEO_CATEGORY_LABELS[r.category as FreeVideoCategory] ?? r.category,
    cover_url: r.cover_url ?? null, card_cover_url: r.cover_url || ytThumbnail(r.youtube_video_id),
    youtube_video_id: r.youtube_video_id, youtube_url: r.source_url || `https://www.youtube.com/watch?v=${r.youtube_video_id}`,
    crop: cropFromRow(r), status: r.status, sort_order: r.sort_order, is_live: Number(r.is_live) === 1,
    published_at: r.published_at ?? null, created_at: r.created_at, updated_at: r.updated_at,
    viewers: views?.viewers ?? 0, plays: views?.plays ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------
export interface FreeVideoInput {
  title?: string; description?: string; category?: FreeVideoCategory; cover_url?: string | null;
  youtube_video_id?: string; source_url?: string; crop?: VideoCrop | null; status?: FreeVideoStatus; sort_order?: number;
}
export type Invalid = { error: string; message: string; field: string };

/** `partial` = PUT (every field optional; crop absent keeps, null clears). Create requires title, category, youtube_url. */
export function validateFreeVideoInput(b: Record<string, unknown>, partial: boolean): { ok: true; value: FreeVideoInput } | { ok: false; invalid: Invalid } {
  const bad = (error: string, message: string, field: string) => ({ ok: false as const, invalid: { error, message, field } });
  const v: FreeVideoInput = {};
  if (!partial || b.title !== undefined) {
    const t = typeof b.title === "string" ? b.title.trim() : "";
    if (t.length < 3 || t.length > 120) return bad("invalid_title", "Title must be 3 to 120 characters.", "title");
    v.title = t;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") return bad("invalid_description", "Description must be text.", "description");
    const d = b.description.trim();
    if (d.length > 600) return bad("invalid_description", "Description can be at most 600 characters.", "description");
    v.description = d;
  }
  if (!partial || b.category !== undefined) {
    if (typeof b.category !== "string" || !(FREE_VIDEO_CATEGORIES as readonly string[]).includes(b.category)) {
      return bad("bad_category", `Category must be one of: ${FREE_VIDEO_CATEGORIES.join(", ")}.`, "category");
    }
    v.category = b.category as FreeVideoCategory;
  }
  if (b.cover_url !== undefined) {
    if (b.cover_url === null || b.cover_url === "") v.cover_url = null;
    else if (typeof b.cover_url === "string" && b.cover_url.length <= 500 && /^https:\/\/[^\s]+$/i.test(b.cover_url.trim())) v.cover_url = b.cover_url.trim();
    else return bad("invalid_cover_url", "Cover must be an https image link (or empty to use the YouTube thumbnail).", "cover_url");
  }
  if (!partial || b.youtube_url !== undefined) {
    const raw = typeof b.youtube_url === "string" ? b.youtube_url.trim() : "";
    const id = raw ? parseYoutubeVideoId(raw) : null;
    if (!id) return bad("invalid_youtube_url", "Paste a YouTube video or live link (or the 11-character video id).", "youtube_url");
    v.youtube_video_id = id;
    v.source_url = raw.slice(0, 500);
  }
  if (Object.prototype.hasOwnProperty.call(b, "crop") && b.crop !== undefined) {
    if (b.crop === null) v.crop = null;
    else if (isValidCrop(b.crop)) v.crop = toCrop(b.crop);
    else return bad("bad_crop", "The crop box is not valid — x, y, w, h must be fractions of the frame (w and h at least 0.05, inside the frame).", "crop");
  }
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !STATUSES.includes(b.status as FreeVideoStatus) || (!partial && b.status === "archived")) {
      return bad("bad_status", partial ? "Status must be draft, published or archived." : "Status must be draft or published.", "status");
    }
    v.status = b.status as FreeVideoStatus;
  }
  if (b.sort_order !== undefined) {
    if (typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order) || Math.abs(b.sort_order) > 1_000_000) return bad("invalid_sort_order", "Sort order must be a whole number.", "sort_order");
    v.sort_order = b.sort_order;
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// DB functions (take a D1Database; tested against SQLite)
// ---------------------------------------------------------------------------
export function newFreeVideoId(): string {
  return "fv_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function listPublicCards(db: D1Database, opts: { limit: number; category?: string | null }): Promise<PublicCard[]> {
  const cat = opts.category || null;
  const rs = await db.prepare(
    `SELECT ${COLS} FROM free_videos WHERE status='published' AND (?1 IS NULL OR category=?1)
      ORDER BY is_live DESC, sort_order ASC, published_at DESC LIMIT ?2`,
  ).bind(cat, opts.limit).all<FreeVideoRow>();
  return (rs.results ?? []).map(toCard);
}

export async function getRow(db: D1Database, id: string): Promise<FreeVideoRow | null> {
  return (await db.prepare(`SELECT ${COLS} FROM free_videos WHERE id=?1`).bind(id).first<FreeVideoRow>()) ?? null;
}

export async function createFreeVideo(db: D1Database, v: FreeVideoInput, adminUid: string, now: number): Promise<FreeVideoRow> {
  const id = newFreeVideoId();
  const status = v.status ?? "draft";
  const c = v.crop ?? null;
  await db.prepare(
    `INSERT INTO free_videos (id, title, description, category, cover_url, youtube_video_id, source_url, crop_x, crop_y, crop_w, crop_h,
       status, sort_order, is_live, created_at, updated_at, published_at, admin_uid)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,?14,?14,?15,?16)`,
  ).bind(id, v.title, v.description ?? "", v.category, v.cover_url ?? null, v.youtube_video_id, v.source_url ?? null,
    c?.x ?? null, c?.y ?? null, c?.w ?? null, c?.h ?? null, status, v.sort_order ?? 0, now, status === "published" ? now : null, adminUid).run();
  return (await getRow(db, id))!;
}

/** Partial update. Returns null when the row does not exist. A new video id resets is_live (the cron re-checks it). */
export async function updateFreeVideo(db: D1Database, id: string, v: FreeVideoInput, adminUid: string, now: number): Promise<FreeVideoRow | null> {
  const cur = await getRow(db, id);
  if (!cur) return null;
  const sets: string[] = []; const binds: unknown[] = [id];
  const set = (col: string, val: unknown) => { binds.push(val); sets.push(`${col}=?${binds.length}`); };
  if (v.title !== undefined) set("title", v.title);
  if (v.description !== undefined) set("description", v.description);
  if (v.category !== undefined) set("category", v.category);
  if (v.cover_url !== undefined) set("cover_url", v.cover_url);
  if (v.youtube_video_id !== undefined) {
    set("youtube_video_id", v.youtube_video_id); set("source_url", v.source_url ?? null);
    if (v.youtube_video_id !== cur.youtube_video_id) { set("is_live", 0); set("live_checked_at", null); }
  }
  if (v.crop !== undefined) { set("crop_x", v.crop?.x ?? null); set("crop_y", v.crop?.y ?? null); set("crop_w", v.crop?.w ?? null); set("crop_h", v.crop?.h ?? null); }
  if (v.sort_order !== undefined) set("sort_order", v.sort_order);
  if (v.status !== undefined) {
    set("status", v.status);
    if (v.status === "published" && cur.published_at == null) set("published_at", now);
  }
  set("updated_at", now); set("admin_uid", adminUid);
  await db.prepare(`UPDATE free_videos SET ${sets.join(", ")} WHERE id=?1`).bind(...binds).run();
  return getRow(db, id);
}

export async function archiveFreeVideo(db: D1Database, id: string, adminUid: string, now: number): Promise<boolean> {
  const r = await db.prepare(`UPDATE free_videos SET status='archived', updated_at=?2, admin_uid=?3 WHERE id=?1`).bind(id, now, adminUid).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function viewCounts(db: D1Database, ids: string[]): Promise<Map<string, { viewers: number; plays: number }>> {
  const out = new Map<string, { viewers: number; plays: number }>();
  if (!ids.length) return out;
  try {
    const ph = ids.map((_, i) => `?${i + 1}`).join(",");
    const rs = await db.prepare(
      `SELECT listing_id, COUNT(*) AS viewers, COALESCE(SUM(plays),0) AS plays FROM event_video_views WHERE listing_id IN (${ph}) GROUP BY listing_id`,
    ).bind(...ids).all<{ listing_id: string; viewers: number; plays: number }>();
    for (const r of rs.results ?? []) out.set(String(r.listing_id), { viewers: Number(r.viewers), plays: Number(r.plays) });
  } catch (e) { if (!isMissingColumnError(e)) throw e; } // views table not migrated: zeros
  return out;
}

export async function listAdmin(db: D1Database): Promise<ReturnType<typeof toAdminShape>[]> {
  const rs = await db.prepare(`SELECT ${COLS} FROM free_videos ORDER BY (status='archived') ASC, created_at DESC LIMIT 500`).all<FreeVideoRow>();
  const rows = rs.results ?? [];
  const views = await viewCounts(db, rows.map((r) => r.id));
  return rows.map((r) => toAdminShape(r, views.get(r.id)));
}

// ---------------------------------------------------------------------------
// Live badge — cron
// ---------------------------------------------------------------------------
/**
 * Refresh is_live for published free videos from the YouTube Data API (videos.list, part=snippet,
 * snippet.liveBroadcastContent === 'live'). Batches of 50 ids. YOUTUBE_API_KEY unset -> nothing
 * runs and is_live stays as is (0 for every new row). A failed batch leaves its rows untouched.
 * Never throws (the cron tick must not fail); table missing is expected before the migration.
 */
export async function refreshFreeVideoLive(env: Env, fetchFn: typeof fetch = fetch): Promise<{ checked: number; live: number; api: "ok" | "skipped" | "error" }> {
  const apiKey = (env.YOUTUBE_API_KEY ?? "").trim();
  if (!apiKey) return { checked: 0, live: 0, api: "skipped" };
  const db = env.DB_META;
  let rows: { id: string; youtube_video_id: string }[] = [];
  try {
    rows = (await db.prepare(`SELECT id, youtube_video_id FROM free_videos WHERE status='published' LIMIT 500`).all<{ id: string; youtube_video_id: string }>()).results ?? [];
  } catch (e) {
    if (!isMissingColumnError(e)) await trackException(env, e, { route: "free_videos:live_query", handled: true, app_name: APP });
    return { checked: 0, live: 0, api: "ok" };
  }
  let api: "ok" | "error" = "ok"; let checked = 0; let liveCount = 0;
  const now = Date.now();
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    try {
      const ids = [...new Set(batch.map((b) => b.youtube_video_id))].join(",");
      const res = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) { api = "error"; continue; }
      const data = await res.json() as { items?: { id: string; snippet?: { liveBroadcastContent?: string } }[] };
      const liveIds = new Set((data.items ?? []).filter((it) => it.snippet?.liveBroadcastContent === "live").map((it) => it.id));
      for (const b of batch) {
        const live = liveIds.has(b.youtube_video_id) ? 1 : 0;
        if (live) liveCount++;
        await db.prepare(`UPDATE free_videos SET is_live=?2, live_checked_at=?3 WHERE id=?1`).bind(b.id, live, now).run();
        checked++;
      }
    } catch (e) {
      api = "error";
      await trackException(env, e, { route: "free_videos:live_refresh", handled: true, app_name: APP });
    }
  }
  return { checked, live: liveCount, api };
}

// ---------------------------------------------------------------------------
// HTTP — public
// ---------------------------------------------------------------------------
const CACHE_60 = { "cache-control": "public, max-age=60" };
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);

async function unavailable(env: Env, e: unknown, route: string): Promise<Response> {
  await trackException(env, e, { route, handled: true, app_name: APP, extra: { missing_table: isMissingColumnError(e) } });
  return err(503, "free_videos_unavailable", "Free videos are not available right now.");
}

export async function freeVideosList(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const limitN = Number(q.get("limit") ?? 12);
  const limit = Number.isFinite(limitN) ? Math.min(50, Math.max(1, Math.floor(limitN))) : 12;
  const category = q.get("category") || null;
  if (category && !(FREE_VIDEO_CATEGORIES as readonly string[]).includes(category)) return err(400, "bad_category", "Unknown category.", { field: "category" });
  try {
    return json({ items: await listPublicCards(env.DB_META, { limit, category }) }, 200, CACHE_60);
  } catch (e) {
    if (isMissingColumnError(e)) {
      await trackException(env, e, { route: "free_videos:list", handled: true, app_name: APP, extra: { missing_table: true } });
      return json({ items: [] }, 200, { "cache-control": "public, max-age=15" });
    }
    return unavailable(env, e, "free_videos:list");
  }
}

export async function freeVideoGet(_req: Request, env: Env, id: string): Promise<Response> {
  try {
    const r = await getRow(env.DB_META, id);
    if (!r || r.status !== "published") return err(404, "not_found", "No such video.");
    return json({ video: toCard(r) }, 200, CACHE_60);
  } catch (e) { return unavailable(env, e, "free_videos:get"); }
}

/** Signed-in only (email sign-in; NO WhatsApp gate). The only place the video id leaves the server. */
export async function freeVideoWatch(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  try {
    const r = await getRow(env.DB_META, id);
    const admin = isAdminUid(env, auth.uid);
    if (!r || (r.status !== "published" && !admin)) return err(404, "not_found", "No such video.");
    return json({ ok: true, id: r.id, youtube_video_id: r.youtube_video_id, crop: cropFromRow(r), is_live: Number(r.is_live) === 1 }, 200, NO_STORE);
  } catch (e) { return unavailable(env, e, "free_videos:watch"); }
}

export async function freeVideoView(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  let r: FreeVideoRow | null;
  try { r = await getRow(env.DB_META, id); } catch (e) { return unavailable(env, e, "free_videos:view"); }
  const admin = isAdminUid(env, auth.uid);
  if (!r || (r.status !== "published" && !admin)) return err(404, "not_found", "No such video.");
  if (r.status !== "published") return json({ ok: true, counted: false, preview: true }, 200, NO_STORE); // admin looking at a draft: not a view
  let out;
  try { out = await recordVideoView(env.DB_META, id, auth.uid, Date.now()); } catch (e) { return unavailable(env, e, "free_videos:view_record"); }
  if (!out.counted) return json({ ok: true, counted: false, throttled: true }, 200, NO_STORE);
  const email = await emailFor(env, auth.uid).catch(() => null);
  await trackUser(env, auth.uid, email, "saathum_video_view", APP, { listing_id: id, free: true, kind: "free_video", first_view: out.firstView, email });
  return json({ ok: true, counted: true, first_view: out.firstView }, 200, NO_STORE);
}

/** Dispatcher for /api/free-videos[/...]. Returns null when the path is not ours. */
export async function freeVideosRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p === "/api/free-videos") return req.method === "GET" ? freeVideosList(req, env) : null;
  const m = /^\/api\/free-videos\/([^/]+)(\/watch|\/view)?$/.exec(p);
  if (!m) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]); } catch { return err(404, "not_found", "No such video."); }
  if (!id || id.length > 100) return err(404, "not_found", "No such video.");
  if (!m[2]) return req.method === "GET" ? freeVideoGet(req, env, id) : null;
  if (m[2] === "/watch") return req.method === "GET" ? freeVideoWatch(req, env, id) : null;
  return req.method === "POST" ? freeVideoView(req, env, id) : null;
}

// ---------------------------------------------------------------------------
// HTTP — admin (admin2 guard)
// ---------------------------------------------------------------------------
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > 8192) return null;
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

async function adminTel(env: Env, uid: string, props: Record<string, unknown>): Promise<void> {
  const email = await emailFor(env, uid).catch(() => null);
  await trackUser(env, uid, email, "free_video_admin_saved", APP, props).catch(() => undefined);
}

const adminUnavailable = async (env: Env, e: unknown, route: string) => {
  await trackException(env, e, { route, handled: true, app_name: APP, extra: { missing_table: isMissingColumnError(e) } });
  return admin2Err(503, "free_videos_unavailable", "Free videos are not available yet (database update pending).");
};

async function adminList(req: Request, env: Env): Promise<Response> {
  const g = await adminGuard(req, env); if (g instanceof Response) return g;
  try { return json({ items: await listAdmin(env.DB_META) }, 200, NO_STORE); } catch (e) { return adminUnavailable(env, e, "free_videos:admin_list"); }
}

async function adminGet(req: Request, env: Env, id: string): Promise<Response> {
  const g = await adminGuard(req, env); if (g instanceof Response) return g;
  try {
    const r = await getRow(env.DB_META, id);
    if (!r) return admin2Err(404, "not_found", "No such video.");
    const views = await viewCounts(env.DB_META, [id]);
    return json({ video: toAdminShape(r, views.get(id)) }, 200, NO_STORE);
  } catch (e) { return adminUnavailable(env, e, "free_videos:admin_get"); }
}

async function adminCreate(req: Request, env: Env): Promise<Response> {
  const g = await adminGuard(req, env); if (g instanceof Response) return g;
  const b = await readBody(req);
  if (!b) return admin2Err(400, "invalid_request", "Send a JSON object.");
  const v = validateFreeVideoInput(b, false);
  if (!v.ok) return admin2Err(400, v.invalid.error, v.invalid.message, { field: v.invalid.field });
  try {
    const row = await createFreeVideo(env.DB_META, v.value, g.uid, Date.now());
    await adminTel(env, g.uid, { id: row.id, action: "create", status: row.status, category: row.category, has_cover: !!row.cover_url, has_crop: cropFromRow(row) != null });
    return json({ ok: true, video: toAdminShape(row) }, 201, NO_STORE);
  } catch (e) { return adminUnavailable(env, e, "free_videos:admin_create"); }
}

async function adminUpdate(req: Request, env: Env, id: string): Promise<Response> {
  const g = await adminGuard(req, env); if (g instanceof Response) return g;
  const b = await readBody(req);
  if (!b) return admin2Err(400, "invalid_request", "Send a JSON object.");
  const v = validateFreeVideoInput(b, true);
  if (!v.ok) return admin2Err(400, v.invalid.error, v.invalid.message, { field: v.invalid.field });
  try {
    const row = await updateFreeVideo(env.DB_META, id, v.value, g.uid, Date.now());
    if (!row) return admin2Err(404, "not_found", "No such video.");
    await adminTel(env, g.uid, { id, action: "update", status: row.status, category: row.category, has_cover: !!row.cover_url, has_crop: cropFromRow(row) != null, fields: Object.keys(v.value) });
    return json({ ok: true, video: toAdminShape(row) }, 200, NO_STORE);
  } catch (e) { return adminUnavailable(env, e, "free_videos:admin_update"); }
}

async function adminArchive(req: Request, env: Env, id: string): Promise<Response> {
  const g = await adminGuard(req, env); if (g instanceof Response) return g;
  try {
    if (!(await archiveFreeVideo(env.DB_META, id, g.uid, Date.now()))) return admin2Err(404, "not_found", "No such video.");
    await adminTel(env, g.uid, { id, action: "archive", status: "archived" });
    return json({ ok: true, id, status: "archived" }, 200, NO_STORE);
  } catch (e) { return adminUnavailable(env, e, "free_videos:admin_archive"); }
}

const ID = "([^/]+)";
export const ADMIN2_FREE_VIDEO_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/free-videos", handler: (req, env) => adminList(req, env) },
  { method: "POST", path: "/api/admin/v2/free-videos", handler: (req, env) => adminCreate(req, env) },
  { method: "GET", path: new RegExp(`^/api/admin/v2/free-videos/${ID}$`), handler: (req, env, [id]) => adminGet(req, env, id) },
  { method: "PUT", path: new RegExp(`^/api/admin/v2/free-videos/${ID}$`), handler: (req, env, [id]) => adminUpdate(req, env, id) },
  { method: "DELETE", path: new RegExp(`^/api/admin/v2/free-videos/${ID}$`), handler: (req, env, [id]) => adminArchive(req, env, id) },
];
