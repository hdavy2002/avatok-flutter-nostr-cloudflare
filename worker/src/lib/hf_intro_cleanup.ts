// [HF-INTRO-DELETE-1 2026-10-28] Intro-video file clean-up (rulebook section 20, HF-INTRO-DEL-*).
// An intro video and its poster live in the PUBLIC media bucket (BLOBS, immutable cache) under intro-video/<uid>/. A file must not outlive the
// decision that made it useless: a rejected video, a replaced (older approved) video and a draft nobody submitted are deleted from storage.
// The DB row stays (it is the record of the decision) with deleted_at set and the keys cleared.
//   deleteIntroVideoFiles -> used by reject / approve / re-record paths (never throws; a failed delete leaves the keys so the sweep retries)
//   sweepIntroVideos      -> daily (hf_retention.ts): rows still holding files + drafts older than 7 days + weekly orphan check of intro-video/
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { mediaUrl } from "./hf_host_store";

const DAY_MS = 86_400_000;
export const INTRO_DRAFT_DAYS = 7;
export const INTRO_ORPHAN_GRACE_MS = DAY_MS; // an upload younger than this may be mid-flight (object written, row not yet)
const SWEEP_BATCH = 50;
const ORPHAN_PAGES_PER_RUN = 5;
const ORPHAN_DELETES_PER_RUN = 200;
const IN_CHUNK = 40;

export type IntroDeleteReason = "rejected" | "replaced" | "draft_replaced" | "draft_expired" | "orphan";

export interface IntroFileRow { id: string; uid: string; r2_key: string; poster_key: string | null; bytes: number }

/** Best-effort CDN purge of public URLs. Only runs when the zone credentials exist (CF_ZONE_ID + CF_PURGE_TOKEN); otherwise the
 *  deletion itself is the control (the origin returns 404 once the object is gone, edge copies age out). Never throws. */
export async function purgeIntroCdn(env: Env, keys: string[]): Promise<"purged" | "skipped" | "failed"> {
  const e = env as unknown as { CF_ZONE_ID?: string; CF_PURGE_TOKEN?: string };
  if (!e.CF_ZONE_ID || !e.CF_PURGE_TOKEN || !keys.length) return "skipped";
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${e.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${e.CF_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: keys.map((k) => mediaUrl(env, k)) }),
    });
    return r.ok ? "purged" : "failed";
  } catch {
    return "failed";
  }
}

