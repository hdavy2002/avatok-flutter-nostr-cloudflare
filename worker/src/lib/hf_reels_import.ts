// [HF-WIRE-4] Reels import for the Reels app. [HF-WIRE-14] EMBEDS ONLY (HF-REEL-32): we never store a video file, only details
// (title, description, likes, views, comments, thumbnail url, publish time) next to the official embed url.
//   YouTube   -> official Data API v3: uploads playlist (UU + channel id minus UC, paged 50 at a time) + videos.list. ALL public videos up to N.
//                Works with the API key, or with the influencer's own access token (sign-in connect). embed_url = https://www.youtube.com/embed/<id>.
//   Instagram -> treg gateway, ScrapeCreators user reels. Stores permalink, embed url, thumbnail. The video file url is NOT stored.
// New reels start visible (HF-REEL-33); the influencer can hide any. Re-importing never touches visible. Secrets are never logged or returned.
import type { Env } from "../types";
import { ProviderError, PROVIDER_TIMEOUT_MS } from "./hf_channel_providers";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImportedReel {
  platformVideoId: string; url: string; embedUrl: string; thumbUrl: string | null;
  caption: string; description?: string; likes: number; comments: number; views: number; publishedAt: number | null;
}

export const TREG_IG_REELS = "scrapecreators.x.v1-instagram-user-reels"; // [HF-WIRE-18] verified live 2026-10-19 via the treg catalog: GET /v1/instagram/user/reels, params handle|user_id, max_id, trim; response {items:[{code,caption,like_count,comment_count,play_count,image_versions2,taken_at,...}], max_id}
export const DEFAULT_IMPORT_COUNT = 50;
export const MAX_IMPORT_COUNT = 200;

export function importCountOf(cfg: Record<string, unknown>): number {
  const v = Number(cfg.hfReelsImportCount);
  return Number.isInteger(v) && v >= 1 ? Math.min(v, MAX_IMPORT_COUNT) : DEFAULT_IMPORT_COUNT;
}

