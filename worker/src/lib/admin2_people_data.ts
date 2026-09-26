// [ADMIN2-PEOPLE 2026-09-26] Admin 2 read models: bookings, payments and customers,
// admin-wide. Contract: Specs/SPEC-2026-09-26-ADMIN-2.md (Bookings / Payments / Customers).
//
// SOURCES — the same tables the customer dashboard reads (lib/me_dashboard_data.ts), with
// no per-account scoping:
//   * orders + commercial_policy_snapshots: every seat the checkout wrote. What the buyer
//     paid = gross_amount + gst_amount (paise = rupees * 100); a free seat is amount 0.
//   * hdfc_sms_payment_intents: the HDFC UPI rail. amount_paise, bank_reference (= UTR) and
//     commercial_order_id. An intent with no order yet is a PENDING booking/payment.
//   * refunds: the latest row per payment folds into the status.
// A row id is the PaymentLine id (intent id when an intent exists, else the order id), so it
// matches refunds.payment_id and the customer's Billing screen.
//
// WHAT WE CAN KNOW ABOUT A CUSTOMER (data limits, 2026-09-26):
//   * email — D1 holds only users.email_hash (sha256 of the lowercased address). The raw
//     address comes from Clerk (lib/identity.ts emailFor, KV-cached). So email search is an
//     EXACT match on the hash; a partial email cannot be searched.
//   * phone — the readable E.164 exists only where the web captured it: the latest verified
//     phone_otp row (web sign-up / Dashboard 2 phone change) or users.private_number. App-only
//     accounts may have ONLY users.phone_hash / contact_verification.phone_hash. Last-4 search
//     therefore matches readable numbers only; a FULL mobile number is also hashed and matched
//     against the hashes, which covers hash-only accounts. Rows say `phone_hash_only`.
import { startsMsSql, SMOKE_LISTING_ID } from "./me_dashboard_data";
import { maskE164, type Cursor } from "./me_dashboard_logic";

export const ADMIN2_PAGE = 50;
export const ADMIN2_EXPORT_MAX = 5000;

const intentOf = (col: string) =>
  `(SELECT h.${col} FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
     ORDER BY (h.status='confirmed') DESC, h.updated_at DESC LIMIT 1)`;

/** Readable phone for a uid expression: latest verified web OTP number, else users.private_number. */
export const phoneSql = (uid: string, users: string) =>
  `COALESCE((SELECT po.e164 FROM phone_otp po WHERE po.uid=${uid} AND po.status='verified' ORDER BY po.verified_at DESC, po.id DESC LIMIT 1), ${users}.private_number)`;
/** Any phone hash on file for a uid (users row or the web verification row). */
export const phoneHashSql = (uid: string, users: string) =>
  `COALESCE(${users}.phone_hash, (SELECT cv.phone_hash FROM contact_verification cv WHERE cv.uid=${uid}))`;

/** Email hash for a uid: the users row's, else the web verification row's. */
export const emailHashSql = (uid: string, users: string) =>
  `COALESCE(${users}.email_hash, (SELECT cv.email_hash FROM contact_verification cv WHERE cv.uid=${uid}))`;

/** Latest refund row per payment id, all accounts. */
const REFUND_CTE = `rf AS (
  SELECT payment_id, status AS refund_status, amount_paise AS refund_amount_paise, refunded_at AS refund_refunded_at,
         ROW_NUMBER() OVER (PARTITION BY payment_id ORDER BY requested_at DESC, id DESC) AS rn
    FROM refunds
)`;

/** Customer columns joined onto a row with a `uid` column via `u` (users). */
const CUSTOMER_COLS = (uid: string) => `u.display_name, u.first_name, u.last_name, ${emailHashSql(uid, "u")} AS email_hash,
         ${phoneSql(uid, "u")} AS phone_e164, ${phoneHashSql(uid, "u")} AS phone_hash`;

