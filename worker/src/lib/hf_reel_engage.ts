// [HF-REEL-ENGAGE-API-1] Likes and comments on every reel (HF-REEL-53..57, Specs/HF-REEL-ENGAGE-1.md). Shared helpers:
//   counts   platform number (hf_reels / hf_invite_reels, refreshed by the import) + ours (hf_reel_counts) = total, split always shown (HF-REEL-55)
//   enrich   adds likeCounts / commentCounts / likedByMe to feed, saved and profile items (flag on) and sets the flat likes / comments to the totals
//   pull     YouTube comments, replace-set per reel, on demand (stale > 6 h) and from the daily cron for reels of the last 7 days; 30-day purge
// One way only: nothing here ever writes to YouTube / Instagram (HF-REEL-54).
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { youtubeCommentThreads } from "./hf_reels_import";

const APP = BRAND.slug;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const EXT_FRESH_SEC = 6 * 3600; // an imported set younger than this is not pulled again
export const EXT_KEEP_MS = 30 * 24 * 3600 * 1000; // imported comment not refreshed for this long is deleted
export const RECENT_REEL_MS = 7 * 24 * 3600 * 1000; // the cron refreshes comments of reels published in this window

export const engageOn = (cfg: Record<string, unknown>): boolean => cfg.hfReelsEnabled === true && cfg.hfReelEngageEnabled === true;
export function hideAtOf(cfg: Record<string, unknown>): number {
  const n = Math.floor(Number(cfg.hfReelCommentHideAt ?? 3));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 3;
}
export function maxLenOf(cfg: Record<string, unknown>): number {
  const n = Math.floor(Number(cfg.hfReelCommentMaxLen ?? 500));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 2000) : 500;
}

export interface Split { platform: number; ours: number; total: number }
export const split = (platform: unknown, ours: unknown): Split => {
  const p = Math.max(0, Math.trunc(Number(platform ?? 0)) || 0);
  const o = Math.max(0, Math.trunc(Number(ours ?? 0)) || 0);
  return { platform: p, ours: o, total: p + o };
};

const chunks = <T,>(a: T[], n = 50): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** Our side of the counts for many reels. Missing rows / table not applied -> zeros. */
export async function ourCounts(env: Env, ids: string[]): Promise<Map<string, { likes: number; comments: number }>> {
  const out = new Map<string, { likes: number; comments: number }>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = (await env.DB_META.prepare(`SELECT reel_id, likes, comments FROM hf_reel_counts WHERE reel_id IN (${part.map((_, i) => `?${i + 1}`).join(",")})`).bind(...part).all<{ reel_id: string; likes: number; comments: number }>()).results ?? [];
    for (const r of rows) out.set(r.reel_id, { likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0) });
  }
  return out;
}

export async function likedSet(env: Env, uid: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = (await env.DB_META.prepare(`SELECT reel_id FROM hf_reel_likes WHERE uid=?1 AND reel_id IN (${part.map((_, i) => `?${i + 2}`).join(",")})`).bind(uid, ...part).all<{ reel_id: string }>()).results ?? [];
    for (const r of rows) out.add(r.reel_id);
  }
  return out;
}

/** Flag on: add `likeCounts`, `commentCounts`, `likedByMe` (only when a signed-in uid is known) and set the flat `likes` / `comments` to the totals. Flag off or tables missing: items untouched. */
export async function enrichItems(env: Env, cfg: Record<string, unknown>, items: any[], uid?: string | null): Promise<void> {
  if (!engageOn(cfg) || !items.length) return;
  try {
    const ids = items.map((i) => String(i?.id ?? "")).filter(Boolean);
    const [counts, liked] = await Promise.all([ourCounts(env, ids), uid ? likedSet(env, uid, ids) : Promise.resolve(null)]);
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const c = counts.get(String(it.id));
      const l = split(it.likes, c?.likes);
      const m = split(it.comments, c?.comments);
      it.likeCounts = l; it.commentCounts = m; it.likes = l.total; it.comments = m.total;
      if (liked) it.likedByMe = liked.has(String(it.id));
    }
  } catch { /* hf_reel_counts not applied yet: leave the plain platform numbers */ }
}

