// [ADMIN2-ANALYTICS 2026-09-26] Admin 2 landing page ("Analytics") read model.
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md. Registered with ONE line in routes/admin2.ts.
//
//   GET /api/admin/v2/analytics?range=today|7d|30d|90d            (preset, default 30d)
//   GET /api/admin/v2/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD      (custom, both inclusive)
//                              &tz=Asia/Kolkata                     (the only zone supported)
//
// Days are IST calendar days (India has no DST: a fixed +05:30 offset is exact). The
// previous period is the same number of days immediately before `from`; every KPI
// carries { cur, prev } so the page can show a delta. Money is integer PAISE.
//
// METRIC DEFINITIONS (keep in step with the overview in routes/admin2.ts):
//  - Revenue: what the buyer paid, GST included (confirmed UPI intent amount, else the
//    policy snapshot gross + GST, else orders.amount), bucketed by the moment it was paid
//    (confirmed intent's updated_at, else order created_at). A payment whose refund was
//    recorded (orders.status='refunded' or a refunds row 'refunded') is excluded; a refund
//    only REQUESTED still counts. Smoke listing never counts.
//  - Paid bookings: the payments that make up Revenue (one per paid seat).
//  - Unique customers: distinct buyers with at least one such payment.
//  - Avg order value: revenue / paid bookings.
//  - New sign-ups: users rows by users.created_at (ms; seconds tolerated).
//  - Refunds: refunds rows with status 'refunded', by refunded_at (money sent back in
//    the period), count and paise.
//  - Refund rate: of the payments PAID in the period, the share since refunded (count).
//  - Seats booked (bookings chart): orders created on real live events, paid or free, not
//    refunded (same as the overview's "bookings").
//  - Pending payments / open refund requests / live now / upcoming: point-in-time (now).
//  - Funnel: UPI checkouts started in the period (hdfc intents, one per customer+event)
//    → payment sent → confirmed → seat kept (order held/released, not refunded).
//
// No runtime import of routes/admin2.ts values at module top level: admin2.ts imports this
// file, and `adminAnalytics` is a function DECLARATION so the route table can reference it
// in either import order.
import type { Env } from "../types";
import { json } from "../util";
import {
  adminGuard, admin2Err, istDayStart, DAY_MS, OVERVIEW_NEXT_EVENTS_SQL, OVERVIEW_PENDING_SQL,
  OVERVIEW_REFUNDS_SQL, shapeOverviewEvent,
} from "./admin2";
import { notStuckLiveSql } from "../lib/listing_schedule";
import { SMOKE_LISTING_ID, startsMsSql } from "../lib/me_dashboard_data";
import { buildAdminPaymentsQuery, personName } from "../lib/admin2_people_data";
import { buildAdminRefundsQuery } from "../lib/admin_refunds_data";

export const ANALYTICS_TZ = "Asia/Kolkata";
export const ANALYTICS_MAX_DAYS = 366;
export const ANALYTICS_PRESETS = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type AnalyticsPreset = keyof typeof ANALYTICS_PRESETS;

const IST_MS = 330 * 60_000;
const DAY = 86_400_000;
/** IST day index (days since 1970-01-01 IST) of an epoch-ms column/expression. Integer division. */
const dayOf = (expr: string) => `((${expr} + ${IST_MS}) / ${DAY})`;
const REAL_LISTING = (a: string) => `${a}.kind='live_event' AND ${a}.id<>'${SMOKE_LISTING_ID}' AND COALESCE(${a}.is_example,0)=0`;
const orderIntent = (col: string) =>
  `(SELECT h.${col} FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
     ORDER BY (h.status='confirmed') DESC, h.updated_at DESC LIMIT 1)`;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
export interface AnalyticsWindow {
  now: number; preset: AnalyticsPreset | "custom"; days: number;
  from: number; to: number; prevFrom: number; prevTo: number;
  fromDay: string; toDay: string; prevFromDay: string; prevToDay: string;
}

/** Day index → "YYYY-MM-DD". */
export const dayKey = (idx: number) => new Date(idx * DAY).toISOString().slice(0, 10);
/** Epoch ms → IST day index. */
export const istDayIndex = (ms: number) => Math.floor((ms + IST_MS) / DAY);

