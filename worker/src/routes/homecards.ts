// [AVA-SHELL-5] Home dashboard card aggregates — Phase 3. ONE precomputed response
// for the Home cards (plan §3 + card contract §8), so Home rendering NEVER queries
// PostHog directly and never fans out to N endpoints. DARK behind the `shellV2`
// flag (config.ts DEFAULTS, default false): the route 403s while OFF, same as the
// spam routes.
//
// Sources are ALL existing D1 tables, read-only (no new writes, no schema):
//   earnings  — env.DB_WALLET earning_holds (uid, amount, created_at). Reuses the
//               same table walletEarnings() reads.
//   visitors  — metaSession listing_views (creator_id, ts, country, city), the
//               server-truth view log insights.ts already maintains. The table
//               EXISTS, so {available:true}. (If it were ever removed, the card
//               degrades to {available:false} — the app hides it.)
//   listings  — metaSession listings (creator_id, title, status) joined to a 7d
//               listing_views count; top 3 by 7d views.
//
// The whole response is cached per-uid via the Cache API (TTL 10 min), so a Home
// open is at most one cold aggregate every 10 minutes and a cache hit otherwise.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaSession } from "../db/shard";
import { readConfig } from "./config";

const DAY = 86_400_000;
const CARDS_CACHE_TTL_S = 10 * 60; // 10 min — Home aggregates are not real-time

/** True when shellV2 is enabled in KV `platform_config` (fail-closed → dark). */
async function shellOn(env: Env): Promise<boolean> {
  try {
    return (await readConfig(env)).shellV2 === true;
  } catch {
    return false;
  }
}

const off = () => json({ error: "shell v2 disabled" }, 403);

interface EarningsAgg {
  today: number;
  week: number;
  month: number;
  series7d: number[]; // oldest→newest, one bucket per day (7 entries)
}

