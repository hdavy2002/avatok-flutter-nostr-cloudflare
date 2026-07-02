// AvaAffiliate — anyone (Trust Ladder L1+) promotes a specific creator listing
// and earns 10% of gross ON THAT LISTING for the referred user's lifetime,
// funded ENTIRELY out of the platform/admin share (creator earnings untouched).
// Spec: Specs/proposals/PROPOSAL-AVA-AFFILIATE.md (owner-locked 2026-06-11).
//
//   POST /api/affiliate/register                 become an affiliate (L1+)
//   GET  /api/affiliate/me                       profile, totals, status
//   GET  /api/affiliate/listings?app=&q=         promotable listings (active, public)
//   POST /api/affiliate/links                    create link (idempotent per pair)
//   GET  /api/affiliate/links                    all links + headline stats
//   GET  /api/affiliate/links/:id/stats?range=   funnel + timeseries (D1 + HogQL proxy)
//   GET  /api/affiliate/links/:id/subscribers    bound users (anonymized) + LTV
//   POST /api/affiliate/links/:id/pause          pause / resume
//   GET  /a/:linkId                              public click → telemetry → KV → preview/deep link
//   POST /api/affiliate/bind                     consume pending KV at signup/first open
//   GET  /api/admin/affiliates                   program management
//   POST /api/admin/affiliates/:uid/suspend      {suspend: bool}
//
// Money rule (canonical, §2): affiliate = min(floor(gross × rate('affiliate_default')),
// platform_cut), moved platform:fees → affiliate wallet IN the settlement pass
// (walletOp 'earn' → standard 7-day earning hold). Allowlist: AvaLive
// ticket/entry releases, AvaConsult listing orders, AvaVoice sessions — NEVER
// gifts or live-translation charges (those code paths never call settleAffiliate).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { requireLevel } from "./ladder";
import { requireAdmin } from "./admin_money";
import { metaDb } from "../db/shard";
import { walletOp, commissionRate } from "./wallet";
import { acctUser, ACCT_PLATFORM_FEES } from "../ledger";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";
import { readConfig } from "./config";
import { geoOf } from "./insights";

const APP = "avaaffiliate";
const APPS = new Set(["avalive", "avaconsult", "avavoice"]);
const PENDING_TTL_S = 30 * 86_400;   // pending-attribution KV — 30 days, last write wins
const CLICK_DEDUPE_TTL_S = 3_600;    // funnel click events deduped per device per hour
const LINK_BASE = "https://api.avatok.ai/a/";
const DEEP_LINK = (listingId: string, linkId: string) => `avatok://listing/${listingId}?aff=${linkId}`;