/** "YYYY-MM-DD" (IST) → epoch ms of 00:00 IST, or null when not a real date. */
export function parseIstDay(s: string | null): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00+05:30`);
  if (!Number.isFinite(ms) || dayKey(istDayIndex(ms)) !== s) return null;
  return ms;
}

export function analyticsWindow(u: URLSearchParams, now: number): AnalyticsWindow | { error: string; message: string } {
  const tz = u.get("tz");
  if (tz && tz !== ANALYTICS_TZ) return { error: "bad_tz", message: `Only ${ANALYTICS_TZ} is supported.` };
  const today = istDayStart(now);
  let from: number, to: number, preset: AnalyticsPreset | "custom";
  const rawFrom = u.get("from"), rawTo = u.get("to");
  if (rawFrom || rawTo) {
    const f = parseIstDay(rawFrom), t = parseIstDay(rawTo ?? rawFrom);
    if (f == null || t == null) return { error: "bad_range", message: "Dates must be YYYY-MM-DD." };
    if (t < f) return { error: "bad_range", message: "The start date is after the end date." };
    from = f; to = t + DAY; preset = "custom";
  } else {
    const r = (u.get("range") ?? "30d") as AnalyticsPreset;
    if (!(r in ANALYTICS_PRESETS)) return { error: "bad_range", message: "Unknown range." };
    const n = ANALYTICS_PRESETS[r];
    from = today - (n - 1) * DAY; to = today + DAY; preset = r;
  }
  const days = Math.round((to - from) / DAY);
  if (days > ANALYTICS_MAX_DAYS) return { error: "bad_range", message: `Pick at most ${ANALYTICS_MAX_DAYS} days.` };
  const prevFrom = from - days * DAY, prevTo = from;
  return {
    now, preset, days, from, to, prevFrom, prevTo,
    fromDay: dayKey(istDayIndex(from)), toDay: dayKey(istDayIndex(to - 1)),
    prevFromDay: dayKey(istDayIndex(prevFrom)), prevToDay: dayKey(istDayIndex(prevTo - 1)),
  };
}

// ---------------------------------------------------------------------------
// SQL (DB_META). Each statement is one aggregate pass; results are rolled up in JS.
// ---------------------------------------------------------------------------

/**
 * Paid money, previous + current period. Binds: ?1 prevFrom, ?2 from, ?3 to.
 * Rows by `k`: 'dl' per (IST day, listing) → v1 revenue paise, v2 kept payments, v3 refunded payments;
 * 'ud' per day → v2 distinct buyers; 'uc' → v1 distinct buyers current, v2 previous.
 */
export const ANALYTICS_MONEY_SQL = `
WITH paid AS (
  SELECT COALESCE(${orderIntent("intent_id")}, o.id) AS payment_id, o.buyer_id AS uid, o.listing_id AS listing_id,
         o.status AS order_status,
         COALESCE(${orderIntent("amount_paise")},
                  (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100) AS amount_paise,
         COALESCE((SELECT h.updated_at FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
                     AND h.status='confirmed' ORDER BY h.updated_at DESC LIMIT 1), o.created_at) AS paid_at
    FROM orders o
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
   WHERE o.amount>0 AND o.status IN ('held','released','refunded') AND o.listing_id<>'${SMOKE_LISTING_ID}'
),
p AS (
  SELECT paid.*, ${dayOf("paid_at")} AS day,
         CASE WHEN order_status='refunded'
                OR EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=paid.payment_id AND r.status='refunded')
              THEN 1 ELSE 0 END AS refunded
    FROM paid WHERE paid_at>=?1 AND paid_at<?3
)
SELECT 'dl' AS k, p.day AS day, p.listing_id AS id, l.title AS title, l.category AS cat, c.label AS cat_label,
       COALESCE(SUM(CASE WHEN p.refunded=0 THEN p.amount_paise ELSE 0 END),0) AS v1,
       COALESCE(SUM(1-p.refunded),0) AS v2, COALESCE(SUM(p.refunded),0) AS v3
  FROM p LEFT JOIN listings l ON l.id=p.listing_id LEFT JOIN listing_categories c ON c.id=l.category
 GROUP BY p.day, p.listing_id
