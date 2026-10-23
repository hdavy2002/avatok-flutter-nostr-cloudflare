// [HF-HOST-PLATFORM-1] Public HF host cards. Flag hostsPublicEnabled. Only status='live'. Never exposes uid, KYC, phone, or an unapproved voice intro.
//   GET /api/hosts/public?limit=&offset=[&lane=women|lgbtq]   [HF-LANE-VERIFY-1] lane needs a bearer token + lane access (403 lane_required); women-lane hosts carry womenOnly:true in the default list   GET /api/hosts/public/:slug
import { publicVerification, phoneVerifiedSql } from "../lib/hf_public_verification";
import type { Env } from "../types";
import { json } from "../util";
import { trackException, track } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { requireUser, isFail } from "../authz";
import { parseLane, getLaneAccess } from "../lib/hf_lanes";
import { parseIntroCaption } from "../lib/hf_intro";
import { hostAggregates, hostReviews, aggregateFields } from "../lib/hf_reviews"; // [HF-CALLS-1] review aggregates
import type { HostAggregate } from "../lib/hf_reviews_pure";
import { profileReels, isHiddenDemoHost } from "./hf_reels"; // [HF-WIRE-4]
import { mediaUrl, mediaToJson, type HostRow, type MediaRow } from "../lib/hf_host_store";
import { lineFieldsForUids, type HostLineFields } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]

const CACHE = { "cache-control": "public, max-age=60" };
const err = (status: number, error: string) => json({ error }, status);
const parse = <T>(s: string | null | undefined, fb: T): T => { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } };

export type LiveRow = HostRow & { phone_verified?: number | null; presence?: string | null; image_key: string | null; image_source: "uploaded" | "ai" | null; audio_key: string | null; audio_caption: string | null };
import { readHfStdPlan, type HfStdPlan } from "../lib/hf_token_config"; // [HF-STD-PLAN-1]
import { formatRupees } from "../lib/hf_token_math";
import { isCreatorCategory, CREATOR_VERSION } from "../lib/hf_creator_pricing";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
export const SEL = `SELECT h.*, ${phoneVerifiedSql("h.uid")} AS phone_verified /* [HF-IDV-WHATSAPP-1] */, COALESCE((SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key,
  CASE WHEN EXISTS (SELECT 1 FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active')
    THEN CASE WHEN (SELECT job_id FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) IS NOT NULL THEN 'ai' ELSE 'uploaded' END
    WHEN a.image_key IS NOT NULL THEN 'ai' ELSE NULL END AS image_source,
  (SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='intro_audio' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) AS audio_key,
  (SELECT caption FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='intro_audio' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) AS audio_caption
  FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id = h.avatar_id`;

// [HF-VOICE-INTRO-1] The host's own admin-approved voice introduction ("Recorded by the host").
function intro(env: Env, r: LiveRow) {
  const c = parseIntroCaption(r.audio_caption);
  return { introAudioUrl: r.audio_key ? mediaUrl(env, r.audio_key) : null, introSeconds: r.audio_key ? c.seconds : null, introMime: r.audio_key ? c.mime : null };
}

/**
 * [HF-STD-PLAN-1] Price block on every card. Standard plan on: every host shows the same rate card (first band, e.g. ₹3.99/min, lower on
 * long calls) and the host's own price_per_min is ignored. Off: the host's own whole-rupee rate as before.
 */
export function priceFields(r: { price_per_min: number; category?: string }, std?: HfStdPlan | null) {
  if (std && std.enabled && !isCreatorCategory(r.category)) {
    const t = std.tariff.tiers;
    return {
      plan: "standard" as const, pricePerMin: t[0].paisePerMin / 100, pricePaisePerMin: t[0].paisePerMin, priceLabel: `${formatRupees(t[0].paisePerMin)}/min`,
      priceTiers: t.map((b, i) => ({ fromMin: b.fromSec / 60, toMin: i + 1 < t.length ? t[i + 1].fromSec / 60 : null, paisePerMin: b.paisePerMin })),
    };
  }
  const paise = Math.max(0, Math.trunc(Number(r.price_per_min))) * 100;
  return { plan: isCreatorCategory(r.category) ? "creator" as const : "host_rate" as const, pricingVersion: isCreatorCategory(r.category) ? CREATOR_VERSION : null,
    pricePerMin: r.price_per_min, pricePaisePerMin: paise, priceLabel: `${formatRupees(paise)}/min`, priceTiers: [{ fromMin: 0, toMin: null, paisePerMin: paise }] };
}

export function card(env: Env, r: LiveRow, agg?: HostAggregate, std?: HfStdPlan | null, line?: HostLineFields | null) {
  return {
    ...publicVerification({ phone_verified: r.phone_verified }, r.status), // [HF-IDV-WHATSAPP-1] WhatsApp OTP only
    slug: r.slug, displayName: r.display_name, tagline: r.tagline, avatarUrl: r.image_key ? mediaUrl(env, r.image_key) : null,
    imageProvenance: r.image_source,
    category: r.category ?? "standard", listingRevision: r.listing_revision ?? 1,
    languages: parse<string[]>(r.languages_json, []), style: r.style, topics: parse<string[]>(r.topics_json, []), ...priceFields(r, std),
    ...aggregateFields(agg), lgbtqFriendly: r.lgbtq_lane === 1 && r.lgbtq_public === 1, womenOnly: r.women_lane === 1,
    ...intro(env, r), status: (r.presence === "online" || r.presence === "busy" ? r.presence : "offline") as "online" | "busy" | "offline",
    ...(line ? { mode: line.mode, callState: line.callState, queue: line.queue } : {}), // [HF-CALL-MODES-A] only while hfCallModesEnabled is on
  };
}

