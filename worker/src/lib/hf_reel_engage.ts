// [HF-REEL-ENGAGE-API-1] Likes and comments on every reel (HF-REEL-53..57, Specs/HF-REEL-ENGAGE-1.md). Shared helpers:
//   counts   platform number (hf_reels / hf_invite_reels, refreshed by the import) + ours (hf_reel_counts) = total, split always shown (HF-REEL-55)
//   enrich   adds likeCounts / commentCounts / likedByMe to feed, saved and profile items (flag on) and sets the flat likes / comments to the totals
//   pull     YouTube comments, replace-set per reel, on demand (stale > 6 h) and from the daily cron for reels of the last 7 days; 30-day purge
// One way only: nothing here ever writes to YouTube / Instagram (HF-REEL-54).
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { youtubeCommentThreads, youtubeCommentsById } from "./hf_reels_import";
import { instagramCommentsForReel, IG_PROVIDER_REF } from "./hf_instagram"; // [HF-IG-LOGIN-1]

const APP = BRAND.slug;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// [HF-REEL-COMMENTS-ONCE-1] (owner 2026-10-24) Each reel's platform comments are imported ONCE, to start the conversation: a random
// 18-30 of them, stored for good, never refreshed, never deleted. One YouTube call / at most 2 treg calls per reel, ever.
export const SEED_MIN = 18;
export const SEED_MAX = 30;
export const YT_RECHECK_MS = 25 * 24 * 3600 * 1000; // stored YouTube comments are re-checked (free) before YouTube's 30-day limit

export const seedCount = (rand: () => number = Math.random): number => SEED_MIN + Math.floor(Math.min(0.999999, Math.max(0, rand())) * (SEED_MAX - SEED_MIN + 1));
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

const doneKey = (reelId: string) => `hfx:done:${reelId}`; // permanent once imported; 10-minute retry block after a failure
/** True when this reel's one-time import already ran (or failed in the last 10 minutes). A reel that already holds imported rows
 *  (imported before the one-time rule) counts as done and is marked so. */
export async function extImportDone(env: Env, reelId: string): Promise<boolean> {
  try {
    if (await env.TOKENS.get(doneKey(reelId))) return true;
    const have = await env.DB_META.prepare("SELECT 1 AS x FROM hf_reel_ext_comments WHERE reel_id=?1 LIMIT 1").bind(reelId).first();
    if (have) { await env.TOKENS.put(doneKey(reelId), "1"); return true; }
    return false;
  } catch { return true; } // unsure -> do not spend
}

/** Can this platform's comments be pulled here? Only YouTube, through the official Data API (needs YOUTUBE_API_KEY). [HF-CHANNEL-LOGIN-P1]
 *  Instagram comments are no longer imported through treg (HF-REEL-59). */
export function canPullComments(env: Env, platform: string): boolean {
  if (platform === "instagram") return !!(env.HF_TOKEN_ENC_KEY ?? "").trim(); // [HF-IG-LOGIN-1] her stored token is decrypted with this key
  return platform === "youtube" && !!(env.YOUTUBE_API_KEY ?? "").trim();
}

/** [HF-CHANNEL-LOGIN-P1] (HF-REEL-59) May this reel's platform comments be imported at all?
 *  - network reel (hfrl_): only when its channel was connected by login (`hf_channels.provider_ref` ends with `-oauth`), or it is a demo reel
 *    (channel_id NULL, is_demo=1: an admin-pasted YouTube link, official API). Bio-code channels get no imports.
 *  - invite reel (hfiv_): YouTube only, through the official API, behind flag `hfInviteYoutubeComments` (default true).
 *  - Instagram: never through treg. [HF-IG-LOGIN-1] Only a network reel (hfrl_) whose channel was connected by Instagram login
 *    (`provider_ref === "instagram-oauth"`), behind flag `hfInstagramLoginEnabled`, through the Instagram API with Instagram Login. */
export async function importAllowed(env: Env, cfg: Record<string, unknown>, reelId: string, platform: string): Promise<boolean> {
  if (platform === "instagram") {
    if (cfg.hfInstagramLoginEnabled !== true || !reelId.startsWith("hfrl_")) return false;
    try {
      const r = await env.DB_META.prepare("SELECT c.provider_ref AS provider_ref FROM hf_reels r JOIN hf_channels c ON c.id=r.channel_id WHERE r.id=?1").bind(reelId).first<{ provider_ref: string | null }>();
      return r?.provider_ref === IG_PROVIDER_REF;
    } catch { return false; }
  }
  if (platform !== "youtube") return false;
  if (reelId.startsWith("hfiv_")) return cfg.hfInviteYoutubeComments !== false;
  try {
    const r = await env.DB_META.prepare("SELECT r.channel_id AS channel_id, r.is_demo AS is_demo, c.provider_ref AS provider_ref FROM hf_reels r LEFT JOIN hf_channels c ON c.id=r.channel_id WHERE r.id=?1").bind(reelId).first<{ channel_id: string | null; is_demo: number | null; provider_ref: string | null }>();
    if (!r) return false;
    if (!r.channel_id) return Number(r.is_demo ?? 0) === 1;
    return String(r.provider_ref ?? "").endsWith("-oauth");
  } catch { return false; }
}

