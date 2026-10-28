// [HF-WIRE-4] Reels feed for the Reels app. Flag hfReelsEnabled (off -> 404 not_enabled).
//   GET   /api/hf/reels?cursor=&limit=    public feed: visible reels of approved influencers (presence included) -> { ok, items:[item], nextCursor }  (online count: GET /api/hf/online-count)
//   GET   /api/hf/reels/:id               one visible reel (deep link /reels?reel=<id>), online or not -> { ok, item }
//   POST  /api/hf/reels/:id/view          cheap counter, rate-limited per reel + IP -> { ok }
//   GET   /api/hf/hosts/me/reels          the caller's own reels, hidden ones too -> { ok, reels:[mine], onFeed, hostStatus }
//   PATCH /api/hf/reels/:id { visible }   owner only (404 for anyone else) -> { ok, reel:mine }
// [HF-WIRE-22] HF-REEL-40: after the network reels the feed continues with INVITE reels (flag hfInviteReelsEnabled, default true): creators not on the app yet.
//   invite item = { id:"hfiv_...", kind:"invite", creator:{platform,handle:"@x",name,avatar,followers,votes}, platform, url, embedUrl, thumbUrl, title, caption, likes, comments, views, publishedAt }
//   Network items carry no `kind` (= network, unchanged). Round-robin across creators, most-voted first. Cursor: "<ts>_<id>" pages the network part, "i:<offset>" the invite part.
// item = { id, host:{slug,name,handle,avatar,ratePaise,followers,presence}, platform, url, embedUrl, thumbUrl, title, caption, likes, comments, views, publishedAt }
// mine = { id, channelId, platform, url, embedUrl, thumbUrl, title, caption, likes, comments, views, publishedAt, visible }
// Demo (starter) hosts/reels are included only while hfDemoInfluencersVisible is true. Reels of a disconnected / unapproved channel never show.
// [HF-REEL-SKIP-2] POST /api/hf/reels/:id/unplayable { reason }  a phone found the reel cannot play inside the app -> { ok }.
//   Public (no sign-in), rate-limited per IP; one vote per reporter (uid or IP hash). Once hfReelUnplayableHideAt distinct
//   reporters agree (default 2), the reel is left out of the feed, saved videos and profiles for everyone for 30 days.
// [HF-WIRE-14] Embeds only: no video file url is stored or returned; the app plays embedUrl in the official YouTube / Instagram player. title = caption.
// Never returns uid, provider payload or secrets.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { mediaUrl } from "../lib/hf_host_store";
import { priceFields } from "./hf_hosts_public";
import { readHfStdPlan } from "../lib/hf_token_config";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
import { lineFieldsForUids } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]
import { videoKycSql, channelVerifiedSql, spaceOfRow } from "../lib/hf_spaces"; // [HF-VERIFIED-BLIP-1]
import { inviteReelsOn } from "../lib/hf_invite_reels"; // [HF-WIRE-22]
import { enrichItems, prefetchFeedComments } from "../lib/hf_reel_engage"; // [HF-REEL-ENGAGE-API-1]
import { introReelsOn, introReelItems, isIntroReelId } from "../lib/hf_intro_reels"; // [HF-INTRO-W1] hfIntroReelsEnabled: approved intro videos only

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const FEED_CACHE = { "cache-control": "public, max-age=15" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const REEL_ID = /^hfrl_[a-z0-9]{8,40}$/;
const PAGE_MAX = 30;

interface FeedRow {
  id: string; host_uid: string; platform: string; url: string | null; embed_url: string | null; video_url: string | null; thumb_url: string | null;
  caption: string | null; likes: number; comments: number; views: number; published_at: number | null; imported_at: number; ts: number;
  slug: string | null; display_name: string | null; price_per_min: number; category: string | null; presence: string | null; image_key: string | null;
  video_kyc?: number | null; channel_verified?: number | null; women_lane?: number | null; lgbtq_lane?: number | null; lgbtq_public?: number | null; // [HF-VERIFIED-BLIP-1]
}

const HOST_COLS = `h.slug AS slug, h.display_name AS display_name, h.price_per_min AS price_per_min, h.category AS category, h.presence AS presence,
  ${videoKycSql("h.uid")} AS video_kyc, ${channelVerifiedSql("h.uid")} AS channel_verified, h.women_lane AS women_lane, h.lgbtq_lane AS lgbtq_lane, h.lgbtq_public AS lgbtq_public, /* [HF-VERIFIED-BLIP-1] name tick */
  COALESCE((SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key`;
const REEL_COLS = `r.id, r.host_uid, r.platform, r.url, r.embed_url, r.video_url, r.thumb_url, r.caption, r.likes, r.comments, r.views, r.published_at, r.imported_at,
  COALESCE(r.published_at, r.imported_at) AS ts`;
const FROM = `FROM hf_reels r JOIN hf_hosts h ON h.uid=r.host_uid LEFT JOIN hf_avatars a ON a.id=h.avatar_id`;

/** [HF-REEL-SKIP-2] Reasons a phone may report: the reel can never play inside the app (not a slow network). */
export const UNPLAYABLE_REASONS = new Set(["appOnly", "novideo", "100", "101", "150", "152", "153"]);
/** How long a reel stays hidden after its last report (the uploader may switch embedding back on). */
export const UNPLAYABLE_HIDE_MS = 30 * 24 * 3600 * 1000;

/** The hide threshold from config; 0 / missing = never hide (also keeps tests without the table working). */
export function unplayableHideAt(cfg: Record<string, unknown>): number {
  const n = Math.floor(Number(cfg.hfReelUnplayableHideAt ?? 0));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 0;
}

/** SQL fragment (numbers inlined, both whole numbers we computed): leave out reels enough phones reported unplayable. */
export function unplayableWhere(col: string, hideAt: number): string {
  if (!hideAt) return "";
  const since = Date.now() - UNPLAYABLE_HIDE_MS;
  return ` AND NOT EXISTS (SELECT 1 FROM hf_reel_unplayable up WHERE up.reel_id=${col} AND up.reports>=${hideAt} AND up.last_at>${since})`;
}

/** SQL fragment: the reel is allowed to be public (host approved/live, channel still connected, demo rules). */
function publicWhere(demoVisible: boolean, hideAt = 0): string {
  const demo = demoVisible ? "" : " AND r.is_demo=0 AND NOT EXISTS (SELECT 1 FROM hf_demo_hosts d WHERE d.host_uid=h.uid)";
  return `r.visible=1 AND h.status IN ('approved','live') AND h.slug IS NOT NULL
    AND (r.is_demo=1 OR EXISTS (SELECT 1 FROM hf_channels c WHERE c.id=r.channel_id AND c.status='approved'))${demo}${unplayableWhere("r.id", hideAt)}`;
}

async function hostFacts(env: Env, uids: string[]): Promise<Map<string, { handle: string | null; followers: number }>> {
  const out = new Map<string, { handle: string | null; followers: number }>();
  if (!uids.length) return out;
  const ph = uids.map((_, i) => `?${i + 1}`).join(",");
  const ch = (await env.DB_META.prepare(`SELECT host_uid, handle, followers FROM hf_channels WHERE host_uid IN (${ph}) AND status='approved' ORDER BY followers DESC`).bind(...uids).all<{ host_uid: string; handle: string; followers: number }>()).results ?? [];
  for (const c of ch) {
    const cur = out.get(c.host_uid);
    if (!cur) out.set(c.host_uid, { handle: c.handle, followers: Number(c.followers ?? 0) });
    else cur.followers += Number(c.followers ?? 0);
  }
  try {
    const dm = (await env.DB_META.prepare(`SELECT host_uid, handle, followers FROM hf_demo_hosts WHERE host_uid IN (${ph})`).bind(...uids).all<{ host_uid: string; handle: string | null; followers: number }>()).results ?? [];
    for (const d of dm) if (!out.has(d.host_uid)) out.set(d.host_uid, { handle: d.handle, followers: Number(d.followers ?? 0) });
  } catch { /* hf_demo_hosts not applied yet: no demo hosts */ }
  return out;
}

const at = (h: string | null) => (h ? (h.startsWith("@") ? h : "@" + h) : null);

async function toItems(env: Env, rows: FeedRow[], cfg: Record<string, unknown>) {
  const facts = await hostFacts(env, [...new Set(rows.map((r) => r.host_uid))]);
  const std = pricingStd(readHfStdPlan(cfg), cfg);
  const lines = await lineFieldsForUids(env, [...new Set(rows.map((r) => r.host_uid))]); // [HF-CALL-MODES-A]
  return rows.map((r) => {
    const f = facts.get(r.host_uid);
    return {
      id: r.id,
      host: {
        slug: r.slug, name: r.display_name ?? "", handle: at(f?.handle ?? null), avatar: r.image_key ? mediaUrl(env, r.image_key) : null,
        ratePaise: priceFields({ price_per_min: r.price_per_min, category: r.category ?? undefined }, std).pricePaisePerMin, followers: f?.followers ?? 0,
        presence: r.presence === "online" || r.presence === "busy" ? r.presence : "offline",
        videoKycVerified: Number(r.video_kyc) === 1, channelVerified: Number(r.channel_verified) === 1, space: spaceOfRow(r), // [HF-VERIFIED-BLIP-1]
        ...(lines?.get(r.host_uid) ?? {}),
      },
      platform: r.platform, url: r.url, embedUrl: r.embed_url, thumbUrl: r.thumb_url, title: r.caption ?? "", caption: r.caption ?? "",
      likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), views: Number(r.views ?? 0), publishedAt: r.published_at ?? null,
    };
  });
}

