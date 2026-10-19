// [HF-WIRE-22] HF-REEL-40: invite reels = reels of creators who are NOT on Hello Fraands yet. Embeds only (HF-REEL-32): details + official embed url,
// never a video file. Sources: exact-handle look-ups, Invite votes, and creators the admin adds. Flag hfInviteReelsEnabled (default true).
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { lookupChannel, ProviderError, type ChannelPlatform, type ChannelLookup } from "./hf_channel_providers";
import { instagramRecent, toReel, isoSeconds, type ImportedReel } from "./hf_reels_import";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const INVITE_REELS_PER_CREATOR = 6;
export const REELS_REFETCH_MS = 6 * 3600 * 1000; // one fetch attempt per creator per 6 h
export const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;
export const SHORT_MAX_S = 60;
export type InviteSource = "search" | "vote" | "admin";

export interface InviteCreatorRow {
  platform: string; handle: string; platform_user_id: string | null; display_name: string | null; avatar_url: string | null; followers: number;
  last_lookup_at: number; source: string; hidden: number; reels_fetched_at: number | null; created_at: number;
}

/** Is the invite feature on? (default true when the key is absent) */
export const inviteReelsOn = (cfg: Record<string, unknown>) => cfg.hfInviteReelsEnabled !== false;

/** True when this creator has since joined: an approved channel with the same platform + handle (or platform user id). */
export async function hasJoined(env: Env, platform: string, handle: string, platformUserId?: string | null): Promise<boolean> {
  const row = await env.DB_META.prepare(
    "SELECT 1 AS x FROM hf_channels WHERE platform=?1 AND status='approved' AND (LOWER(REPLACE(handle,'@',''))=?2 OR (?3 IS NOT NULL AND platform_user_id=?3)) LIMIT 1",
  ).bind(platform, handle, platformUserId ?? null).first();
  return !!row;
}

export interface CreatorSeed { platform: ChannelPlatform; handle: string; source: InviteSource; followers?: number; platformUserId?: string | null; name?: string | null; avatar?: string | null }

/** Insert or touch a creator. Never un-hides, never downgrades an admin-added creator's source. Returns false when the creator is already on the network. */
export async function upsertInviteCreator(env: Env, s: CreatorSeed, now = Date.now()): Promise<boolean> {
  if (await hasJoined(env, s.platform, s.handle, s.platformUserId)) return false;
  await env.DB_META.prepare(
    `INSERT INTO hf_invite_creators (platform, handle, platform_user_id, display_name, avatar_url, followers, last_lookup_at, source, hidden, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?7)
     ON CONFLICT(platform, handle) DO UPDATE SET
       last_lookup_at=excluded.last_lookup_at,
       platform_user_id=COALESCE(excluded.platform_user_id, platform_user_id),
       display_name=COALESCE(NULLIF(excluded.display_name,''), display_name),
       avatar_url=COALESCE(excluded.avatar_url, avatar_url),
       followers=CASE WHEN excluded.followers>0 THEN excluded.followers ELSE followers END,
       source=CASE WHEN source='admin' THEN 'admin' ELSE excluded.source END`,
  ).bind(s.platform, s.handle, s.platformUserId ?? null, s.name ?? null, s.avatar ?? null, Math.max(0, Math.trunc(s.followers ?? 0)), now, s.source).run();
  return true;
}

/** Up to n recent YouTube videos, Shorts (<= 60 s) first, then the most recent others to fill. One playlistItems call + one videos.list call. */
export async function youtubeInviteReels(env: Pick<Env, "YOUTUBE_API_KEY">, channelId: string, n: number, f: FetchLike = fetch): Promise<ImportedReel[]> {
  const key = (env.YOUTUBE_API_KEY ?? "").trim();
  if (!key) throw new ProviderError("provider_not_configured");
  if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(channelId)) return [];
  const get = async (url: string) => {
    const res = await f(url, { headers: { accept: "application/json" } }).catch(() => { throw new ProviderError("provider_unavailable"); });
    if (!res.ok) throw new ProviderError("provider_unavailable");
    return res.json().catch(() => { throw new ProviderError("provider_unavailable"); }) as Promise<any>;
  };
  const pq = new URLSearchParams({ part: "contentDetails", playlistId: "UU" + channelId.slice(2), maxResults: "25", key });
  const pl = await get(`https://www.googleapis.com/youtube/v3/playlistItems?${pq}`);
  const ids = (Array.isArray(pl?.items) ? pl.items : []).map((i: any) => String(i?.contentDetails?.videoId ?? "")).filter((x: string) => /^[A-Za-z0-9_-]{6,20}$/.test(x));
  if (!ids.length) return [];
  const vq = new URLSearchParams({ part: "snippet,statistics,contentDetails", id: ids.join(","), key });
  const vs = await get(`https://www.googleapis.com/youtube/v3/videos?${vq}`);
  const byId = new Map<string, any>((Array.isArray(vs?.items) ? vs.items : []).filter((v: any) => v?.id).map((v: any) => [String(v.id), v]));
  const ordered = ids.map((i: string) => byId.get(i)).filter(Boolean);
  const isShort = (v: any) => { const s = isoSeconds(v.contentDetails?.duration); return s > 0 && s <= SHORT_MAX_S; };
  const pick = [...ordered.filter(isShort), ...ordered.filter((v: any) => !isShort(v))].slice(0, n);
  return pick.map(toReel);
}