/** Recount our side from the source rows (self-healing, idempotent). Use inside the same batch() as the like / comment write. */
export function recountStmt(env: Env, reelId: string, now: number): D1PreparedStatement {
  return env.DB_META.prepare(
    `INSERT INTO hf_reel_counts (reel_id, likes, comments, updated_at)
     VALUES (?1, (SELECT COUNT(*) FROM hf_reel_likes WHERE reel_id=?1), (SELECT COUNT(*) FROM hf_reel_comments WHERE reel_id=?1 AND status='visible'), ?2)
     ON CONFLICT(reel_id) DO UPDATE SET likes=excluded.likes, comments=excluded.comments, updated_at=excluded.updated_at`,
  ).bind(reelId, now);
}

const freshKey = (reelId: string) => `hfx:fresh:${reelId}`;
export async function extIsFresh(env: Env, reelId: string): Promise<boolean> {
  try { return !!(await env.TOKENS.get(freshKey(reelId))); } catch { return false; }
}

/** Pull one YouTube video's comments and REPLACE the stored set (a comment deleted on YouTube disappears here). Never throws. */
export async function refreshExtComments(env: Env, reelId: string, videoId: string, f: FetchLike = fetch): Promise<{ ok: boolean; count: number; reason: string }> {
  const t0 = Date.now();
  let ok = false, count = 0, reason = "";
  try {
    const pull = await youtubeCommentThreads(env, videoId, f);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [env.DB_META.prepare("DELETE FROM hf_reel_ext_comments WHERE reel_id=?1").bind(reelId)];
    for (const c of pull.items) {
      stmts.push(env.DB_META.prepare(
        "INSERT OR REPLACE INTO hf_reel_ext_comments (id, reel_id, platform, author_name, author_avatar, author_url, body, like_count, published_at, fetched_at) VALUES (?1,?2,'youtube',?3,?4,?5,?6,?7,?8,?9)",
      ).bind(c.id, reelId, c.authorName, c.authorAvatar, c.authorUrl, c.body, c.likeCount, c.publishedAt, now));
    }
    await env.DB_META.batch(stmts);
    ok = true; count = pull.items.length; reason = pull.disabled ? "comments_disabled" : "";
  } catch (e) {
    reason = String((e as { code?: string })?.code ?? (e as Error)?.name ?? "error").slice(0, 60);
    await trackException(env, e, { route: "hf_reel_ext_comments", handled: true, app_name: APP, extra: { area: "hf_reel_engage", reel_id: reelId } });
  }
  try { await env.TOKENS.put(freshKey(reelId), "1", { expirationTtl: ok ? EXT_FRESH_SEC : 600 }); } catch { /* marker is best effort */ }
  await track(env, "server", "hf_reel_ext_comments_fetch", APP, { reel_id: reelId, platform: "youtube", count, ms: Date.now() - t0, ok, reason });
  return { ok, count, reason };
}

/** Daily cron: delete imported comments not refreshed for 30 days (always), then refresh YouTube comments of reels published in the last 7 days (flag on). */
export async function refreshRecentReelComments(env: Env, cfg: Record<string, unknown>, f: FetchLike = fetch, limit = 40): Promise<{ purged: number; scanned: number; fetched: number }> {
  const out = { purged: 0, scanned: 0, fetched: 0 };
  try {
    const r = await env.DB_META.prepare("DELETE FROM hf_reel_ext_comments WHERE fetched_at<?1").bind(Date.now() - EXT_KEEP_MS).run();
    out.purged = Number(r.meta?.changes ?? 0);
  } catch { /* table not applied yet */ }
  if (!engageOn(cfg) || !(env.YOUTUBE_API_KEY ?? "").trim()) return out;
  const since = Date.now() - RECENT_REEL_MS;
  let rows: { id: string; platform_video_id: string }[] = [];
  try {
    rows = (await env.DB_META.prepare("SELECT id, platform_video_id FROM hf_reels WHERE platform='youtube' AND visible=1 AND COALESCE(published_at, imported_at)>?1 ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?2").bind(since, limit).all<{ id: string; platform_video_id: string }>()).results ?? [];
    if (rows.length < limit && cfg.hfInviteReelsEnabled !== false) {
      rows = rows.concat((await env.DB_META.prepare("SELECT id, platform_video_id FROM hf_invite_reels WHERE platform='youtube' AND COALESCE(published_at, fetched_at)>?1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?2").bind(since, limit - rows.length).all<{ id: string; platform_video_id: string }>()).results ?? []);
    }
  } catch { return out; }
  for (const r of rows) {
    out.scanned++;
    const x = await refreshExtComments(env, r.id, r.platform_video_id, f);
    if (x.ok) out.fetched++;
    else if (x.reason === "provider_not_configured") break;
  }
  return out;
}