interface MineRow { id: string; channel_id: string | null; platform: string; url: string | null; embed_url: string | null; video_url: string | null; thumb_url: string | null; caption: string | null; likes: number; comments: number; views: number; published_at: number | null; visible: number }
const mineJson = (r: MineRow) => ({
  id: r.id, channelId: r.channel_id, platform: r.platform, url: r.url, embedUrl: r.embed_url, thumbUrl: r.thumb_url,
  title: r.caption ?? "", caption: r.caption ?? "", likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), views: Number(r.views ?? 0), publishedAt: r.published_at ?? null, visible: r.visible === 1,
});
const MINE_COLS = "id, channel_id, platform, url, embed_url, video_url, thumb_url, caption, likes, comments, views, published_at, visible";

interface InviteRow {
  id: string; platform: string; handle: string; url: string | null; embed_url: string | null; thumb_url: string | null; caption: string | null;
  likes: number; comments: number; views: number; published_at: number | null; display_name: string | null; avatar_url: string | null; followers: number; votes: number;
}

/** Invite reels: not hidden, creator has not joined, round-robin across creators (newest first), most-voted creators first. Details only, never a video file. */
async function inviteItems(env: Env, offset: number, take: number, ids?: string[], hideAt = 0): Promise<{ items: unknown[]; more: boolean }> {
  try {
    const rows = (await env.DB_META.prepare(
      `SELECT x.* FROM (
         SELECT r.id, r.platform, r.handle, r.url, r.embed_url, r.thumb_url, r.caption, r.likes, r.comments, r.views, r.published_at,
           c.display_name, c.avatar_url, c.followers,
           (SELECT COUNT(*) FROM hf_invite_votes v WHERE v.platform=r.platform AND v.handle=r.handle) AS votes,
           ROW_NUMBER() OVER (PARTITION BY r.platform, r.handle ORDER BY COALESCE(r.published_at,0) DESC, r.id DESC) AS rn
         FROM hf_invite_reels r JOIN hf_invite_creators c ON c.platform=r.platform AND c.handle=r.handle
         WHERE c.hidden=0 AND r.embed_url IS NOT NULL${unplayableWhere("r.id", hideAt)} ${ids ? `AND r.id IN (${ids.map((_, i) => `?${i + 3}`).join(",")})` : ""}
           AND NOT EXISTS (SELECT 1 FROM hf_channels ch WHERE ch.platform=c.platform AND ch.status='approved' AND (LOWER(REPLACE(ch.handle,'@',''))=c.handle OR (c.platform_user_id IS NOT NULL AND ch.platform_user_id=c.platform_user_id)))
       ) x ORDER BY x.rn ASC, x.votes DESC, x.followers DESC, x.handle ASC, x.id ASC LIMIT ?1 OFFSET ?2`,
    ).bind(take + 1, offset, ...(ids ?? [])).all<InviteRow>()).results ?? [];
    const items = rows.slice(0, take).map((r) => ({
      id: r.id, kind: "invite",
      creator: { platform: r.platform, handle: "@" + r.handle, name: r.display_name ?? "", avatar: r.avatar_url ?? null, followers: Number(r.followers ?? 0), votes: Number(r.votes ?? 0) },
      platform: r.platform, url: r.url, embedUrl: r.embed_url, thumbUrl: r.thumb_url, title: r.caption ?? "", caption: r.caption ?? "",
      likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), views: Number(r.views ?? 0), publishedAt: r.published_at ?? null,
    }));
    return { items, more: rows.length > take };
  } catch { return { items: [], more: false }; } // tables not applied yet
}