export interface FetchProviders { lookup?: typeof lookupChannel; youtube?: typeof youtubeInviteReels; instagram?: typeof instagramRecent; f?: FetchLike }

/** Fetch + store this creator's reels. Rate-limited by reels_fetched_at unless force. Never throws on provider trouble. Returns the number stored. */
export async function fetchInviteReels(env: Env, platform: string, handle: string, opts: { force?: boolean; now?: number } & FetchProviders = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const c = await env.DB_META.prepare("SELECT * FROM hf_invite_creators WHERE platform=?1 AND handle=?2").bind(platform, handle).first<InviteCreatorRow>();
  if (!c || c.hidden === 1) return 0;
  if (!opts.force && c.reels_fetched_at && now - c.reels_fetched_at < REELS_REFETCH_MS) return 0;
  await env.DB_META.prepare("UPDATE hf_invite_creators SET reels_fetched_at=?3 WHERE platform=?1 AND handle=?2").bind(platform, handle, now).run(); // stamp first: a failure still waits 6 h
  try {
    let uid = c.platform_user_id;
    let lk: ChannelLookup | null = null;
    if (platform === "youtube" && !uid) {
      lk = await (opts.lookup ?? lookupChannel)(env, "youtube", handle, opts.f);
      if (!lk.exists) return 0;
      uid = lk.platformUserId;
    }
    if (lk?.exists) {
      await env.DB_META.prepare("UPDATE hf_invite_creators SET platform_user_id=COALESCE(?3,platform_user_id), display_name=COALESCE(NULLIF(?4,''),display_name), avatar_url=COALESCE(?5,avatar_url), followers=CASE WHEN ?6>0 THEN ?6 ELSE followers END WHERE platform=?1 AND handle=?2")
        .bind(platform, handle, lk.platformUserId, lk.displayName ?? null, lk.avatarUrl ?? null, lk.followers).run();
      if (await hasJoined(env, platform, handle, lk.platformUserId)) { await removeInviteCreator(env, platform, handle); return 0; }
    }
    const list = platform === "youtube"
      ? await (opts.youtube ?? youtubeInviteReels)(env, uid ?? "", INVITE_REELS_PER_CREATOR, opts.f)
      : await (opts.instagram ?? instagramRecent)(env, handle, INVITE_REELS_PER_CREATOR, opts.f);
    return await storeInviteReels(env, platform, handle, list, now);
  } catch (e) {
    if (e instanceof ProviderError) return 0;
    throw e;
  }
}

/** Upsert on (platform, platform_video_id) and drop this creator's reels that are no longer among the newest. Details only: no video file url exists in this table. */
export async function storeInviteReels(env: Env, platform: string, handle: string, list: ImportedReel[], now = Date.now()): Promise<number> {
  const keep: string[] = [];
  for (const r of list.slice(0, INVITE_REELS_PER_CREATOR)) {
    if (!r.embedUrl || !r.platformVideoId) continue;
    const id = "hfiv_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.DB_META.prepare(
      `INSERT INTO hf_invite_reels (id, platform, handle, platform_video_id, url, embed_url, thumb_url, caption, likes, comments, views, published_at, fetched_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(platform, platform_video_id) DO UPDATE SET handle=excluded.handle, url=excluded.url, embed_url=excluded.embed_url, thumb_url=excluded.thumb_url,
         caption=excluded.caption, likes=excluded.likes, comments=excluded.comments, views=excluded.views, published_at=COALESCE(excluded.published_at, published_at), fetched_at=excluded.fetched_at`,
    ).bind(id, platform, handle, r.platformVideoId, r.url, r.embedUrl, r.thumbUrl, r.caption, r.likes, r.comments, r.views, r.publishedAt, now).run();
    keep.push(r.platformVideoId);
  }
  if (keep.length) {
    const ph = keep.map((_, i) => `?${i + 3}`).join(",");
    await env.DB_META.prepare(`DELETE FROM hf_invite_reels WHERE platform=?1 AND handle=?2 AND platform_video_id NOT IN (${ph})`).bind(platform, handle, ...keep).run();
  }
  return keep.length;
}

