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
// [HF-WIRE-14] Embeds only: no video file url is stored or returned; the app plays embedUrl in the official YouTube / Instagram player. title = caption.
// Never returns uid, provider payload or secrets.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { mediaUrl } from "../lib/hf_host_store";
import { priceFields } from "./hf_hosts_public";
import { readHfStdPlan } from "../lib/hf_token_config";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
import { inviteReelsOn } from "../lib/hf_invite_reels"; // [HF-WIRE-22]

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
}

const HOST_COLS = `h.slug AS slug, h.display_name AS display_name, h.price_per_min AS price_per_min, h.category AS category, h.presence AS presence,
  COALESCE((SELECT r2_key FROM hf_host_media m WHERE m.uid=h.uid AND m.kind='profile' AND m.status='active' ORDER BY m.created_at DESC LIMIT 1), a.image_key) AS image_key`;
const REEL_COLS = `r.id, r.host_uid, r.platform, r.url, r.embed_url, r.video_url, r.thumb_url, r.caption, r.likes, r.comments, r.views, r.published_at, r.imported_at,
  COALESCE(r.published_at, r.imported_at) AS ts`;
const FROM = `FROM hf_reels r JOIN hf_hosts h ON h.uid=r.host_uid LEFT JOIN hf_avatars a ON a.id=h.avatar_id`;

/** SQL fragment: the reel is allowed to be public (host approved/live, channel still connected, demo rules). */
function publicWhere(demoVisible: boolean): string {
  const demo = demoVisible ? "" : " AND r.is_demo=0 AND NOT EXISTS (SELECT 1 FROM hf_demo_hosts d WHERE d.host_uid=h.uid)";
  return `r.visible=1 AND h.status IN ('approved','live') AND h.slug IS NOT NULL
    AND (r.is_demo=1 OR EXISTS (SELECT 1 FROM hf_channels c WHERE c.id=r.channel_id AND c.status='approved'))${demo}`;
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
  return rows.map((r) => {
    const f = facts.get(r.host_uid);
    return {
      id: r.id,
      host: {
        slug: r.slug, name: r.display_name ?? "", handle: at(f?.handle ?? null), avatar: r.image_key ? mediaUrl(env, r.image_key) : null,
        ratePaise: priceFields({ price_per_min: r.price_per_min, category: r.category ?? undefined }, std).pricePaisePerMin, followers: f?.followers ?? 0,
        presence: r.presence === "online" || r.presence === "busy" ? r.presence : "offline",
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
async function inviteItems(env: Env, offset: number, take: number, ids?: string[]): Promise<{ items: unknown[]; more: boolean }> {
  try {
    const rows = (await env.DB_META.prepare(
      `SELECT x.* FROM (
         SELECT r.id, r.platform, r.handle, r.url, r.embed_url, r.thumb_url, r.caption, r.likes, r.comments, r.views, r.published_at,
           c.display_name, c.avatar_url, c.followers,
           (SELECT COUNT(*) FROM hf_invite_votes v WHERE v.platform=r.platform AND v.handle=r.handle) AS votes,
           ROW_NUMBER() OVER (PARTITION BY r.platform, r.handle ORDER BY COALESCE(r.published_at,0) DESC, r.id DESC) AS rn
         FROM hf_invite_reels r JOIN hf_invite_creators c ON c.platform=r.platform AND c.handle=r.handle
         WHERE c.hidden=0 AND r.embed_url IS NOT NULL ${ids ? `AND r.id IN (${ids.map((_, i) => `?${i + 3}`).join(",")})` : ""}
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
export async function savedReelItems(env: Env, ids: string[], cfg: Record<string, unknown>): Promise<unknown[]> {
  if (!ids.length || cfg.hfReelsEnabled !== true) return [];
  const network = ids.filter((id) => REEL_ID.test(id));
  const invites = ids.filter((id) => /^hfiv_[a-z0-9]{8,40}$/.test(id));
  const rows = network.length ? (await env.DB_META.prepare(
    `SELECT ${REEL_COLS}, ${HOST_COLS} ${FROM} WHERE r.id IN (${network.map((_, i) => `?${i + 1}`).join(",")}) AND ${publicWhere(cfg.hfDemoInfluencersVisible !== false)}`,
  ).bind(...network).all<FeedRow>()).results ?? [] : [];
  return [...await toItems(env, rows, cfg), ...(invites.length && inviteReelsOn(cfg) ? (await inviteItems(env, 0, invites.length, invites)).items : [])];
}

/** Visible reels of one host for the public profile (GET /api/hosts/public/:slug). Returns null when the flag is off or the tables are missing. */
export async function profileReels(env: Env, hostUid: string, cfg: Record<string, unknown>): Promise<{ reels: unknown[]; followers: number; handle: string | null } | null> {
  if (cfg.hfReelsEnabled !== true) return null;
  try {
    const demoVisible = cfg.hfDemoInfluencersVisible !== false;
    const rows = (await env.DB_META.prepare(
      `SELECT ${REEL_COLS}, ${HOST_COLS} ${FROM} WHERE r.host_uid=?1 AND ${publicWhere(demoVisible)} ORDER BY ts DESC, r.id DESC LIMIT 60`,
    ).bind(hostUid).all<FeedRow>()).results ?? [];
    const items = await toItems(env, rows, cfg);
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
  void ctx;
  const m = p.match(/^\/api\/hf\/reels(?:\/((?:hfrl|hfiv)_[a-z0-9]{8,40}))?(?:\/(view))?$/);
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
    if (id && action === "view") {
      if (!REEL_ID.test(id)) return err(405, "method_not_allowed");
      const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anon";
      const lim = await rateLimit(env, `hfview:${id}:${ip}`, 3, 3600);
      if (lim) return lim;
      await env.DB_META.prepare("UPDATE hf_reels SET views=views+1 WHERE id=?1 AND visible=1").bind(id).run();
      return json({ ok: true }, 200, NO_STORE);
    }

    // ── GET one reel (deep link) ───────────────────────────────────────────────────────────────────────────────
    if (id) {
      const item = (await savedReelItems(env, [id], cfg))[0];
      if (!item) return err(404, "not_found", "That video is not available any more.");
      return json({ ok: true, item }, 200, FEED_CACHE);
    }

    // ── GET feed ───────────────────────────────────────────────────────────────────────────────────────────────
    const url = new URL(req.url);
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 10)) || 10));
    const rawCursor = url.searchParams.get("cursor") ?? "";
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
      const where = `${publicWhere(demoVisible)}${cur ? " AND (COALESCE(r.published_at, r.imported_at) < ?2 OR (COALESCE(r.published_at, r.imported_at) = ?2 AND r.id < ?3))" : ""}`;
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
      const r = await inviteItems(env, invOffset, room);
      items = items.concat(r.items);
      if (r.more) nextCursor = `i:${invOffset + r.items.length}`;
    }
    return json({ ok: true, items, nextCursor }, 200, FEED_CACHE);
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: APP, extra: { area: "hf_reels" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