// ---------------------------------------------------------------------------
// Bookings — every seat: paid, free, pending (UPI intent awaiting its order), refunded.
// Live events only (a "seat" is a live_event concept). Binds: ?1 = now (ms).
// ---------------------------------------------------------------------------
export const BOOKING_ROWS_SQL = `WITH ${REFUND_CTE}, b AS (
  SELECT COALESCE(${intentOf("intent_id")}, o.id) AS id, o.id AS order_id, ${intentOf("intent_id")} AS intent_id,
         o.buyer_id AS uid, o.listing_id AS listing_id,
         CASE WHEN o.amount>0 AND o.status<>'free'
              THEN COALESCE(${intentOf("amount_paise")}, (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100)
              ELSE 0 END AS amount_paise,
         CASE WHEN o.status='refunded' THEN 'refunded' WHEN o.status='free' OR o.amount<=0 THEN 'free' ELSE 'paid' END AS base_status,
         ${intentOf("bank_reference")} AS utr, ${intentOf("status")} AS intent_status, o.created_at AS booked_at
    FROM orders o
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
   WHERE o.status IN ('held','free','released','refunded') AND o.listing_id<>'${SMOKE_LISTING_ID}'
  UNION ALL
  SELECT h.intent_id, NULL, h.intent_id, h.uid, h.listing_id, h.amount_paise, 'pending', h.bank_reference, h.status, h.created_at
    FROM hdfc_sms_payment_intents h
   WHERE h.commercial_order_id IS NULL AND h.listing_id<>'${SMOKE_LISTING_ID}'
     AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?1))
)
SELECT * FROM (
  SELECT b.*, b.booked_at AS sort_ts,
         l.title AS event_title, l.category AS category, c.label AS category_label, ${startsMsSql("l")} AS event_starts_at,
         ${CUSTOMER_COLS("b.uid")},
         rf.refund_status,
         CASE WHEN b.base_status='refunded' OR rf.refund_status='refunded' THEN 'refunded'
              WHEN b.base_status='pending' THEN 'pending'
              WHEN b.base_status='free' THEN 'free'
              WHEN rf.refund_status='requested' THEN 'refund_requested'
              ELSE 'paid' END AS status
    FROM b
    JOIN listings l ON l.id=b.listing_id AND l.kind='live_event'
    LEFT JOIN listing_categories c ON c.id=l.category
    LEFT JOIN users u ON u.uid=b.uid
    LEFT JOIN rf ON rf.payment_id=b.id AND rf.rn=1
) p`;

