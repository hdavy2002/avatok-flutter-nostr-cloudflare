// [HF-WIRE-9] Reels-app search + "Invite" votes (rulebook HF-REEL-9 / HF-REEL-29).
//   GET  /api/hf/search?q=&topic=&platform=all|youtube|instagram      public, rate-limited, flag hfReelsEnabled
//        -> { ok, q, online:[host], offline:[host], notOnNetwork:[{ handle, platform, followers?, votes }] }
//        host = { slug, name, handle, avatar, presence:'online'|'busy'|'offline', followers, platforms:['instagram'|'youtube'], topics, ratePaise }
//        [HF-WIRE-22 / HF-REEL-41] platform filters our hosts (an approved channel on that platform; demo hosts count as youtube) AND limits the look-up to that platform.
//        notOnNetwork appears only when q is an exact @handle that is not an approved channel on our network. Provider look-ups
//        (YouTube Data API / treg Instagram) are cached 24 h in KV and skipped silently when the provider is not configured.
//   POST /api/hf/invites/:platform/:handle/vote   signed in, idempotent, flag hfInvitesEnabled -> { ok, votes, voted:true }
//   GET  /api/hf/invites/:platform/:handle   [HF-EXPLORE-PUBLIC-1] public, flag hfInvitesEnabled, cache 60 s -> { ok, creator:{platform,handle,name,avatar,followers,votes,joinedSlug?}, reels:[invite reel] }
//        Backs the public web page /i/<platform>/<handle>. joinedSlug is set when the creator has since joined (the page redirects to /h/<slug>). Never a uid.
//   GET  /api/hf/invites/top           public, flag hfInvitesEnabled -> { ok, items:[{ handle, platform, votes, followers? }] }
//   GET  /api/admin/hf/invites         ADMIN_UIDS only -> { ok, items:[{ handle, platform, votes, lastVoteAt, onNetwork }] }
//   [HF-SEARCH-FILTERS-1] While hfIntroReelsEnabled is on the search lists ONLY approved intro influencers (offline ones too) and accepts
//        category=a,b lang=hi,en avail=online|bookings priceMin= priceMax= (rupees/min) verified=youtube,instagram,facebook women=1 sort=recommended|online|price_low|newest limit= offset=
//        and q matches name, @handle, verified social handle, category, language and description words. The response also carries
//        intro:true, items:[intro card incl. languages[]], total, nextOffset (online[] / offline[] stay for old builds). Details: lib/hf_intro_search.ts.
// Never returns a uid, phone or email. handle is returned with a leading "@".
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { readConfig } from "./config";
import { mediaUrl } from "../lib/hf_host_store";
import { priceFields } from "./hf_hosts_public";
import { readHfStdPlan } from "../lib/hf_token_config";
import { TOPICS, TOPIC_SLUGS } from "../lib/hf_options";
import { lookupChannel, ProviderError, type ChannelPlatform, type ChannelLookup } from "../lib/hf_channel_providers";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
import { lineFieldsForUids } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]
import { noteInviteCreator, hasJoined, inviteReelsOn } from "../lib/hf_invite_reels"; // [HF-WIRE-22]
import { introReelsOn } from "../lib/hf_intro_reels"; // [HF-SEARCH-FILTERS-1]
import { introSearch, parseIntroSearch, legacyHosts } from "../lib/hf_intro_search"; // [HF-SEARCH-FILTERS-1]
import { unplayableHideAt, unplayableWhere } from "./hf_reels"; // [HF-EXPLORE-PUBLIC-1]
import { videoKycSql, channelVerifiedSql, effectiveCallerLevel, spaceOfRow, parseSpace, type SpaceName } from "../lib/hf_spaces"; // [HF-CREATOR-SPACES-1]

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const PLATFORMS: readonly ChannelPlatform[] = ["instagram", "youtube"];
const HANDLE_RE = /^[a-z0-9._-]{2,60}$/;
export const LOOKUP_TTL_S = 24 * 3600;
const RESULT_MAX = 30;

