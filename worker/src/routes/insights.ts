// Creator analytics (2026-06-11) — shared by AvaLive/AvaConsult (listings)
// and AvaVoice (voice agents).
//
//   recordView()                       server-truth view log (D1 listing_views)
//                                      + PostHog mirror with geo + age group
//   GET /api/listings/:id/stats        per-listing creator dashboard (owner)
//   GET /api/creators/me/stats         cross-listing rollup (owner)
//
// Geo comes from Cloudflare's edge (request.cf) — no client work, no IP
// stored. Age group is a coarse bracket from the OPTIONAL self-declared
// users.birth_year; raw birth year never rides an event.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track } from "../hooks";

/** Edge geo for the current request (Cloudflare populates request.cf). */
export function geoOf(req: Request): { country: string | null; city: string | null; region: string | null; timezone: string | null } {
  const cf = (req as any).cf ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { country: s(cf.country), city: s(cf.city), region: s(cf.region), timezone: s(cf.timezone) };
}

/** Coarse age bracket from a self-declared birth year (privacy: never raw). */
export function ageGroup(birthYear: number | null | undefined): string | null {
  const y = Number(birthYear);
  if (!(y >= 1900 && y <= new Date().getFullYear())) return null;
  const age = new Date().getFullYear() - y;
  if (age < 13) return null;
  if (age < 18) return "13-17";
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  if (age < 55) return "45-54";
  if (age < 65) return "55-64";
  return "65+";
}

async function viewerAgeGroup(env: Env, uid: string | null): Promise<string | null> {
  if (!uid) return null;
  try {
    const r = await metaSession(env).prepare("SELECT birth_year FROM users WHERE uid=?1").bind(uid).first<{ birth_year: number | null }>();
    return ageGroup(r?.birth_year);
  } catch { return null; }
}

/**
 * Log one detail view: D1 row (creator dashboard) + PostHog event (admin).
 * Owner views are skipped by callers. Best-effort — never breaks the read.
 */