export const BOOKING_STATUSES = ["paid", "free", "pending", "refund_requested", "refunded"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type BookingRow = {
  id: string; order_id: string | null; intent_id: string | null; uid: string; listing_id: string;
  amount_paise: number; base_status: string; utr: string | null; intent_status: string | null;
  booked_at: number; sort_ts: number; event_title: string | null; category: string | null;
  category_label: string | null; event_starts_at: number | null; display_name: string | null;
  first_name: string | null; last_name: string | null; email_hash: string | null;
  phone_e164: string | null; phone_hash: string | null; refund_status: string | null; status: BookingStatus;
};

// ---------------------------------------------------------------------------
// Payments — every money line (free seats excluded). Binds: ?1 = now (ms).
// ---------------------------------------------------------------------------
export const PAYMENT_ROWS_SQL = `WITH ${REFUND_CTE}, x AS (
  SELECT COALESCE(${intentOf("intent_id")}, o.id) AS id, o.id AS order_id, o.listing_id AS listing_id, o.buyer_id AS uid,
         COALESCE(${intentOf("amount_paise")}, (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100) AS amount_paise,
         CASE WHEN o.status='refunded' THEN 'refunded' ELSE 'paid' END AS base_status,
         COALESCE((SELECT h.updated_at FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id AND h.status='confirmed' ORDER BY h.updated_at DESC LIMIT 1),
                  o.created_at) AS paid_at,
         ${intentOf("bank_reference")} AS utr, o.created_at AS created_at
    FROM orders o
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
   WHERE o.amount>0 AND o.status IN ('held','released','refunded') AND o.listing_id<>'${SMOKE_LISTING_ID}'
  UNION ALL
  SELECT h.intent_id, NULL, h.listing_id, h.uid, h.amount_paise, 'pending', NULL, h.bank_reference, h.created_at
    FROM hdfc_sms_payment_intents h
   WHERE h.listing_id<>'${SMOKE_LISTING_ID}' AND h.commercial_order_id IS NULL
     AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?1))
)
SELECT * FROM (
  SELECT x.*, COALESCE(x.paid_at, x.created_at) AS sort_ts,
         l.title AS event_title, l.category AS category, c.label AS category_label, ${startsMsSql("l")} AS event_starts_at,
         ${CUSTOMER_COLS("x.uid")},
         rf.refund_status, rf.refund_amount_paise, rf.refund_refunded_at,
         CASE WHEN x.base_status='refunded' OR rf.refund_status='refunded' THEN 'refunded'
              WHEN x.base_status='pending' THEN 'pending'
              WHEN rf.refund_status='requested' THEN 'refund_requested'
              ELSE 'paid' END AS status
    FROM x
    LEFT JOIN listings l ON l.id=x.listing_id
    LEFT JOIN listing_categories c ON c.id=l.category
    LEFT JOIN users u ON u.uid=x.uid
    LEFT JOIN rf ON rf.payment_id=x.id AND rf.rn=1
) p`;

export const PAYMENT_STATUSES = ["paid", "pending", "refund_requested", "refunded"] as const;
export type AdminPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type AdminPaymentRow = {
  id: string; order_id: string | null; listing_id: string; uid: string; amount_paise: number;
  base_status: string; paid_at: number | null; utr: string | null; created_at: number; sort_ts: number;
  event_title: string | null; category: string | null; category_label: string | null; event_starts_at: number | null;
  display_name: string | null; first_name: string | null; last_name: string | null; email_hash: string | null;
  phone_e164: string | null; phone_hash: string | null; refund_status: string | null;
  refund_amount_paise: number | null; refund_refunded_at: number | null; status: AdminPaymentStatus;
};

// ---------------------------------------------------------------------------
// Shared filter building
// ---------------------------------------------------------------------------

/** A parsed people-search query. Built by the route (hashing is async). */
export type PeopleQuery = {
  text: string;
  /** sha256(lowercased email) when the text looks like an email. */
  emailHash?: string | null;
  /** 4 digits: match the readable phone's last 4. */
  phoneLast4?: string | null;
  /** sha256(E.164) when the text is a full Indian mobile number. */
  phoneHash?: string | null;
};

/** Classifies a search box value. Pure (hashing happens in the route). */
export function classifyQuery(raw: string | null | undefined): { text: string; kind: "empty" | "email" | "last4" | "phone" | "text" } {
  const text = (raw ?? "").trim().slice(0, 80);
  if (!text) return { text, kind: "empty" };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { text, kind: "email" };
  if (/^\d{4}$/.test(text)) return { text, kind: "last4" };
  const digits = text.replace(/[\s\-()+]/g, "");
  if (/^\d{10,12}$/.test(digits) && /^[+\d\s\-()]+$/.test(text)) return { text, kind: "phone" };
  return { text, kind: "text" };
}

class Where {
  binds: unknown[]; parts: string[] = [];
  constructor(initial: unknown[]) { this.binds = [...initial]; }
  ref(v: unknown): string { this.binds.push(v); return `?${this.binds.length}`; }
  add(sql: string) { this.parts.push(sql); }
  sql(): string { return this.parts.length ? " WHERE " + this.parts.join(" AND ") : ""; }
}

const esc = (s: string) => s.replace(/[\\%_]/g, (ch) => "\\" + ch);
const like = (col: string, r: string) => `${col} LIKE ${r} ESCAPE '\\'`;

/** Person + ids + title + UTR search against a `p` row with the customer columns. */
function addSearch(w: Where, q: PeopleQuery | null | undefined, alias = "p") {
  if (!q || !q.text) return;
  const ors: string[] = [];
  const sub = w.ref(`%${esc(q.text.toLowerCase())}%`);
  const pre = w.ref(`${esc(q.text)}%`);
  ors.push(
    like(`lower(COALESCE(${alias}.event_title,''))`, sub),
    like(`lower(COALESCE(${alias}.display_name,''))`, sub),
    like(`lower(COALESCE(${alias}.first_name,'') || ' ' || COALESCE(${alias}.last_name,''))`, sub),
    like(`lower(COALESCE(${alias}.utr,''))`, sub),
    like(`${alias}.id`, pre), like(`COALESCE(${alias}.order_id,'')`, pre),
    like(`${alias}.listing_id`, pre), like(`${alias}.uid`, pre),
  );
  if (q.emailHash) ors.push(`${alias}.email_hash=${w.ref(q.emailHash)}`);
  if (q.phoneLast4) ors.push(like(`COALESCE(${alias}.phone_e164,'')`, w.ref(`%${q.phoneLast4}`)));
  if (q.phoneHash) ors.push(`${alias}.phone_hash=${w.ref(q.phoneHash)}`);
  w.add(`(${ors.join(" OR ")})`);
}

function addStatus(w: Where, raw: string | null | undefined, allowed: readonly string[]) {
  if (!raw) return;
  const list = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => allowed.includes(s)))];
  if (list.length) w.add(`p.status IN (${list.map((s) => w.ref(s)).join(",")})`);
}