/** "@Name" / "name" -> "name" (lowercase, no @), or null when it is not a plausible handle. */
export function normHandle(raw: string): string | null {
  const h = String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
  return HANDLE_RE.test(h) && !h.startsWith(".") && !h.endsWith(".") ? h : null;
}
/** True when q is written as an exact handle: starts with @ and is a plausible handle. */
export function exactHandle(q: string): string | null {
  const t = q.trim();
  return t.startsWith("@") ? normHandle(t) : null;
}
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const at = (h: string) => "@" + h;

interface CachedLookup { exists: boolean; followers: number; pid?: string | null; name?: string; avatar?: string | null }
const cacheKey = (platform: string, handle: string) => `hfinv:lk:${platform}:${handle}`;

async function cachedPeek(env: Env, platform: string, handle: string): Promise<CachedLookup | null> {
  try {
    const raw = await env.TOKENS.get(cacheKey(platform, handle));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return { exists: v.exists === true, followers: Math.max(0, Number(v.followers) || 0), pid: typeof v.pid === "string" ? v.pid : null, name: typeof v.name === "string" ? v.name : "", avatar: typeof v.avatar === "string" ? v.avatar : null };
  } catch { return null; }
}

/** Cached (24 h) provider look-up. null = provider not configured / unavailable / bad handle (skipped gracefully). */
export async function cachedLookup(env: Env, platform: ChannelPlatform, handle: string, f?: typeof fetch): Promise<CachedLookup | null> {
  const hit = await cachedPeek(env, platform, handle);
  if (hit) return hit;
  try {
    const r: ChannelLookup = await lookupChannel(env, platform, handle, f);
    const v: CachedLookup = { exists: r.exists, followers: r.exists ? r.followers : 0, ...(r.exists ? { pid: r.platformUserId, name: r.displayName ?? "", avatar: r.avatarUrl ?? null } : {}) };
    try { await env.TOKENS.put(cacheKey(platform, handle), JSON.stringify(v), { expirationTtl: LOOKUP_TTL_S }); } catch { /* cache is best effort */ }
    return v;
  } catch (e) {
    if (e instanceof ProviderError) return null;
    throw e;
  }
}

async function voteCounts(env: Env, pairs: { handle: string; platform: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!pairs.length) return out;
  const handles = [...new Set(pairs.map((p) => p.handle))];
  const ph = handles.map((_, i) => `?${i + 1}`).join(",");
  try {
    const rows = (await env.DB_META.prepare(`SELECT handle, platform, COUNT(*) AS c FROM hf_invite_votes WHERE handle IN (${ph}) GROUP BY handle, platform`).bind(...handles).all<{ handle: string; platform: string; c: number }>()).results ?? [];
    for (const r of rows) out.set(`${r.platform}:${r.handle}`, Number(r.c));
  } catch { /* table not applied yet: no votes */ }
  return out;
}

async function onNetwork(env: Env, platform: string, handle: string): Promise<boolean> {
  const row = await env.DB_META.prepare("SELECT 1 AS x FROM hf_channels WHERE platform=?1 AND LOWER(REPLACE(handle,'@',''))=?2 AND status='approved' LIMIT 1").bind(platform, handle).first();
  return !!row;
}

interface HostRow {
  uid: string; slug: string; display_name: string | null; presence: string | null; price_per_min: number; category: string | null; topics_json: string | null; image_key: string | null;
  women_lane?: number | null; lgbtq_lane?: number | null; lgbtq_public?: number | null; video_kyc?: number | null;
  channel_verified?: number | null; caller_level?: string | null; creator_kind?: string | null;
}