// Unambiguous lowercase alphabet for public affiliate codes (no 0/o/1/l/i).
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function randId(alphabet: string, len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

async function flagOff(env: Env): Promise<Response | null> {
  const cfg = await readConfig(env);
  return cfg.avaAffiliateEnabled !== true
    ? json({ error: "affiliate program disabled", flag: "avaAffiliateEnabled" }, 503) : null;
}

interface AffiliateRow { uid: string; code: string; status: string; created_at: number; }
async function loadAffiliate(env: Env, uid: string): Promise<AffiliateRow | null> {
  const r = await metaDb(env).prepare("SELECT * FROM affiliates WHERE uid=?1").bind(uid).first<any>();
  return r ? (r as AffiliateRow) : null;
}

interface LinkRow { id: string; affiliate_uid: string; listing_id: string; app: string; status: string; clicks: number; created_at: number; }
async function loadLink(env: Env, id: string): Promise<LinkRow | null> {
  const r = await metaDb(env).prepare("SELECT * FROM affiliate_links WHERE id=?1").bind(id).first<any>();
  return r ? (r as LinkRow) : null;
}

/** Unified promotable-listing shape across the 3 apps (creator self-promo check
 *  + web preview both need creator_id + title + price). */
async function loadListing(env: Env, app: string, listingId: string):
    Promise<{ id: string; app: string; title: string; price: number; creator_id: string; status: string } | null> {
  const db = metaDb(env);
  if (app === "avavoice") {
    const a = await db.prepare(
      "SELECT id, name, rate_per_hour, payer_mode, creator_id, status FROM avavoice_agents WHERE id=?1",
    ).bind(listingId).first<any>();
    if (!a) return null;
    return { id: String(a.id), app, title: String(a.name), price: Number(a.rate_per_hour), creator_id: String(a.creator_id), status: String(a.status) };
  }
  const l = await db.prepare(
    "SELECT id, kind, title, price, creator_id, status FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!l) return null;
  const wantKind = app === "avalive" ? "live_event" : "consult";
  if (String(l.kind) !== wantKind) return null;
  return { id: String(l.id), app, title: String(l.title), price: Number(l.price), creator_id: String(l.creator_id), status: String(l.status) };
}

// ---------------------------------------------------------------------------
// POST /api/affiliate/register — L1+ (verified email+password). The whole bar.
// ---------------------------------------------------------------------------
export async function affiliateRegister(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  track(env, ctx.uid, "affiliate_signup_started", APP, { identity_level: 1 });
  const gate = await requireLevel(env, ctx.uid, 1);
  if (gate) return json({ error: gate.error, reason: gate.reason, required: gate.required }, gate.status);

  const existing = await loadAffiliate(env, ctx.uid);
  if (existing) {
    if (existing.status === "suspended") return json({ error: "affiliate account suspended" }, 403);
    return json({ ok: true, already: true, code: existing.code, status: existing.status });
  }
  const now = Date.now();
  // Retry on the (astronomically unlikely) UNIQUE collision of the short code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randId(CODE_ALPHABET, 6);
    try {
      await metaDb(env).prepare(
        "INSERT INTO affiliates (uid, code, status, created_at) VALUES (?1,?2,'active',?3)",
      ).bind(ctx.uid, code, now).run();
      track(env, ctx.uid, "affiliate_signup_completed", APP, { identity_level: 1, code });
      metric(env, "affiliate_signup", [1]);
      return json({ ok: true, code, status: "active" });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/UNIQUE|constraint/i.test(msg) && /code/i.test(msg)) continue; // re-roll code
      if (/UNIQUE|constraint/i.test(msg)) {                              // concurrent self-register
        const a = await loadAffiliate(env, ctx.uid);
        if (a) return json({ ok: true, already: true, code: a.code, status: a.status });
      }
      return json({ error: "could not register", detail: msg.slice(0, 200) }, 500);
    }
  }
  return json({ error: "could not allocate code" }, 500);
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/me — profile + headline totals (D1, never PostHog)
// ---------------------------------------------------------------------------
export async function affiliateMe(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const aff = await loadAffiliate(env, ctx.uid);
  if (!aff) return json({ error: "not an affiliate", registered: false }, 404);

  // Lazy hold→settled flip mirrors the WalletDO's 7-day maturity (reporting only).
  const now = Date.now();
  await env.DB_WALLET.prepare(
    "UPDATE affiliate_commissions SET status='settled' WHERE status='held' AND created_at<?1",
  ).bind(now - 7 * 86_400_000).run().catch(() => null);

  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const [totals, monthRow, links, referred] = await Promise.all([
    env.DB_WALLET.prepare(
      `SELECT COALESCE(SUM(affiliate_coins - reversed_coins),0) AS lifetime,
              COALESCE(SUM(CASE WHEN status='held' THEN affiliate_coins - reversed_coins ELSE 0 END),0) AS held
         FROM affiliate_commissions WHERE affiliate_uid=?1 AND status!='reversed'`,
    ).bind(ctx.uid).first<any>(),
    env.DB_WALLET.prepare(
      "SELECT COALESCE(SUM(affiliate_coins - reversed_coins),0) AS month FROM affiliate_commissions WHERE affiliate_uid=?1 AND status!='reversed' AND created_at>=?2",
    ).bind(ctx.uid, monthStart).first<any>(),
    metaDb(env).prepare("SELECT COUNT(*) AS n FROM affiliate_links WHERE affiliate_uid=?1").bind(ctx.uid).first<any>(),
    metaDb(env).prepare("SELECT COUNT(DISTINCT referred_uid) AS n FROM affiliate_attributions WHERE affiliate_uid=?1").bind(ctx.uid).first<any>(),
  ]);
  track(env, ctx.uid, "affiliate_dashboard_viewed", APP, {});
  return json({
    registered: true, code: aff.code, status: aff.status, created_at: aff.created_at,
    link_url_base: LINK_BASE,
    totals: {
      lifetime_coins: Number(totals?.lifetime ?? 0),
      month_coins: Number(monthRow?.month ?? 0),
      held_coins: Number(totals?.held ?? 0),
      links: Number(links?.n ?? 0),
      referred_users: Number(referred?.n ?? 0),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/listings?app=&q= — promotable: active, public, user-paid
// ---------------------------------------------------------------------------
export async function affiliateListings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const aff = await loadAffiliate(env, ctx.uid);
  if (!aff || aff.status !== "active") return json({ error: "not an active affiliate" }, 403);

  const u = new URL(req.url);
  const appFilter = (u.searchParams.get("app") || "").trim().toLowerCase();
  const q = (u.searchParams.get("q") || "").trim().toLowerCase();
  const like = `%${q}%`;
  const db = metaDb(env);
  const affRate = await commissionRate(env, "affiliate_default");

  const out: any[] = [];
  if (!appFilter || appFilter === "avalive" || appFilter === "avaconsult") {
    const kinds = appFilter === "avalive" ? ["live_event"] : appFilter === "avaconsult" ? ["consult"] : ["live_event", "consult"];
    for (const kind of kinds) {
      const app = kind === "live_event" ? "avalive" : "avaconsult";
      const platRate = await commissionRate(env, app);
      const rows = q
        ? await db.prepare(
            "SELECT id, title, price, creator_id, rating_avg, rating_count FROM listings WHERE status='published' AND kind=?1 AND price>0 AND lower(title) LIKE ?2 ORDER BY updated_at DESC LIMIT 60",
          ).bind(kind, like).all()
        : await db.prepare(
            "SELECT id, title, price, creator_id, rating_avg, rating_count FROM listings WHERE status='published' AND kind=?1 AND price>0 ORDER BY updated_at DESC LIMIT 60",
          ).bind(kind).all();
      for (const l of (rows.results ?? []) as any[]) {
        const price = Number(l.price);
        out.push({
          listing_id: String(l.id), app, title: String(l.title), price,
          creator_id: String(l.creator_id), rating_avg: l.rating_avg ?? null, rating_count: Number(l.rating_count ?? 0),
          est_commission_per_sale: Math.min(Math.floor(price * affRate), Math.floor(price * platRate)),
        });
      }
    }
  }
  if (!appFilter || appFilter === "avavoice") {
    // Sponsored (creator_pays) agents have no buyer payment → nothing to commission.
    const rows = q
      ? await db.prepare(
          "SELECT id, name, rate_per_hour, creator_id FROM avavoice_agents WHERE status='published' AND payer_mode='user_pays' AND lower(name) LIKE ?1 ORDER BY updated_at DESC LIMIT 60",
        ).bind(like).all()
      : await db.prepare(
          "SELECT id, name, rate_per_hour, creator_id FROM avavoice_agents WHERE status='published' AND payer_mode='user_pays' ORDER BY updated_at DESC LIMIT 60",
        ).all();
    for (const a of (rows.results ?? []) as any[]) {
      const price = Number(a.rate_per_hour); // per hour — 50% platform rate (avavoice FEE_RATE)
      out.push({
        listing_id: String(a.id), app: "avavoice", title: String(a.name), price,
        creator_id: String(a.creator_id), rating_avg: null, rating_count: 0,
        est_commission_per_sale: Math.min(Math.floor(price * affRate), Math.floor(price * 0.5)),
      });
    }
  }
  return json({ listings: out, affiliate_rate: affRate });
}

// ---------------------------------------------------------------------------
// POST /api/affiliate/links {listing_id, app} — idempotent per (affiliate, listing)
// ---------------------------------------------------------------------------
export async function affiliateLinkCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const aff = await loadAffiliate(env, ctx.uid);
  if (!aff || aff.status !== "active") return json({ error: "not an active affiliate" }, 403);
  const limited = await rateLimit(env, `aff:link:${ctx.uid}`, 60, 3600);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const listingId = String(b.listing_id || "").trim();
  const app = String(b.app || "").trim().toLowerCase();
  if (!listingId || !APPS.has(app)) return json({ error: "listing_id and app (avalive|avaconsult|avavoice) required" }, 400);

  const listing = await loadListing(env, app, listingId);
  if (!listing || listing.status !== "published") return json({ error: "listing not promotable" }, 404);
  // Creator-self-promo is meaningless — block at mint (also re-blocked at bind + settle).
  if (listing.creator_id === ctx.uid) return json({ error: "cannot promote your own listing" }, 403);

  const db = metaDb(env);
  const existing = await db.prepare(
    "SELECT * FROM affiliate_links WHERE affiliate_uid=?1 AND listing_id=?2",
  ).bind(ctx.uid, listingId).first<any>();
  if (existing) {
    return json({ ok: true, already: true, link: linkJson(existing as LinkRow) });
  }
  const id = randId(ID_ALPHABET, 10); // short + unguessable (~10^17 space)
  const now = Date.now();
  try {
    await db.prepare(
      "INSERT INTO affiliate_links (id, affiliate_uid, listing_id, app, status, clicks, created_at) VALUES (?1,?2,?3,?4,'active',0,?5)",
    ).bind(id, ctx.uid, listingId, app, now).run();
  } catch {
    // Lost a race with ourselves — return the winner (idempotent pair).
    const again = await db.prepare("SELECT * FROM affiliate_links WHERE affiliate_uid=?1 AND listing_id=?2").bind(ctx.uid, listingId).first<any>();
    if (again) return json({ ok: true, already: true, link: linkJson(again as LinkRow) });
    return json({ error: "could not create link" }, 500);
  }
  track(env, ctx.uid, "affiliate_link_created", APP,
      { link_id: id, listing_id: listingId, app, listing_price: listing.price });
  metric(env, "affiliate_link_created", [1], [app]);
  return json({ ok: true, link: linkJson({ id, affiliate_uid: ctx.uid, listing_id: listingId, app, status: "active", clicks: 0, created_at: now }) });
}

function linkJson(l: LinkRow): any {
  return {
    id: l.id, listing_id: l.listing_id, app: l.app, status: l.status,
    clicks: Number(l.clicks ?? 0), created_at: l.created_at,
    url: LINK_BASE + l.id, deep_link: DEEP_LINK(l.listing_id, l.id),
  };
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/links — all links + headline stats (D1 aggregates)
// ---------------------------------------------------------------------------
export async function affiliateLinks(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const aff = await loadAffiliate(env, ctx.uid);
  if (!aff) return json({ error: "not an affiliate" }, 404);

  const db = metaDb(env);
  const links = await db.prepare(
    "SELECT * FROM affiliate_links WHERE affiliate_uid=?1 ORDER BY created_at DESC LIMIT 200",
  ).bind(ctx.uid).all();
  const binds = await db.prepare(
    "SELECT link_id, COUNT(*) AS n FROM affiliate_attributions WHERE affiliate_uid=?1 GROUP BY link_id",
  ).bind(ctx.uid).all();
  const earnings = await env.DB_WALLET.prepare(
    `SELECT link_id, COUNT(*) AS purchases, COALESCE(SUM(affiliate_coins - reversed_coins),0) AS earned
       FROM affiliate_commissions WHERE affiliate_uid=?1 AND status!='reversed' GROUP BY link_id`,
  ).bind(ctx.uid).all();
  const bindBy: Record<string, number> = {};
  for (const r of (binds.results ?? []) as any[]) bindBy[String(r.link_id)] = Number(r.n);
  const earnBy: Record<string, { purchases: number; earned: number }> = {};
  for (const r of (earnings.results ?? []) as any[]) earnBy[String(r.link_id)] = { purchases: Number(r.purchases), earned: Number(r.earned) };

  // Listing titles for the dashboard cards (best-effort, one query per app store).
  const rows = ((links.results ?? []) as any[]).map((l) => l as LinkRow);
  const titles = await linkTitles(env, rows);
  const out = rows.map((l) => ({
    ...linkJson(l),
    title: titles[l.id] ?? null,
    bound_users: bindBy[l.id] ?? 0,
    purchases: earnBy[l.id]?.purchases ?? 0,
    earned_coins: earnBy[l.id]?.earned ?? 0,
  })).sort((a, b) => b.earned_coins - a.earned_coins);
  return json({ links: out });
}

async function linkTitles(env: Env, links: LinkRow[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const db = metaDb(env);
  const listingIds = links.filter((l) => l.app !== "avavoice").map((l) => l.listing_id);
  const agentIds = links.filter((l) => l.app === "avavoice").map((l) => l.listing_id);
  const byListing: Record<string, string> = {};
  if (listingIds.length) {
    const ph = listingIds.map((_, i) => `?${i + 1}`).join(",");
    const rs = await db.prepare(`SELECT id, title FROM listings WHERE id IN (${ph})`).bind(...listingIds).all().catch(() => ({ results: [] as any[] }));
    for (const r of (rs.results ?? []) as any[]) byListing[String(r.id)] = String(r.title);
  }
  if (agentIds.length) {
    const ph = agentIds.map((_, i) => `?${i + 1}`).join(",");
    const rs = await db.prepare(`SELECT id, name FROM avavoice_agents WHERE id IN (${ph})`).bind(...agentIds).all().catch(() => ({ results: [] as any[] }));
    for (const r of (rs.results ?? []) as any[]) byListing[String(r.id)] = String(r.name);
  }
  for (const l of links) { const t = byListing[l.listing_id]; if (t) out[l.id] = t; }
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/links/:id/stats?range=7|30|90 — D1 truth + HogQL funnel
// ---------------------------------------------------------------------------
export async function affiliateLinkStats(req: Request, env: Env, linkId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const link = await loadLink(env, linkId);
  if (!link || link.affiliate_uid !== ctx.uid) return json({ error: "not found" }, 404);

  const rangeDays = [7, 30, 90].includes(Number(new URL(req.url).searchParams.get("range")))
    ? Number(new URL(req.url).searchParams.get("range")) : 30;
  const since = Date.now() - rangeDays * 86_400_000;

  const db = metaDb(env);
  const [bindsTotal, bindsRange, comm, byDay] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM affiliate_attributions WHERE link_id=?1").bind(linkId).first<any>(),
    db.prepare("SELECT COUNT(*) AS n FROM affiliate_attributions WHERE link_id=?1 AND bound_at>?2").bind(linkId, since).first<any>(),
    env.DB_WALLET.prepare(
      `SELECT COUNT(*) AS purchases, COUNT(DISTINCT referred_uid) AS buyers,
              COALESCE(SUM(gross_coins),0) AS gross, COALESCE(SUM(affiliate_coins - reversed_coins),0) AS earned,
              COALESCE(SUM(CASE WHEN status='held' THEN affiliate_coins - reversed_coins ELSE 0 END),0) AS held
         FROM affiliate_commissions WHERE link_id=?1 AND status!='reversed' AND created_at>?2`,
    ).bind(linkId, since).first<any>(),
    env.DB_WALLET.prepare(
      `SELECT date(created_at/1000,'unixepoch') AS day, COUNT(*) AS purchases,
              COALESCE(SUM(affiliate_coins - reversed_coins),0) AS earned
         FROM affiliate_commissions WHERE link_id=?1 AND status!='reversed' AND created_at>?2
         GROUP BY day ORDER BY day`,
    ).bind(linkId, since).all(),
  ]);

  // PostHog funnel (clicks → binds → first purchase → repeat) + sources —
  // server-proxied HogQL; the app never holds a PostHog key. Best-effort.
  const funnel = await hogqlFunnel(env, linkId, rangeDays).catch(() => null);

  track(env, ctx.uid, "affiliate_link_stats_viewed", APP, { link_id: linkId, range: rangeDays });
  return json({
    link: linkJson(link),
    range_days: rangeDays,
    raw_clicks_total: Number(link.clicks ?? 0),
    binds: { total: Number(bindsTotal?.n ?? 0), in_range: Number(bindsRange?.n ?? 0) },
    commissions: {
      purchases: Number(comm?.purchases ?? 0), buyers: Number(comm?.buyers ?? 0),
      gross_coins: Number(comm?.gross ?? 0), earned_coins: Number(comm?.earned ?? 0),
      held_coins: Number(comm?.held ?? 0),
    },
    timeseries: byDay.results ?? [],
    funnel, // null when PostHog key/project unset or query failed
  });
}

async function hogqlFunnel(env: Env, linkId: string, rangeDays: number):
    Promise<{ clicks: number; binds: number; first_purchases: number; repeat_purchases: number; sources: { source: string; n: number }[]; countries: { code: string; n: number }[] } | null> {
  const key = env.POSTHOG_PERSONAL_API_KEY;
  const project = env.POSTHOG_PROJECT_ID || "";
  if (!key || !project) return null;
  const host = env.POSTHOG_QUERY_HOST || "https://us.posthog.com";
  const safe = linkId.replace(/[^A-Za-z0-9_-]/g, "");
  const run = async (q: string): Promise<any[]> => {
    const r = await fetch(`${host}/api/projects/${project}/query/`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: q } }),
    });
    if (!r.ok) throw new Error(`posthog ${r.status}`);
    return ((await r.json()) as any).results ?? [];
  };
  const base = `properties.link_id = '${safe}' AND timestamp > now() - INTERVAL ${rangeDays} DAY`;
  const [events, sources, countries] = await Promise.all([
    run(`SELECT event, countIf(event != 'affiliate_commission_earned' OR properties.is_repeat = false) AS firsts,
                countIf(event = 'affiliate_commission_earned' AND properties.is_repeat = true) AS repeats
           FROM events WHERE event IN ('affiliate_link_click','affiliate_attribution_bound','affiliate_commission_earned')
            AND ${base} GROUP BY event`),
    run(`SELECT properties.source AS source, count() AS n FROM events
          WHERE event = 'affiliate_link_click' AND ${base} GROUP BY source ORDER BY n DESC LIMIT 5`),
    run(`SELECT properties.$geoip_country_code AS code, count() AS n FROM events
          WHERE event = 'affiliate_link_click' AND ${base} GROUP BY code ORDER BY n DESC LIMIT 10`),
  ]);
  const by: Record<string, { firsts: number; repeats: number }> = {};
  for (const [event, firsts, repeats] of events) by[String(event)] = { firsts: Number(firsts), repeats: Number(repeats) };
  return {
    clicks: by.affiliate_link_click?.firsts ?? 0,
    binds: by.affiliate_attribution_bound?.firsts ?? 0,
    first_purchases: by.affiliate_commission_earned?.firsts ?? 0,
    repeat_purchases: by.affiliate_commission_earned?.repeats ?? 0,
    sources: sources.filter((s: any[]) => s[0]).map((s: any[]) => ({ source: String(s[0]), n: Number(s[1]) })),
    countries: countries.filter((c: any[]) => c[0]).map((c: any[]) => ({ code: String(c[0]), n: Number(c[1]) })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/affiliate/links/:id/subscribers — anonymized bound users + LTV
// ---------------------------------------------------------------------------
export async function affiliateLinkSubscribers(req: Request, env: Env, linkId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const link = await loadLink(env, linkId);
  if (!link || link.affiliate_uid !== ctx.uid) return json({ error: "not found" }, 404);

  const attrs = await metaDb(env).prepare(
    `SELECT a.referred_uid, a.bound_at, a.source, u.handle
       FROM affiliate_attributions a LEFT JOIN users u ON u.uid = a.referred_uid
      WHERE a.link_id=?1 ORDER BY a.bound_at DESC LIMIT 500`,
  ).bind(linkId).all();
  const ltv = await env.DB_WALLET.prepare(
    `SELECT referred_uid, COUNT(*) AS purchases, COALESCE(SUM(gross_coins),0) AS gross,
            COALESCE(SUM(affiliate_coins - reversed_coins),0) AS commission
       FROM affiliate_commissions WHERE link_id=?1 AND status!='reversed' GROUP BY referred_uid`,
  ).bind(linkId).all();
  const ltvBy: Record<string, any> = {};
  for (const r of (ltv.results ?? []) as any[]) ltvBy[String(r.referred_uid)] = r;

  // Privacy: never the uid, never the full handle — "•••42"-style masking.
  const subscribers = ((attrs.results ?? []) as any[]).map((a) => {
    const handle = String(a.handle ?? "");
    const masked = handle.length >= 2 ? `•••${handle.slice(-2)}` : "•••";
    const v = ltvBy[String(a.referred_uid)];
    return {
      handle_masked: masked, bound_at: Number(a.bound_at), source: String(a.source),
      purchases: Number(v?.purchases ?? 0),
      lifetime_gross_coins: Number(v?.gross ?? 0),
      your_commission_coins: Number(v?.commission ?? 0),
    };
  });
  return json({ link_id: linkId, subscribers });
}

// ---------------------------------------------------------------------------
// POST /api/affiliate/links/:id/pause {paused: bool} — pause / resume
// ---------------------------------------------------------------------------
export async function affiliateLinkPause(req: Request, env: Env, linkId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const link = await loadLink(env, linkId);
  if (!link || link.affiliate_uid !== ctx.uid) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const paused = b.paused !== false; // default: pause
  await metaDb(env).prepare("UPDATE affiliate_links SET status=?2 WHERE id=?1")
    .bind(linkId, paused ? "paused" : "active").run();
  track(env, ctx.uid, paused ? "affiliate_link_paused" : "affiliate_link_resumed", APP, { link_id: linkId });
  return json({ ok: true, status: paused ? "paused" : "active" });
}

// ---------------------------------------------------------------------------
// GET /a/:linkId — PUBLIC click: telemetry → pending KV (30 d, last wins) →
// deep-link attempt + web preview with store badges. No auth, rate-limited.
// ---------------------------------------------------------------------------
export async function affiliateClick(req: Request, env: Env, linkId: string): Promise<Response> {
  // Existing KV sliding-window limiter, per IP (fraud guardrail §10).
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = (await sha256Hex(ip)).slice(0, 16);
  const limited = await rateLimit(env, `aff:click:${ipHash}`, 120, 3600);
  if (limited) return limited;

  const link = await loadLink(env, linkId);
  if (!link) return htmlResponse(previewHtml(env, { title: "Link not found", missing: true }), 404);
  const [affiliate, listing, cfg] = await Promise.all([
    loadAffiliate(env, link.affiliate_uid),
    loadListing(env, link.app, link.listing_id),
    readConfig(env),
  ]);

  const u = new URL(req.url);
  const source = ["qr", "link", "share"].includes(String(u.searchParams.get("s")))
    ? String(u.searchParams.get("s")) : "link";

  // Device token: cookie if the browser has one, else mint (carried on the redirect).
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)ava_aff_dev=([A-Za-z0-9-]{8,64})/);
  const device = m ? m[1] : crypto.randomUUID();

  // Raw click always logged (counter + ops metric)…
  await metaDb(env).prepare("UPDATE affiliate_links SET clicks=clicks+1 WHERE id=?1").bind(linkId).run().catch(() => null);
  metric(env, "affiliate_click", [1], [link.app, source]);

  // …but the FUNNEL event is deduped per device per hour (§10).
  const dedupeKey = `aff_cd:${linkId}:${await sha256Hex(device)}`;
  const seen = await env.TOKENS.get(dedupeKey);
  if (!seen) {
    const g = geoOf(req);
    track(env, link.affiliate_uid, "affiliate_link_click", APP, {
      link_id: linkId, affiliate_uid: link.affiliate_uid, listing_id: link.listing_id,
      app: link.app, source, referrer: req.headers.get("referer") || null,
      country: g.country, device: req.headers.get("user-agent")?.slice(0, 120) ?? null,
      is_app_installed: null, // unknowable server-side; the deep-link attempt decides
    });
    await env.TOKENS.put(dedupeKey, "1", { expirationTtl: CLICK_DEDUPE_TTL_S }).catch(() => null);
  }

  // Pending attribution — flag ON + link active + affiliate active only. OFF ⇒
  // the redirect still works, no attribution (§10 kill-switch semantics).
  if (cfg.avaAffiliateEnabled === true && link.status === "active" && affiliate?.status === "active") {
    await env.TOKENS.put(`aff_pending:${device}`,
      JSON.stringify({ link_id: linkId, ts: Date.now(), source }),
      { expirationTtl: PENDING_TTL_S }).catch(() => null); // plain put = last write wins
  }

  const deep = DEEP_LINK(link.listing_id, linkId);
  const html = previewHtml(env, {
    title: listing?.title ?? "AvaTok",
    price: listing?.price ?? null,
    app: link.app,
    creator: listing?.creator_id ?? null,
    deepLink: deep,
    linkId,
  });
  return htmlResponse(html, 200, {
    "set-cookie": `ava_aff_dev=${device}; Max-Age=${PENDING_TTL_S}; Path=/; Secure; SameSite=Lax`,
  });
}

function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
}