/** Delete the video + poster of one row from R2, then mark the row (deleted_at, keys cleared). Returns true when the files are gone. */
export async function deleteIntroVideoFiles(env: Env, row: IntroFileRow, reason: IntroDeleteReason, opts: { newStatus?: string } = {}): Promise<boolean> {
  const keys = [row.r2_key, row.poster_key].filter((k): k is string => !!k);
  try {
    for (const k of keys) await env.BLOBS.delete(k);
  } catch (e) {
    await trackException(env, e, { uid: row.uid, route: "hf_intro_cleanup", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_cleanup", step: "r2_delete", reason } }).catch(() => undefined);
    return false;
  }
  const now = Date.now();
  try {
    await env.DB_META.prepare(
      `UPDATE hf_intro_videos SET deleted_at=?2, deleted_reason=?3, r2_key='', poster_key=NULL${opts.newStatus ? ", status=?4" : ""}, updated_at=?2 WHERE id=?1`,
    ).bind(...[row.id, now, reason, ...(opts.newStatus ? [opts.newStatus] : [])]).run();
  } catch (e) {
    // Files are already gone; the row keeps its old keys, so the sweep deletes (no-op) and marks it on its next pass.
    await trackException(env, e, { uid: row.uid, route: "hf_intro_cleanup", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_cleanup", step: "mark_row", reason } }).catch(() => undefined);
  }
  const purge = await purgeIntroCdn(env, keys);
  await track(env, row.uid, "hf_intro_video_deleted", BRAND.slug, { area: "hf_intro_cleanup", reason, bytes: row.bytes, video_id: row.id, files: keys.length, cdn_purge: purge }).catch(() => undefined);
  return true;
}

export interface IntroSweepResult { rejected: number; replaced: number; expired: number; orphans: number; errors: number; more: boolean }

const ROW_COLS = "id, uid, r2_key, poster_key, bytes";

/** Daily sweep. Safe to run when the table / column is missing (returns zeros). */
export async function sweepIntroVideos(env: Env, now = Date.now()): Promise<IntroSweepResult> {
  const out: IntroSweepResult = { rejected: 0, replaced: 0, expired: 0, orphans: 0, errors: 0, more: false };
  const cols = (await env.DB_META.prepare("SELECT name FROM pragma_table_info('hf_intro_videos')").all<{ name: string }>().catch(() => ({ results: [] as { name: string }[] }))).results ?? [];
  if (!cols.some((c) => c.name === "deleted_at")) return out;

  // 1. Rejected / replaced rows that still hold files (the delete failed at decision time, or they pre-date this clean-up).
  for (const status of ["rejected", "replaced"] as const) {
    const rows = (await env.DB_META.prepare(`SELECT ${ROW_COLS} FROM hf_intro_videos WHERE status=?1 AND deleted_at IS NULL AND r2_key<>'' LIMIT ${SWEEP_BATCH + 1}`).bind(status).all<IntroFileRow>()).results ?? [];
    if (rows.length > SWEEP_BATCH) out.more = true;
    for (const r of rows.slice(0, SWEEP_BATCH)) {
      if (await deleteIntroVideoFiles(env, r, status)) out[status]++; else out.errors++;
    }
  }
  // 2. Drafts never submitted within 7 days.
  const drafts = (await env.DB_META.prepare(`SELECT ${ROW_COLS} FROM hf_intro_videos WHERE status='draft' AND deleted_at IS NULL AND created_at < ?1 LIMIT ${SWEEP_BATCH + 1}`)
    .bind(now - INTRO_DRAFT_DAYS * DAY_MS).all<IntroFileRow>()).results ?? [];
  if (drafts.length > SWEEP_BATCH) out.more = true;
  for (const r of drafts.slice(0, SWEEP_BATCH)) {
    if (await deleteIntroVideoFiles(env, r, "draft_expired", { newStatus: "expired" })) out.expired++; else out.errors++;
  }
  // 3. Weekly orphan check.
  const o = await orphanCheck(env, now).catch(async (e) => {
    out.errors++;
    await trackException(env, e, { route: "hf_intro_cleanup", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_cleanup", step: "orphan_check" } }).catch(() => undefined);
    return { deleted: 0, more: false };
  });
  out.orphans = o.deleted;
  if (o.more) out.more = true;
  return out;
}

/** Once a week: list intro-video/ and delete objects no row points to (older than one day). Resumes from a KV cursor across days. */
export async function orphanCheck(env: Env, now = Date.now()): Promise<{ deleted: number; more: boolean }> {
  const week = Math.floor(now / (7 * DAY_MS));
  const doneKey = `hf_intro_orphans:${week}`;
  const cursorKey = "hf_intro_orphans:cursor";
  if (await env.TOKENS.get(doneKey)) return { deleted: 0, more: false };
  let cursor: string | undefined = (await env.TOKENS.get(cursorKey)) || undefined;
  let deleted = 0;
  let complete = false;
  for (let page = 0; page < ORPHAN_PAGES_PER_RUN; page++) {
    const l = await env.BLOBS.list({ prefix: "intro-video/", cursor, limit: 500 });
    const objs = l.objects.filter((x) => now - new Date(x.uploaded).getTime() > INTRO_ORPHAN_GRACE_MS);
    const known = new Set<string>();
    for (let i = 0; i < objs.length; i += IN_CHUNK) {
      const ks = objs.slice(i, i + IN_CHUNK).map((x) => x.key);
      const ph = ks.map((_, n) => `?${n + 1}`).join(",");
      const r = await env.DB_META.prepare(`SELECT r2_key AS k FROM hf_intro_videos WHERE r2_key IN (${ph}) UNION SELECT poster_key AS k FROM hf_intro_videos WHERE poster_key IN (${ph})`).bind(...ks).all<{ k: string }>();
      for (const x of r.results ?? []) known.add(x.k);
    }
    for (const ob of objs) {
      if (known.has(ob.key) || deleted >= ORPHAN_DELETES_PER_RUN) continue;
      const uid = ob.key.split("/")[1] ?? "unknown";
      try {
        await env.BLOBS.delete(ob.key);
        deleted++;
        await purgeIntroCdn(env, [ob.key]);
        await track(env, uid, "hf_intro_video_deleted", BRAND.slug, { area: "hf_intro_cleanup", reason: "orphan", bytes: ob.size, key_kind: ob.key.includes("-poster-") ? "poster" : "video" }).catch(() => undefined);
      } catch { /* retried next week */ }
    }
    if (!l.truncated) { complete = true; cursor = undefined; break; }
    cursor = l.cursor;
    if (deleted >= ORPHAN_DELETES_PER_RUN) break;
  }
  if (complete) {
    await env.TOKENS.delete(cursorKey).catch(() => undefined);
    await env.TOKENS.put(doneKey, "1", { expirationTtl: 8 * 24 * 3600 });
    return { deleted, more: false };
  }
  if (cursor) await env.TOKENS.put(cursorKey, cursor, { expirationTtl: 8 * 24 * 3600 });
  return { deleted, more: true };
}