async function searchHosts(env: Env, cfg: Record<string, unknown>, q: string, topic: string | null, platform: ChannelPlatform | null = null, space: SpaceName | null = null, kyc = false) {
  const demoVisible = cfg.hfDemoInfluencersVisible !== false;
  const binds: unknown[] = [];
  const where: string[] = [
    "h.status IN ('approved','live')", "h.slug IS NOT NULL", // [HF-CREATOR-SPACES-1] space channels are no longer excluded: they are visible to everyone (only calling is locked)
  ];
  if (!demoVisible) where.push("NOT EXISTS (SELECT 1 FROM hf_demo_hosts d WHERE d.host_uid=h.uid)");
  const needle = q.trim().replace(/^@/, "").toLowerCase();
  if (needle) {
    const like = `%${likeEsc(needle)}%`;
    binds.push(like); const iLike = binds.length;
    const labelSlugs = TOPICS.filter((t) => t.label.toLowerCase().includes(needle) || t.slug.includes(needle)).map((t) => t.slug).slice(0, 8);
    const topicOr = labelSlugs.map((s) => { binds.push(`%"${s}"%`); return `h.topics_json LIKE ?${binds.length}`; });
    where.push(`(LOWER(h.display_name) LIKE ?${iLike} ESCAPE '\\' OR LOWER(h.slug) LIKE ?${iLike} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM hf_channels c WHERE c.host_uid=h.uid AND c.status='approved' AND LOWER(REPLACE(c.handle,'@','')) LIKE ?${iLike} ESCAPE '\\')
      ${topicOr.length ? "OR " + topicOr.join(" OR ") : ""})`);
  }
  if (space) where.push(space === "women" ? "h.women_lane=1" : "h.lgbtq_lane=1 AND h.lgbtq_public=1"); // [HF-CREATOR-SPACES-1]
  if (kyc) where.push(videoKycSql("h.uid")); // [HF-CREATOR-BADGES-1]
  if (topic) { binds.push(`%"${topic}"%`); where.push(`h.topics_json LIKE ?${binds.length}`); }
  if (platform) { // [HF-WIRE-22] HF-REEL-41
    binds.push(platform);
    where.push(`(EXISTS (SELECT 1 FROM hf_channels pc WHERE pc.host_uid=h.uid AND pc.status='approved' AND pc.platform=?${binds.length})${platform === "youtube" ? " OR EXISTS (SELECT 1 FROM hf_demo_hosts pd WHERE pd.host_uid=h.uid)" : ""})`);
  }
  const sql = `SELECT h.uid, h.slug, h.display_name, h.presence, h.price_per_min, h.category, h.topics_json, h.women_lane, h.lgbtq_lane, h.lgbtq_public, h.caller_level, h.creator_kind, ${videoKycSql("h.uid")} AS video_kyc, ${channelVerifiedSql("h.uid")} AS channel_verified,
      COALESCE((SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key
    FROM hf_hosts h LEFT JOIN hf_avatars a ON a.id=h.avatar_id WHERE ${where.join(" AND ")}
    ORDER BY CASE h.presence WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, h.display_name LIMIT ${RESULT_MAX * 2}`;
  const rows = (await env.DB_META.prepare(sql).bind(...binds).all<HostRow>()).results ?? [];
  if (!rows.length) return [];
  const uids = rows.map((r) => r.uid);
  const ph = uids.map((_, i) => `?${i + 1}`).join(",");
  const facts = new Map<string, { handle: string | null; followers: number }>();
  const plats = new Map<string, Set<string>>(); // [HF-WIRE-22] platforms of each host's approved channels (small icon in the app)
  const ch = (await env.DB_META.prepare(`SELECT host_uid, handle, followers, platform FROM hf_channels WHERE host_uid IN (${ph}) AND status='approved' ORDER BY followers DESC`).bind(...uids).all<{ host_uid: string; handle: string; followers: number; platform: string }>()).results ?? [];
  for (const c of ch) {
    if (!plats.has(c.host_uid)) plats.set(c.host_uid, new Set());
    plats.get(c.host_uid)!.add(c.platform);
    const cur = facts.get(c.host_uid);
    if (!cur) facts.set(c.host_uid, { handle: c.handle, followers: Number(c.followers ?? 0) }); else cur.followers += Number(c.followers ?? 0);
  }
  try {
    const dm = (await env.DB_META.prepare(`SELECT host_uid, handle, followers FROM hf_demo_hosts WHERE host_uid IN (${ph})`).bind(...uids).all<{ host_uid: string; handle: string | null; followers: number }>()).results ?? [];
    for (const d of dm) if (!facts.has(d.host_uid)) { facts.set(d.host_uid, { handle: d.handle, followers: Number(d.followers ?? 0) }); plats.set(d.host_uid, new Set(["youtube"])); }
  } catch { /* no demo table */ }
  const std = pricingStd(readHfStdPlan(cfg), cfg);
  const lines = await lineFieldsForUids(env, uids); // [HF-CALL-MODES-A] null while hfCallModesEnabled is off
  return rows.map((r) => {
    const f = facts.get(r.uid);
    let topics: string[] = [];
    try { const v = JSON.parse(r.topics_json ?? "[]"); if (Array.isArray(v)) topics = v.filter((x) => typeof x === "string"); } catch { /* none */ }
    const h = f?.handle ? (f.handle.startsWith("@") ? f.handle : "@" + f.handle) : null;
    return {
      slug: r.slug, name: r.display_name ?? "", handle: h, avatar: r.image_key ? mediaUrl(env, r.image_key) : null,
      presence: r.presence === "online" || r.presence === "busy" ? r.presence : "offline",
      followers: f?.followers ?? 0, platforms: [...(plats.get(r.uid) ?? [])].sort(), topics, ratePaise: priceFields({ price_per_min: r.price_per_min, category: r.category ?? undefined }, std).pricePaisePerMin,
      videoKycVerified: Number(r.video_kyc) === 1, space: spaceOfRow(r), callerLevel: effectiveCallerLevel(r), channelVerified: Number(r.channel_verified) === 1, // [HF-CREATOR-SPACES-1] [HF-CREATOR-BADGES-1]
      ...(lines?.get(r.uid) ?? {}),
    };
  });
}