export async function hfHostsPublicRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  void ctx;
  const url = new URL(req.url);
  const p = url.pathname;
  const one = p.match(/^\/api\/hosts\/public\/([a-z0-9-]{3,40})$/);
  if (!(p === "/api/hosts/public" || one) || req.method !== "GET") return null;
  try {
    const cfgAll = await readConfig(env);
    if (cfgAll.hostsPublicEnabled !== true) return err(404, "not_enabled");
    const std = pricingStd(readHfStdPlan(cfgAll as unknown as Record<string, unknown>), cfgAll as unknown as Record<string, unknown>); // [HF-STD-PLAN-1] [HF-WIRE-18]
    const laneRaw = url.searchParams.get("lane");
    const lane = parseLane(laneRaw);
    if (laneRaw && !lane) return err(400, "bad_lane");
    let laneWhere = "";
    if (lane) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      if (!(await getLaneAccess(env, u.uid))[lane]) return err(403, "lane_required");
      laneWhere = lane === "women" ? " AND h.women_lane=1" : " AND h.lgbtq_lane=1";
    }
    if (one) {
      const r = await env.DB_META.prepare(`${SEL} WHERE h.slug=?1 AND (h.status='live' OR (h.status='approved' AND ?2=1))`).bind(one[1], cfgAll.hfReelsEnabled === true ? 1 : 0).first<LiveRow>();
      if (!r) return err(404, "not_found");
      if (await isHiddenDemoHost(env, r.uid, cfgAll as unknown as Record<string, unknown>)) return err(404, "not_found"); // [HF-WIRE-4]
      const pr = await profileReels(env, r.uid, cfgAll as unknown as Record<string, unknown>); // [HF-WIRE-4] visible reels + followers (null while the flag is off)
      if ((lane === "women" && r.women_lane !== 1) || (lane === "lgbtq" && r.lgbtq_lane !== 1)) return err(404, "not_found");
      const gal = (await env.DB_META.prepare("SELECT * FROM hf_host_media WHERE uid=?1 AND kind='gallery' AND status='active' ORDER BY sort, created_at").bind(r.uid).all<MediaRow>()).results ?? [];
      // [HF-IDV-WHATSAPP-1] success signal: a live profile served as callable because its WhatsApp OTP is verified.
      const pv = publicVerification({ phone_verified: r.phone_verified }, r.status);
      const tp = track(env, r.uid, "hf_public_profile_served", BRAND.slug, { area: "hf_host_public", slug: r.slug, call_eligible: pv.callEligible, identity_verified: pv.identityVerified, identity_method: "whatsapp_otp", listing_status: r.status }).catch(() => {});
      if (ctx) ctx.waitUntil(tp);
      return json({
        protectedLane: lane,
        ...card(env, r, (await hostAggregates(env, [r.uid])).get(r.uid), std, (await lineFieldsForUids(env, [r.uid]))?.get(r.uid)), reviews: await hostReviews(env, r.uid, 10), aboutPolished: r.about_polished, about: r.about ?? null, quote: r.quote, // [HF-DAILY-FLOWS-1] the host's own saved bio is the fallback while no polished version exists
        ...(pr ? { reels: pr.reels, followers: pr.followers, handle: pr.handle } : {}),
        gallery: gal.map((m) => { const j = mediaToJson(env, m); return { url: j.url, caption: j.caption, imageProvenance: m.job_id ? "ai" : "uploaded" }; }),
      }, 200, lane ? { "cache-control": "private, no-store" } : CACHE);
    }
    const limit = Math.min(48, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 24)) || 24));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)) || 0);
    // [HF-LANE-VERIFY-1] A protected-lane list is only for callers who have joined that lane.
    const rows = (await env.DB_META.prepare(`${SEL} WHERE h.status='live' AND h.slug IS NOT NULL${laneWhere} ORDER BY h.live_at DESC, h.uid LIMIT ?1 OFFSET ?2`).bind(limit, offset).all<LiveRow>()).results ?? [];
    const aggs = await hostAggregates(env, rows.map((r) => r.uid)); // [HF-CALLS-1]
    const lines = await lineFieldsForUids(env, rows.map((r) => r.uid)); // [HF-CALL-MODES-A]
    return json(rows.map((r) => card(env, r, aggs.get(r.uid), std, lines?.get(r.uid))), 200, lane ? { "cache-control": "private, no-store" } : CACHE);
  } catch (e) {
    await trackException(env, e, { route: p, method: "GET", handled: true, app_name: BRAND.slug, extra: { area: "hf_host_public" } });
    return err(500, "internal_error");
  }
}