export async function recordView(env: Env, req: Request, v: {
  kind: "listing" | "voice_agent";
  subjectId: string;
  creatorId: string;
  viewerUid: string | null;
  app: string;                       // 'avaexplore' | 'avavoice'
  source?: string | null;
  extra?: Record<string, unknown>;   // listing kind, price, status …
}): Promise<void> {
  try {
    const g = geoOf(req);
    const ag = await viewerAgeGroup(env, v.viewerUid);
    await metaDb(env).prepare(
      `INSERT INTO listing_views (id, subject_kind, subject_id, creator_id, viewer_uid, country, city, region, age_group, source, ts)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(crypto.randomUUID(), v.kind, v.subjectId, v.creatorId, v.viewerUid, g.country, g.city, g.region, ag, v.source ?? null, Date.now()).run();
    track(env, v.viewerUid ?? "guest", v.kind === "voice_agent" ? "avavoice_agent_viewed" : "listing_viewed", v.app, {
      subject_id: v.subjectId, creator_id: v.creatorId, guest: !v.viewerUid,
      country: g.country, city: g.city, region: g.region, timezone: g.timezone,
      age_group: ag, source: v.source ?? null, ...(v.extra ?? {}),
    });
  } catch { /* best-effort */ }
}

/** Feed-impression mirror (one event per page of results, not per card). */
export function trackImpressions(env: Env, req: Request, uid: string | null, app: string, surface: string, ids: string[]): void {
  if (!ids.length) return;
  const g = geoOf(req);
  track(env, uid ?? "guest", "listing_impressions", app, {
    surface, ids: ids.slice(0, 50), n: ids.length, guest: !uid,
    country: g.country, city: g.city, region: g.region,
  });
}

// ---------------------------------------------------------------------------
// dashboards
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

interface ViewAgg {
  total: number; last7d: number; last30d: number; unique_viewers: number; guests: number;
  by_day: { day: string; views: number }[];
  by_country: { country: string; views: number }[];
  by_age_group: { age_group: string; views: number }[];
  by_source: { source: string; views: number }[];
}

async function viewAgg(env: Env, where: string, binds: unknown[]): Promise<ViewAgg> {
  const db = metaSession(env);
  const now = Date.now();
  const since30 = now - 30 * DAY;
  const b30 = [...binds, since30];
  const head = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(ts > ?${binds.length + 1}) AS last7d,
            COUNT(DISTINCT viewer_uid) AS uniq,
            SUM(viewer_uid IS NULL) AS guests
       FROM listing_views WHERE ${where}`,
  ).bind(...binds, now - 7 * DAY).first<any>();
  const last30 = await db.prepare(
    `SELECT COUNT(*) AS n FROM listing_views WHERE ${where} AND ts > ?${binds.length + 1}`,
  ).bind(...b30).first<{ n: number }>();
  const byDay = await db.prepare(
    `SELECT date(ts/1000,'unixepoch') AS day, COUNT(*) AS views
       FROM listing_views WHERE ${where} AND ts > ?${binds.length + 1}
      GROUP BY day ORDER BY day`,
  ).bind(...b30).all();
  const byCountry = await db.prepare(
    `SELECT COALESCE(country,'??') AS country, COUNT(*) AS views
       FROM listing_views WHERE ${where} AND ts > ?${binds.length + 1}
      GROUP BY country ORDER BY views DESC LIMIT 12`,
  ).bind(...b30).all();
  const byAge = await db.prepare(
    `SELECT age_group, COUNT(*) AS views
       FROM listing_views WHERE ${where} AND ts > ?${binds.length + 1} AND age_group IS NOT NULL
      GROUP BY age_group ORDER BY age_group`,
  ).bind(...b30).all();
  const bySource = await db.prepare(
    `SELECT COALESCE(source,'direct') AS source, COUNT(*) AS views
       FROM listing_views WHERE ${where} AND ts > ?${binds.length + 1}
      GROUP BY source ORDER BY views DESC LIMIT 8`,
  ).bind(...b30).all();
  return {
    total: Number(head?.total ?? 0), last7d: Number(head?.last7d ?? 0),
    last30d: Number(last30?.n ?? 0),
    unique_viewers: Number(head?.uniq ?? 0), guests: Number(head?.guests ?? 0),
    by_day: (byDay.results ?? []) as any[],
    by_country: (byCountry.results ?? []) as any[],
    by_age_group: (byAge.results ?? []) as any[],
    by_source: (bySource.results ?? []) as any[],
  };
}

// GET /api/listings/:id/stats — owner-only per-listing dashboard.
export async function listingStats(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaSession(env);
  const l = await db.prepare("SELECT creator_id, kind, title, status, price, joined_count, rating_avg, rating_count FROM listings WHERE id=?1").bind(id).first<any>();
  if (!l || l.creator_id !== ctx.uid) return json({ error: "not found" }, 404);

  const views = await viewAgg(env, "subject_kind='listing' AND subject_id=?1", [id]);
  const orders = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross,
            SUM(created_at > ?2) AS n30, COALESCE(SUM(CASE WHEN created_at > ?2 THEN amount ELSE 0 END),0) AS gross30
       FROM orders WHERE listing_id=?1 AND status IN ('held','released','free')`,
  ).bind(id, Date.now() - 30 * DAY).first<any>();
  const bookings = Number(orders?.n ?? 0);
  track(env, ctx.uid, "creator_listing_stats_viewed", "avaexplore", { listing: id, kind: l.kind });
  return json({
    listing: { id, kind: l.kind, title: l.title, status: l.status, price: Number(l.price), joined_count: Number(l.joined_count ?? 0), rating_avg: l.rating_avg != null ? Number(l.rating_avg) : null, rating_count: Number(l.rating_count ?? 0) },
    views,
    bookings: { total: bookings, last30d: Number(orders?.n30 ?? 0), gross_coins: Number(orders?.gross ?? 0), gross_coins_30d: Number(orders?.gross30 ?? 0) },
    conversion_pct: views.total > 0 ? Math.round((bookings / views.total) * 1000) / 10 : null,
  });
}

// GET /api/creators/me/stats — cross-listing rollup (all three products feed
// listing_views; AvaVoice agents appear with subject_kind='voice_agent').
export async function creatorStats(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const db = metaSession(env);
  const views = await viewAgg(env, "creator_id=?1", [ctx.uid]);
  const since30 = Date.now() - 30 * DAY;

  // Per-subject rollup (top 20 by 30-day views) with titles joined per kind.
  const per = await db.prepare(
    `SELECT subject_kind, subject_id, COUNT(*) AS views
       FROM listing_views WHERE creator_id=?1 AND ts > ?2
      GROUP BY subject_kind, subject_id ORDER BY views DESC LIMIT 20`,
  ).bind(ctx.uid, since30).all();
  const rows = (per.results ?? []) as any[];
  const titled: any[] = [];
  for (const r of rows) {
    let title: string | null = null, kind = String(r.subject_kind);
    try {
      if (kind === "voice_agent") {
        const a = await db.prepare("SELECT name FROM avavoice_agents WHERE id=?1").bind(r.subject_id).first<any>();
        title = a?.name ?? null;
      } else {
        const l = await db.prepare("SELECT title, kind FROM listings WHERE id=?1").bind(r.subject_id).first<any>();
        title = l?.title ?? null; if (l?.kind) kind = String(l.kind);
      }
    } catch { /* keep null */ }
    titled.push({ subject_id: r.subject_id, kind, title, views_30d: Number(r.views) });
  }

  const orders = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross,
            SUM(created_at > ?2) AS n30, COALESCE(SUM(CASE WHEN created_at > ?2 THEN amount ELSE 0 END),0) AS gross30
       FROM orders WHERE creator_id=?1 AND status IN ('held','released','free')`,
  ).bind(ctx.uid, since30).first<any>();
  const voice = await db.prepare(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(creator_coins),0) AS net
       FROM avavoice_sessions WHERE agent_id IN (SELECT id FROM avavoice_agents WHERE creator_id=?1) AND status='ended' AND started_at > ?2`,
  ).bind(ctx.uid, since30).first<any>().catch(() => null);
  const followers = await db.prepare("SELECT follower_count FROM creator_profiles WHERE user_id=?1").bind(ctx.uid).first<any>();

  const bookings = Number(orders?.n ?? 0);
  track(env, ctx.uid, "creator_insights_viewed", "avaexplore", {});
  return json({
    views,
    listings: titled,
    bookings: { total: bookings, last30d: Number(orders?.n30 ?? 0), gross_coins: Number(orders?.gross ?? 0), gross_coins_30d: Number(orders?.gross30 ?? 0) },
    voice_calls_30d: { calls: Number(voice?.calls ?? 0), net_coins: Number(voice?.net ?? 0) },
    follower_count: Number(followers?.follower_count ?? 0),
    conversion_pct: views.total > 0 ? Math.round((bookings / views.total) * 1000) / 10 : null,
  });
}
