// [DASH2-API 2026-09-25] Read models for the customer dashboard (Dashboard 2).
//
// WHERE A CUSTOMER'S PAYMENTS LIVE TODAY (investigated 2026-09-25, see the report in
// the DASH2-API commits):
//   * `orders` (migrations/listings.sql + phase7.sql) is the commercial order the
//     checkout writes for every paid seat (routes/commercial_checkout.ts
//     provisionCommercialPurchase): buyer_id, listing_id, amount (TOKENS = rupees,
//     the pre-tax gross), status held|free|released|refunded, created_at.
//   * `commercial_policy_snapshots` freezes gross_amount + gst_amount per order;
//     what the buyer actually paid is gross_amount + gst_amount (lib/session_pricing.ts
//     buyerTotal), so that is the amount shown here, not orders.amount alone.
//   * `hdfc_sms_payment_intents` (2026-09-17) is the HDFC UPI SMS rail's intent:
//     amount_paise, status, bank_reference (= UTR) and commercial_order_id, the
//     order it provisioned. It records NO payer VPA. (The newer hdfc_sms_smoke_*
//     tables are the ₹1 internal smoke test only and are never a customer payment.)
//
// A PaymentLine id is the HDFC intent_id when an intent exists for the order, else the
// order id. That keeps the id stable when a pending UPI intent later gains its order.
import { endMsSql } from "./listing_schedule";

export const SMOKE_LISTING_ID = "avatok-upi-smoke-2026";

/** starts_at normalised to epoch ms (historical rows stored seconds). */
export const startsMsSql = (a: string) =>
  `(CASE WHEN ${a}.starts_at IS NULL OR ${a}.starts_at<=0 THEN NULL WHEN ${a}.starts_at < 100000000000 THEN ${a}.starts_at*1000 ELSE ${a}.starts_at END)`;

const intentFor = (col: string) =>
  `(SELECT h.${col} FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
     ORDER BY (h.status='confirmed') DESC, h.updated_at DESC LIMIT 1)`;

/**
 * CTE `lines`: every payment line of ONE account. Binds: ?1 = uid, ?2 = now (ms).
 * Excludes free seats (nothing was paid), failed/expired UPI intents, and the
 * internal ₹1 smoke-test listing.
 */
export const PAYMENT_LINES_CTE = `lines AS (
  SELECT COALESCE(${intentFor("intent_id")}, o.id) AS id,
         o.id AS order_id, o.listing_id AS listing_id, o.buyer_id AS uid,
         COALESCE(${intentFor("amount_paise")},
                  (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100) AS amount_paise,
         CASE WHEN o.status='refunded' THEN 'refunded' ELSE 'paid' END AS base_status,
         COALESCE((SELECT h.updated_at FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id AND h.status='confirmed' ORDER BY h.updated_at DESC LIMIT 1),
                  o.created_at) AS paid_at,
         ${intentFor("bank_reference")} AS utr,
         o.created_at AS created_at
    FROM orders o
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
   WHERE o.buyer_id=?1 AND o.amount>0 AND o.status IN ('held','released','refunded')
     AND o.listing_id<>'${SMOKE_LISTING_ID}'
  UNION ALL
  SELECT h.intent_id, NULL, h.listing_id, h.uid, h.amount_paise, 'pending', NULL, h.bank_reference, h.created_at
    FROM hdfc_sms_payment_intents h
   WHERE h.uid=?1 AND h.listing_id<>'${SMOKE_LISTING_ID}' AND h.commercial_order_id IS NULL
     AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?2))
)`;

/** Latest refund row per payment for the account (?1 = uid). */
const REFUND_CTE = `rf AS (
  SELECT payment_id, status AS refund_status, requested_at AS refund_requested_at, refunded_at AS refund_refunded_at,
         amount_paise AS refund_amount_paise, refund_vpa, refund_utr,
         ROW_NUMBER() OVER (PARTITION BY payment_id ORDER BY requested_at DESC, id DESC) AS rn
    FROM refunds WHERE uid=?1
)`;

