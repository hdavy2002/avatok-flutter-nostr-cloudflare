// [HF-WIRE-4] Reels import for the Reels app (HF-REEL-26/27). Pulls the latest N videos of an approved channel into hf_reels.
//   YouTube   -> official Data API v3: uploads playlist (UU + channel id minus UC) + videos.list. Shorts are kept when detectable (duration <= 180 s);
//                when none are, the latest videos are kept. embed_url = https://www.youtube.com/embed/<id>.
//   Instagram -> treg gateway, ScrapeCreators user reels. Stores permalink, embed url, thumbnail and the video file url. The Instagram CDN url is SIGNED AND
//                EXPIRES: it is refreshed by every import run (the daily recheck) and the app must fall back to the embed when it fails.
// New reels start hidden (visible=0); the influencer picks which go on the feed. Re-importing never touches visible. Secrets are never logged or returned.
import type { Env } from "../types";
import { ProviderError, PROVIDER_TIMEOUT_MS } from "./hf_channel_providers";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImportedReel {
  platformVideoId: string; url: string; embedUrl: string; videoUrl: string | null; thumbUrl: string | null;
  caption: string; likes: number; comments: number; views: number; publishedAt: number | null;
}

export const TREG_IG_REELS = "scrapecreators.instagram.user.reels"; // treg publishes no schema: name follows its catalog naming (see HF-TREG-JEV-RESEARCH.md)
export const DEFAULT_IMPORT_COUNT = 20;
export const MAX_IMPORT_COUNT = 50;
const SHORT_MAX_SECONDS = 180;

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

export async function youtubeRecent(env: Pick<Env, "YOUTUBE_API_KEY">, channelId: string, n: number, f: FetchLike = fetch): Promise<ImportedReel[]> {
  const key = (env.YOUTUBE_API_KEY ?? "").trim();
  if (!key) throw new ProviderError("provider_not_configured");
  if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(channelId)) return [];
  const playlist = "UU" + channelId.slice(2);
  const pq = new URLSearchParams({ part: "contentDetails", playlistId: playlist, maxResults: String(Math.min(50, n * 2)), key });
  const pl = await timedGet(f, `https://www.googleapis.com/youtube/v3/playlistItems?${pq.toString()}`, { headers: { accept: "application/json" } });
  const ids: string[] = (Array.isArray(pl?.items) ? pl.items : []).map((i: any) => String(i?.contentDetails?.videoId ?? "")).filter((x: string) => /^[A-Za-z0-9_-]{6,20}$/.test(x));
  if (!ids.length) return [];
  const vq = new URLSearchParams({ part: "snippet,contentDetails,statistics", id: ids.join(","), key });
  const vs = await timedGet(f, `https://www.googleapis.com/youtube/v3/videos?${vq.toString()}`, { headers: { accept: "application/json" } });
  const items: any[] = Array.isArray(vs?.items) ? vs.items : [];
  const rows = items.map((v) => ({ v, secs: isoSeconds(v?.contentDetails?.duration) })).filter((x) => x.v?.id);
  const shorts = rows.filter((x) => x.secs > 0 && x.secs <= SHORT_MAX_SECONDS);
  const chosen = (shorts.length ? shorts : rows).slice(0, n);
  return chosen.map(({ v }) => {
    const id = String(v.id);
    const th = v.snippet?.thumbnails ?? {};
    const pub = Date.parse(String(v.snippet?.publishedAt ?? ""));
    return {
      platformVideoId: id, url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube.com/embed/${id}`, videoUrl: null,
      thumbUrl: String((th.maxres ?? th.high ?? th.medium ?? th.default)?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
      caption: String(v.snippet?.title ?? "").slice(0, 300), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
      views: num(v.statistics?.viewCount), publishedAt: Number.isFinite(pub) ? pub : null,
    };
  });
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
    const video = m?.video_versions?.[0]?.url ?? m?.video_url ?? null;
    const thumb = m?.image_versions2?.candidates?.[0]?.url ?? m?.display_uri ?? m?.thumbnail_url ?? null;
    const cap = typeof m?.caption === "string" ? m.caption : String(m?.caption?.text ?? "");
    const takenAt = Number(m?.taken_at);
    const iso = Date.parse(String(m?.created_at ?? ""));
    out.push({
      platformVideoId: code, url: `https://www.instagram.com/reel/${code}/`, embedUrl: `https://www.instagram.com/reel/${code}/embed`,
      videoUrl: typeof video === "string" && video.startsWith("https://") ? video : null,
      thumbUrl: typeof thumb === "string" && thumb.startsWith("https://") ? thumb : null,
      caption: cap.slice(0, 300), likes: num(m?.like_count), comments: num(m?.comment_count), views: num(m?.play_count ?? m?.ig_play_count ?? m?.view_count),
      publishedAt: Number.isFinite(takenAt) && takenAt > 0 ? takenAt * 1000 : Number.isFinite(iso) ? iso : null,
    });
    if (out.length >= n) break;
  }
  return out;
}

export interface ReelChannel { id: string; host_uid: string; platform: string; handle: string; platform_user_id: string | null }
export interface ImportProviders { youtube?: typeof youtubeRecent; instagram?: typeof instagramRecent }

/** Upsert the latest N videos of one approved channel. Idempotent on (channel_id, platform_video_id); never changes `visible`. */
export async function importChannelReels(env: Env, ch: ReelChannel, n: number, prov: ImportProviders = {}): Promise<{ fetched: number; inserted: number; updated: number }> {
  const list = ch.platform === "youtube"
    ? await (prov.youtube ?? youtubeRecent)(env, ch.platform_user_id ?? "", n)
    : ch.platform === "instagram" ? await (prov.instagram ?? instagramRecent)(env, ch.handle, n) : [];
  const now = Date.now();
  let inserted = 0;
  let updated = 0;
  for (const r of list) {
    const ex = await env.DB_META.prepare("SELECT id FROM hf_reels WHERE channel_id=?1 AND platform_video_id=?2").bind(ch.id, r.platformVideoId).first<{ id: string }>();
    if (ex) {
      await env.DB_META.prepare("UPDATE hf_reels SET url=?2, embed_url=?3, video_url=?4, thumb_url=?5, caption=?6, likes=?7, comments=?8, views=?9, published_at=COALESCE(?10, published_at) WHERE id=?1")
        .bind(ex.id, r.url, r.embedUrl, r.videoUrl, r.thumbUrl, r.caption, r.likes, r.comments, r.views, r.publishedAt).run();
      updated++;
    } else {
      const id = "hfrl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      await env.DB_META.prepare(
        "INSERT OR IGNORE INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, url, embed_url, video_url, thumb_url, caption, likes, comments, views, published_at, visible, is_demo, imported_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,0,?15)",
      ).bind(id, ch.host_uid, ch.id, ch.platform, r.platformVideoId, r.url, r.embedUrl, r.videoUrl, r.thumbUrl, r.caption, r.likes, r.comments, r.views, r.publishedAt, now).run();
      inserted++;
    }
  }
  return { fetched: list.length, inserted, updated };
}
