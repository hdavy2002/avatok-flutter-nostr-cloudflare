// [ADMIN2-PEOPLE 2026-09-26] Admin 2: bookings, payments and customers, admin-wide.
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md. Registered in the Admin 2 route table
// (routes/admin2.ts ADMIN2_ROUTES, one spread of ADMIN2_PEOPLE_ROUTES). Every route is admin-only (requireAdmin, the
// ADMIN_UIDS list). Money on the wire is integer PAISE; CSV exports show plain rupees.
//
//   GET /api/admin/v2/bookings?event&status&q&from&to&uid&cursor&format=csv
//   GET /api/admin/v2/payments?q&status&cat&paid_from&paid_to&min&max&event&uid&cursor&format=csv
//   GET /api/admin/v2/customers?q&cursor
//   GET /api/admin/v2/customers/:uid
//
// Read models + data limits (email only as a hash in D1, phone often only as a hash):
// lib/admin2_people_data.ts.
import type { Env } from "../types";
// Type-only: routes/admin2.ts imports this file, so a runtime import back would be circular.
import type { Admin2RouteDef } from "./admin2";
import { json, sha256Hex, CORS } from "../util";
import { trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { indianMobileE164 } from "./phone_otp";
import { decodeCursor, encodeCursor, msParam, rupeesParamToPaise, type Cursor } from "../lib/me_dashboard_logic";
import { startsMsSql } from "../lib/me_dashboard_data";
import { ADMIN_REFUND_ROWS_SQL, customerName, type AdminRefundRow } from "../lib/admin_refunds_data";
import {
  ADMIN2_PAGE, ADMIN2_EXPORT_MAX, buildBookingsQuery, buildBookingTotalsQuery, buildAdminPaymentsQuery,
  buildAdminPaymentTotalsQuery, buildCustomersQuery, classifyQuery, personName, phoneView, toCsv, csvRupees, csvIst,
  csvFilename, type PeopleQuery, type BookingRow, type AdminPaymentRow, type CustomerRow,
} from "../lib/admin2_people_data";

const APP = "saathum";
/** Clerk lookups per CSV export (each is KV-cached; beyond this the email column is left empty). */
export const EXPORT_EMAIL_LOOKUPS = 500;

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);
const NO_STORE = { "cache-control": "private, no-store" };

async function admin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  // Same shape as admin2.ts adminGuard (not imported: see the type-only import above).
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

/** Search box -> PeopleQuery (hashes an email or a full mobile number). */
export async function peopleQuery(raw: string | null): Promise<PeopleQuery | null> {
  const c = classifyQuery(raw);
  if (c.kind === "empty") return null;
  const q: PeopleQuery = { text: c.text };
  if (c.kind === "email") q.emailHash = await sha256Hex(c.text.toLowerCase());
  if (c.kind === "last4") q.phoneLast4 = c.text;
  if (c.kind === "phone") {
    const e164 = indianMobileE164(c.text);
    if (e164) { q.phoneHash = await sha256Hex(e164); q.phoneLast4 = e164.slice(-4); }
  }
  return q;
}

/** uid -> email via Clerk (identity.ts, KV-cached), 8 at a time, at most `cap` lookups. */
async function emailsFor(env: Env, uids: string[], cap = ADMIN2_PAGE): Promise<{ map: Map<string, string | null>; capped: boolean }> {
  const uniq = [...new Set(uids)];
  const todo = uniq.slice(0, cap);
  const map = new Map<string, string | null>();
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const got = await Promise.all(chunk.map(async (u) => [u, await emailFor(env, u).catch(() => null)] as const));
    for (const [u, e] of got) map.set(u, e);
  }
  return { map, capped: uniq.length > todo.length };
}

function cursorParam(u: URLSearchParams): { cursor: Cursor | null } | Response {
  const raw = u.get("cursor");
  const cursor = decodeCursor(raw);
  if (raw && !cursor) return err(400, "invalid_cursor", "That page link is no longer valid. Reload the list.");
  return { cursor };
}

function csvResponse(body: string, filename: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "text/csv; charset=utf-8; header=present",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-expose-headers": "content-disposition, x-export-truncated, x-export-rows",
      ...NO_STORE,
      ...extra,
    },
  });
}