UNION ALL
SELECT 'ud', day, NULL, NULL, NULL, NULL, 0, COUNT(DISTINCT uid), 0 FROM p WHERE refunded=0 GROUP BY day
UNION ALL
SELECT 'uc', NULL, NULL, NULL, NULL, NULL,
       COUNT(DISTINCT CASE WHEN paid_at>=?2 THEN uid END), COUNT(DISTINCT CASE WHEN paid_at<?2 THEN uid END), 0
  FROM p WHERE refunded=0`;

/**
 * Per-IST-day counts, previous + current period. Binds: ?1 prevFrom, ?2 to.
 * 's' sign-ups (n); 'r' refunds sent (n, paise); 'b' seats booked (n, free seats in `paise`).
 */
export const ANALYTICS_DAILY_SQL = `
SELECT 's' AS k, ${dayOf("ts")} AS day, COUNT(*) AS n, 0 AS paise
  FROM (SELECT CASE WHEN created_at < 100000000000 THEN created_at*1000 ELSE created_at END AS ts FROM users) u
 WHERE ts>=?1 AND ts<?2 GROUP BY day
UNION ALL
SELECT 'r', ${dayOf("refunded_at")}, COUNT(*), COALESCE(SUM(amount_paise),0)
  FROM refunds WHERE status='refunded' AND refunded_at>=?1 AND refunded_at<?2 GROUP BY 2
UNION ALL
SELECT 'b', ${dayOf("o.created_at")}, COUNT(*), COALESCE(SUM(CASE WHEN o.status='free' OR o.amount<=0 THEN 1 ELSE 0 END),0)
  FROM orders o JOIN listings l ON l.id=o.listing_id
 WHERE ${REAL_LISTING("l")} AND o.status IN ('held','free','released') AND o.created_at>=?1 AND o.created_at<?2
 GROUP BY 2`;

/**
 * Point-in-time event counts. Binds: ?1 now, ?2 today 00:00 IST, ?3 +14 days, ?4 now + 7 days.
 * 'live' live now (not stuck); 'up' all upcoming; 'up7' upcoming within 7 days; 'ud' events per day (next 14 IST days).
 */
export const ANALYTICS_EVENTS_SQL = `
SELECT 'live' AS k, NULL AS day, COUNT(*) AS n FROM listings l
 WHERE ${REAL_LISTING("l")} AND l.status='live' AND ${notStuckLiveSql("l", "?1")}
UNION ALL
SELECT 'up', NULL, COUNT(*) FROM listings l WHERE ${REAL_LISTING("l")} AND l.status='published' AND ${startsMsSql("l")}>?1
UNION ALL
SELECT 'up7', NULL, COUNT(*) FROM listings l
 WHERE ${REAL_LISTING("l")} AND l.status='published' AND ${startsMsSql("l")}>?1 AND ${startsMsSql("l")}<?4