async function earningsFor(env: Env, uid: string, now: number): Promise<EarningsAgg> {
  const empty: EarningsAgg = { today: 0, week: 0, month: 0, series7d: [0, 0, 0, 0, 0, 0, 0] };
  try {
    const startOfToday = now - (now % DAY); // UTC midnight bucket (matches series buckets)
    const head = await env.DB_WALLET.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= ?2 THEN amount ELSE 0 END), 0) AS today,
         COALESCE(SUM(CASE WHEN created_at >= ?3 THEN amount ELSE 0 END), 0) AS week,
         COALESCE(SUM(CASE WHEN created_at >= ?4 THEN amount ELSE 0 END), 0) AS month
       FROM earning_holds WHERE uid = ?1`,
    )
      .bind(uid, startOfToday, now - 7 * DAY, now - 30 * DAY)
      .first<{ today: number; week: number; month: number }>();

    // 7-day series bucketed by UTC day (oldest first). date() groups; we backfill
    // the missing days with 0 so the bar chart always has exactly 7 columns.
    const rows = await env.DB_WALLET.prepare(
      `SELECT date(created_at/1000,'unixepoch') AS day, COALESCE(SUM(amount),0) AS coins
         FROM earning_holds WHERE uid = ?1 AND created_at > ?2
        GROUP BY day`,
    )
      .bind(uid, now - 7 * DAY)
      .all<{ day: string; coins: number }>();
    const byDay = new Map<string, number>();
    for (const r of rows.results ?? []) byDay.set(r.day, Number(r.coins));

    const series: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * DAY).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      series.push(byDay.get(d) ?? 0);
    }
    return {
      today: Number(head?.today ?? 0),
      week: Number(head?.week ?? 0),
      month: Number(head?.month ?? 0),
      series7d: series,
    };
  } catch (e) {
    console.error("[home/cards] earnings failed", String(e));
    return empty;
  }
}

interface VisitorsAgg {
  available: boolean;
  total7d?: number;
  byCountry?: { country: string; views: number }[];
  byCity?: { city: string; views: number }[];
}

async function visitorsFor(env: Env, uid: string, now: number): Promise<VisitorsAgg> {
  // listing_views IS a D1 table (insights.recordView writes it), so visitor data
  // is available server-side without touching PostHog. If the query throws we
  // degrade to {available:false} and the app hides the card.
  try {
    const db = metaSession(env);
    const since = now - 7 * DAY;
    const total = await db
      .prepare(`SELECT COUNT(*) AS n FROM listing_views WHERE creator_id=?1 AND ts>?2`)
      .bind(uid, since)
      .first<{ n: number }>();
    const byCountry = await db
      .prepare(
        `SELECT COALESCE(country,'??') AS country, COUNT(*) AS views
           FROM listing_views WHERE creator_id=?1 AND ts>?2
          GROUP BY country ORDER BY views DESC LIMIT 5`,
      )
      .bind(uid, since)
      .all<{ country: string; views: number }>();
    const byCity = await db
      .prepare(
        `SELECT city, COUNT(*) AS views
           FROM listing_views WHERE creator_id=?1 AND ts>?2 AND city IS NOT NULL AND city<>''
          GROUP BY city ORDER BY views DESC LIMIT 5`,
      )
      .bind(uid, since)
      .all<{ city: string; views: number }>();
    return {
      available: true,
      total7d: Number(total?.n ?? 0),
      byCountry: (byCountry.results ?? []).map((r) => ({ country: r.country, views: Number(r.views) })),
      byCity: (byCity.results ?? []).map((r) => ({ city: r.city, views: Number(r.views) })),
    };
  } catch (e) {
    console.error("[home/cards] visitors unavailable", String(e));
    return { available: false };
  }
}

interface ListingRow {
  id: string;
  title: string;
  kind: string | null;
  status: string;
  joined_count: number;
  views7d: number;
}

async function listingsFor(env: Env, uid: string, now: number): Promise<ListingRow[]> {
  try {
    const db = metaSession(env);
    const since = now - 7 * DAY;
    // Top 3 owned listings by 7-day views (LEFT JOIN so a listing with 0 views can
    // still surface, ranked below any with traffic). bookings ≈ joined_count.
    const rows = await db
      .prepare(
        `SELECT l.id AS id, l.title AS title, l.kind AS kind, l.status AS status,
                l.joined_count AS joined_count,
                (SELECT COUNT(*) FROM listing_views v
                   WHERE v.subject_id=l.id AND v.ts>?2) AS views7d
           FROM listings l
          WHERE l.creator_id=?1 AND l.status IN ('published','live','completed')
          ORDER BY views7d DESC, l.joined_count DESC
          LIMIT 3`,
      )
      .bind(uid, since)
      .all<ListingRow>();
    return (rows.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      joined_count: Number(r.joined_count ?? 0),
      views7d: Number(r.views7d ?? 0),
    }));
  } catch (e) {
    console.error("[home/cards] listings failed", String(e));
    return [];
  }
}

// GET /api/home/cards — one precomputed aggregate for the Home dashboard cards.
// Cached per-uid via the Cache API (10 min TTL). Home NEVER hits PostHog.
export async function homeCards(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await shellOn(env))) return off();
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const uid = auth.uid;

  // Cache key is per-uid (no auth in the key — the value is this user's private
  // aggregate, so the key namespaces it by uid on the shared edge cache).
  const cacheKey = new Request(`https://homecards-cache.avatok.internal/cards/${uid}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const now = Date.now();
  const [earnings, visitors, listings] = await Promise.all([
    earningsFor(env, uid, now),
    visitorsFor(env, uid, now),
    listingsFor(env, uid, now),
  ]);

  const body = {
    updated_ms: now,
    earnings,
    visitors,
    listings: { top: listings },
  };

  const res = json(body);
  const toCache = new Response(res.clone().body, res);
  toCache.headers.set("cache-control", `private, max-age=${CARDS_CACHE_TTL_S}`);
  ctx.waitUntil(cache.put(cacheKey, toCache));
  return res;
}