const customerOf = (r: { uid: string; display_name?: string | null; first_name?: string | null; last_name?: string | null; phone_e164?: string | null; phone_hash?: string | null }, email: string | null) => {
  const ph = phoneView(r);
  return { uid: r.uid, name: personName(r), email, phone_masked: ph.masked, phone_hash_only: ph.hash_only };
};

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
function bookingItem(r: BookingRow, email: string | null) {
  return {
    id: r.id, order_id: r.order_id, intent_id: r.intent_id, listing_id: r.listing_id,
    event_title: r.event_title, event_starts_at: r.event_starts_at != null ? Number(r.event_starts_at) : null,
    category: r.category, category_label: r.category_label,
    status: r.status, amount_paise: Number(r.amount_paise ?? 0), utr: r.utr, intent_status: r.intent_status,
    booked_at: Number(r.booked_at), customer: customerOf(r, email),
  };
}

export async function adminV2Bookings(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const c = cursorParam(u); if (c instanceof Response) return c;
  const csv = u.get("format") === "csv";
  const now = Date.now();
  const event = (u.get("event") ?? "").trim().slice(0, 200) || null;
  const uid = (u.get("uid") ?? "").trim().slice(0, 200) || null;
  const filters = {
    event, uid, status: u.get("status"), q: await peopleQuery(u.get("q")),
    from: msParam(u.get("from")), to: msParam(u.get("to")),
  };
  const db = env.DB_META;
  if (csv) {
    const { sql, binds } = buildBookingsQuery(now, { ...filters, limit: ADMIN2_EXPORT_MAX + 1 });
    const rows = (await db.prepare(sql).bind(...binds).all<BookingRow>()).results ?? [];
    const page = rows.slice(0, ADMIN2_EXPORT_MAX);
    const { map, capped } = await emailsFor(env, page.map((r) => r.uid), EXPORT_EMAIL_LOOKUPS);
    const body = toCsv(
      ["Booking ID", "Order ID", "Booked at (IST)", "Status", "Event", "Event ID", "Event starts (IST)",
        "Customer", "Email", "Phone (masked)", "Amount (INR)", "UTR", "Customer ID"],
      page.map((r) => {
        const ph = phoneView(r);
        return [r.id, r.order_id, csvIst(r.booked_at), r.status, r.event_title, r.listing_id, csvIst(r.event_starts_at),
          personName(r), map.get(r.uid) ?? "", ph.masked ?? (ph.hash_only ? "on file (hash only)" : ""),
          csvRupees(Number(r.amount_paise ?? 0)), r.utr, r.uid];
      }),
    );
    return csvResponse(body, csvFilename("bookings", now, event ? `event-${event}` : uid ? `customer-${uid}` : null), {
      "x-export-rows": String(page.length),
      ...(rows.length > ADMIN2_EXPORT_MAX ? { "x-export-truncated": "1" } : {}),
      ...(capped ? { "x-export-emails-capped": "1" } : {}),
    });
  }
  const { sql, binds } = buildBookingsQuery(now, { ...filters, cursor: c.cursor, limit: ADMIN2_PAGE + 1 });
  const first = !c.cursor;
  const tq = first ? buildBookingTotalsQuery(now, filters) : null;
  const [rs, tot, ev] = await Promise.all([
    db.prepare(sql).bind(...binds).all<BookingRow>(),
    tq ? db.prepare(tq.sql).bind(...tq.binds).first<Record<string, number>>() : Promise.resolve(null),
    first && event
      ? db.prepare(`SELECT l.id, l.title, l.status, l.capacity, l.price, l.free_entry, ${startsMsSql("l")} AS starts_at, l.duration_min
                      FROM listings l WHERE l.id=?1`).bind(event).first<any>()
      : Promise.resolve(null),
  ]);
  const rows = rs.results ?? [];
  const page = rows.slice(0, ADMIN2_PAGE);
  const { map } = await emailsFor(env, page.map((r) => r.uid));
  const last = page[page.length - 1];
  return json({
    items: page.map((r) => bookingItem(r, map.get(r.uid) ?? null)),
    ...(rows.length > ADMIN2_PAGE && last ? { next_cursor: encodeCursor({ t: Number(last.sort_ts), id: last.id }) } : {}),
    ...(tot ? { totals: numbers(tot) } : {}),
    ...(ev ? {
      event: {
        id: ev.id, title: ev.title, status: ev.status, starts_at: ev.starts_at != null ? Number(ev.starts_at) : null,
        duration_min: ev.duration_min != null ? Number(ev.duration_min) : null,
        capacity: ev.capacity != null ? Number(ev.capacity) : null,
        price_paise: Number(ev.free_entry) === 1 ? 0 : Math.max(0, Math.round(Number(ev.price ?? 0) * 100)),
      },
    } : {}),
  }, 200, NO_STORE);
}