async function timedGet(f: FetchLike, url: string, init: RequestInit = {}): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await f(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new ProviderError("provider_unavailable");
    return await res.json();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("provider_unavailable"); // never include the URL (it can carry a key)
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number => Math.max(0, Math.trunc(Number(v ?? 0)) || 0);

/** ISO-8601 duration ("PT1M5S") to seconds; 0 when unreadable. */
export function isoSeconds(d: unknown): number {
  const m = String(d ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return num(m[1]) * 86400 + num(m[2]) * 3600 + num(m[3]) * 60 + num(m[4]);
}

export interface YoutubeAuth { bearer?: string }

function ytHeaders(auth?: YoutubeAuth): Record<string, string> {
  return auth?.bearer ? { accept: "application/json", authorization: `Bearer ${auth.bearer}` } : { accept: "application/json" };
}
function ytKey(env: Pick<Env, "YOUTUBE_API_KEY">, auth?: YoutubeAuth): string {
  const key = (env.YOUTUBE_API_KEY ?? "").trim();
  if (!key && !auth?.bearer) throw new ProviderError("provider_not_configured");
  return key;
}
function ytQuery(params: Record<string, string>, key: string, auth?: YoutubeAuth): string {
  const q = new URLSearchParams(params);
  if (!auth?.bearer && key) q.set("key", key);
  return q.toString();
}

export function toReel(v: any): ImportedReel {
  const id = String(v.id);
  const th = v.snippet?.thumbnails ?? {};
  const pub = Date.parse(String(v.snippet?.publishedAt ?? ""));
  return {
    platformVideoId: id, url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube.com/embed/${id}`,
    thumbUrl: String((th.maxres ?? th.high ?? th.medium ?? th.default)?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    caption: String(v.snippet?.title ?? "").slice(0, 300), description: String(v.snippet?.description ?? "").slice(0, 1000),
    likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
    views: num(v.statistics?.viewCount), publishedAt: Number.isFinite(pub) ? pub : null,
  };
}

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** Details of known video ids (videos.list, 50 per call). Videos that are private or deleted are simply missing from the result. */
export async function youtubeVideoDetails(env: Pick<Env, "YOUTUBE_API_KEY">, ids: string[], f: FetchLike = fetch, auth?: YoutubeAuth): Promise<ImportedReel[]> {
  const key = ytKey(env, auth);
  const clean = [...new Set(ids.filter((x) => YT_ID.test(x)))];
  const out: ImportedReel[] = [];
  for (let i = 0; i < clean.length; i += 50) {
    const vq = ytQuery({ part: "snippet,statistics", id: clean.slice(i, i + 50).join(",") }, key, auth);
    const vs = await timedGet(f, `https://www.googleapis.com/youtube/v3/videos?${vq}`, { headers: ytHeaders(auth) });
    for (const v of Array.isArray(vs?.items) ? vs.items : []) if (v?.id) out.push(toReel(v));
  }
  return out;
}

/** The newest `n` public videos of a channel (all of them, not only Shorts), paged through the uploads playlist. */
export async function youtubeRecent(env: Pick<Env, "YOUTUBE_API_KEY">, channelId: string, n: number, f: FetchLike = fetch, auth?: YoutubeAuth): Promise<ImportedReel[]> {
  const key = ytKey(env, auth);
  if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(channelId)) return [];
  const playlist = "UU" + channelId.slice(2);
  const ids: string[] = [];
  let token = "";
  for (let page = 0; page < 6 && ids.length < n; page++) {
    const pq = ytQuery({ part: "contentDetails", playlistId: playlist, maxResults: String(Math.min(50, n - ids.length)), ...(token ? { pageToken: token } : {}) }, key, auth);
    const pl = await timedGet(f, `https://www.googleapis.com/youtube/v3/playlistItems?${pq}`, { headers: ytHeaders(auth) });
    for (const i of Array.isArray(pl?.items) ? pl.items : []) {
      const id = String(i?.contentDetails?.videoId ?? "");
      if (YT_ID.test(id)) ids.push(id);
    }
    token = typeof pl?.nextPageToken === "string" ? pl.nextPageToken : "";
    if (!token) break;
  }
  if (!ids.length) return [];
  const byId = new Map((await youtubeVideoDetails(env, ids.slice(0, n), f, auth)).map((r) => [r.platformVideoId, r]));
  return ids.slice(0, n).map((id) => byId.get(id)).filter((r): r is ImportedReel => !!r);
}

export async function instagramRecent(env: Pick<Env, "TREG_API_KEY">, handle: string, n: number, f: FetchLike = fetch): Promise<ImportedReel[]> {
  const token = (env.TREG_API_KEY ?? "").trim();
  if (!token) throw new ProviderError("provider_not_configured");
  const h = handle.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h)) return [];
  const q = new URLSearchParams({ handle: h, username: h, trim: "true" });
  const body = await timedGet(f, `https://treg.to/call/${TREG_IG_REELS}?${q.toString()}`, { headers: { "X-Treg-Token": token, accept: "application/json" } });
  const list: any[] = Array.isArray(body?.items) ? body.items : Array.isArray(body?.data?.items) ? body.data.items : [];
  const out: ImportedReel[] = [];
  for (const it of list) {
    const m = it?.media ?? it;
    const code = String(m?.code ?? "");
    if (!/^[A-Za-z0-9_-]{5,20}$/.test(code)) continue;
    const thumb = m?.image_versions2?.candidates?.[0]?.url ?? m?.display_uri ?? m?.thumbnail_url ?? null;
    const cap = typeof m?.caption === "string" ? m.caption : String(m?.caption?.text ?? "");
    const takenAt = Number(m?.taken_at);
    const iso = Date.parse(String(m?.created_at ?? ""));
    out.push({
      platformVideoId: code, url: `https://www.instagram.com/reel/${code}/`, embedUrl: `https://www.instagram.com/reel/${code}/embed`,
      thumbUrl: typeof thumb === "string" && thumb.startsWith("https://") ? thumb : null,
      caption: cap.slice(0, 300), likes: num(m?.like_count), comments: num(m?.comment_count), views: num(m?.play_count ?? m?.ig_play_count ?? m?.view_count),
      publishedAt: Number.isFinite(takenAt) && takenAt > 0 ? takenAt * 1000 : Number.isFinite(iso) ? iso : null,
    });
    if (out.length >= n) break;
  }
  return out;
}