function addCursor(w: Where, c: Cursor | null | undefined) {
  if (!c) return;
  const t = w.ref(c.t), i = w.ref(c.id);
  w.add(`(p.sort_ts<${t} OR (p.sort_ts=${t} AND p.id<${i}))`);
}

const clampLimit = (n: number | undefined, dflt: number, max = ADMIN2_EXPORT_MAX + 1) => Math.max(1, Math.min(max, n ?? dflt));

export type BookingFilters = {
  event?: string | null; uid?: string | null; status?: string | null; q?: PeopleQuery | null;
  from?: number | null; to?: number | null; cursor?: Cursor | null; limit?: number;
};

/** Filters shared by the page query and the totals query. */
function bookingWhere(now: number, f: BookingFilters): Where {
  const w = new Where([now]);
  if (f.event) w.add(`p.listing_id=${w.ref(f.event)}`);
  if (f.uid) w.add(`p.uid=${w.ref(f.uid)}`);
  addStatus(w, f.status, BOOKING_STATUSES);
  addSearch(w, f.q);
  if (f.from != null) w.add(`p.booked_at>=${w.ref(f.from)}`);
  if (f.to != null) w.add(`p.booked_at<=${w.ref(f.to)}`);
  return w;
}

export function buildBookingsQuery(now: number, f: BookingFilters): { sql: string; binds: unknown[] } {
  const w = bookingWhere(now, f);
  addCursor(w, f.cursor);
  return { sql: `${BOOKING_ROWS_SQL}${w.sql()} ORDER BY p.sort_ts DESC, p.id DESC LIMIT ${clampLimit(f.limit, ADMIN2_PAGE + 1)}`, binds: w.binds };
}

/** Totals of the filtered set (no cursor): seats held (paid + free + refund requested), pending, refunded, revenue. */
export function buildBookingTotalsQuery(now: number, f: BookingFilters): { sql: string; binds: unknown[] } {
  const w = bookingWhere(now, { ...f, cursor: null });
  const sql = `SELECT COUNT(*) AS bookings,
      COALESCE(SUM(CASE WHEN p.status IN ('paid','free','refund_requested') THEN 1 ELSE 0 END),0) AS seats,
      COALESCE(SUM(CASE WHEN p.status IN ('paid','refund_requested') THEN 1 ELSE 0 END),0) AS paid_seats,
      COALESCE(SUM(CASE WHEN p.status='free' THEN 1 ELSE 0 END),0) AS free_seats,
      COALESCE(SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN p.status='refunded' THEN 1 ELSE 0 END),0) AS refunded,
      COALESCE(SUM(CASE WHEN p.status IN ('paid','refund_requested') THEN p.amount_paise ELSE 0 END),0) AS revenue_paise,
      COALESCE(SUM(CASE WHEN p.status='pending' THEN p.amount_paise ELSE 0 END),0) AS pending_paise
    FROM (${BOOKING_ROWS_SQL}${w.sql()}) p`;
  return { sql, binds: w.binds };
}