/** Resolve saved IDs against current visibility; never persist a stale snapshot of a creator. */
export async function savedReelItems(env: Env, ids: string[], cfg: Record<string, unknown>, uid?: string | null): Promise<unknown[]> {
  if (!ids.length || cfg.hfReelsEnabled !== true) return [];
  if (introReelsOn(cfg)) { // [HF-INTRO-W1] the old embed reels are retired while the intro feed is on; a deep link / saved intro reel plays even when option B is offline
    const intro = ids.filter(isIntroReelId);
    const out = intro.length ? (await introReelItems(env, { ids: intro, limit: 30, ignoreVisibility: true })).items : [];
    await enrichItems(env, cfg, out, uid);
    return out;
  }
  const network = ids.filter((id) => REEL_ID.test(id));
  const invites = ids.filter((id) => /^hfiv_[a-z0-9]{8,40}$/.test(id));
  const rows = network.length ? (await env.DB_META.prepare(
    `SELECT ${REEL_COLS}, ${HOST_COLS} ${FROM} WHERE r.id IN (${network.map((_, i) => `?${i + 1}`).join(",")}) AND ${publicWhere(cfg.hfDemoInfluencersVisible !== false, unplayableHideAt(cfg))}`,
  ).bind(...network).all<FeedRow>()).results ?? [] : [];
  const out = [...await toItems(env, rows, cfg), ...(invites.length && inviteReelsOn(cfg) ? (await inviteItems(env, 0, invites.length, invites, unplayableHideAt(cfg))).items : [])];
  await enrichItems(env, cfg, out, uid); // [HF-REEL-ENGAGE-API-1] likeCounts / commentCounts / likedByMe (flag hfReelEngageEnabled)
  return out;
}