/** Full PaymentLine rows (joined to listing + category + latest refund), as a subquery `p`. */
export const PAYMENT_ROWS_SQL = `WITH ${PAYMENT_LINES_CTE}, ${REFUND_CTE}
SELECT * FROM (
  SELECT x.id, x.order_id, x.listing_id, x.amount_paise, x.base_status, x.paid_at, x.utr, x.created_at,
         COALESCE(x.paid_at, x.created_at) AS sort_ts,
         l.title AS event_title, l.category AS category, c.label AS category_label, l.kind AS listing_kind,
         ${startsMsSql("l")} AS event_starts_at,
         rf.refund_status, rf.refund_requested_at, rf.refund_refunded_at, rf.refund_amount_paise, rf.refund_vpa, rf.refund_utr,
         CASE WHEN x.base_status='refunded' OR rf.refund_status='refunded' THEN 'refunded'
              WHEN x.base_status='pending' THEN 'pending'
              WHEN rf.refund_status='requested' THEN 'refund_requested'
              ELSE 'paid' END AS status
    FROM lines x
    LEFT JOIN listings l ON l.id=x.listing_id
    LEFT JOIN listing_categories c ON c.id=l.category
    LEFT JOIN rf ON rf.payment_id=x.id AND rf.rn=1
) p`;

export type PaymentRow = {
  id: string; order_id: string | null; listing_id: string; amount_paise: number;
  base_status: "paid" | "pending" | "refunded"; paid_at: number | null; utr: string | null;
  created_at: number; sort_ts: number; event_title: string | null; category: string | null;
  category_label: string | null; listing_kind: string | null; event_starts_at: number | null;
  refund_status: "requested" | "refunded" | "rejected" | null; refund_requested_at: number | null;
  refund_refunded_at: number | null; refund_amount_paise: number | null; refund_vpa: string | null;
  refund_utr: string | null; status: "paid" | "pending" | "refund_requested" | "refunded";
};

export type PaymentFilters = {
  q?: string | null; cat?: string | null; status?: string | null;
  eventFrom?: number | null; eventTo?: number | null; paidFrom?: number | null; paidTo?: number | null;
  minPaise?: number | null; maxPaise?: number | null; cursor?: { t: number; id: string } | null;
  id?: string | null; limit?: number;
};

const STATUSES = new Set(["paid", "pending", "refund_requested", "refunded"]);

