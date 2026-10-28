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

// ── [HF-FB-LOGIN-1] Verified socials (HF-INTRO-14/15): the accounts she PROVED by logging in, for the reel icons and the "Verified owner of" sheet. ──
export type VerifiedPlatform = "youtube" | "instagram" | "facebook";
export interface VerifiedSocial { platform: VerifiedPlatform; handle: string; url: string; followers?: number }

/** provider_ref values that mean "ownership proven by the platform's own login" (a bio-code or treg check never counts). */
const OAUTH_REFS: Record<VerifiedPlatform, string> = { youtube: "youtube-oauth", instagram: "instagram-oauth", facebook: "facebook-oauth" };
const PLATFORM_ORDER: VerifiedPlatform[] = ["youtube", "instagram", "facebook"];

interface VRow { host_uid: string; platform: string; handle: string; url: string | null; followers: number | null; provider_ref: string | null }

/** Pure shaping of channel rows into verifiedSocials (exported for tests). Keeps only approved-by-login rows, one per platform+handle, YouTube/Instagram/Facebook order. */
export function shapeVerifiedSocials(rows: Omit<VRow, "host_uid">[]): VerifiedSocial[] {
  const seen = new Set<string>();
  const out: VerifiedSocial[] = [];
  for (const r of rows) {
    const platform = String(r.platform || "").toLowerCase() as VerifiedPlatform;
    if (!(platform in OAUTH_REFS) || r.provider_ref !== OAUTH_REFS[platform]) continue;
    const pc = toPublicChannel({ platform, handle: r.handle, url: r.url, followers: r.followers, views: 0, reel_views: 0, last_sync_at: null });
    if (!pc.handle || !pc.url || seen.has(platform + pc.handle)) continue;
    seen.add(platform + pc.handle);
    out.push({ platform, handle: pc.handle, url: pc.url, ...(pc.followers > 0 ? { followers: pc.followers } : {}) });
  }
  return out.sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) || (b.followers ?? 0) - (a.followers ?? 0));
}

/** Verified socials for many hosts in one query: uid -> list. Never throws (a failure means no icons, not a broken feed). */
export async function verifiedSocialsForMany(env: Env, uids: string[]): Promise<Map<string, VerifiedSocial[]>> {
  const out = new Map<string, VerifiedSocial[]>();
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const ph = ids.map((_, i) => `?${i + 1}`).join(",");
    const rows = (await env.DB_META.prepare(
      `SELECT host_uid, platform, handle, url, followers, provider_ref FROM hf_channels
        WHERE host_uid IN (${ph}) AND status='approved' AND verified_at IS NOT NULL AND platform IN ('youtube','instagram','facebook')
          AND provider_ref IN ('youtube-oauth','instagram-oauth','facebook-oauth') ORDER BY followers DESC`,
    ).bind(...ids).all<VRow>()).results ?? [];
    const by = new Map<string, VRow[]>();
    for (const r of rows) { const l = by.get(r.host_uid) ?? []; l.push(r); by.set(r.host_uid, l); }
    for (const [uid, l] of by) out.set(uid, shapeVerifiedSocials(l));
  } catch { /* no icons rather than a broken feed */ }
  return out;
}

/** The one builder every surface uses: [{ platform:'youtube'|'instagram'|'facebook', handle, url, followers? }] for the accounts this host proved by login. */
export async function verifiedSocialsFor(env: Env, uid: string): Promise<VerifiedSocial[]> {
  return (await verifiedSocialsForMany(env, [uid])).get(uid) ?? [];
}