function numbers(r: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) out[k] = Number(v ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
function paymentItem(r: AdminPaymentRow, email: string | null) {
  return {
    id: r.id, order_id: r.order_id, listing_id: r.listing_id, event_title: r.event_title,
    category: r.category, category_label: r.category_label,
    event_starts_at: r.event_starts_at != null ? Number(r.event_starts_at) : null,
    amount_paise: Number(r.amount_paise), status: r.status,
    paid_at: r.base_status === "pending" ? null : (r.paid_at != null ? Number(r.paid_at) : null),
    created_at: Number(r.created_at), utr: r.utr,
    ...(r.refund_status ? { refund: { status: r.refund_status, amount_paise: r.refund_amount_paise != null ? Number(r.refund_amount_paise) : null, refunded_at: r.refund_refunded_at != null ? Number(r.refund_refunded_at) : null } } : {}),
    customer: customerOf(r, email),
  };
}

function paymentFilters(u: URLSearchParams, q: PeopleQuery | null) {
  return {
    q, status: u.get("status"), cat: (u.get("cat") ?? "").trim() || null,
    event: (u.get("event") ?? "").trim().slice(0, 200) || null,
    uid: (u.get("uid") ?? "").trim().slice(0, 200) || null,
    paidFrom: msParam(u.get("paid_from")), paidTo: msParam(u.get("paid_to")),
    minPaise: rupeesParamToPaise(u.get("min")), maxPaise: rupeesParamToPaise(u.get("max")),
  };
}

export async function adminV2Payments(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const c = cursorParam(u); if (c instanceof Response) return c;
  const now = Date.now();
  const f = paymentFilters(u, await peopleQuery(u.get("q")));
  const db = env.DB_META;
  if (u.get("format") === "csv") {
    const { sql, binds } = buildAdminPaymentsQuery(now, { ...f, limit: ADMIN2_EXPORT_MAX + 1 });
    const rows = (await db.prepare(sql).bind(...binds).all<AdminPaymentRow>()).results ?? [];
    const page = rows.slice(0, ADMIN2_EXPORT_MAX);
    const { map, capped } = await emailsFor(env, page.map((r) => r.uid), EXPORT_EMAIL_LOOKUPS);
    const body = toCsv(
      ["Payment ID", "Order ID", "Paid at (IST)", "Status", "Amount (INR)", "Refunded (INR)", "UTR", "Event", "Event ID",
        "Category", "Event starts (IST)", "Customer", "Email", "Phone (masked)", "Customer ID"],
      page.map((r) => {
        const ph = phoneView(r);
        const refunded = r.status === "refunded" ? csvRupees(r.refund_amount_paise ?? r.amount_paise) : "";
        return [r.id, r.order_id, csvIst(r.base_status === "pending" ? null : r.paid_at), r.status, csvRupees(r.amount_paise), refunded,
          r.utr, r.event_title, r.listing_id, r.category_label ?? r.category, csvIst(r.event_starts_at),
          personName(r), map.get(r.uid) ?? "", ph.masked ?? (ph.hash_only ? "on file (hash only)" : ""), r.uid];
      }),
    );
    return csvResponse(body, csvFilename("payments", now, f.event ? `event-${f.event}` : f.uid ? `customer-${f.uid}` : null), {
      "x-export-rows": String(page.length),
      ...(rows.length > ADMIN2_EXPORT_MAX ? { "x-export-truncated": "1" } : {}),
      ...(capped ? { "x-export-emails-capped": "1" } : {}),
    });
  }
  const { sql, binds } = buildAdminPaymentsQuery(now, { ...f, cursor: c.cursor, limit: ADMIN2_PAGE + 1 });
  const tq = !c.cursor ? buildAdminPaymentTotalsQuery(now, f) : null;
  const [rs, tot, cats] = await Promise.all([
    db.prepare(sql).bind(...binds).all<AdminPaymentRow>(),
    tq ? db.prepare(tq.sql).bind(...tq.binds).first<Record<string, number>>() : Promise.resolve(null),
    // Category filter options (first page only): the active Saa Thum categories.
    tq ? db.prepare("SELECT id, label FROM listing_categories WHERE active=1 ORDER BY sort, label").all<{ id: string; label: string }>() : Promise.resolve(null),
  ]);
  const rows = rs.results ?? [];
  const page = rows.slice(0, ADMIN2_PAGE);
  const { map } = await emailsFor(env, page.map((r) => r.uid));
  const last = page[page.length - 1];
  return json({
    items: page.map((r) => paymentItem(r, map.get(r.uid) ?? null)),
    ...(rows.length > ADMIN2_PAGE && last ? { next_cursor: encodeCursor({ t: Number(last.sort_ts), id: last.id }) } : {}),
    ...(tot ? { totals: numbers(tot) } : {}),
    ...(cats ? { categories: (cats.results ?? []).map((c) => ({ id: c.id, label: c.label })) } : {}),
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export async function adminV2Customers(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const c = cursorParam(u); if (c instanceof Response) return c;
  const q = await peopleQuery(u.get("q"));
  const { sql, binds } = buildCustomersQuery({ q, cursor: c.cursor, limit: ADMIN2_PAGE + 1 });
  const rows = (await env.DB_META.prepare(sql).bind(...binds).all<CustomerRow>()).results ?? [];
  const page = rows.slice(0, ADMIN2_PAGE);
  const { map } = await emailsFor(env, page.map((r) => r.uid));
  const last = page[page.length - 1];
  return json({
    items: page.map((r) => ({
      ...customerOf(r, map.get(r.uid) ?? null),
      joined_at: r.joined_at != null ? Number(r.joined_at) : null,
      bookings: Number(r.bookings ?? 0), paid_paise: Number(r.paid_paise ?? 0),
      last_booked_at: r.last_booked_at != null ? Number(r.last_booked_at) : null,
    })),
    ...(rows.length > ADMIN2_PAGE && last ? { next_cursor: encodeCursor({ t: Number(last.sort_ts), id: last.id }) } : {}),
    // What the search could match on: tells the UI to explain partial emails / hash-only phones.
    search: q ? { kind: classifyQuery(q.text).kind, email_exact_only: true, phone_last4_readable_only: true } : null,
  }, 200, NO_STORE);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const DETAIL_LIMIT = 200;

export async function adminV2Customer(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  if (!uid || uid.length > 200) return err(404, "not_found", "We couldn't find that customer.");
  const db = env.DB_META;
  const now = Date.now();
  const b = buildBookingsQuery(now, { uid, limit: DETAIL_LIMIT + 1 });
  const p = buildAdminPaymentsQuery(now, { uid, limit: DETAIL_LIMIT + 1 });
  const pt = buildAdminPaymentTotalsQuery(now, { uid });
  const [user, cv, otp, extras, addr, vpas, bookings, payments, ptot, refunds, email] = await Promise.all([
    db.prepare("SELECT uid, display_name, first_name, last_name, avatar_url, email_hash, phone_hash, private_number, created_at FROM users WHERE uid=?1").bind(uid).first<any>(),
    db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1").bind(uid).first<any>(),
    db.prepare("SELECT e164 FROM phone_otp WHERE uid=?1 AND status='verified' ORDER BY verified_at DESC, id DESC LIMIT 1").bind(uid).first<{ e164: string }>(),
    db.prepare("SELECT gotra, family_json, language FROM user_profile_extras WHERE uid=?1").bind(uid).first<any>(),
    db.prepare("SELECT name,line1,line2,city,state,pin,country FROM user_addresses WHERE uid=?1").bind(uid).first<any>(),
    db.prepare("SELECT id, vpa, is_default, created_at FROM user_vpas WHERE uid=?1 ORDER BY is_default DESC, created_at ASC").bind(uid).all<any>(),
    db.prepare(b.sql).bind(...b.binds).all<BookingRow>(),
    db.prepare(p.sql).bind(...p.binds).all<AdminPaymentRow>(),
    db.prepare(pt.sql).bind(...pt.binds).first<Record<string, number>>(),
    db.prepare(`${ADMIN_REFUND_ROWS_SQL} WHERE q.uid=?1 ORDER BY q.requested_at DESC, q.refund_id DESC LIMIT ${DETAIL_LIMIT}`).bind(uid).all<AdminRefundRow>(),
    emailFor(env, uid).catch(() => null),
  ]);
  const bRows = bookings.results ?? [], pRows = payments.results ?? [], rRows = refunds.results ?? [];
  if (!user && !bRows.length && !pRows.length && !rRows.length) return err(404, "not_found", "We couldn't find that customer.");
  const e164 = otp?.e164 ?? user?.private_number ?? null;
  const hash = user?.phone_hash ?? cv?.phone_hash ?? null;
  const ph = phoneView({ phone_e164: e164, phone_hash: hash });
  const name = user ? personName(user) : null;
  return json({
    profile: {
      uid, name, email,
      ...(user?.avatar_url ? { photo_url: user.avatar_url } : {}),
      joined_at: user?.created_at != null ? Number(user.created_at) : null,
      phone: { masked: ph.masked, verified: !!cv && Number(cv.phone_verified) === 1, hash_only: ph.hash_only },
      vpas: (vpas.results ?? []).map((v) => ({ id: v.id, vpa: v.vpa, is_default: Number(v.is_default) === 1 })),
      address: addr ? { name: addr.name, line1: addr.line1, line2: addr.line2, city: addr.city, state: addr.state, pin: addr.pin, country: addr.country } : null,
      gotra: extras?.gotra ?? null,
      language: extras?.language ?? null,
      family: parseJson<unknown[]>(extras?.family_json, []),
    },
    bookings: bRows.slice(0, DETAIL_LIMIT).map((r) => bookingItem(r, email)),
    payments: pRows.slice(0, DETAIL_LIMIT).map((r) => paymentItem(r, email)),
    payment_totals: numbers(ptot ?? {}),
    refunds: rRows.map((r) => ({
      refund_id: r.refund_id, payment_id: r.payment_id, order_id: r.order_id, listing_id: r.listing_id,
      event_title: r.event_title, event_starts_at: r.event_starts_at != null ? Number(r.event_starts_at) : null,
      amount_paise: Number(r.amount_paise), payer_utr: r.payer_utr, requested_at: Number(r.requested_at),
      reason: r.reason, status: r.status, refund_amount_paise: Number(r.refund_amount_paise),
      refund_utr: r.refund_utr, refund_vpa: r.refund_vpa, refunded_at: r.refunded_at != null ? Number(r.refunded_at) : null,
      customer_name: customerName(r),
    })),
    truncated: { bookings: bRows.length > DETAIL_LIMIT, payments: pRows.length > DETAIL_LIMIT },
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// Registration: routes/admin2.ts spreads this into ADMIN2_ROUTES (its dispatcher owns
// the try/catch → trackException). admin2PeopleRoute is the same table for tests.
// ---------------------------------------------------------------------------
export const ADMIN2_PEOPLE_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/bookings", handler: (req, env) => adminV2Bookings(req, env) },
  { method: "GET", path: "/api/admin/v2/payments", handler: (req, env) => adminV2Payments(req, env) },
  { method: "GET", path: "/api/admin/v2/customers", handler: (req, env) => adminV2Customers(req, env) },
  { method: "GET", path: /^\/api\/admin\/v2\/customers\/([^/]+)$/, handler: (req, env, [uid]) => adminV2Customer(req, env, uid ?? "") },
];

/** Standalone dispatcher over ADMIN2_PEOPLE_ROUTES (tests; admin2.ts uses the table). */
export async function admin2PeopleRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  for (const r of ADMIN2_PEOPLE_ROUTES) {
    if (r.method !== req.method) continue;
    let params: string[] | null = null;
    if (typeof r.path === "string") params = r.path === p ? [] : null;
    else { const m = r.path.exec(p); if (m) { try { params = m.slice(1).map((x) => decodeURIComponent(x ?? "")); } catch { params = null; } } }
    if (!params) continue;
    try {
      return await r.handler(req, env, params);
    } catch (e) {
      await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "admin2_people" } });
      return err(500, "internal", "Something went wrong. Please try again.");
    }
  }
  return null;
}