/** [HF-REEL-COMMENTS-ONCE-1] The one-time import of a reel's platform comments: a random 18-30 (or [want]), inserted, never replaced or
 *  deleted later. Success (even with comments turned off) marks the reel done for good; a failure blocks retries for 10 minutes. Never throws. */
export async function refreshExtComments(env: Env, reelId: string, videoId: string, f: FetchLike = fetch, platform: "youtube" | "instagram" = "youtube", want: number = seedCount()): Promise<{ ok: boolean; count: number; reason: string }> {
  const t0 = Date.now();
  let ok = false, count = 0, reason = "";
  try {
    const pull = platform === "instagram"
      ? { disabled: false, items: await instagramCommentsForReel(env, reelId, want, f) } // [HF-IG-LOGIN-1] her media id + her token
      : await youtubeCommentThreads(env, videoId, f, want);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (const c of pull.items.slice(0, want)) {
      stmts.push(env.DB_META.prepare(
        "INSERT OR IGNORE INTO hf_reel_ext_comments (id, reel_id, platform, author_name, author_avatar, author_url, body, like_count, published_at, fetched_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
      ).bind(c.id, reelId, platform, c.authorName, c.authorAvatar, c.authorUrl, c.body, c.likeCount, c.publishedAt, now));
    }
    if (stmts.length) await env.DB_META.batch(stmts);
    ok = true; count = stmts.length; reason = pull.disabled ? "comments_disabled" : "";
  } catch (e) {
    reason = String((e as { code?: string })?.code ?? (e as Error)?.name ?? "error").slice(0, 60);
    await trackException(env, e, { route: "hf_reel_ext_comments", handled: true, app_name: APP, extra: { area: "hf_reel_engage", reel_id: reelId } });
  }
  try { await env.TOKENS.put(doneKey(reelId), "1", ok ? undefined : { expirationTtl: 600 }); } catch { /* marker is best effort */ }
  await track(env, "server", "hf_reel_ext_comments_fetch", APP, { reel_id: reelId, platform, count, ms: Date.now() - t0, ok, reason });
  return { ok, count, reason };
}

/** Daily cron: the one-time import for new reels (published in the last 7 days) nobody has opened yet, so their sheet opens with
 *  comments. Reels already imported are skipped; nothing is refreshed or purged (HF-REEL-COMMENTS-ONCE-1). */
export async function refreshRecentReelComments(env: Env, cfg: Record<string, unknown>, f: FetchLike = fetch, limit = 40): Promise<{ purged: number; scanned: number; fetched: number }> {
  const out = { purged: 0, scanned: 0, fetched: 0 };
  if (!engageOn(cfg)) return out;
  if (!canPullComments(env, "youtube") && !(cfg.hfInstagramLoginEnabled === true && canPullComments(env, "instagram"))) return out;
  const since = Date.now() - RECENT_REEL_MS;
  let rows: { id: string; platform: string; platform_video_id: string }[] = [];
  const inP = cfg.hfInstagramLoginEnabled === true ? "'youtube','instagram'" : "'youtube'"; // [HF-IG-LOGIN-1]
  try {
    rows = (await env.DB_META.prepare(`SELECT id, platform, platform_video_id FROM hf_reels WHERE platform IN (${inP}) AND visible=1 AND COALESCE(published_at, imported_at)>?1 ORDER BY COALESCE(published_at, imported_at) DESC LIMIT ?2`).bind(since, limit).all<{ id: string; platform: string; platform_video_id: string }>()).results ?? [];
    if (rows.length < limit && cfg.hfInviteReelsEnabled !== false) {
      rows = rows.concat((await env.DB_META.prepare(`SELECT id, platform, platform_video_id FROM hf_invite_reels WHERE platform IN ('youtube') AND COALESCE(published_at, fetched_at)>?1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?2`).bind(since, limit - rows.length).all<{ id: string; platform: string; platform_video_id: string }>()).results ?? []);
    }
  } catch { return out; }
  const dead = new Set<string>();
  for (const r of rows) {
    if (dead.has(r.platform) || !(await importAllowed(env, cfg, r.id, r.platform)) || (await extImportDone(env, r.id))) continue;
    out.scanned++;
    const x = await refreshExtComments(env, r.id, r.platform_video_id, f, r.platform === "instagram" ? "instagram" : "youtube");
    if (x.ok) out.fetched++;
    else if (x.reason === "provider_not_configured") dead.add(r.platform);
  }
  try { out.purged = await recheckYoutubeComments(env); } catch { /* best effort */ }
  return out;
}