/** [HF-REEL-ENGAGE-API-1] The signed-in uid when a valid bearer is sent, else null (never fails the request). */
export async function optionalUid(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("authorization")) return null;
  try { const u = await requireUser(req, env); return isFail(u) ? null : u.uid; } catch { return null; }
}

/** [HF-REEL-ENGAGE-API-1] One publicly visible reel (same rules as the feed) with the platform numbers and the id the platform knows it by, or null. */
export async function visibleReel(env: Env, cfg: Record<string, unknown>, id: string): Promise<{ id: string; platform: string; videoId: string; likes: number; comments: number; publishedAt: number | null } | null> {
  if (isIntroReelId(id)) { // [HF-INTRO-W1] likes / comments / share on an approved intro video (ours: no platform numbers)
    if (!introReelsOn(cfg)) return null;
    const r = (await introReelItems(env, { ids: [id], limit: 1, ignoreVisibility: true })).items[0];
    return r ? { id, platform: "intro", videoId: id, likes: 0, comments: 0, publishedAt: (r.publishedAt as number) ?? null } : null;
  }
  const hideAt = unplayableHideAt(cfg);
  if (REEL_ID.test(id)) {
    const r = await env.DB_META.prepare(`SELECT r.platform, r.platform_video_id, r.likes, r.comments, r.published_at ${FROM} WHERE r.id=?1 AND ${publicWhere(cfg.hfDemoInfluencersVisible !== false, hideAt)}`).bind(id).first<{ platform: string; platform_video_id: string; likes: number; comments: number; published_at: number | null }>();
    return r ? { id, platform: r.platform, videoId: r.platform_video_id, likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), publishedAt: r.published_at ?? null } : null;
  }
  if (/^hfiv_[a-z0-9]{8,40}$/.test(id) && inviteReelsOn(cfg)) {
    if (!(await inviteItems(env, 0, 1, [id], hideAt)).items.length) return null;
    const r = await env.DB_META.prepare("SELECT platform, platform_video_id, likes, comments, published_at FROM hf_invite_reels WHERE id=?1").bind(id).first<{ platform: string; platform_video_id: string; likes: number; comments: number; published_at: number | null }>();
    return r ? { id, platform: r.platform, videoId: r.platform_video_id, likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), publishedAt: r.published_at ?? null } : null;
  }
  return null;
}