const APP_LABEL: Record<string, string> = { avalive: "AvaLive", avaconsult: "AvaConsult", avavoice: "AvaVoice" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Minimal public preview for non-installed users — attempts the deep link
 *  (which carries the aff param), then shows the listing + store badges.
 *  Store links are config-driven: PLAY_PACKAGE_ID (var; falls back to the real
 *  applicationId) and APP_STORE_ID (unset on the Android-only launch ⇒ NO App
 *  Store badge is rendered at all — never a dead id000000000 link). */
function previewHtml(env: Env, p: { title: string; price?: number | null; app?: string; creator?: string | null; deepLink?: string; linkId?: string; missing?: boolean }): string {
  const price = p.price != null && p.price > 0 ? `$${(p.price / 100).toFixed(2)}` : "";
  const appLabel = p.app ? APP_LABEL[p.app] ?? "AvaTok" : "AvaTok";
  const open = p.deepLink ? `<script>setTimeout(function(){window.location.href=${JSON.stringify(p.deepLink)};},300);</script>` : "";
  const playId = (env.PLAY_PACKAGE_ID || "ai.avatok.avatok_call").trim();
  const appStoreId = (env.APP_STORE_ID || "").trim();
  const playBadge = `<a href="https://play.google.com/store/apps/details?id=${encodeURIComponent(playId)}${p.linkId ? `&referrer=aff%3D${encodeURIComponent(p.linkId)}` : ""}" style="display:inline-block;border:1px solid #ccc;border-radius:10px;padding:10px 16px;text-decoration:none;color:#222;margin:0 6px 8px 0">Google&nbsp;Play</a>`;
  const appStoreBadge = appStoreId
    ? `<a href="https://apps.apple.com/app/avatok/id${encodeURIComponent(appStoreId)}" style="display:inline-block;border:1px solid #ccc;border-radius:10px;padding:10px 16px;text-decoration:none;color:#222;margin:0 0 8px 0">App&nbsp;Store</a>`
    : "";
  const body = p.missing
    ? `<p style="color:#888">This affiliate link doesn't exist (anymore).</p>`
    : `<p style="margin:4px 0 2px;color:#888;font-size:13px">${esc(appLabel)}${p.creator ? " · by a verified creator" : ""}</p>
       <h1 style="margin:0 0 6px;font-size:22px">${esc(p.title)}</h1>
       ${price ? `<p style="margin:0 0 18px;font-weight:700;font-size:18px">${price}</p>` : ""}
       ${p.deepLink ? `<a href="${esc(p.deepLink)}" style="display:inline-block;background:#5b3df5;color:#fff;text-decoration:none;border-radius:12px;padding:12px 28px;font-weight:600;margin-bottom:22px">Open in AvaTok</a>` : ""}
       <p style="color:#888;font-size:13px;margin:0 0 10px">Don't have the app yet?</p>
       <p style="margin:0">${playBadge}${appStoreBadge}</p>
       <p style="color:#bbb;font-size:11px;margin-top:18px">Your invite stays linked when you install &amp; sign up.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — AvaTok</title>${open}</head>
<body style="font-family:system-ui,-apple-system,sans-serif;margin:0;background:#fafafa">
<div style="max-width:420px;margin:0 auto;padding:48px 24px;text-align:center">
<p style="font-weight:800;letter-spacing:.5px;margin:0 0 28px">AvaTok</p>${body}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// POST /api/affiliate/bind {device_id?, source?} — authed; consume pending KV.
// Called at signup / first authenticated open. Permanent per (user, listing).
// ---------------------------------------------------------------------------
export async function affiliateBind(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.avaAffiliateEnabled !== true) return json({ ok: true, bound: false, reason: "disabled" });

  const b = (await req.json().catch(() => ({}))) as any;
  const cookie = req.headers.get("cookie") || "";
  const cm = cookie.match(/(?:^|;\s*)ava_aff_dev=([A-Za-z0-9-]{8,64})/);
  const device = String(b.device_id || (cm ? cm[1] : "")).slice(0, 64);
  if (!device) return json({ ok: true, bound: false, reason: "no_device" });

  const pendingKey = `aff_pending:${device}`;
  let pending: { link_id: string; ts: number; source?: string } | null = null;
  try { pending = (await env.TOKENS.get(pendingKey, "json")) as any; } catch { /* none */ }
  if (!pending?.link_id) return json({ ok: true, bound: false, reason: "no_pending" });

  const link = await loadLink(env, String(pending.link_id));
  if (!link || link.status !== "active") {
    await env.TOKENS.delete(pendingKey).catch(() => null);
    return json({ ok: true, bound: false, reason: "link_inactive" });
  }
  const [affiliate, listing] = await Promise.all([
    loadAffiliate(env, link.affiliate_uid),
    loadListing(env, link.app, link.listing_id),
  ]);
  // Suspended affiliates get NO new bindings (§10).
  if (!affiliate || affiliate.status !== "active" || !listing) {
    await env.TOKENS.delete(pendingKey).catch(() => null);
    return json({ ok: true, bound: false, reason: "affiliate_inactive" });
  }
  // Fraud gates: self-referral + creator-self-promo (§10, re-checked at settle).
  const reject = ctx.uid === link.affiliate_uid ? "self_referral"
    : link.affiliate_uid === listing.creator_id ? "creator_self_promo" : null;
  if (reject) {
    track(env, ctx.uid, "affiliate_attribution_rejected", APP,
        { reason: reject, link_id: link.id, listing_id: link.listing_id, app: link.app });
    metric(env, "affiliate_bind_rejected", [1], [reject]);
    await env.TOKENS.delete(pendingKey).catch(() => null);
    return json({ ok: true, bound: false, reason: reject });
  }

  const source = ["qr", "link", "share"].includes(String(b.source ?? pending.source)) ? String(b.source ?? pending.source) : "link";
  const now = Date.now();
  const r = await metaDb(env).prepare(
    `INSERT INTO affiliate_attributions (referred_uid, listing_id, link_id, affiliate_uid, bound_at, source)
     VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(referred_uid, listing_id) DO NOTHING`,
  ).bind(ctx.uid, link.listing_id, link.id, link.affiliate_uid, now, source).run();
  await env.TOKENS.delete(pendingKey).catch(() => null);
  const fresh = (r.meta?.changes ?? 0) > 0; // set once — an existing binding never moves
  if (fresh) {
    track(env, ctx.uid, "affiliate_attribution_bound", APP, {
      link_id: link.id, referred_uid: ctx.uid, source,
      hours_since_click: Math.round((now - Number(pending.ts || now)) / 3_600_000),
    });
    metric(env, "affiliate_bound", [1], [link.app, source]);
  }
  return json({ ok: true, bound: fresh, already: !fresh, listing_id: link.listing_id, app: link.app });
}

// ---------------------------------------------------------------------------
// Admin: list + suspend/unsuspend (program management)
// ---------------------------------------------------------------------------
export async function adminAffiliates(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = new URL(req.url).searchParams.get("status");
  const rows = status
    ? await metaDb(env).prepare("SELECT * FROM affiliates WHERE status=?1 ORDER BY created_at DESC LIMIT 200").bind(status).all()
    : await metaDb(env).prepare("SELECT * FROM affiliates ORDER BY created_at DESC LIMIT 200").all();
  const affs = (rows.results ?? []) as any[];
  const earned = await env.DB_WALLET.prepare(
    "SELECT affiliate_uid, COALESCE(SUM(affiliate_coins - reversed_coins),0) AS earned, COUNT(*) AS commissions FROM affiliate_commissions WHERE status!='reversed' GROUP BY affiliate_uid",
  ).all().catch(() => ({ results: [] as any[] }));
  const by: Record<string, any> = {};
  for (const r of (earned.results ?? []) as any[]) by[String(r.affiliate_uid)] = r;
  return json({
    affiliates: affs.map((x) => ({
      uid: x.uid, code: x.code, status: x.status, created_at: x.created_at,
      earned_coins: Number(by[String(x.uid)]?.earned ?? 0),
      commissions: Number(by[String(x.uid)]?.commissions ?? 0),
    })),
  });
}

export async function adminAffiliateSuspend(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  const suspend = b.suspend !== false; // default: suspend
  const r = await metaDb(env).prepare("UPDATE affiliates SET status=?2 WHERE uid=?1")
    .bind(uid, suspend ? "suspended" : "active").run();
  if ((r.meta?.changes ?? 0) === 0) return json({ error: "not found" }, 404);
  track(env, uid, suspend ? "affiliate_suspended" : "affiliate_unsuspended", APP, { admin: a.uid });
  return json({ ok: true, uid, status: suspend ? "suspended" : "active" });
}

// ---------------------------------------------------------------------------
// Settlement integration (§6) — called from the existing money paths ONLY for
// the commissionable allowlist (AvaLive ticket/entry release, AvaConsult order
// release, AvaVoice session settle). Idempotent end-to-end: walletOp op_id
// `aff:<settlementId>` + affiliate_commissions PK `<settlementId>:aff`.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TOP-UP COMMISSION — the live model (2026-06-18). An affiliate earns
// TOPUP_AFFILIATE_RATE (10%) of every top-up their referred users ever make,
// FOR LIFE. A user's "lifetime affiliate" is the FIRST affiliate who ever
// referred them (earliest attribution). Funded platform:fees → affiliate, paid
// into the standard 7-day hold (reversible), idempotent per top-up. Self-referral
// blocked. Reuses the existing affiliate signup + link + attribution system.
// ---------------------------------------------------------------------------
const TOPUP_AFFILIATE_RATE = 0.10;

export async function payAffiliateOnTopup(env: Env, referredUid: string, coins: number, topupId: string): Promise<number> {
  try {
    const cfg = await readConfig(env);
    if (cfg.avaAffiliateEnabled !== true) return 0;
    const gross = Math.trunc(Number(coins));
    if (!(gross > 0) || !referredUid || !topupId) return 0;

    // Lifetime affiliate = the first affiliate who ever referred this user.
    const attr = await metaDb(env).prepare(
      "SELECT link_id, affiliate_uid FROM affiliate_attributions WHERE referred_uid=?1 ORDER BY bound_at ASC LIMIT 1",
    ).bind(referredUid).first<{ link_id: string; affiliate_uid: string }>();
    if (!attr) return 0;
    if (attr.affiliate_uid === referredUid) return 0; // self-referral
    const affiliate = await loadAffiliate(env, attr.affiliate_uid);
    if (!affiliate || affiliate.status !== "active") return 0;

    const aff = Math.floor(gross * TOPUP_AFFILIATE_RATE);
    if (!(aff > 0)) return 0;

    const commId = `aff_topup:${topupId}`;
    // Money first (WalletDO op_id dedupe = idempotent), then the reporting row.
    await walletOp(env, attr.affiliate_uid, {
      op: "earn", uid: attr.affiliate_uid, amount: aff, commission: 0,
      app_name: APP, counterparty_uid: referredUid, ref: topupId, op_id: commId,
      ledger: {
        debit: ACCT_PLATFORM_FEES, credit: acctUser(attr.affiliate_uid),
        type: "affiliate_topup_commission", ref: topupId,
        meta: JSON.stringify({ link_id: attr.link_id, topup_id: topupId, coins: gross, rate: TOPUP_AFFILIATE_RATE }),
      },
    });
    const ins = await env.DB_WALLET.prepare(
      `INSERT INTO affiliate_commissions (id, order_id, link_id, affiliate_uid, referred_uid, listing_id, app, gross_coins, affiliate_coins, admin_coins, reversed_coins, status, created_at)
       VALUES (?1,?2,?3,?4,?5,'topup','avawallet',?6,?7,0,0,'held',?8) ON CONFLICT(id) DO NOTHING`,
    ).bind(commId, topupId, attr.link_id, attr.affiliate_uid, referredUid, gross, aff, Date.now()).run();
    if ((ins.meta?.changes ?? 0) > 0) {
      track(env, attr.affiliate_uid, "affiliate_topup_commission", APP, { coins: gross, affiliate_coins: aff, rate: TOPUP_AFFILIATE_RATE });
      metric(env, "affiliate_topup_commission", [aff, gross]);
    }
    return aff;
  } catch (e) {
    console.error("payAffiliateOnTopup failed:", String(e));
    return 0;
  }
}

export async function settleAffiliate(env: Env, p: {
  settlementId: string;          // the settlement_log id (or `avv:<session>` for AvaVoice)
  orderId: string;               // escrow order ref (clawback lookup)
  app: "avalive" | "avaconsult" | "avavoice";
  gross: number;                 // coins actually released in THIS settlement
  platformCut: number;           // the platform fee taken in this settlement (cap)
  buyerId?: string;              // resolved from `orders` when omitted
  listingId?: string;
  creatorId?: string;
}): Promise<number> {
  // PURCHASE COMMISSIONS RETIRED (2026-06-18). Affiliates now earn 10% of their
  // referred users' TOP-UPS for life (payAffiliateOnTopup) instead of a cut of
  // listing purchases. No-op so the existing callers (money_engine, avavision,
  // avavoice) keep compiling without paying purchase commissions.
  return 0;
}

/** Refund/reversal mirror (§6): claw back PROPORTIONALLY to the refunded share
 *  of gross. Comes out of the 7-day hold first (the normal case — holds exist
 *  precisely as the refund-fraud window), spendable balance for any remainder. */
export async function reverseAffiliate(env: Env, orderId: string, refundAmount: number, reason: string, opId: string): Promise<number> {
  try {
    const refund = Math.trunc(Number(refundAmount));
    if (!(refund > 0)) return 0;
    const rows = await env.DB_WALLET.prepare(
      "SELECT * FROM affiliate_commissions WHERE order_id=?1 AND status!='reversed'",
    ).bind(orderId).all();
    let clawedTotal = 0;
    for (const c of (rows.results ?? []) as any[]) {
      const grossC = Number(c.gross_coins);
      const remaining = Number(c.affiliate_coins) - Number(c.reversed_coins);
      if (!(grossC > 0) || !(remaining > 0)) continue;
      const claw = Math.min(remaining, Math.floor(Number(c.affiliate_coins) * Math.min(refund, grossC) / grossC));
      if (!(claw > 0)) continue;

      // Hold-first clawback; any matured remainder comes from spendable balance.
      const dh = await walletOp(env, String(c.affiliate_uid), {
        op: "debit_hold", uid: String(c.affiliate_uid), amount: claw,
        app_name: APP, ref: String(c.id), op_id: `affrev:${c.id}:${opId}`,
        ledger: {
          debit: acctUser(String(c.affiliate_uid)), credit: ACCT_PLATFORM_FEES,
          type: "affiliate_commission_reversal", ref: String(c.id),
          meta: JSON.stringify({ order_id: orderId, refund, claw, reason }),
        },
      });
      const fromHold = Number(dh.body?.clawed ?? 0);
      const rest = dh.body?.duplicate ? 0 : claw - fromHold;
      if (rest > 0) {
        await walletOp(env, String(c.affiliate_uid), {
          op: "spend", uid: String(c.affiliate_uid), amount: rest,
          app_name: APP, ref: String(c.id), op_id: `affrev:${c.id}:${opId}:rest`,
          ledger: {
            debit: acctUser(String(c.affiliate_uid)), credit: ACCT_PLATFORM_FEES,
            type: "affiliate_commission_reversal", ref: String(c.id),
            meta: JSON.stringify({ order_id: orderId, refund, claw: rest, reason, matured: true }),
          },
        });
      }
      const reversed = Number(c.reversed_coins) + claw;
      await env.DB_WALLET.prepare(
        "UPDATE affiliate_commissions SET reversed_coins=?2, status=CASE WHEN ?2>=affiliate_coins THEN 'reversed' ELSE status END WHERE id=?1",
      ).bind(String(c.id), reversed).run();
      clawedTotal += claw;
      track(env, String(c.affiliate_uid), "affiliate_commission_reversed", APP, {
        link_id: String(c.link_id), affiliate_uid: String(c.affiliate_uid),
        listing_id: String(c.listing_id), app: String(c.app),
        gross_coins: grossC, affiliate_coins: claw, reason,
      });
      metric(env, "affiliate_commission_reversed", [claw], [String(c.app)]);
    }
    return clawedTotal;
  } catch (e) {
    console.error("reverseAffiliate failed:", String(e));
    return 0;
  }
}