/** [HF-REEL-COMMENTS-ONCE-1] Keep the stored YouTube comments within YouTube's rules for free: every ~25 days look the SAME comments up by id
 *  (comments.list, 1 quota unit per 50) — update text / likes, drop any deleted on YouTube unless one of our users replied to it. Never adds
 *  new comments and never calls treg. Returns how many were dropped. */
export async function recheckYoutubeComments(env: Env, f: FetchLike = fetch, batches = 20): Promise<number> {
  if (!(env.YOUTUBE_API_KEY ?? "").trim()) return 0;
  let dropped = 0;
  const now = Date.now();
  for (let b = 0; b < batches; b++) {
    const rows = (await env.DB_META.prepare("SELECT id FROM hf_reel_ext_comments WHERE platform='youtube' AND fetched_at<?1 ORDER BY fetched_at ASC LIMIT 50").bind(now - YT_RECHECK_MS).all<{ id: string }>()).results ?? [];
    if (!rows.length) break;
    const live = await youtubeCommentsById(env, rows.map((r) => r.id.replace(/^youtube:/, "")), f);
    const stmts: D1PreparedStatement[] = [];
    for (const r of rows) {
      const c = live.get(r.id.replace(/^youtube:/, ""));
      if (c) stmts.push(env.DB_META.prepare("UPDATE hf_reel_ext_comments SET body=?2, like_count=?3, fetched_at=?4 WHERE id=?1").bind(r.id, c.body, c.likeCount, now));
      else {
        stmts.push(env.DB_META.prepare("DELETE FROM hf_reel_ext_comments WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM hf_reel_comments oc WHERE oc.parent_id=?1 AND oc.status='visible')").bind(r.id));
        stmts.push(env.DB_META.prepare("UPDATE hf_reel_ext_comments SET fetched_at=?2 WHERE id=?1").bind(r.id, now)); // kept (has our replies): do not re-check every run
        dropped++;
      }
    }
    await env.DB_META.batch(stmts);
  }
  return dropped;
}

/** [HF-REEL-COMMENTS-PREFETCH-1] When the feed is served, run the one-time import (HF-REEL-COMMENTS-ONCE-1) in the background for the reels on
 *  that page that have not had it yet, so their comment sheet opens instantly instead of waiting ~5-13 s on the first open. A short
 *  "pending" marker stops two requests importing the same reel. At most [max] reels per feed page, 3 at a time. Never throws. */
export async function prefetchFeedComments(env: Env, cfg: Record<string, unknown>, items: { id?: unknown; platform?: unknown; platformVideoId?: unknown; url?: unknown }[], max = 6): Promise<number> {
  if (!engageOn(cfg)) return 0;
  const todo: { id: string; platform: "youtube" | "instagram"; vid: string }[] = [];
  for (const it of items) {
    const id = String(it?.id ?? "");
    const platform = it?.platform === "youtube" ? "youtube" : it?.platform === "instagram" ? "instagram" : null; // [HF-IG-LOGIN-1]
    if (!id || !platform || !canPullComments(env, platform) || !(await importAllowed(env, cfg, id, platform))) continue;
    const vid = videoIdOf(platform, String(it?.url ?? ""));
    if (!vid || (await extImportDone(env, id))) continue;
    todo.push({ id, platform, vid });
    if (todo.length >= max) break;
  }
  let done = 0;
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (t) => {
      try { await env.TOKENS.put(doneKey(t.id), "pending", { expirationTtl: 120 }); } catch { /* best effort */ }
      const r = await refreshExtComments(env, t.id, t.vid, fetch, t.platform);
      if (r.ok) done++;
    }));
  }
  return done;
}

/** The platform's video id from the public link we already store (YouTube watch?v= / Instagram /reel/<code>/). */
export function videoIdOf(platform: "youtube" | "instagram", url: string): string | null {
  try {
    const u = new URL(url);
    if (platform === "youtube") { const v = u.searchParams.get("v") ?? (u.hostname.endsWith("youtu.be") ? u.pathname.slice(1) : u.pathname.split("/").filter(Boolean).pop() ?? ""); return /^[A-Za-z0-9_-]{6,20}$/.test(v) ? v : null; }
    const m = u.pathname.match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]{5,20})/);
    return m ? m[1] : null;
  } catch { return null; }
}