/** Builds the filtered, keyset-paginated payments query. Returns SQL + binds. */
export function buildPaymentsQuery(uid: string, now: number, f: PaymentFilters): { sql: string; binds: unknown[] } {
  const binds: unknown[] = [uid, now];
  const where: string[] = [];
  const add = (frag: (n: string) => string, v: unknown) => { binds.push(v); where.push(frag(`?${binds.length}`)); };
  if (f.id) add((n) => `p.id=${n}`, f.id);
  if (f.q && f.q.trim()) {
    // Title / UTR: substring. Listing id, order id and payment id: exact or prefix
    // (ids are opaque; a substring match on them would be noise). LIKE wildcards in the
    // input are ESCAPED, so "L_soon" means that literal id and "%" matches nothing.
    const q = f.q.trim().slice(0, 80).replace(/[\\%_]/g, (ch) => "\\" + ch);
    binds.push(`%${q.toLowerCase()}%`); const sub = `?${binds.length}`;
    binds.push(`${q}%`); const pre = `?${binds.length}`;
    const like = (col: string, ref: string) => `${col} LIKE ${ref} ESCAPE '\\'`;
    where.push(`(${like("lower(p.event_title)", sub)} OR ${like("p.utr", sub)}
      OR ${like("p.listing_id", pre)} OR ${like("p.order_id", pre)} OR ${like("p.id", pre)})`);
  }
  if (f.cat) add((n) => `p.category=${n}`, f.cat);
  if (f.status) {
    const list = f.status.split(",").map((s) => s.trim()).filter((s) => STATUSES.has(s));
    if (list.length) {
      const refs = list.map((s) => { binds.push(s); return `?${binds.length}`; });
      where.push(`p.status IN (${refs.join(",")})`);
    }
  }
  if (f.eventFrom != null) add((n) => `p.event_starts_at>=${n}`, f.eventFrom);
  if (f.eventTo != null) add((n) => `p.event_starts_at<=${n}`, f.eventTo);
  if (f.paidFrom != null) add((n) => `p.paid_at>=${n}`, f.paidFrom);
  if (f.paidTo != null) add((n) => `p.paid_at<=${n}`, f.paidTo);
  if (f.minPaise != null) add((n) => `p.amount_paise>=${n}`, f.minPaise);
  if (f.maxPaise != null) add((n) => `p.amount_paise<=${n}`, f.maxPaise);
  if (f.cursor) {
    binds.push(f.cursor.t); const t = `?${binds.length}`;
    binds.push(f.cursor.id); const i = `?${binds.length}`;
    where.push(`(p.sort_ts<${t} OR (p.sort_ts=${t} AND p.id<${i}))`);
  }
  const limit = Math.max(1, Math.min(100, f.limit ?? 21));
  const sql = `${PAYMENT_ROWS_SQL}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY p.sort_ts DESC, p.id DESC LIMIT ${limit}`;
  return { sql, binds };
}

/** Who owns a payment id (admin path, no caller scoping). */
export const PAYMENT_OWNER_SQL = `SELECT buyer_id AS uid FROM orders WHERE id=?1
  UNION ALL SELECT uid FROM hdfc_sms_payment_intents WHERE intent_id=?1 LIMIT 1`;

/**
 * The caller's booked live events: paid or free seats (orders), plus UPI intents
 * still awaiting confirmation. Binds ?1 = uid, ?2 = now. Refunded orders are omitted
 * (they appear on Billing, not in My events).
 */
export const EVENTS_SQL = `
SELECT o.id AS order_id,
       -- Same id as the PaymentLine (intent id when a UPI intent exists); NULL for a free seat.
       CASE WHEN o.amount>0 THEN COALESCE((SELECT h.intent_id FROM hdfc_sms_payment_intents h WHERE h.commercial_order_id=o.id AND h.uid=o.buyer_id
         ORDER BY (h.status='confirmed') DESC, h.updated_at DESC LIMIT 1), o.id) END AS payment_id,
       1 AS paid, o.created_at AS booked_at, l.*,
       c.label AS category_label,
       (SELECT s.replay_state FROM commercial_sessions s WHERE s.listing_id=l.id AND s.kind='live_event' ORDER BY s.session_version DESC LIMIT 1) AS replay_state,
       -- [DASH2-API] Seat holders only: this branch is the caller's own paid/free seats.
       (SELECT v.youtube_video_id FROM event_videos v WHERE v.listing_id=l.id) AS youtube_video_id,
       ${endMsSql("l")} AS ends_ms
  FROM orders o JOIN listings l ON l.id=o.listing_id
  LEFT JOIN listing_categories c ON c.id=l.category
 WHERE o.buyer_id=?1 AND l.kind='live_event' AND o.status IN ('held','free','released')
   AND o.listing_id<>'${SMOKE_LISTING_ID}'
UNION ALL
SELECT NULL, h.intent_id, 0, h.created_at, l.*, c.label, NULL, NULL, ${endMsSql("l")}
  FROM hdfc_sms_payment_intents h JOIN listings l ON l.id=h.listing_id
  LEFT JOIN listing_categories c ON c.id=l.category
 WHERE h.uid=?1 AND h.commercial_order_id IS NULL AND l.kind='live_event' AND h.listing_id<>'${SMOKE_LISTING_ID}'
   AND (h.status IN ('payment_received','review_pending') OR (h.status='pending' AND h.expires_at>?2))
 ORDER BY booked_at DESC LIMIT 300`;

