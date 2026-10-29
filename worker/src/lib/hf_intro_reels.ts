// [HF-INTRO-W1] HF-INTRO-VIDEO-1 D14 / D16 / D18: the Reels feed built from APPROVED intro videos only (flag hfIntroReelsEnabled).
// Used by routes/hf_reels.ts (feed, one reel, saved reels, profile reels) and visibleReel() for likes / comments (reel id = hfin_<20 hex>).
// Visibility (D16): call option A is always shown; option B only while the host is Online (presence online|busy and call_mode online).
// A host without intro_approved_at (every pre-existing influencer until re-approved, D18) is never returned.
import type { Env } from "../types";
import { BRAND, brandUrl } from "./brand";
import { trackException } from "../hooks";
import { mediaUrl } from "./hf_host_store";
import { categoriesFromJson } from "./hf_categories";
import { verifiedSocialsForMany, type VerifiedSocial } from "./hf_public_channels"; // [HF-INTRO-INT] D14: only accounts proven by login
import { mainActionFor, parseCallOption } from "./hf_call_option"; // [HF-INTRO-INT] one button rule for web + app (W2)
import type { PublicCallState } from "./hf_call_contracts";
import { readConfig } from "../routes/config";
import { lineFieldsForUids } from "./hf_host_line_view";
import { INTRO_VIDEO_ID_RE } from "./hf_intro_video";
import { isInfluencer } from "./hf_influencer"; // [HF-INFLUENCER-GATE-1]

export const introReelsOn = (cfg: Record<string, unknown>): boolean => cfg.hfIntroReelsEnabled === true;
export const isIntroReelId = (id: string): boolean => INTRO_VIDEO_ID_RE.test(id);

interface Row {
  id: string; r2_key: string; poster_key: string | null; duration_ms: number; width: number; height: number; lang: string | null; topic: string | null; views: number;
  uid: string; slug: string; display_name: string | null; about: string | null; tagline: string | null; price_per_min: number; presence: string | null; call_option: string;
  categories_json: string | null; women_lane: number | null; intro_approved_at: number; image_key: string | null;
}

const VISIBLE_SQL = `(h.call_option='A' OR (h.call_option='B' AND h.presence IN ('online','busy') AND COALESCE(h.call_mode,'online') NOT IN ('offline','bookings_only')))`;

export function oneLine(about: string | null | undefined, tagline?: string | null): string {
  const t = String(tagline || about || "").replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 117).trimEnd() + "..." : t;
}

/** Pure: the call state a fan sees. A -> appointments (button "Book a time"); B -> the live state (available / on_call / queue_only ...). */
export function introCallState(option: string, presence: string | null, lineState: string | null | undefined): string {
  if (option !== "B") return "appointments";
  if (lineState) return lineState;
  return presence === "busy" ? "on_call" : "available";
}

export interface IntroReelQuery { limit?: number; cursor?: string | null; ids?: string[]; hostUid?: string; ignoreVisibility?: boolean }

