// [HF-CHANNEL-MOBILE-1 2026-10-24] The influencer's connected social channels for the public channel page ("Find me on").
// One row per APPROVED channel: platform, handle, link, followers and views. Counts come from the daily channel re-check
// (recheckAllChannels, ~20 h per channel). YouTube has a real channel total; Instagram/Facebook/TikTok have none, so their
// views are the sum of views on the videos we imported from that channel (viewsKind = 'videos'). Never throws.
import type { Env } from "../types";

export interface PublicChannel {
  platform: string; handle: string; url: string | null; followers: number; views: number;
  viewsKind: "channel" | "videos"; updatedAt: number | null;
}

interface Row { platform: string; handle: string; url: string | null; followers: number | null; views: number | null; reel_views: number | null; last_sync_at: number | null }

const PROFILE_URL: Record<string, (h: string) => string> = {
  instagram: (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`,
  youtube: (h) => `https://www.youtube.com/@${encodeURIComponent(h)}`,
  facebook: (h) => `https://www.facebook.com/${encodeURIComponent(h)}`,
  tiktok: (h) => `https://www.tiktok.com/@${encodeURIComponent(h)}`,
};

export function toPublicChannel(r: Row): PublicChannel {
  const platform = String(r.platform || "").toLowerCase();
  const handle = String(r.handle || "").replace(/^@+/, "");
  const yt = platform === "youtube";
  const url = r.url && /^https:\/\//.test(r.url) ? r.url : PROFILE_URL[platform]?.(handle) ?? null;
  return {
    platform, handle, url,
    followers: Math.max(0, Number(r.followers ?? 0) || 0),
    views: Math.max(0, Number(yt ? r.views : r.reel_views) || 0),
    viewsKind: yt ? "channel" : "videos",
    updatedAt: r.last_sync_at ?? null,
  };
}

export async function publicChannels(env: Env, hostUid: string): Promise<PublicChannel[]> {
  try {
    const rows = (await env.DB_META.prepare(
      `SELECT c.platform, c.handle, c.url, c.followers, c.views, c.last_sync_at,
              (SELECT COALESCE(SUM(r.views),0) FROM hf_reels r WHERE r.channel_id=c.id) AS reel_views
         FROM hf_channels c WHERE c.host_uid=?1 AND c.status='approved' ORDER BY c.followers DESC LIMIT 6`,
    ).bind(hostUid).all<Row>()).results ?? [];
    const seen = new Set<string>();
    return rows.map(toPublicChannel).filter((c) => c.handle && !seen.has(c.platform + c.handle) && seen.add(c.platform + c.handle));
  } catch {
    return [];
  }
}