export async function hfSearchRoute(req: Request, env: Env, p: string, f?: typeof fetch, ctx?: ExecutionContext): Promise<Response | null> {
  const vote = p.match(/^\/api\/hf\/invites\/(instagram|youtube)\/([^/]{2,64})$/);
  const isSearch = p === "/api/hf/search";
  const isTop = p === "/api/hf/invites/top";
  const isAdmin = p === "/api/admin/hf/invites";
  if (!isSearch && !isTop && !isAdmin && !vote) return null;
  const m = req.method;
  if (vote ? m !== "POST" && m !== "GET" : m !== "GET") return err(405, "method_not_allowed");
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    const ip = req.headers.get("cf-connecting-ip") ?? "0";

    if (isAdmin) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
      const rows = (await env.DB_META.prepare("SELECT handle, platform, COUNT(*) AS votes, MAX(at) AS last_at FROM hf_invite_votes GROUP BY handle, platform ORDER BY votes DESC, last_at DESC LIMIT 200")
        .all<{ handle: string; platform: string; votes: number; last_at: number }>()).results ?? [];
      const items = [];
      for (const r of rows) {
        const c = await cachedPeek(env, r.platform, r.handle);
        items.push({ handle: at(r.handle), platform: r.platform, votes: Number(r.votes), lastVoteAt: Number(r.last_at), onNetwork: await onNetwork(env, r.platform, r.handle), ...(c?.exists ? { followers: c.followers } : {}) });
      }
      return json({ ok: true, items }, 200, NO_STORE);
    }

    if (isSearch) {
      if (cfg.hfReelsEnabled !== true) return err(404, "not_enabled");
      const limited = await rateLimit(env, `hfsearch:${ip}`, 60, 60);
      if (limited) return limited;
      const url = new URL(req.url);
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      const topicRaw = (url.searchParams.get("topic") ?? "").trim();
      const topic = topicRaw && TOPIC_SLUGS.has(topicRaw) ? topicRaw : null;
      const platRaw = (url.searchParams.get("platform") ?? "all").trim().toLowerCase();
      const platform: ChannelPlatform | null = platRaw === "youtube" || platRaw === "instagram" ? platRaw : null;
      const spaceRaw = (url.searchParams.get("space") ?? "").trim();
      const space = parseSpace(spaceRaw);
      if (spaceRaw && !space) return err(400, "bad_space");
      // [HF-SEARCH-FILTERS-1] flag on: ONLY approved intro influencers, with the new filters / sort / paging (see lib/hf_intro_search.ts). The legacy online[] / offline[] stay for old app builds.
      const introOn = introReelsOn(cfg);
      const intro = introOn ? await introSearch(env, parseIntroSearch(url.searchParams)) : null;
      const hosts = intro ? [] : await searchHosts(env, cfg, q, topic, platform, space, url.searchParams.get("kyc") === "1");
      const legacy = intro ? legacyHosts(intro.items) : null;
      const online = legacy ? legacy.online : hosts.filter((h) => h.presence !== "offline").slice(0, RESULT_MAX);
      const offline = legacy ? legacy.offline : hosts.filter((h) => h.presence === "offline").slice(0, RESULT_MAX);
      const notOnNetwork: { handle: string; platform: string; followers?: number; votes: number }[] = [];
      const exact = exactHandle(q);
      if (exact && cfg.hfInvitesEnabled === true) {
        const found: { platform: ChannelPlatform; followers?: number }[] = [];
        const plats = platform ? [platform] : PLATFORMS;
        for (const pl of plats) {
          if (await onNetwork(env, pl, exact)) continue;
          const lk = await cachedLookup(env, pl, exact, f);
          if (lk?.exists) {
            found.push({ platform: pl, followers: lk.followers });
            await noteInviteCreator(env, cfg, { platform: pl, handle: exact, source: "search", followers: lk.followers, platformUserId: lk.pid ?? null, name: lk.name, avatar: lk.avatar ?? null }, ctx, { f }); // [HF-WIRE-22] HF-REEL-40
          }
        }
        const votes = await voteCounts(env, plats.map((platform) => ({ handle: exact, platform })));
        for (const x of found) notOnNetwork.push({ handle: at(exact), platform: x.platform, ...(x.followers ? { followers: x.followers } : {}), votes: votes.get(`${x.platform}:${exact}`) ?? 0 });
        // Provider not configured / down: still show a handle that fans have already voted for, so the vote count is not lost.
        for (const platform of plats) {
          if (notOnNetwork.some((n) => n.platform === platform)) continue;
          const v = votes.get(`${platform}:${exact}`) ?? 0;
          if (v > 0 && !(await onNetwork(env, platform, exact))) notOnNetwork.push({ handle: at(exact), platform, votes: v });
        }
      }
      return json({ ok: true, q, online, offline, notOnNetwork, ...(intro ? { intro: true, items: intro.items, total: intro.total, nextOffset: intro.nextOffset } : {}) }, 200, NO_STORE);
    }

    // ── invites ───────────────────────────────────────────────────────────────────────────────────────────────
    if (cfg.hfInvitesEnabled !== true) return err(404, "not_enabled");
    if (isTop) {
      const rows = (await env.DB_META.prepare("SELECT handle, platform, COUNT(*) AS votes, MAX(at) AS last_at FROM hf_invite_votes GROUP BY handle, platform ORDER BY votes DESC, last_at DESC LIMIT 40")
        .all<{ handle: string; platform: string; votes: number }>()).results ?? [];
      const items: { handle: string; platform: string; votes: number; followers?: number }[] = [];
      for (const r of rows) {
        if (await onNetwork(env, r.platform, r.handle)) continue;
        const c = await cachedPeek(env, r.platform, r.handle);
        items.push({ handle: at(r.handle), platform: r.platform, votes: Number(r.votes), ...(c?.exists && c.followers ? { followers: c.followers } : {}) });
        if (items.length >= 20) break;
      }
      return json({ ok: true, items }, 200, { "cache-control": "public, max-age=60" });
    }

    // [HF-EXPLORE-PUBLIC-1] GET one not-yet-on-network creator + their invite reels (public)
    if (m === "GET") {
      const gPlatform = vote![1];
      let gRaw = vote![2];
      try { gRaw = decodeURIComponent(gRaw); } catch { return err(400, "bad_handle", "That handle doesn't look right."); }
      const gHandle = normHandle(gRaw);
      if (!gHandle) return err(400, "bad_handle", "That handle doesn't look right.");
      const limited = await rateLimit(env, `hfinvget:${ip}`, 120, 60);
      if (limited) return limited;
      const pub = { "cache-control": "public, max-age=60" };
      const crow = await env.DB_META.prepare("SELECT platform, handle, display_name, avatar_url, followers, hidden, platform_user_id FROM hf_invite_creators WHERE platform=?1 AND handle=?2")
        .bind(gPlatform, gHandle).first<{ platform: string; handle: string; display_name: string | null; avatar_url: string | null; followers: number; hidden: number; platform_user_id: string | null }>().catch(() => null);
      if (!crow || crow.hidden === 1) return json({ ok: false, error: "not_found", message: "We could not find that creator." }, 404, pub);
      const votes = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_invite_votes WHERE handle=?1 AND platform=?2").bind(gHandle, gPlatform).first<{ c: number }>())?.c ?? 0);
      const creator: Record<string, unknown> = { platform: gPlatform, handle: at(gHandle), name: crow.display_name ?? "", avatar: crow.avatar_url ?? null, followers: Number(crow.followers ?? 0), votes };
      if (await hasJoined(env, gPlatform, gHandle, crow.platform_user_id)) {
        const hs = await env.DB_META.prepare(
          "SELECT h.slug AS slug FROM hf_channels c JOIN hf_hosts h ON h.uid=c.host_uid WHERE c.platform=?1 AND c.status='approved' AND LOWER(REPLACE(c.handle,'@',''))=?2 AND h.status IN ('approved','live') AND h.slug IS NOT NULL LIMIT 1",
        ).bind(gPlatform, gHandle).first<{ slug: string }>().catch(() => null);
        if (hs?.slug) creator.joinedSlug = hs.slug;
        return json({ ok: true, creator, reels: [] }, 200, pub);
      }
      let reels: unknown[] = [];
      if (inviteReelsOn(cfg)) {
        try {
          const rr = (await env.DB_META.prepare(
            `SELECT r.id, r.platform, r.url, r.embed_url, r.thumb_url, r.caption, r.likes, r.comments, r.views, r.published_at FROM hf_invite_reels r
             WHERE r.platform=?1 AND r.handle=?2 AND r.embed_url IS NOT NULL${unplayableWhere("r.id", unplayableHideAt(cfg))}
             ORDER BY COALESCE(r.published_at,0) DESC, r.id DESC LIMIT 30`,
          ).bind(gPlatform, gHandle).all<any>()).results ?? [];
          reels = rr.map((r) => ({ id: r.id, kind: "invite", creator, platform: r.platform, url: r.url, embedUrl: r.embed_url, thumbUrl: r.thumb_url, title: r.caption ?? "", caption: r.caption ?? "", likes: Number(r.likes ?? 0), comments: Number(r.comments ?? 0), views: Number(r.views ?? 0), publishedAt: r.published_at ?? null }));
        } catch { /* tables not applied yet: no reels */ }
      }
      return json({ ok: true, creator, reels }, 200, pub);
    }

    // POST vote
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const platform = vote![1] as ChannelPlatform;
    let rawHandle = vote![2];
    try { rawHandle = decodeURIComponent(rawHandle); } catch { return err(400, "bad_handle", "That handle doesn't look right."); }
    const handle = normHandle(rawHandle);
    if (!handle) return err(400, "bad_handle", "That handle doesn't look right.");
    const limited = await rateLimit(env, `hfvote:${u.uid}`, 30, 3600);
    if (limited) return limited;
    if (await onNetwork(env, platform, handle)) return err(409, "already_on_network", "This creator is already here.");
    await env.DB_META.prepare("INSERT OR IGNORE INTO hf_invite_votes (handle, platform, uid, at) VALUES (?1,?2,?3,?4)").bind(handle, platform, u.uid, Date.now()).run();
    await noteInviteCreator(env, cfg, { platform, handle, source: "vote" }, ctx, { f }); // [HF-WIRE-22] a vote keeps the creator's invite reels in the feed
    const votes = Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_invite_votes WHERE handle=?1 AND platform=?2").bind(handle, platform).first<{ c: number }>())?.c ?? 0);
    return json({ ok: true, votes, voted: true }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_search" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