/** Visible reels of one host for the public profile (GET /api/hosts/public/:slug). Returns null when the flag is off or the tables are missing. */
export async function profileReels(env: Env, hostUid: string, cfg: Record<string, unknown>, uid?: string | null): Promise<{ reels: unknown[]; followers: number; handle: string | null } | null> {
  if (cfg.hfReelsEnabled !== true) return null;
  if (introReelsOn(cfg)) { // [HF-INTRO-W1] the host's approved intro video is their profile reel
    try {
      const { items } = await introReelItems(env, { hostUid, limit: 5, ignoreVisibility: true });
      await enrichItems(env, cfg, items, uid);
      return { reels: items.map(({ host: _h, ...rest }) => rest), followers: 0, handle: null };
    } catch (e) {
      await trackException(env, e, { route: "profileReels", handled: true, app_name: APP, extra: { area: "hf_reels", step: "intro_profile" } });
      return null;
    }
  }
  try {
    const demoVisible = cfg.hfDemoInfluencersVisible !== false;
    const rows = (await env.DB_META.prepare(
      `SELECT ${REEL_COLS}, ${HOST_COLS} ${FROM} WHERE r.host_uid=?1 AND ${publicWhere(demoVisible, unplayableHideAt(cfg))} ORDER BY ts DESC, r.id DESC LIMIT 60`,
    ).bind(hostUid).all<FeedRow>()).results ?? [];
    const items = await toItems(env, rows, cfg);
    await enrichItems(env, cfg, items, uid); // [HF-REEL-ENGAGE-API-1]
    const f = (await hostFacts(env, [hostUid])).get(hostUid);
    return { reels: items.map(({ host: _h, ...rest }) => rest), followers: f?.followers ?? 0, handle: at(f?.handle ?? null) };
  } catch {
    return null;
  }
}

