// [SAATHUM-FREEVID-API-1 2026-10-01] Free events + video crop: the small helpers the
// API side shares. Spec: Specs/SPEC-2026-10-01-FREE-EVENTS-VIDEO-CROP.md.
//
// WHY THE FALLBACKS. listings.free_watch and event_videos.crop_* come from
// migrations/2026-10-01-freevid-alters.sql, which the OWNER applies to prod. Until he
// does, a SELECT that names those columns throws "no such column". Every read that needs
// them goes through withNewColumns() (or a helper below) so the missing column degrades to
// free_watch=false / crop=null instead of a 500. The degrade is reported once per isolate
// to PostHog (`freevid_schema_missing`) so it is never silent.
import type { Env } from "../types";
import { track } from "../hooks";
import { cropFromRow, isValidCrop, toCrop, type VideoCrop } from "./video_crop";

const APP = "saathum";

export function isMissingColumnError(e: unknown): boolean {
  const m = String((e as { message?: unknown } | null)?.message ?? e ?? "");
  return /no such column|has no column named|no such table/i.test(m);
}

const reported = new Set<string>();
function reportMissing(env: Env, where: string, e: unknown): void {
  if (reported.has(where)) return;
  reported.add(where);
  try {
    void track(env, "system", "freevid_schema_missing", APP, { where, error: String((e as { message?: unknown } | null)?.message ?? e).slice(0, 200) });
  } catch { /* telemetry is best-effort */ }
}

/** Run `primary` (names the new columns); on a missing-column error run `fallback`. Any other error propagates. */
export async function withNewColumns<T>(env: Env, where: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    reportMissing(env, where, e);
    return fallback();
  }
}

/** listings.free_watch for one listing; false when the column is not migrated yet. */
export async function freeWatchOf(env: Env, listingId: string): Promise<boolean> {
  if (!listingId) return false;
  return withNewColumns(env, "freeWatchOf",
    async () => {
      const r = await env.DB_META.prepare("SELECT free_watch FROM listings WHERE id=?1").bind(listingId).first<{ free_watch: number | null }>();
      return Number(r?.free_watch ?? 0) === 1;
    },
    async () => false,
  );
}

/** Set `free_watch` (0/1) on each card row in place so shapeCard can read it. Batched, no N+1. */
export async function hydrateFreeWatch(env: Env, rows: any[]): Promise<void> {
  const ids = rows.map((r) => String(r?.id ?? "")).filter(Boolean);
  if (!ids.length) return;
  const free = new Set<string>();
  await withNewColumns(env, "hydrateFreeWatch",
    async () => {
      const ph = ids.map((_, i) => `?${i + 1}`).join(",");
      const rs = await env.DB_META.prepare(`SELECT id FROM listings WHERE free_watch=1 AND id IN (${ph})`).bind(...ids).all<{ id: string }>();
      for (const r of rs.results ?? []) free.add(String(r.id));
    },
    async () => undefined,
  );
  for (const r of rows) if (r) r.free_watch = free.has(String(r.id)) ? 1 : 0;
}

/** The crop saved on an event's video, or null (also null when the columns are not migrated yet). */
export async function cropOf(env: Env, listingId: string): Promise<VideoCrop | null> {
  const m = await cropsFor(env, [listingId]);
  return m.get(listingId) ?? null;
}

/** Crops for many listings in one query. Missing column -> empty map. */
export async function cropsFor(env: Env, ids: string[]): Promise<Map<string, VideoCrop>> {
  const out = new Map<string, VideoCrop>();
  if (!ids.length) return out;
  await withNewColumns(env, "cropsFor",
    async () => {
      const ph = ids.map((_, i) => `?${i + 1}`).join(",");
      const rs = await env.DB_META.prepare(
        `SELECT listing_id, crop_x, crop_y, crop_w, crop_h FROM event_videos WHERE listing_id IN (${ph})`,
      ).bind(...ids).all<any>();
      for (const r of rs.results ?? []) {
        const c = cropFromRow(r);
        if (c) out.set(String(r.listing_id), c);
      }
    },
    async () => undefined,
  );
  return out;
}

/**
 * The `crop` field of the admin YouTube save body.
 *   key absent        -> { present:false }            keep whatever is stored
 *   null              -> { present:true, crop:null }  clear (write NULLs)
 *   valid box         -> { present:true, crop }       normalised by toCrop (a full-frame box also clears)
 *   anything else     -> { error:'bad_crop' }         the route answers 400 bad_crop
 */
export function parseCropField(body: Record<string, unknown>): { present: false } | { present: true; crop: VideoCrop | null } | { error: "bad_crop" } {
  if (!Object.prototype.hasOwnProperty.call(body, "crop") || body.crop === undefined) return { present: false };
  if (body.crop === null) return { present: true, crop: null };
  if (!isValidCrop(body.crop)) return { error: "bad_crop" };
  return { present: true, crop: toCrop(body.crop) };
}

export type WatchStreamState = "none" | "live" | "ended";

/**
 * The entitlement-independent half of the watch decision: can a player be shown?
 *   FREE event: a saved video and state live OR ended (replay stays up after the end).
 *   PAID event: state live only (today's rule: no player once ended).
 *   Admin preview: playable as long as a video is saved.
 */
export function isPlayable(a: { free: boolean; hasVideo: boolean; state: WatchStreamState; preview?: boolean }): boolean {
  if (!a.hasVideo) return false;
  if (a.preview) return true;
  return a.free ? a.state === "live" || a.state === "ended" : a.state === "live";
}

/** Whether a free listing's ended stream should be advertised as a replay on live-state. */
export function isReplay(free: boolean, state: WatchStreamState): boolean {
  return free && state === "ended";
}

/** Window inside which a second Play by the same viewer is not counted. */
export const VIEW_RATE_LIMIT_MS = 60_000;

export type ViewOutcome = { counted: boolean; firstView: boolean };

/**
 * Upsert event_video_views, honouring the 60 s per uid+listing limit atomically:
 *   1. UPDATE ... WHERE last_at <= now-60s  (an existing viewer, old enough -> plays+1)
 *   2. INSERT OR IGNORE                      (a brand-new viewer -> first view)
 *   3. neither changed a row                 -> inside the window, ignored (not counted)
 */
export async function recordVideoView(db: D1Database, listingId: string, uid: string, now: number): Promise<ViewOutcome> {
  const upd = await db.prepare(
    "UPDATE event_video_views SET plays=plays+1, last_at=?3 WHERE listing_id=?1 AND uid=?2 AND last_at<=?4",
  ).bind(listingId, uid, now, now - VIEW_RATE_LIMIT_MS).run();
  if ((upd.meta?.changes ?? 0) > 0) return { counted: true, firstView: false };
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO event_video_views (listing_id, uid, first_at, last_at, plays) VALUES (?1,?2,?3,?3,1)",
  ).bind(listingId, uid, now).run();
  if ((ins.meta?.changes ?? 0) > 0) return { counted: true, firstView: true };
  return { counted: false, firstView: false };
}