export type PaymentFiltersAdmin = {
  uid?: string | null; event?: string | null; status?: string | null; cat?: string | null; q?: PeopleQuery | null;
  paidFrom?: number | null; paidTo?: number | null; minPaise?: number | null; maxPaise?: number | null;
  cursor?: Cursor | null; limit?: number;
};

function paymentWhere(now: number, f: PaymentFiltersAdmin): Where {
  const w = new Where([now]);
  if (f.uid) w.add(`p.uid=${w.ref(f.uid)}`);
  if (f.event) w.add(`p.listing_id=${w.ref(f.event)}`);
  if (f.cat) w.add(`p.category=${w.ref(f.cat)}`);
  addStatus(w, f.status, PAYMENT_STATUSES);
  addSearch(w, f.q);
  // A pending line has no paid_at; the paid range then reads its created_at.
  if (f.paidFrom != null) w.add(`p.sort_ts>=${w.ref(f.paidFrom)}`);
  if (f.paidTo != null) w.add(`p.sort_ts<=${w.ref(f.paidTo)}`);
  if (f.minPaise != null) w.add(`p.amount_paise>=${w.ref(f.minPaise)}`);
  if (f.maxPaise != null) w.add(`p.amount_paise<=${w.ref(f.maxPaise)}`);
  return w;
}

export function buildAdminPaymentsQuery(now: number, f: PaymentFiltersAdmin): { sql: string; binds: unknown[] } {
  const w = paymentWhere(now, f);
  addCursor(w, f.cursor);
  return { sql: `${PAYMENT_ROWS_SQL}${w.sql()} ORDER BY p.sort_ts DESC, p.id DESC LIMIT ${clampLimit(f.limit, ADMIN2_PAGE + 1)}`, binds: w.binds };
}

/**
 * Totals of the filtered set. collected = paid + refund requested (money we hold);
 * refunded = amount actually sent back (the refund row's amount, else the payment's);
 * net = collected (a refunded line is no longer collected, so nothing is double-counted).
 */