/** Cache the description beside the reel. Best effort: the side table may not be applied yet. */
export async function saveDetails(env: Env, reelId: string, r: ImportedReel, now: number): Promise<void> {
  if (r.description == null) return;
  try {
    await env.DB_META.prepare("INSERT INTO hf_reel_details (reel_id, description, updated_at) VALUES (?1,?2,?3) ON CONFLICT(reel_id) DO UPDATE SET description=excluded.description, updated_at=excluded.updated_at")
      .bind(reelId, r.description, now).run();
  } catch { /* hf_reel_details not applied yet */ }
}

/** Daily refresh of the cached details of demo reels (they have no channel). Needs YOUTUBE_API_KEY; quietly does nothing without it. */
export async function refreshDemoReels(env: Env, batch = 50, f: FetchLike = fetch): Promise<{ scanned: number; updated: number }> {
  const out = { scanned: 0, updated: 0 };
  if (!(env.YOUTUBE_API_KEY ?? "").trim()) return out;
  const rows = (await env.DB_META.prepare("SELECT id, platform_video_id FROM hf_reels WHERE is_demo=1 AND platform='youtube' ORDER BY imported_at ASC LIMIT ?1").bind(batch).all<{ id: string; platform_video_id: string }>()).results ?? [];
  out.scanned = rows.length;
  if (!rows.length) return out;
  const details = new Map((await youtubeVideoDetails(env, rows.map((r) => r.platform_video_id), f)).map((d) => [d.platformVideoId, d]));
  const now = Date.now();
  for (const row of rows) {
    const d = details.get(row.platform_video_id);
    if (!d) continue;
    await env.DB_META.prepare("UPDATE hf_reels SET caption=?2, thumb_url=?3, likes=?4, comments=?5, views=?6, published_at=COALESCE(?7, published_at), video_url=NULL WHERE id=?1")
      .bind(row.id, d.caption, d.thumbUrl, d.likes, d.comments, d.views, d.publishedAt).run();
    await saveDetails(env, row.id, d, now);
    out.updated++;
  }
  return out;
}

export interface ReelChannel { id: string; host_uid: string; platform: string; handle: string; platform_user_id: string | null }
export interface ImportProviders { youtube?: typeof youtubeRecent; instagram?: typeof instagramRecent; auth?: YoutubeAuth }

/** Upsert the latest N videos of one approved channel. Idempotent on (channel_id, platform_video_id); never changes `visible`. */
export async function importChannelReels(env: Env, ch: ReelChannel, n: number, prov: ImportProviders = {}): Promise<{ fetched: number; inserted: number; updated: number }> {
  const list = ch.platform === "youtube"
    ? await (prov.youtube ?? youtubeRecent)(env, ch.platform_user_id ?? "", n, fetch, prov.auth)
    : ch.platform === "instagram" ? await (prov.instagram ?? instagramRecent)(env, ch.handle, n) : [];
  const now = Date.now();
  let inserted = 0;
  let updated = 0;
  for (const r of list) {
    const ex = await env.DB_META.prepare("SELECT id FROM hf_reels WHERE channel_id=?1 AND platform_video_id=?2").bind(ch.id, r.platformVideoId).first<{ id: string }>();
    if (ex) {
      await env.DB_META.prepare("UPDATE hf_reels SET url=?2, embed_url=?3, video_url=NULL, thumb_url=?4, caption=?5, likes=?6, comments=?7, views=?8, published_at=COALESCE(?9, published_at) WHERE id=?1")
        .bind(ex.id, r.url, r.embedUrl, r.thumbUrl, r.caption, r.likes, r.comments, r.views, r.publishedAt).run();
      await saveDetails(env, ex.id, r, now);
      updated++;
    } else {
      const id = "hfrl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      await env.DB_META.prepare(
        "INSERT OR IGNORE INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, url, embed_url, video_url, thumb_url, caption, likes, comments, views, published_at, visible, is_demo, imported_at) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11,?12,?13,1,0,?14)",
      ).bind(id, ch.host_uid, ch.id, ch.platform, r.platformVideoId, r.url, r.embedUrl, r.thumbUrl, r.caption, r.likes, r.comments, r.views, r.publishedAt, now).run();
      await saveDetails(env, id, r, now);
      inserted++;
    }
  }
  return { fetched: list.length, inserted, updated };
}