/** True when a hidden-demo host must not be shown. */
export async function isHiddenDemoHost(env: Env, hostUid: string, cfg: Record<string, unknown>): Promise<boolean> {
  if (cfg.hfDemoInfluencersVisible !== false) return false;
  try { return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_demo_hosts WHERE host_uid=?1").bind(hostUid).first()); } catch { return false; }
}

export async function hfReelsRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = p.match(/^\/api\/hf\/reels(?:\/((?:hfrl|hfiv)_[a-z0-9]{8,40}|hfin_[a-f0-9]{20}))?(?:\/(view|unplayable))?$/);
  const mine = p === "/api/hf/hosts/me/reels";
  if (!m && !mine) return null;
  const id = m?.[1] ?? null;
  const action = m?.[2] ?? null;
  const method = req.method;
  if (mine ? method !== "GET" : !id ? method !== "GET" : action ? method !== "POST" : method !== "GET" && method !== "PATCH") return err(405, "method_not_allowed");
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfReelsEnabled !== true) return err(404, "not_enabled");
    const demoVisible = cfg.hfDemoInfluencersVisible !== false;

    // ── own reels ───────────────────────────────────────────────────────────────────────────────────────────────
    if (mine) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      const rows = (await env.DB_META.prepare(
        `SELECT ${MINE_COLS.split(", ").map((c) => "r." + c).join(", ")} FROM hf_reels r LEFT JOIN hf_channels c ON c.id=r.channel_id
         WHERE r.host_uid=?1 AND (r.channel_id IS NULL OR c.status!='disconnected') ORDER BY COALESCE(r.published_at, r.imported_at) DESC, r.id DESC LIMIT 100`,
      ).bind(u.uid).all<MineRow>()).results ?? [];
      const host = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ status: string }>();
      return json({ ok: true, reels: rows.map(mineJson), onFeed: rows.filter((r) => r.visible === 1).length, hostStatus: host?.status ?? null }, 200, NO_STORE);
    }

    // ── PATCH: show / hide one of my reels ─────────────────────────────────────────────────────────────────────
    if (id && method === "PATCH") {
      if (!REEL_ID.test(id)) return err(405, "method_not_allowed");
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      const txt = await req.text().catch(() => "");
      let b: any = null;
      try { b = txt && txt.length < 2000 ? JSON.parse(txt) : null; } catch { b = null; }
      if (!b || typeof b.visible !== "boolean") return err(400, "invalid_field", "Say whether to show this video on the feed.");
      const row = await env.DB_META.prepare(`SELECT ${MINE_COLS} FROM hf_reels WHERE id=?1 AND host_uid=?2`).bind(id, u.uid).first<MineRow>();
      if (!row) return err(404, "not_found", "We could not find that video.");
      await env.DB_META.prepare("UPDATE hf_reels SET visible=?3 WHERE id=?1 AND host_uid=?2").bind(id, u.uid, b.visible ? 1 : 0).run();
      return json({ ok: true, reel: mineJson({ ...row, visible: b.visible ? 1 : 0 }) }, 200, NO_STORE);
    }

    // ── POST view counter ──────────────────────────────────────────────────────────────────────────────────────
    if (id && action === "view" && isIntroReelId(id)) { // [HF-INTRO-W1]
      const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anon";
      const lim = await rateLimit(env, `hfview:${id}:${ip}`, 3, 3600);
      if (lim) return lim;
      await env.DB_META.prepare("UPDATE hf_intro_videos SET views=views+1 WHERE id=?1 AND status='approved'").bind(id).run();
      return json({ ok: true }, 200, NO_STORE);
    }
    if (id && action === "view") {
      if (!REEL_ID.test(id)) return err(405, "method_not_allowed");
      const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anon";
      const lim = await rateLimit(env, `hfview:${id}:${ip}`, 3, 3600);
      if (lim) return lim;
      await env.DB_META.prepare("UPDATE hf_reels SET views=views+1 WHERE id=?1 AND visible=1").bind(id).run();
      return json({ ok: true }, 200, NO_STORE);
    }

    // ── POST unplayable report [HF-REEL-SKIP-2] ───────────────────────────────────────────────────────────────────
    if (id && action === "unplayable") {
      const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anon";
      const lim = await rateLimit(env, `hfunplay:${ip}`, 30, 3600);
      if (lim) return lim;
      const txt = await req.text().catch(() => "");
      let b: any = null;
      try { b = txt && txt.length < 500 ? JSON.parse(txt) : null; } catch { b = null; }
      const reason = typeof b?.reason === "string" ? b.reason : "";
      if (!UNPLAYABLE_REASONS.has(reason)) return err(400, "invalid_field", "Unknown reason.");
      const table = id.startsWith("hfiv_") ? "hf_invite_reels" : "hf_reels";
      const reel = await env.DB_META.prepare(`SELECT platform FROM ${table} WHERE id=?1`).bind(id).first<{ platform: string }>();
      if (!reel) return err(404, "not_found", "We could not find that video.");
      const u = req.headers.get("authorization") ? await requireUser(req, env) : null;
      const who = u && !isFail(u) ? `u:${u.uid}` : `ip:${ip}`;
      const reporter = await sha256Hex(`hf-unplayable:${who}`);
      const now = Date.now();
      const ins = await env.DB_META.prepare("INSERT OR IGNORE INTO hf_reel_unplayable_reports (reel_id, reporter, at) VALUES (?1, ?2, ?3)").bind(id, reporter, now).run();
      const fresh = Number(ins.meta?.changes ?? 0) > 0;
      await env.DB_META.prepare(
        `INSERT INTO hf_reel_unplayable (reel_id, platform, reason, reports, first_at, last_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(reel_id) DO UPDATE SET reason=?3, reports=reports+?4, last_at=?5`,
      ).bind(id, reel.platform, reason, fresh ? 1 : 0, now).run();
      return json({ ok: true }, 200, NO_STORE);
    }

    // ── GET one reel (deep link) ───────────────────────────────────────────────────────────────────────────────
    if (id) {
      const item = (await savedReelItems(env, [id], cfg, await optionalUid(req, env)))[0];
      if (!item) return err(404, "not_found", "That video is not available any more.");
      return json({ ok: true, item }, 200, cfg.hfReelEngageEnabled === true ? NO_STORE : FEED_CACHE); // likedByMe is per user
    }

    // ── GET feed ───────────────────────────────────────────────────────────────────────────────────────────────
    const url = new URL(req.url);
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 10)) || 10));
    const rawCursor = url.searchParams.get("cursor") ?? "";
    if (introReelsOn(cfg)) { // [HF-INTRO-W1] HF-INTRO-13 / 16: ONLY approved intro videos; option A always, option B only while Online
      if (rawCursor && !/^\d{1,15}_hfin_[a-f0-9]{20}$/.test(rawCursor)) return err(400, "invalid_field", "Bad page marker.");
      const r = await introReelItems(env, { limit, cursor: rawCursor || null });
      if (cfg.hfReelEngageEnabled === true) await enrichItems(env, cfg, r.items, await optionalUid(req, env));
      return json({ ok: true, items: r.items, nextCursor: r.nextCursor }, 200, NO_STORE); // liveness (Online / Busy) changes by the second: never shared-cached
    }
    const inv = rawCursor.match(/^i:(\d{1,6})$/);
    const cur = rawCursor.match(/^(\d{1,15})_(hfrl_[a-z0-9]{8,40})$/);
    if (rawCursor && !cur && !inv) return err(400, "invalid_field", "Bad page marker.");
    const withInvites = inviteReelsOn(cfg);
    let items: unknown[] = [];
    let nextCursor: string | null = null;
    let room = limit;
    let invOffset = 0;
    let doInvite = false;
    if (inv) { doInvite = true; invOffset = Number(inv[1]); }
    else {
      const where = `${publicWhere(demoVisible, unplayableHideAt(cfg))}${cur ? " AND (COALESCE(r.published_at, r.imported_at) < ?2 OR (COALESCE(r.published_at, r.imported_at) = ?2 AND r.id < ?3))" : ""}`;
      const stmt = env.DB_META.prepare(`SELECT ${REEL_COLS}, ${HOST_COLS} ${FROM} WHERE ${where} ORDER BY ts DESC, r.id DESC LIMIT ?1`);
      const rows = (await (cur ? stmt.bind(limit + 1, Number(cur[1]), cur[2]) : stmt.bind(limit + 1)).all<FeedRow>()).results ?? [];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      items = await toItems(env, page, cfg);
      room = limit - page.length;
      if (rows.length > limit && last) nextCursor = `${last.ts}_${last.id}`;
      else doInvite = true; // network part is finished: continue with invite reels
    }
    if (doInvite && withInvites) {
      const r = await inviteItems(env, invOffset, room, undefined, unplayableHideAt(cfg));
      items = items.concat(r.items);
      if (r.more) nextCursor = `i:${invOffset + r.items.length}`;
    }
    const engage = cfg.hfReelEngageEnabled === true;
    if (engage) await enrichItems(env, cfg, items as any[], await optionalUid(req, env)); // [HF-REEL-ENGAGE-API-1]
    if (engage && ctx) ctx.waitUntil(prefetchFeedComments(env, cfg, items as any[]).catch(() => 0)); // [HF-REEL-COMMENTS-PREFETCH-1]
    return json({ ok: true, items, nextCursor }, 200, engage ? { "cache-control": "private, no-store" } : FEED_CACHE); // per-user likedByMe: never shared-cached
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: APP, extra: { area: "hf_reels" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
