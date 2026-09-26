// [ADMIN2-API 2026-09-26] Admin 2 (Saa Thum's own admin dashboard) API.
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md. Every route is admin-only
// (requireAdmin from routes/admin_money.ts → env.ADMIN_UIDS). Money on the wire is
// integer PAISE. Errors are { error, message } with a real status; unexpected failures
// go to PostHog through hooks.trackException — no silent catch.
//
// index.ts sends `/api/admin/whoami` and every `/api/admin/v2/*` path here. Handlers
// live in their own files; each area registers its routes in ONE marked section of the
// ROUTES table below (a spread of an exported array, or one line per route).
import type { Env } from "../types";
import { json } from "../util";
import { trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { notStuckLiveSql } from "../lib/listing_schedule";
import { SMOKE_LISTING_ID, startsMsSql, coverImageUrl } from "../lib/me_dashboard_data";
import { ADMIN2_EVENT_ROUTES } from "./admin2_events"; // [ADMIN2-EVENTS]
import { ADMIN2_PEOPLE_ROUTES } from "./admin2_people"; // [ADMIN2-PEOPLE] agent C

const APP = "saathum";

export const admin2Err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

/** requireAdmin with the Admin 2 error shape: 401 {error:"unauthorized"}, 403 {error:"admin_only"}. */
export async function adminGuard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403
      ? admin2Err(403, "admin_only", "You don't have admin access.")
      : admin2Err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

export type Admin2Handler = (req: Request, env: Env, params: string[]) => Promise<Response>;
export type Admin2Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** `path` is an exact string, or a RegExp whose capture groups arrive (URI-decoded) as `params`. */
export interface Admin2RouteDef { method: Admin2Method; path: string | RegExp; handler: Admin2Handler }

// ---------------------------------------------------------------------------
// Time windows (IST calendar days; India has no DST, so a fixed +05:30 offset is exact).
// ---------------------------------------------------------------------------
export const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Epoch ms of 00:00 IST on the IST calendar day that contains `now`. */
export function istDayStart(now: number): number {
  return Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

export interface OverviewWindows {
  now: number; todayStart: number; tomorrowStart: number;
  /** Events: today + the next 6 IST days, i.e. [todayStart, todayStart + 7d). */
  weekEnd: number;
  /** Bookings / revenue look BACK: the last 7 and 30 IST days including today. */
  last7Start: number; last30Start: number;
}

export function overviewWindows(now: number): OverviewWindows {
  const todayStart = istDayStart(now);
  return {
    now, todayStart, tomorrowStart: todayStart + DAY_MS, weekEnd: todayStart + 7 * DAY_MS,
    last7Start: todayStart - 6 * DAY_MS, last30Start: todayStart - 29 * DAY_MS,
  };
}

// ---------------------------------------------------------------------------
// Overview read models (DB_META). Same sources as lib/me_dashboard_data.ts
// (orders + commercial_policy_snapshots + hdfc_sms_payment_intents + listings + refunds),
// admin-wide instead of one account. The internal ₹1 smoke listing and example
// listings are never counted.
// ---------------------------------------------------------------------------
const REAL_LISTING = (a: string) => `${a}.kind='live_event' AND ${a}.id<>'${SMOKE_LISTING_ID}' AND COALESCE(${a}.is_example,0)=0`;

/** Binds: ?1 todayStart, ?2 tomorrowStart, ?3 weekEnd. Events that happen (or happened) in the window. */
export const OVERVIEW_EVENTS_SQL = `
SELECT COALESCE(SUM(CASE WHEN s>=?1 AND s<?2 THEN 1 ELSE 0 END),0) AS events_today,
       COALESCE(SUM(CASE WHEN s>=?1 AND s<?3 THEN 1 ELSE 0 END),0) AS events_7d
  FROM (SELECT ${startsMsSql("l")} AS s FROM listings l
         WHERE ${REAL_LISTING("l")} AND l.status IN ('published','live','completed')) x
 WHERE s IS NOT NULL AND s>=?1 AND s<?3`;

/**
 * Seats booked (orders created) — paid or free, not refunded/failed. Binds: ?1 todayStart, ?2 last7Start.
 * A seat that was later refunded drops out (orders.status becomes 'refunded').
 */
export const OVERVIEW_BOOKINGS_SQL = `
SELECT COALESCE(SUM(CASE WHEN o.created_at>=?1 THEN 1 ELSE 0 END),0) AS bookings_today,
       COALESCE(COUNT(*),0) AS bookings_7d
  FROM orders o JOIN listings l ON l.id=o.listing_id
 WHERE ${REAL_LISTING("l")} AND o.status IN ('held','free','released') AND o.created_at>=?2`;

const orderIntent = (col: string) =>
  `(SELECT h.${col} FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
     ORDER BY (h.status='confirmed') DESC, h.updated_at DESC LIMIT 1)`;

/**
 * Revenue = what buyers actually paid (the confirmed UPI intent's amount_paise, else the
 * policy snapshot's gross + GST, else orders.amount) on paid seats, by the moment it was
 * paid, minus nothing else — a seat whose refund was recorded (orders.status='refunded'
 * or a refunds row status='refunded') is excluded. A pending refund REQUEST still counts
 * (the money has not left). Binds: ?1 todayStart, ?2 last7Start, ?3 last30Start.
 */
export const OVERVIEW_REVENUE_SQL = `
WITH paid AS (
  SELECT COALESCE(${orderIntent("intent_id")}, o.id) AS payment_id,
         COALESCE(${orderIntent("amount_paise")},
                  (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100) AS amount_paise,
         COALESCE((SELECT h.updated_at FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
                     AND h.status='confirmed' ORDER BY h.updated_at DESC LIMIT 1), o.created_at) AS paid_at
    FROM orders o
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
   WHERE o.amount>0 AND o.status IN ('held','released') AND o.listing_id<>'${SMOKE_LISTING_ID}'
)
SELECT COALESCE(SUM(CASE WHEN paid_at>=?1 THEN amount_paise ELSE 0 END),0) AS revenue_today_paise,
       COALESCE(SUM(CASE WHEN paid_at>=?2 THEN amount_paise ELSE 0 END),0) AS revenue_7d_paise,
       COALESCE(SUM(amount_paise),0) AS revenue_30d_paise
  FROM paid
 WHERE paid_at>=?3
   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=paid.payment_id AND r.status='refunded')`;

export const OVERVIEW_REFUNDS_SQL = `
SELECT COUNT(*) AS open_refunds, COALESCE(SUM(amount_paise),0) AS open_refunds_paise
  FROM refunds WHERE status='requested'`;

/**
 * UPI payments a customer has started or sent that have not become a seat yet:
 * received/under review, or still pending inside their window. Binds: ?1 now.
 */
export const OVERVIEW_PENDING_SQL = `
SELECT COUNT(*) AS pending_payments, COALESCE(SUM(h.amount_paise),0) AS pending_paise,
       COALESCE(SUM(CASE WHEN h.status IN ('payment_received','review_pending') THEN 1 ELSE 0 END),0) AS pending_review
  FROM hdfc_sms_payment_intents h
 WHERE h.commercial_order_id IS NULL AND h.listing_id<>'${SMOKE_LISTING_ID}'
   AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?1))`;

/** Live now (and not stuck) first, then the soonest upcoming. Binds: ?1 now. */
export const OVERVIEW_NEXT_EVENTS_SQL = `
SELECT l.id, l.title, l.category, c.label AS category_label, l.status, l.starts_at, l.duration_min,
       l.capacity, l.price, l.free_entry, l.cover_media,
       ${startsMsSql("l")} AS starts_ms,
       (SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.status IN ('held','free','released')) AS booked
  FROM listings l LEFT JOIN listing_categories c ON c.id=l.category
 WHERE ${REAL_LISTING("l")} AND l.status IN ('published','live')
   AND ((l.status='live' AND ${notStuckLiveSql("l", "?1")}) OR ${startsMsSql("l")} > ?1)
 ORDER BY (l.status='live') DESC, starts_ms ASC
 LIMIT 8`;

export interface OverviewEvent {
  id: string; title: string; category: string | null; category_label: string | null; status: string;
  live: boolean; starts_at: number | null; duration_min: number | null; capacity: number | null;
  booked: number; price_paise: number; image_url: string | null; admin_url: string; public_url: string;
}

export function shapeOverviewEvent(r: any): OverviewEvent {
  const id = String(r.id);
  return {
    id, title: String(r.title ?? ""), category: r.category ?? null, category_label: r.category_label ?? null,
    status: String(r.status ?? ""), live: r.status === "live",
    starts_at: r.starts_ms != null ? Number(r.starts_ms) : null,
    duration_min: r.duration_min != null ? Number(r.duration_min) : null,
    capacity: r.capacity != null ? Number(r.capacity) : null,
    booked: Number(r.booked ?? 0),
    price_paise: Number(r.free_entry) === 1 ? 0 : Math.max(0, Math.round(Number(r.price ?? 0) * 100)),
    image_url: coverImageUrl(r.cover_media),
    admin_url: `/admin/events/${encodeURIComponent(id)}`,
    public_url: `/book/${encodeURIComponent(id)}`,
  };
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };

// ---------------------------------------------------------------------------
// GET /api/admin/whoami → { admin: true, uid, email }  (403 {error:"admin_only"} otherwise)
// ---------------------------------------------------------------------------
export async function adminWhoami(req: Request, env: Env): Promise<Response> {
  const a = await adminGuard(req, env); if (a instanceof Response) return a;
  const email = await emailFor(env, a.uid).catch(() => null);
  return json({ admin: true, uid: a.uid, email: email ?? null });
}

// ---------------------------------------------------------------------------
// GET /api/admin/v2/overview
// ---------------------------------------------------------------------------
export async function adminOverview(req: Request, env: Env): Promise<Response> {
  const a = await adminGuard(req, env); if (a instanceof Response) return a;
  const w = overviewWindows(Date.now());
  const db = env.DB_META;
  const [ev, bk, rev, rf, pend, next] = await Promise.all([
    db.prepare(OVERVIEW_EVENTS_SQL).bind(w.todayStart, w.tomorrowStart, w.weekEnd).first<any>(),
    db.prepare(OVERVIEW_BOOKINGS_SQL).bind(w.todayStart, w.last7Start).first<any>(),
    db.prepare(OVERVIEW_REVENUE_SQL).bind(w.todayStart, w.last7Start, w.last30Start).first<any>(),
    db.prepare(OVERVIEW_REFUNDS_SQL).first<any>(),
    db.prepare(OVERVIEW_PENDING_SQL).bind(w.now).first<any>(),
    db.prepare(OVERVIEW_NEXT_EVENTS_SQL).bind(w.now).all<any>(),
  ]);
  return json({
    generated_at: w.now,
    windows: { today_start: w.todayStart, week_end: w.weekEnd, last7_start: w.last7Start, last30_start: w.last30Start },
    kpis: {
      events_today: num(ev?.events_today), events_7d: num(ev?.events_7d),
      bookings_today: num(bk?.bookings_today), bookings_7d: num(bk?.bookings_7d),
      revenue_today_paise: num(rev?.revenue_today_paise), revenue_7d_paise: num(rev?.revenue_7d_paise),
      revenue_30d_paise: num(rev?.revenue_30d_paise),
      open_refunds: num(rf?.open_refunds), open_refunds_paise: num(rf?.open_refunds_paise),
      pending_payments: num(pend?.pending_payments), pending_payments_paise: num(pend?.pending_paise),
      pending_review: num(pend?.pending_review),
    },
    next_events: (next?.results ?? []).map(shapeOverviewEvent),
  }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// Route table. ONE marked section per area; keep registrations to a line each.
// ---------------------------------------------------------------------------
export const ADMIN2_ROUTES: Admin2RouteDef[] = [
  // --- shell + overview (agent A) ---
  { method: "GET", path: "/api/admin/whoami", handler: adminWhoami },
  { method: "GET", path: "/api/admin/v2/overview", handler: adminOverview },
  // --- events (agent B) ---
  ...ADMIN2_EVENT_ROUTES,
  // --- bookings/payments/customers (agent C) ---
  ...ADMIN2_PEOPLE_ROUTES,
];

/** Match a path against the table. Exported for tests. */
export function matchAdmin2(method: string, p: string, routes: Admin2RouteDef[] = ADMIN2_ROUTES):
  { route: Admin2RouteDef; params: string[] } | { methodNotAllowed: true } | null {
  let pathHit = false;
  for (const route of routes) {
    let params: string[] | null = null;
    if (typeof route.path === "string") params = route.path === p ? [] : null;
    else {
      const m = route.path.exec(p);
      if (m && m[0] === p) {
        try { params = m.slice(1).map((s) => (s === undefined ? "" : decodeURIComponent(s))); } catch { params = null; }
      }
    }
    if (!params) continue;
    pathHit = true;
    if (route.method === method) return { route, params };
  }
  return pathHit ? { methodNotAllowed: true } : null;
}

/** Dispatcher for `/api/admin/whoami` and `/api/admin/v2/*`; null when nothing matched. */
export async function admin2Route(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method.toUpperCase();
  const hit = matchAdmin2(m, p);
  if (!hit) return null;
  if ("methodNotAllowed" in hit) return admin2Err(405, "method_not_allowed", "That action isn't supported here.");
  try {
    return await hit.route.handler(req, env, hit.params);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "admin2" } });
    return admin2Err(500, "internal", "Something went wrong. Please try again.");
  }
}