/** Remove a creator and their reels (they joined, or the prune window passed). */
export async function removeInviteCreator(env: Env, platform: string, handle: string): Promise<void> {
  await env.DB_META.prepare("DELETE FROM hf_invite_reels WHERE platform=?1 AND handle=?2").bind(platform, handle).run();
  await env.DB_META.prepare("DELETE FROM hf_invite_creators WHERE platform=?1 AND handle=?2").bind(platform, handle).run();
}

/** Called from search (exact handle found) and from a vote: remember the creator and fetch reels in the background (ctx) or inline (no ctx). Flag-gated. */
export async function noteInviteCreator(env: Env, cfg: Record<string, unknown>, seed: CreatorSeed, ctx?: { waitUntil(p: Promise<unknown>): void }, prov: FetchProviders = {}): Promise<void> {
  if (!inviteReelsOn(cfg)) return;
  try {
    if (!(await upsertInviteCreator(env, seed))) return;
    const job = fetchInviteReels(env, seed.platform, seed.handle, prov).catch(() => 0);
    if (ctx) ctx.waitUntil(job); else await job;
  } catch { /* tables not applied yet: invite reels are optional */ }
}

/** Daily cron: refresh stats + reels of a few stale creators, drop the ones that joined, prune 30-day-idle ones (no votes, no searches). */
export async function refreshInviteCreators(env: Env, batch = 15, prov: FetchProviders = {}, now = Date.now()): Promise<{ scanned: number; refreshed: number; joined: number; pruned: number }> {
  const out = { scanned: 0, refreshed: 0, joined: 0, pruned: 0 };
  const cfg = (await readConfig(env).catch(() => null)) as unknown as Record<string, unknown> | null;
  if (!cfg || !inviteReelsOn(cfg)) return out;
  const rows = (await env.DB_META.prepare(
    "SELECT * FROM hf_invite_creators WHERE reels_fetched_at IS NULL OR reels_fetched_at < ?1 ORDER BY COALESCE(reels_fetched_at,0) ASC LIMIT ?2",
  ).bind(now - 20 * 3600 * 1000, batch).all<InviteCreatorRow>()).results ?? [];
  for (const c of rows) {
    out.scanned++;
    if (await hasJoined(env, c.platform, c.handle, c.platform_user_id)) { await removeInviteCreator(env, c.platform, c.handle); out.joined++; continue; }
    const votes = Number((await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_invite_votes WHERE platform=?1 AND handle=?2").bind(c.platform, c.handle).first<{ n: number }>())?.n ?? 0);
    if (c.source !== "admin" && c.hidden !== 1 && votes === 0 && c.last_lookup_at < now - PRUNE_AFTER_MS) { await removeInviteCreator(env, c.platform, c.handle); out.pruned++; continue; }
    if (c.hidden === 1) continue;
    try {
      const lk = await (prov.lookup ?? lookupChannel)(env, c.platform as ChannelPlatform, c.handle, prov.f);
      if (lk.exists) {
        await env.DB_META.prepare("UPDATE hf_invite_creators SET platform_user_id=COALESCE(?3,platform_user_id), display_name=COALESCE(NULLIF(?4,''),display_name), avatar_url=COALESCE(?5,avatar_url), followers=?6 WHERE platform=?1 AND handle=?2")
          .bind(c.platform, c.handle, lk.platformUserId, lk.displayName ?? null, lk.avatarUrl ?? null, lk.followers).run();
        if (await hasJoined(env, c.platform, c.handle, lk.platformUserId)) { await removeInviteCreator(env, c.platform, c.handle); out.joined++; continue; }
      }
      await fetchInviteReels(env, c.platform, c.handle, { ...prov, force: true, now });
      out.refreshed++;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "provider_not_configured") break;
    }
  }
  return out;
}