export function buildAdminPaymentTotalsQuery(now: number, f: PaymentFiltersAdmin): { sql: string; binds: unknown[] } {
  const w = paymentWhere(now, { ...f, cursor: null });
  const sql = `SELECT COUNT(*) AS count,
      COALESCE(SUM(p.amount_paise),0) AS gross_paise,
      COALESCE(SUM(CASE WHEN p.status IN ('paid','refund_requested') THEN p.amount_paise ELSE 0 END),0) AS collected_paise,
      COALESCE(SUM(CASE WHEN p.status='pending' THEN p.amount_paise ELSE 0 END),0) AS pending_paise,
      COALESCE(SUM(CASE WHEN p.status='refund_requested' THEN p.amount_paise ELSE 0 END),0) AS refund_requested_paise,
      COALESCE(SUM(CASE WHEN p.status='refunded' THEN COALESCE(p.refund_amount_paise, p.amount_paise) ELSE 0 END),0) AS refunded_paise,
      COALESCE(SUM(CASE WHEN p.status IN ('paid','refund_requested') THEN 1 ELSE 0 END),0) AS paid_count,
      COALESCE(SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END),0) AS pending_count,
      COALESCE(SUM(CASE WHEN p.status='refunded' THEN 1 ELSE 0 END),0) AS refunded_count
    FROM (${PAYMENT_ROWS_SQL}${w.sql()}) p`;
  return { sql, binds: w.binds };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * One row per account. With no search: accounts that have booked a live event (an order or
 * a live UPI intent), most recent booking first; `bookings`/`paid_paise` count live-event seats only. With a search: every account that matches, booked or
 * not. No fixed binds; filters number from ?1.
 */
export function buildCustomersQuery(f: { q?: PeopleQuery | null; cursor?: Cursor | null; limit?: number }): { sql: string; binds: unknown[] } {
  const w = new Where([]);
  const base = `SELECT * FROM (
  SELECT u.uid AS id, u.uid AS uid, u.display_name, u.first_name, u.last_name, ${emailHashSql("u.uid", "u")} AS email_hash, u.created_at AS joined_at,
         ${phoneSql("u.uid", "u")} AS phone_e164, ${phoneHashSql("u.uid", "u")} AS phone_hash,
         a.bookings, a.paid_paise, a.last_booked_at,
         COALESCE(a.last_booked_at, u.created_at, 0) AS sort_ts
    FROM users u
    LEFT JOIN (
      SELECT uid, COUNT(*) AS bookings, SUM(paid) AS paid_paise, MAX(t) AS last_booked_at FROM (
        SELECT o.buyer_id AS uid, o.created_at AS t,
               CASE WHEN o.amount>0 AND o.status IN ('held','released')
                    THEN COALESCE(${intentOf("amount_paise")}, (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100)
                    ELSE 0 END AS paid
          FROM orders o JOIN listings l ON l.id=o.listing_id AND l.kind='live_event'
          LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
         WHERE o.status IN ('held','free','released','refunded') AND o.listing_id<>'${SMOKE_LISTING_ID}'
        UNION ALL
        SELECT h.uid, h.created_at, 0 FROM hdfc_sms_payment_intents h
         WHERE h.commercial_order_id IS NULL AND h.listing_id<>'${SMOKE_LISTING_ID}' AND h.status IN ('pending','payment_received','review_pending')
      ) GROUP BY uid
    ) a ON a.uid=u.uid
) p`;
  const q = f.q && f.q.text ? f.q : null;
  if (q) {
    // Search: names, uid prefix, exact email hash, phone last-4, full-phone hash.
    const ors: string[] = [];
    const sub = w.ref(`%${esc(q.text.toLowerCase())}%`);
    const pre = w.ref(`${esc(q.text)}%`);
    ors.push(
      like("lower(COALESCE(p.display_name,''))", sub),
      like("lower(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,''))", sub),
      like("p.uid", pre),
    );
    if (q.emailHash) ors.push(`p.email_hash=${w.ref(q.emailHash)}`);
    if (q.phoneLast4) ors.push(like("COALESCE(p.phone_e164,'')", w.ref(`%${q.phoneLast4}`)));
    if (q.phoneHash) ors.push(`p.phone_hash=${w.ref(q.phoneHash)}`);
    w.add(`(${ors.join(" OR ")})`);
  } else {
    w.add("p.bookings>0");
  }
  addCursor(w, f.cursor);
  return { sql: `${base}${w.sql()} ORDER BY p.sort_ts DESC, p.id DESC LIMIT ${clampLimit(f.limit, ADMIN2_PAGE + 1, 201)}`, binds: w.binds };
}

export type CustomerRow = {
  id: string; uid: string; display_name: string | null; first_name: string | null; last_name: string | null;
  email_hash: string | null; joined_at: number | null; phone_e164: string | null; phone_hash: string | null;
  bookings: number | null; paid_paise: number | null; last_booked_at: number | null; sort_ts: number;
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export function personName(r: { display_name?: string | null; first_name?: string | null; last_name?: string | null }): string | null {
  const full = [r.first_name, r.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return (r.display_name ?? "").trim() || full || null;
}

/** The phone as an admin may see it: masked, plus whether only a hash exists. */
export function phoneView(r: { phone_e164?: string | null; phone_hash?: string | null }): { masked: string | null; hash_only: boolean } {
  const masked = maskE164(r.phone_e164 ?? null);
  return { masked, hash_only: !masked && !!r.phone_hash };
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

/** One RFC 4180 field. Text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header + rows, CRLF line breaks, CRLF after the last record, UTF-8 BOM for Excel. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Paise -> plain rupees with two decimals ("627.00"): no symbol, no grouping. */
export function csvRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) return "";
  const p = Math.round(Number(paise));
  const sign = p < 0 ? "-" : "";
  const a = Math.abs(p);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Epoch ms -> "2026-09-26 17:30" in IST (the column header says IST). */
export function csvIst(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return "";
  const d = new Date(Number(ms) + 5.5 * 3_600_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** "saathum-bookings-2026-09-26.csv" / "saathum-bookings-2026-09-26-event-L1.csv" (safe chars only). */
export function csvFilename(kind: string, now: number, extra?: string | null): string {
  const day = csvIst(now).slice(0, 10);
  const tail = extra ? "-" + extra.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) : "";
  return `saathum-${kind}-${day}${tail}.csv`;
}