UNION ALL
SELECT 'ud', ${dayOf("s")}, COUNT(*) FROM (SELECT ${startsMsSql("l")} AS s FROM listings l
  WHERE ${REAL_LISTING("l")} AND l.status IN ('published','live','completed')) x
 WHERE s>=?2 AND s<?3 GROUP BY 2`;

/** UPI checkout funnel for the current period, one step per customer+event. Binds: ?1 from, ?2 to. */
export const ANALYTICS_FUNNEL_SQL = `
SELECT COUNT(DISTINCT h.uid || '|' || h.listing_id) AS started,
       COUNT(DISTINCT CASE WHEN h.status IN ('payment_received','review_pending','confirmed') THEN h.uid || '|' || h.listing_id END) AS sent,
       COUNT(DISTINCT CASE WHEN h.status='confirmed' THEN h.uid || '|' || h.listing_id END) AS confirmed,
       COUNT(DISTINCT CASE WHEN h.status='confirmed' AND h.commercial_order_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM orders o WHERE o.id=h.commercial_order_id AND o.status IN ('held','released'))
             AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id IN (h.intent_id, h.commercial_order_id) AND r.status='refunded')
             THEN h.uid || '|' || h.listing_id END) AS kept
  FROM hdfc_sms_payment_intents h
 WHERE h.listing_id<>'${SMOKE_LISTING_ID}' AND h.created_at>=?1 AND h.created_at<?2`;

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const pair = (cur: number, prev: number) => ({ cur, prev });
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export interface AnalyticsRows { money: any[]; daily: any[]; events: any[]; funnel: any | null }

export function rollUp(w: AnalyticsWindow, r: AnalyticsRows) {
  const d0 = istDayIndex(w.from), p0 = istDayIndex(w.prevFrom);
  const days = Array.from({ length: w.days }, (_, i) => dayKey(d0 + i));
  const zeros = () => new Array<number>(w.days).fill(0);
  // slot: index into the current (0) or previous (1) period arrays.
  const slot = (day: number): [0 | 1, number] | null => {
    if (day >= d0 && day < d0 + w.days) return [0, day - d0];
    if (day >= p0 && day < p0 + w.days) return [1, day - p0];
    return null;
  };
  const S = () => [zeros(), zeros()] as [number[], number[]];
  const rev = S(), paid = S(), refundedPaid = S(), buyers = S(), signups = S(), refunds = S(), refundsPaise = S(),
    seats = S(), freeSeats = S();
  let uniqCur = 0, uniqPrev = 0;
  const events = new Map<string, { id: string; title: string | null; category: string | null; category_label: string | null; revenue_paise: number; paid_bookings: number }>();
  const cats = new Map<string, { category: string | null; label: string; revenue_paise: number; paid_bookings: number }>();

  for (const row of r.money) {
    if (row.k === "uc") { uniqCur = num(row.v1); uniqPrev = num(row.v2); continue; }
    const s = slot(num(row.day)); if (!s) continue;
    const [pi, i] = s;
    if (row.k === "ud") { buyers[pi][i] += num(row.v2); continue; }
    if (row.k !== "dl") continue;
    const v = num(row.v1), n = num(row.v2), rf = num(row.v3);
    rev[pi][i] += v; paid[pi][i] += n; refundedPaid[pi][i] += rf;
    if (pi !== 0 || n === 0) continue;
    const id = String(row.id);
    const e = events.get(id) ?? { id, title: row.title ?? null, category: row.cat ?? null, category_label: row.cat_label ?? null, revenue_paise: 0, paid_bookings: 0 };
    e.revenue_paise += v; e.paid_bookings += n; events.set(id, e);
    const ck = row.cat ?? "";
    const c = cats.get(ck) ?? { category: row.cat ?? null, label: row.cat_label ?? row.cat ?? "Uncategorised", revenue_paise: 0, paid_bookings: 0 };
    c.revenue_paise += v; c.paid_bookings += n; cats.set(ck, c);
  }
  for (const row of r.daily) {
    const s = slot(num(row.day)); if (!s) continue;
    const [pi, i] = s;
    if (row.k === "s") signups[pi][i] += num(row.n);
    else if (row.k === "r") { refunds[pi][i] += num(row.n); refundsPaise[pi][i] += num(row.paise); }
    else if (row.k === "b") { seats[pi][i] += num(row.n); freeSeats[pi][i] += num(row.paise); }
  }
  const t0 = istDayIndex(istDayStart(w.now));
  const upcomingDays = Array.from({ length: 14 }, (_, i) => ({ day: dayKey(t0 + i), count: 0 }));
  let live = 0, up = 0, up7 = 0;
  for (const row of r.events) {
    if (row.k === "live") live = num(row.n);
    else if (row.k === "up") up = num(row.n);
    else if (row.k === "up7") up7 = num(row.n);
    else if (row.k === "ud") { const i = num(row.day) - t0; if (i >= 0 && i < 14) upcomingDays[i].count += num(row.n); }
  }

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const tot = (s: [number[], number[]]) => pair(sum(s[0]), sum(s[1]));
  const revenue = tot(rev), paidB = tot(paid), refundedB = tot(refundedPaid);
  const aov = (i: 0 | 1) => (i === 0 ? (paidB.cur ? Math.round(revenue.cur / paidB.cur) : 0) : (paidB.prev ? Math.round(revenue.prev / paidB.prev) : 0));
  const aovDaily = rev[0].map((v, i) => (paid[0][i] ? Math.round(v / paid[0][i]) : 0));
  const rate = (i: 0 | 1) => { const k = i === 0 ? "cur" : "prev"; return ratio(refundedB[k], paidB[k] + refundedB[k]); };
  const f = r.funnel;

  return {
    kpis: {
      revenue_paise: revenue,
      paid_bookings: paidB,
      unique_customers: pair(uniqCur, uniqPrev),
      signups: tot(signups),
      aov_paise: pair(aov(0), aov(1)),
      refunds: { count: tot(refunds), paise: tot(refundsPaise) },
      refund_rate: { cur: rate(0), prev: rate(1) },
      seats: tot(seats),
      live_now: live,
      upcoming_events: { total: up, next_7d: up7 },
    },
    series: {
      days,
      revenue_paise: rev[0], revenue_prev_paise: rev[1],
      paid_bookings: paid[0], paid_bookings_prev: paid[1],
      unique_customers: buyers[0],
      aov_paise: aovDaily,
      signups: signups[0], signups_prev: signups[1],
      refunds: refunds[0], refunds_paise: refundsPaise[0],
      seats: seats[0], free_seats: freeSeats[0], seats_prev: seats[1],
      upcoming: upcomingDays,
    },
    by_category: [...cats.values()].sort((a, b) => b.revenue_paise - a.revenue_paise || a.label.localeCompare(b.label)),
    top_events: [...events.values()].sort((a, b) => b.revenue_paise - a.revenue_paise || b.paid_bookings - a.paid_bookings).slice(0, 10),
    funnel: f && num(f.started) > 0
      ? { started: num(f.started), sent: num(f.sent), confirmed: num(f.confirmed), kept: num(f.kept) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/v2/analytics
// ---------------------------------------------------------------------------
export async function adminAnalytics(req: Request, env: Env): Promise<Response> {
  const a = await adminGuard(req, env); if (a instanceof Response) return a;
  const w = analyticsWindow(new URL(req.url).searchParams, Date.now());
  if ("error" in w) return admin2Err(400, w.error, w.message);
  const db = env.DB_META;
  const today = istDayStart(w.now);
  const pay = buildAdminPaymentsQuery(w.now, { limit: 10 });
  const rq = buildAdminRefundsQuery({ status: "requested", limit: 6 });
  const [money, daily, events, funnel, pend, openRf, next, recent, openRows] = await Promise.all([
    db.prepare(ANALYTICS_MONEY_SQL).bind(w.prevFrom, w.from, w.to).all<any>(),
    db.prepare(ANALYTICS_DAILY_SQL).bind(w.prevFrom, w.to).all<any>(),
    db.prepare(ANALYTICS_EVENTS_SQL).bind(w.now, today, today + 14 * DAY_MS, w.now + 7 * DAY_MS).all<any>(),
    db.prepare(ANALYTICS_FUNNEL_SQL).bind(w.from, w.to).first<any>(),
    db.prepare(OVERVIEW_PENDING_SQL).bind(w.now).first<any>(),
    db.prepare(OVERVIEW_REFUNDS_SQL).first<any>(),
    db.prepare(OVERVIEW_NEXT_EVENTS_SQL).bind(w.now).all<any>(),
    db.prepare(pay.sql).bind(...pay.binds).all<any>(),
    db.prepare(rq.sql).bind(...rq.binds).all<any>(),
  ]);
  const out = rollUp(w, { money: money?.results ?? [], daily: daily?.results ?? [], events: events?.results ?? [], funnel });
  return json({
    generated_at: w.now,
    range: {
      preset: w.preset, tz: ANALYTICS_TZ, days: w.days,
      from: w.fromDay, to: w.toDay, prev_from: w.prevFromDay, prev_to: w.prevToDay,
      from_ms: w.from, to_ms: w.to, prev_from_ms: w.prevFrom, prev_to_ms: w.prevTo,
    },
    kpis: {
      ...out.kpis,
      pending_payments: { count: num(pend?.pending_payments), paise: num(pend?.pending_paise), review: num(pend?.pending_review) },
      open_refunds: { count: num(openRf?.open_refunds), paise: num(openRf?.open_refunds_paise) },
    },
    series: out.series,
    by_category: out.by_category,
    top_events: out.top_events,
    funnel: out.funnel,
    next_events: (next?.results ?? []).map(shapeOverviewEvent),
    recent_payments: (recent?.results ?? []).map((p: any) => ({
      id: String(p.id), uid: String(p.uid), customer: personName(p), listing_id: String(p.listing_id),
      event_title: p.event_title ?? null, amount_paise: num(p.amount_paise), status: String(p.status), at: num(p.sort_ts),
    })),
    open_refunds: (openRows?.results ?? []).map((r: any) => ({
      id: String(r.refund_id), uid: String(r.uid), customer: personName(r), event_title: r.event_title ?? null,
      amount_paise: num(r.refund_amount_paise), requested_at: num(r.requested_at), reason: r.reason ?? null,
    })),
  }, 200, { "cache-control": "private, no-store" });
}
