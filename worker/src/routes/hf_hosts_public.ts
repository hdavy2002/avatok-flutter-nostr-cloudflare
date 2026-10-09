// [HF-HOST-PLATFORM-1] Public HF host cards. Flag hostsPublicEnabled. Only status='live'. Never exposes uid, KYC, phone, or an unapproved voice intro.
//   GET /api/hosts/public?limit=&offset=   GET /api/hosts/public/:slug
import type { Env } from "../types";
import { json } from "../util";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { parseIntroCaption } from "../lib/hf_intro";
import { mediaUrl, mediaToJson, type HostRow, type MediaRow } from "../lib/hf_host_store";

const CACHE = { "cache-control": "public, max-age=60" };
const err = (status: number, error: string) => json({ error }, status);
const parse = <T>(s: string | null | undefined, fb: T): T => { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } };

type LiveRow = HostRow & { image_key: string | null; audio_key: string | null; audio_caption: string | null };
const SEL = `SELECT h.*, a.image_key AS image_key,
  (SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='intro_audio' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) AS audio_key,
  (SELECT caption FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='intro_audio' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) AS audio_caption
  FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id = h.avatar_id`;

// [HF-VOICE-INTRO-1] The host's own admin-approved voice introduction ("Recorded by the host").
function intro(env: Env, r: LiveRow) {
  const c = parseIntroCaption(r.audio_caption);
  return { introAudioUrl: r.audio_key ? mediaUrl(env, r.audio_key) : null, introSeconds: r.audio_key ? c.seconds : null, introMime: r.audio_key ? c.mime : null };
}

function card(env: Env, r: LiveRow) {
  return {
    slug: r.slug, displayName: r.display_name, tagline: r.tagline, avatarUrl: r.image_key ? mediaUrl(env, r.image_key) : null,
    languages: parse<string[]>(r.languages_json, []), style: r.style, topics: parse<string[]>(r.topics_json, []), pricePerMin: r.price_per_min,
    rating: null, reviewCount: 0, talkedTo: 0, lgbtqFriendly: r.lgbtq_lane === 1 && r.lgbtq_public === 1, womenOnly: false,
    ...intro(env, r), status: "offline" as const,
  };
}

export async function hfHostsPublicRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  void ctx;
  const url = new URL(req.url);
  const p = url.pathname;
  const one = p.match(/^\/api\/hosts\/public\/([a-z0-9-]{3,40})$/);
  if (!(p === "/api/hosts/public" || one) || req.method !== "GET") return null;
  try {
    if ((await readConfig(env)).hostsPublicEnabled !== true) return err(404, "not_enabled");
    if (one) {
      const r = await env.DB_META.prepare(`${SEL} WHERE h.slug=?1 AND h.status='live'`).bind(one[1]).first<LiveRow>();
      if (!r) return err(404, "not_found");
      const gal = (await env.DB_META.prepare("SELECT * FROM hf_host_media WHERE uid=?1 AND kind='gallery' AND status='active' ORDER BY sort, created_at").bind(r.uid).all<MediaRow>()).results ?? [];
      return json({
        ...card(env, r), aboutPolished: r.about_polished, quote: r.quote,
        gallery: gal.map((m) => { const j = mediaToJson(env, m); return { url: j.url, caption: j.caption }; }),
      }, 200, CACHE);
    }
    const limit = Math.min(48, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 24)) || 24));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)) || 0);
    const rows = (await env.DB_META.prepare(`${SEL} WHERE h.status='live' AND h.slug IS NOT NULL ORDER BY h.live_at DESC, h.uid LIMIT ?1 OFFSET ?2`).bind(limit, offset).all<LiveRow>()).results ?? [];
    return json(rows.map((r) => card(env, r)), 200, CACHE);
  } catch (e) {
    await trackException(env, e, { route: p, method: "GET", handled: true, app_name: BRAND.slug, extra: { area: "hf_host_public" } });
    return err(500, "internal_error");
  }
}