export async function introReelItems(env: Env, q: IntroReelQuery = {}): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const limit = Math.min(30, Math.max(1, q.limit ?? 10));
  const cur = q.cursor ? q.cursor.match(/^(\d{1,15})_(hfin_[a-f0-9]{20})$/) : null;
  const binds: unknown[] = [];
  const bind = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  let where = `v.status='approved' AND h.intro_approved_at IS NOT NULL AND h.status='live' AND h.slug IS NOT NULL AND h.call_option IN ('A','B')`;
  if (!q.ignoreVisibility) where += ` AND ${VISIBLE_SQL}`;
  if (q.hostUid) where += ` AND h.uid=${bind(q.hostUid)}`;
  if (q.ids) where += ` AND v.id IN (${q.ids.map((i) => bind(i)).join(",") || "''"})`;
  if (cur) { const at = bind(Number(cur[1])); const id = bind(cur[2]); where += ` AND (h.intro_approved_at < ${at} OR (h.intro_approved_at = ${at} AND v.id < ${id}))`; }
  const rows = (await env.DB_META.prepare(
    `SELECT v.id, v.r2_key, v.poster_key, v.duration_ms, v.width, v.height, v.lang, v.topic, v.views,
            h.uid, h.slug, h.display_name, h.about, h.tagline, h.price_per_min, h.presence, h.call_option, h.categories_json, h.women_lane, h.intro_approved_at,
            COALESCE((SELECT m.r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key
       FROM hf_intro_videos v JOIN hf_hosts h ON h.intro_video_id=v.id LEFT JOIN hf_avatars a ON a.id=h.avatar_id
      WHERE ${where} ORDER BY h.intro_approved_at DESC, v.id DESC LIMIT ${limit + 1}`,
  ).bind(...binds).all<Row>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? `${last.intro_approved_at}_${last.id}` : null;
  const uids = [...new Set(page.map((r) => r.uid))];
  const cfg = (await readConfig(env).catch(() => ({}))) as unknown as Record<string, unknown>;
  const [socialsBy, handleBy, lines] = await Promise.all([verifiedSocialsForMany(env, uids).catch(async (e) => {
    await trackException(env, e, { route: "hf_intro_reels", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_reels", step: "socials" } });
    return new Map<string, VerifiedSocial[]>();
  }), handlesFor(env, uids), lineFieldsForUids(env, uids).catch(async (e) => {
    await trackException(env, e, { route: "hf_intro_reels", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_reels", step: "line_fields" } });
    return null;
  })]);
  const items = page.map((r) => {
    const line = lines?.get(r.uid);
    const socials = socialsBy.get(r.uid) ?? [];
    const handle = handleBy.get(r.uid) ?? (socials[0] ? "@" + socials[0].handle : null);
    const callState = introCallState(r.call_option, r.presence, line?.callState);
    const description = oneLine(r.about, r.tagline);
    const mainAction = mainActionFor({ option: parseCallOption(r.call_option), state: callState as PublicCallState, queueOpen: line?.queue?.open === true, bookingsOn: cfg.hfBookingsEnabled === true });
    const ratePaise = Math.max(0, Math.trunc(Number(r.price_per_min))) * 100;
    const posterUrl = r.poster_key ? mediaUrl(env, r.poster_key) : null;
    const shareUrl = brandUrl(`/r/${r.id}`);
    return {
      id: r.id, kind: "intro", platform: "intro",
      videoUrl: mediaUrl(env, r.r2_key), posterUrl, durationMs: r.duration_ms, width: r.width, height: r.height, lang: r.lang, topic: r.topic,
      host: {
        slug: r.slug, name: r.display_name ?? "", handle, avatar: r.image_key ? mediaUrl(env, r.image_key) : null, ratePaise,
        presence: r.presence === "online" || r.presence === "busy" ? r.presence : "offline", greenTick: true,
        ...(line ? { mode: line.mode, callState: line.callState, queue: line.queue } : {}),
      },
      categories: categoriesFromJson(r.categories_json), description, ratePaise, callOption: r.call_option, callState, mainAction,
      ...(line ? { queue: line.queue } : {}),
      womenOnly: r.women_lane === 1, // [HF-INTRO-INT] the lane flag is what the server enforces
      greenTick: true, socials: socials.map((s) => ({ platform: s.platform, handle: s.handle, url: s.url, ...(s.followers != null ? { followers: s.followers } : {}) })), shareUrl,
      // Old-feed field names so an older client never crashes on an intro item.
      url: shareUrl, embedUrl: null, thumbUrl: posterUrl, title: description, caption: description, likes: 0, comments: 0, views: Number(r.views ?? 0), publishedAt: r.intro_approved_at,
    };
  });
  return { items, nextCursor };
}


async function handlesFor(env: Env, uids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!uids.length) return out;
  try {
    const rows = (await env.DB_META.prepare(`SELECT uid, username FROM hf_user_registration WHERE username IS NOT NULL AND uid IN (${uids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...uids).all<{ uid: string; username: string }>()).results ?? [];
    for (const r of rows) if (r.username) out.set(r.uid, "@" + r.username);
  } catch (e) {
    await trackException(env, e, { route: "hf_intro_reels", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_reels", step: "handles" } });
  }
  return out;
}

/** [HF-INTRO-W1] D18: the host's own intro state for GET /api/hf/me. needsIntroVideo = already an approved/live influencer with no approved intro and nothing waiting for review
 *  (the dashboard shows a banner; no bulk WhatsApp is sent). Never throws: on a read failure the extra fields are simply left out. */
export async function introSelfState(env: Env, uid: string, hostStatus: string | null): Promise<Record<string, unknown> | null> {
  try {
    const h = await env.DB_META.prepare("SELECT call_option, intro_approved_at FROM hf_hosts WHERE uid=?1").bind(uid).first<{ call_option: string | null; intro_approved_at: number | null }>();
    const app = await env.DB_META.prepare("SELECT status, reject_reasons_json, reject_note FROM hf_influencer_applications WHERE uid=?1 ORDER BY submitted_at DESC, id DESC LIMIT 1")
      .bind(uid).first<{ status: string; reject_reasons_json: string | null; reject_note: string | null }>();
    const live = isInfluencer(hostStatus); // [HF-INFLUENCER-GATE-1]
    const approved = !!h?.intro_approved_at;
    return {
      needsIntroVideo: live && !approved && app?.status !== "submitted",
      introStatus: approved ? "approved" : app?.status ?? "none",
      callOption: h?.call_option ?? null,
      introApprovedAt: h?.intro_approved_at ?? null,
      ...(app?.status === "rejected" ? { introRejectReasons: (() => { try { return JSON.parse(app.reject_reasons_json || "[]"); } catch { return []; } })(), introRejectNote: app.reject_note } : {}),
    };
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hf/me", handled: true, app_name: BRAND.slug, extra: { area: "hf_intro_reels", step: "self_state" } });
    return null;
  }
}