/** First usable cover image URL: the AI poster if any, else the first image. */
export function coverImageUrl(raw: unknown): string | null {
  let media: unknown = raw;
  if (typeof raw === "string") { try { media = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(media)) return null;
  const urlOf = (m: any): string | null => {
    const u = m?.url ?? m?.r2_key;
    return typeof u === "string" && u ? u : null;
  };
  const poster = media.find((m: any) => m && m.source === "ai_poster" && urlOf(m));
  if (poster) return urlOf(poster);
  const image = media.find((m: any) => m && (m.type === "image" || !m.type) && urlOf(m));
  if (image) return urlOf(image);
  return null;
}

function attrsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

export type ListingWire = {
  id: string; title: string; description: string | null; category: string; category_label: string | null;
  deity?: string; image_url: string | null; starts_at: number | null; duration_min: number | null;
  price_paise: number; seats_left?: number; status: string; book_url: string;
};

/** Listing wire shape of the Dashboard 2 contract. price_paise = the LIST price
 * (listings.price is rupees); checkout adds the platform fee and GST on top. */
export function shapeListing(r: any): ListingWire {
  const attrs = attrsOf(r.attrs);
  const deity = typeof attrs.deity === "string" && attrs.deity.trim() ? attrs.deity.trim() : undefined;
  const startsRaw = Number(r.starts_at);
  const starts = Number.isFinite(startsRaw) && startsRaw > 0 ? (startsRaw < 100_000_000_000 ? startsRaw * 1000 : startsRaw) : null;
  const out: ListingWire = {
    id: String(r.id), title: String(r.title ?? ""), description: r.description ?? null,
    category: String(r.category ?? ""), category_label: r.category_label ?? null,
    image_url: coverImageUrl(r.cover_media), starts_at: starts,
    duration_min: r.duration_min != null ? Number(r.duration_min) : null,
    price_paise: Number(r.free_entry) === 1 ? 0 : Math.max(0, Math.round(Number(r.price ?? 0) * 100)),
    status: String(r.status ?? ""), book_url: `/book/${encodeURIComponent(String(r.id))}`,
  };
  if (deity) out.deity = deity;
  if (r.capacity != null && r.seats_taken != null) out.seats_left = Math.max(0, Number(r.capacity) - Number(r.seats_taken));
  return out;
}

/**
 * The swap as ONE D1 batch (one transaction): mark the code used, point the account's
 * single verified phone at the new number, and keep the users row's copy in step.
 * There is no DELETE anywhere in it, so the account can never be left with zero
 * verified phones — the old number is replaced in place, atomically. Exported for tests.
 */
export function phoneSwapStatements(db: D1Database, a: { uid: string; otpId: number; hash: string; e164: string; now: number }): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE phone_otp SET status='verified', verified_at=?2 WHERE id=?1 AND status='sent'").bind(a.otpId, a.now),
    db.prepare(
      `INSERT INTO contact_verification (uid, phone_verified, phone_hash, phone_verified_at, updated_at)
       VALUES (?1, 1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET phone_verified=1, phone_hash=excluded.phone_hash,
         phone_verified_at=excluded.phone_verified_at, updated_at=excluded.updated_at`,
    ).bind(a.uid, a.hash, a.now),
    // web_account.ts bootstrap also stores the phone on users; a stale copy there would
    // keep resolving the OLD number, so it moves in the same transaction.
    db.prepare(
      `UPDATE users SET phone_hash=?2, private_number=CASE WHEN private_number IS NULL THEN NULL ELSE ?3 END, updated_at=?4
        WHERE uid=?1 AND phone_hash IS NOT NULL`,
    ).bind(a.uid, a.hash, a.e164, a.now),
  ];
}
